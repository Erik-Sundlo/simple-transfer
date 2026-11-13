const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const path = require('node:path');
const { Client: SSHClient } = require('ssh2');
const { Client: FTPClient } = require('basic-ftp');
const { SocksClient } = require('socks');
const { Socket } = require('node:net');
const { validPath, sortEntries } = require('./files');

function validateConnection(input) {
  if (!input || !['sftp', 'ftp', 'ftps', 'ftps-implicit'].includes(input.protocol)) {
    throw new Error('Choose SFTP, FTP, or FTPS.');
  }
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const defaultPort = input.protocol === 'sftp' ? 22 : input.protocol === 'ftps-implicit' ? 990 : 21;
  const port = input.port === '' || input.port == null ? defaultPort : Number(input.port);
  if (!host || /[\s/@\0]/.test(host)) throw new Error('Enter a hostname or IP address, without a URL prefix.');
  if (!username || /[\r\n\0]/.test(username)) throw new Error('Enter a username.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (input.protocol === 'sftp' && !['password', 'key'].includes(input.auth)) {
    throw new Error('Choose password or SSH key authentication.');
  }
  if (input.auth === 'key' && input.protocol === 'sftp' && !Buffer.isBuffer(input.privateKey)) validPath(input.keyPath);
  const useProxy = input.useProxy === true;
  const proxyHost = useProxy ? String(input.proxyHost || '').trim() : '';
  const proxyPort = useProxy ? Number(input.proxyPort) : 0;
  if (useProxy) {
    if (input.protocol !== 'sftp') throw new Error('SOCKS5 tunneling is currently supported for SFTP only.');
    if (!proxyHost || /[\s/@\0]/.test(proxyHost)) throw new Error('Enter the SOCKS5 proxy hostname or IP address.');
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('SOCKS5 proxy port must be between 1 and 65535.');
  }
  return { ...input, host, username, port, useProxy, proxyHost, proxyPort };
}

function sshCall(target, timeout, method, ...args) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      target.removeListener('close', closed);
      target.removeListener('error', failed);
      if (error) reject(error);
      else resolve(value);
    };
    const closed = () => finish(new Error('SFTP connection closed.'));
    const failed = (error) => finish(error);
    const timer = setTimeout(() => finish(Object.assign(
      new Error(`SFTP ${method} timed out. Check the tunnel and server.`), { code: 'ETIMEDOUT' },
    )), timeout);
    target.once('close', closed);
    target.once('error', failed);
    try { target[method](...args, finish); }
    catch (error) { finish(error); }
  });
}

class TransferSession {
  constructor({ verifyHost, onProgress = () => {}, onClose = () => {}, onStatus = () => {}, timeout = 20000 } = {}) {
    this.verifyHost = verifyHost;
    this.onProgress = onProgress;
    this.onClose = onClose;
    this.onStatus = onStatus;
    this.timeout = timeout;
    this.closed = false;
  }

  async connect(input) {
    const config = validateConnection(input);
    this.protocol = config.protocol;
    if (config.protocol === 'sftp') {
      await this.connectSSH(config);
      this.assertOpen();
      this.home = await this.request('realpath', '.');
    } else {
      this.onStatus('Connecting to FTP server...');
      this.ftp = new FTPClient(30000);
      await this.ftp.access({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password || '',
        secure: config.protocol === 'ftps' ? true : config.protocol === 'ftps-implicit' ? 'implicit' : false,
        secureOptions: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      });
      this.assertOpen();
      this.ftp.trackProgress(({ bytes, name }) => this.onProgress({ bytes, name }));
      this.home = await this.ftp.pwd();
    }
    return this.home;
  }

  async connectSSH(config) {
    const privateKey = config.auth === 'key' ? config.privateKey || await fs.readFile(config.keyPath) : undefined;
    this.assertOpen();
    const sock = config.useProxy ? await this.openProxy(config) : undefined;
    this.assertOpen();
    this.onStatus(config.useProxy ? 'Tunnel connected. Waiting for SSH handshake...' : 'Connecting directly. Waiting for SSH handshake...');
    this.ssh = new SSHClient();
    await new Promise((resolve, reject) => {
      let subsystemTimer;
      const fail = (error) => {
        clearTimeout(subsystemTimer);
        if (error.level === 'client-timeout') {
          reject(new Error('SSH connection timed out. Check the server address and network route. If you use an SSH SOCKS tunnel, enable it in the connection settings.'));
        } else reject(error);
      };
      this.ssh.on('error', fail);
      this.ssh.once('close', () => {
        clearTimeout(subsystemTimer);
        this.closed = true;
        this.onClose();
        reject(new Error('SSH connection closed.'));
      });
      this.ssh.once('ready', () => {
        this.onStatus('SSH authenticated. Opening SFTP...');
        subsystemTimer = setTimeout(() => {
          fail(new Error('The server did not open SFTP in time. Check that the SFTP subsystem is enabled.'));
          this.close();
        }, this.timeout);
        this.ssh.sftp((error, sftp) => {
          clearTimeout(subsystemTimer);
          if (error) fail(error);
          else if (this.closed) {
            sftp.destroy();
            reject(new Error('Connection closed.'));
          }
          else {
            this.sftp = sftp;
            resolve();
          }
        });
      });
      this.ssh.connect({
        host: config.host,
        port: config.port,
        sock,
        username: config.username,
        password: config.auth === 'password' ? config.password || '' : undefined,
        privateKey,
        passphrase: config.auth === 'key' ? config.passphrase || undefined : undefined,
        readyTimeout: this.timeout,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (hash, callback) => {
          this.onStatus('Verifying SSH server identity. Check for a fingerprint confirmation dialog...');
          Promise.resolve().then(() => {
            if (!this.verifyHost) throw new Error('SSH host verification is unavailable.');
            return this.verifyHost(config.host, config.port, hash);
          }).then((trusted) => {
            if (trusted) this.onStatus('SSH server verified. Authenticating...');
            callback(Boolean(trusted));
          }, () => callback(false));
        },
      });
    });
  }

