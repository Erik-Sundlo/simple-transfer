const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Server, utils } = require('ssh2');
const { TransferSession } = require('../lib/session');
const { ConnectionStore } = require('../lib/connections');
const { downloadSafely } = require('../lib/files');

const hostKeys = utils.generateKeyPairSync('ed25519');
const userKeys = utils.generateKeyPairSync('ed25519', { passphrase: 'test-passphrase', cipher: 'aes256-ctr' });
const userPublic = utils.parseKey(userKeys.public);
const OK = 0, EOF = 1, MISSING = 2;

async function sftpServer(t) {
  const files = new Map([['/hello.txt', Buffer.from('Hello from SFTP')], ['/file2.txt', Buffer.from('second')]]);
  const directories = new Set(['/', '/folder']);
  const clients = new Set();
  const attributes = (name) => ({
    mode: directories.has(name) ? 0o40755 : 0o100644,
    uid: 1000, gid: 1000, size: files.get(name)?.length || 0,
    atime: 1700000000, mtime: 1700000000,
  });
  const server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (context) => {
      if (context.username !== 'tester') return context.reject();
      if (context.method === 'password' && context.password === 'test-password') return context.accept();
      if (context.method === 'publickey' && context.key.data.equals(userPublic.getPublicSSH()) &&
        (!context.signature || userPublic.verify(context.blob, context.signature, context.hashAlgo) === true)) {
        return context.accept();
      }
      context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map();
        let sequence = 0;
        const handle = (request, info) => {
          const value = Buffer.alloc(4);
          value.writeUInt32BE(++sequence);
          handles.set(sequence, info);
          sftp.handle(request, value);
        };
        const get = (value) => handles.get(value.readUInt32BE());
        sftp.on('REALPATH', (id, name) => sftp.name(id, [{
          filename: path.posix.resolve('/', name), longname: '', attrs: attributes('/'),
        }]));
        sftp.on('OPENDIR', (id, name) => {
          if (!directories.has(name)) return sftp.status(id, MISSING);
          handle(id, { path: name, directory: true, read: false });
        });
        sftp.on('READDIR', (id, value) => {
          const info = get(value);
          if (info.read) return sftp.status(id, EOF);
          info.read = true;
          const names = [...directories, ...files.keys()].filter((name) =>
            name !== info.path && path.posix.dirname(name) === info.path);
          sftp.name(id, names.map((name) => ({
            filename: path.posix.basename(name), longname: '', attrs: attributes(name),
          })));
        });
        const stat = (id, name) => {
          if (!files.has(name) && !directories.has(name)) return sftp.status(id, MISSING);
          sftp.attrs(id, attributes(name));
        };
        sftp.on('STAT', stat);
        sftp.on('LSTAT', stat);
        sftp.on('FSTAT', (id, value) => stat(id, get(value).path));
        sftp.on('OPEN', (id, name, flags) => {
          if (flags & 8) files.set(name, Buffer.alloc(0));
          if (!files.has(name)) return sftp.status(id, MISSING);
          handle(id, { path: name });
        });
        sftp.on('READ', (id, value, offset, length) => {
          const data = files.get(get(value).path);
          if (offset >= data.length) return sftp.status(id, EOF);
          sftp.data(id, data.subarray(offset, offset + length));
        });
        sftp.on('WRITE', (id, value, offset, data) => {
          const name = get(value).path;
          const previous = files.get(name);
          const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
          previous.copy(next);
          data.copy(next, offset);
          files.set(name, next);
          sftp.status(id, OK);
        });
        sftp.on('CLOSE', (id, value) => { handles.delete(value.readUInt32BE()); sftp.status(id, OK); });
        sftp.on('MKDIR', (id, name) => { directories.add(name); sftp.status(id, OK); });
      });
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, files };
}

test('SFTP password connection browses, uploads, downloads, and creates folders', { timeout: 15000 }, async (t) => {
  const { port, files } = await sftpServer(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-sftp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const progress = [];
  let fingerprint;
  const session = new TransferSession({
    verifyHost: (host, actualPort, hash) => {
      assert.equal(host, '127.0.0.1');
      assert.equal(actualPort, port);
      fingerprint = hash;
      return true;
    },
    onProgress: (item) => progress.push(item),
  });
  t.after(() => session.close());
  assert.equal(await session.connect({
    protocol: 'sftp', host: '127.0.0.1', port, username: 'tester', auth: 'password', password: 'test-password',
  }), '/');
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const listing = await session.list('/');
  assert.equal(listing.entries[0].name, 'folder');
  const content = Buffer.alloc(300000, 42);
  const source = path.join(root, 'upload.bin');
  await fs.writeFile(source, content);
  await session.upload(source, '/upload.bin');
  assert.deepEqual(files.get('/upload.bin'), content);
  const destination = path.join(root, 'download.bin');
  await downloadSafely(session, '/upload.bin', destination);
  assert.deepEqual(await fs.readFile(destination), content);
  await session.mkdir('/new-folder');
  assert.ok((await session.list('/')).entries.some((entry) => entry.name === 'new-folder' && entry.type === 'directory'));
  assert.ok(progress.some((item) => item.bytes === content.length));
  session.close();
  await assert.rejects(session.list('/'), /Connection closed/);
});

test('SFTP refuses a server when its SSH fingerprint is not trusted', { timeout: 5000 }, async (t) => {
  const { port } = await sftpServer(t);
  const session = new TransferSession({ verifyHost: () => false });
  t.after(() => session.close());
  await assert.rejects(session.connect({
    protocol: 'sftp', host: '127.0.0.1', port, username: 'tester', auth: 'password', password: 'test-password',
  }), /verification failed/i);
});

test('stored encrypted private key and passphrase support actual SSH authentication', { timeout: 15000 }, async (t) => {
  const { port } = await sftpServer(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keyPath = path.join(root, 'id_ed25519');
  await fs.writeFile(keyPath, userKeys.private);
  // Storage persistence is tested with authenticated encryption in connections.test.js.
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  };
  const store = new ConnectionStore(path.join(root, 'test-connections.json'), storage);
  const input = {
    protocol: 'sftp', host: '127.0.0.1', port, username: 'tester', auth: 'key',
    keyPath, passphrase: 'test-passphrase',
  };
  const id = await store.save(input, await store.resolve(input));
  await fs.rm(keyPath);
  const session = new TransferSession({ verifyHost: () => true });
  t.after(() => session.close());
  const config = await store.resolve({ ...input, savedId: id, keyPath: '', passphrase: '' });
  assert.equal(await session.connect(config), '/');
  assert.ok((await session.list('/')).entries.some((entry) => entry.name === 'hello.txt'));
});
