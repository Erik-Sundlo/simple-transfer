const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const path = require('node:path');
const { Client: SSHClient } = require('ssh2');
const { Client: FTPClient } = require('basic-ftp');
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
  return { ...input, host, username, port };
}

function sshCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

class TransferSession {
  constructor({ verifyHost, onProgress = () => {}, onClose = () => {} } = {}) {
    this.verifyHost = verifyHost;
    this.onProgress = onProgress;
    this.onClose = onClose;
    this.closed = false;
  }

  async connect(input) {
    const config = validateConnection(input);
    this.protocol = config.protocol;
    if (config.protocol === 'sftp') {
      await this.connectSSH(config);
      this.assertOpen();
      this.home = await sshCall(this.sftp, 'realpath', '.');
    } else {
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
    this.ssh = new SSHClient();
    await new Promise((resolve, reject) => {
      this.ssh.on('error', reject);
      this.ssh.once('close', () => {
        this.closed = true;
        this.onClose();
        reject(new Error('SSH connection closed.'));
      });
      this.ssh.once('ready', () => {
        this.ssh.sftp((error, sftp) => {
          if (error) reject(error);
          else {
            this.sftp = sftp;
            resolve();
          }
        });
      });
      this.ssh.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.auth === 'password' ? config.password || '' : undefined,
        privateKey,
        passphrase: config.auth === 'key' ? config.passphrase || undefined : undefined,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: (hash, callback) => {
          Promise.resolve().then(() => {
            if (!this.verifyHost) throw new Error('SSH host verification is unavailable.');
            return this.verifyHost(config.host, config.port, hash);
          }).then((trusted) => callback(Boolean(trusted)), () => callback(false));
        },
      });
    });
  }

  async list(directory) {
    this.assertOpen();
    validPath(directory);
    let entries;
    if (this.protocol === 'sftp') {
      entries = (await sshCall(this.sftp, 'readdir', directory)).map(({ filename, attrs }) => ({
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
    if (this.protocol === 'sftp') await sshCall(this.sftp, 'mkdir', directory);
    else await this.ftp.send(`MKD ${directory}`);
  }

  close() {
    this.closed = true;
    this.ftp?.close();
    this.sftp?.destroy();
    this.ssh?.destroy();
  }

  assertOpen() {
    if (this.closed) throw new Error('Connection closed.');
  }
}

module.exports = { TransferSession, validateConnection };
