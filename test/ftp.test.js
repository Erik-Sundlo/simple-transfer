const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { TransferSession } = require('../lib/session');
const { downloadSafely } = require('../lib/files');

async function certificate(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-tls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = path.join(root, 'key.pem');
  const cert = path.join(root, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: await fs.readFile(key), cert: await fs.readFile(cert) };
}

async function ftpServer(t, { implicit = false, credentials } = {}) {
  const files = new Map([['/hello.txt', Buffer.from('Hello from FTP')]]);
  const directories = new Set(['/', '/folder']);
  const sockets = new Set();
  const listeners = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const secureContext = credentials ? tls.createSecureContext(credentials) : null;
  const connect = (original) => {
    let control = track(original);
    let secure = implicit;
    let passive;
    let text = '';
    const reply = (value) => control.write(`${value}\r\n`);
    const processCommand = async (line) => {
      const space = line.indexOf(' ');
      const command = space === -1 ? line : line.slice(0, space);
      const argument = space === -1 ? '' : line.slice(space + 1);
      if (command === 'AUTH' && credentials) {
        reply('234 Start TLS');
        control.removeListener('data', onData);
        control = track(new tls.TLSSocket(control, { isServer: true, secureContext }));
        secure = true;
        control.on('data', onData);
      } else if (command === 'USER') reply('331 Password required');
      else if (command === 'PASS') reply(argument === 'test-password' ? '230 Logged in' : '530 Invalid password');
      else if (command === 'FEAT') reply('211-Features\r\n UTF8\r\n MLST type*;size*;modify*;\r\n211 End');
      else if (command === 'PWD') reply('257 "/"');
      else if (['TYPE', 'STRU', 'OPTS', 'PBSZ', 'PROT'].includes(command)) reply('200 OK');
      else if (command === 'EPSV') {
        const passiveServer = secure ? tls.createServer(credentials) : net.createServer();
        listeners.add(passiveServer);
        const event = secure ? 'secureConnection' : 'connection';
        const data = once(passiveServer, event).then(([socket]) => track(socket));
        passiveServer.listen(0, '127.0.0.1');
        await once(passiveServer, 'listening');
        passive = { server: passiveServer, data };
        reply(`229 Entering Extended Passive Mode (|||${passiveServer.address().port}|)`);
      } else if (['MLSD', 'LIST', 'RETR', 'STOR'].includes(command)) {
        reply('150 Opening data connection');
        const connection = passive;
        const data = await connection.data;
        if (command === 'STOR') {
          const parts = [];
          data.on('data', (part) => parts.push(part));
          await once(data, 'end');
          files.set(argument, Buffer.concat(parts));
          data.end();
        } else if (command === 'RETR') {
          if (!files.has(argument)) {
            data.end();
            reply('550 Not found');
            connection.server.close();
            return;
          }
          data.end(files.get(argument));
        } else {
          const directory = argument || '/';
          const names = [...directories, ...files.keys()].filter((name) =>
            name !== directory && path.posix.dirname(name) === directory);
          data.end(names.map((name) =>
            `type=${directories.has(name) ? 'dir' : 'file'};size=${files.get(name)?.length || 0};modify=20260101000000; ${path.posix.basename(name)}\r\n`).join(''));
        }
        await once(data, 'close');
        connection.server.close();
        listeners.delete(connection.server);
        reply('226 Transfer complete');
      } else if (command === 'MKD') { directories.add(argument); reply(`257 "${argument}"`); }
      else if (command === 'QUIT') { reply('221 Goodbye'); control.end(); }
      else reply('502 Not implemented');
    };
    let queue = Promise.resolve();
    function onData(chunk) {
      text += chunk.toString('utf8');
      let end;
      while ((end = text.indexOf('\r\n')) !== -1) {
        const line = text.slice(0, end);
        text = text.slice(end + 2);
        queue = queue.then(() => processCommand(line)).catch(() => control.destroy());
      }
    }
    control.on('data', onData);
    reply('220 Test FTP server');
  };
  const server = implicit ? tls.createServer(credentials, connect) : net.createServer(connect);
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const listener of listeners) listener.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, files };
}

for (const protocol of ['ftp', 'ftps', 'ftps-implicit']) {
  test(`${protocol} connects, lists, and transfers files in both directions`, { timeout: 15000 }, async (t) => {
    const credentials = protocol === 'ftp' ? undefined : await certificate(t);
    if (credentials) {
      const originalCAs = tls.getCACertificates('default');
      tls.setDefaultCACertificates([...originalCAs, credentials.cert.toString()]);
      t.after(() => tls.setDefaultCACertificates(originalCAs));
    }
    const { port, files } = await ftpServer(t, { implicit: protocol === 'ftps-implicit', credentials });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-ftp-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const progress = [];
    const session = new TransferSession({ onProgress: (item) => progress.push(item) });
    t.after(() => session.close());
    assert.equal(await session.connect({
      protocol, host: '127.0.0.1', port, username: 'tester', auth: 'password', password: 'test-password',
    }), '/');
    const listing = await session.list('/');
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['folder', 'hello.txt']);
    const source = path.join(root, 'upload with spaces.bin');
    const content = Buffer.alloc(250000, 42);
    await fs.writeFile(source, content);
    await session.upload(source, '/upload with spaces.bin');
    assert.deepEqual(files.get('/upload with spaces.bin'), content);
    const destination = path.join(root, 'download.bin');
    await downloadSafely(session, '/upload with spaces.bin', destination);
    assert.deepEqual(await fs.readFile(destination), content);
    assert.ok(progress.some((item) => item.bytes === content.length));
    await session.mkdir('/created folder');
    assert.ok((await session.list('/')).entries.some((entry) => entry.name === 'created folder'));
  });
}

test('FTPS refuses an untrusted certificate instead of bypassing TLS verification', { timeout: 5000 }, async (t) => {
  const credentials = await certificate(t);
  const { port } = await ftpServer(t, { credentials });
  const session = new TransferSession();
  t.after(() => session.close());
  await assert.rejects(session.connect({
    protocol: 'ftps', host: '127.0.0.1', port, username: 'tester', auth: 'password', password: 'test-password',
  }), /self.signed|certificate/i);
});