  async openProxy(config) {
    this.onStatus('Connecting through SOCKS5 tunnel...');
    const socket = new Socket();
    this.proxySocket = socket;
    try {
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          socket.removeListener('connect', connected);
          socket.removeListener('close', closed);
          socket.removeListener('error', failed);
          if (error) reject(error);
          else resolve();
        };
        const connected = () => finish();
        const closed = () => finish(new Error('Connection closed.'));
        const failed = (error) => finish(error);
        const timer = setTimeout(() => socket.destroy(new Error('Connection to the SOCKS5 proxy timed out.')), this.timeout);
        socket.once('connect', connected);
        socket.once('close', closed);
        socket.once('error', failed);
        socket.connect({ host: config.proxyHost, port: config.proxyPort });
      });
      this.assertOpen();
      const { socket: tunnel } = await SocksClient.createConnection({
        proxy: { host: config.proxyHost, port: config.proxyPort, type: 5 },
        command: 'connect',
        destination: { host: config.host, port: config.port },
        existing_socket: socket,
        timeout: this.timeout,
      });
      this.assertOpen();
      return tunnel;
    } catch (error) {
      socket.destroy();
      if (this.closed) throw new Error('Connection closed.');
      throw new Error(`SOCKS5 tunnel failed: ${error.message}. Check that the tunnel is running and its proxy port is correct.`);
    }
  }

  async request(method, ...args) {
    this.assertOpen();
    try { return await sshCall(this.sftp, this.timeout, method, ...args); }
    catch (error) {
      if (error.code === 'ETIMEDOUT') this.close();
      throw error;
    }
  }

  async list(directory) {
    this.assertOpen();
    validPath(directory);
    let entries;
    if (this.protocol === 'sftp') {
      entries = (await this.request('readdir', directory)).map(({ filename, attrs }) => ({
        name: filename,
        type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'link' : attrs.isFile() ? 'file' : 'other',
        size: attrs.size,
        modified: attrs.mtime * 1000,
      }));
    } else {
      entries = (await this.ftp.list(directory)).map((item) => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : item.isSymbolicLink ? 'link' : item.isFile ? 'file' : 'other',
        size: item.size,
        modified: item.modifiedAt?.getTime() || 0,
      }));
    }
    entries = entries.filter(({ name }) => name !== '.' && name !== '..' && !/[/\0\r\n]/.test(name));
    const normalized = path.posix.resolve('/', directory);
    return { path: normalized, parent: path.posix.dirname(normalized), entries: sortEntries(entries) };
  }

  async upload(local, remote) {
    this.assertOpen();
    validPath(local);
    validPath(remote);
    if (!(await fs.stat(local)).isFile()) throw new Error('Only individual files can be uploaded.');
    this.assertOpen();
    if (this.protocol !== 'sftp') return this.ftp.uploadFrom(local, remote);
    const { createReadStream } = require('node:fs');
    return this.copy(createReadStream(local), this.sftp.createWriteStream(remote), path.basename(local));
  }

  async download(remote, local) {
    this.assertOpen();
    validPath(remote);
    validPath(local);
    if (this.protocol !== 'sftp') return this.ftp.downloadTo(local, remote);
    const { createWriteStream } = require('node:fs');
    return this.copy(this.sftp.createReadStream(remote), createWriteStream(local, { flags: 'wx' }), path.posix.basename(remote));
  }

  async copy(source, destination, name) {
    let bytes = 0;
    const report = new Transform({
      transform: (chunk, encoding, callback) => {
        bytes += chunk.length;
        this.onProgress({ bytes, name });
        callback(null, chunk);
      },
    });
    await pipeline(source, report, destination);
  }

  async mkdir(directory) {
    this.assertOpen();
    validPath(directory);
    if (this.protocol === 'sftp') await this.request('mkdir', directory);
    else await this.ftp.send(`MKD ${directory}`);
  }

  close() {
    this.closed = true;
    this.ftp?.close();
    this.sftp?.destroy();
    this.ssh?.destroy();
    this.proxySocket?.destroy();
  }

  assertOpen() {
    if (this.closed) throw new Error('Connection closed.');
  }
}

module.exports = { TransferSession, validateConnection };
