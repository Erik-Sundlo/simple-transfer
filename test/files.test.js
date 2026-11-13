const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validName, validPath, listLocal, downloadSafely } = require('../lib/files');
const { validateConnection } = require('../lib/session');

test('connection validation handles protocol defaults and rejects malformed inputs', () => {
  const input = { protocol: 'sftp', host: ' example.com ', username: ' user ', auth: 'password' };
  assert.equal(validateConnection(input).port, 22);
  assert.equal(validateConnection(input).host, 'example.com');
  assert.equal(validateConnection({ ...input, protocol: 'ftp' }).port, 21);
  assert.equal(validateConnection({ ...input, protocol: 'ftps-implicit' }).port, 990);
  for (const bad of [
    { host: 'sftp://example.com' }, { host: 'example.com\r\nBAD' },
    { port: 0 }, { port: 65536 }, { port: 2.5 }, { username: 'user\nBAD' },
    { protocol: 'http' }, { auth: 'key', keyPath: '' },
    { useProxy: true, proxyHost: '', proxyPort: 1080 },
    { useProxy: true, proxyHost: 'socks://localhost', proxyPort: 1080 },
    { useProxy: true, proxyHost: '127.0.0.1', proxyPort: 0 },
    { useProxy: true, proxyHost: '127.0.0.1', proxyPort: 65536 },
    { protocol: 'ftp', useProxy: true, proxyHost: '127.0.0.1', proxyPort: 1080 },
  ]) assert.throws(() => validateConnection({ ...input, ...bad }));
});

test('file names cannot escape the selected folder or inject FTP commands', () => {
  for (const name of ['', '.', '..', '../secret', 'a/b', 'a\\b', 'a\r\nDELE /x', 'a\0b']) {
    assert.throws(() => validName(name));
  }
  assert.equal(validName('a file.txt'), 'a file.txt');
  assert.throws(() => validPath('/safe\r\nDELE /x'));
});

test('local browsing puts folders first and follows directory symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'hello');
  await fs.mkdir(path.join(root, 'z-folder'));
  await fs.symlink(path.join(root, 'z-folder'), path.join(root, 'linked-folder'));
  await fs.symlink(path.join(root, 'missing'), path.join(root, 'broken'));
  const listing = await listLocal(root);
  assert.deepEqual(listing.entries.slice(0, 2).map((item) => item.name), ['linked-folder', 'z-folder']);
  assert.equal(listing.entries.find((item) => item.name === 'a.txt').size, 5);
  assert.equal(listing.entries.find((item) => item.name === 'broken').type, 'other');
  assert.equal(listing.parent, path.dirname(root));
});

test('failed downloads preserve existing files and clean up partial data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'existing.txt');
  await fs.writeFile(destination, 'original');
  const session = {
    download: async (_remote, temporary) => {
      await fs.writeFile(temporary, 'partial');
      throw new Error('Connection lost');
    },
  };
  await assert.rejects(downloadSafely(session, '/remote.txt', destination), /Connection lost/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(root), ['existing.txt']);
  session.download = async (_remote, temporary) => fs.writeFile(temporary, 'complete');
  await downloadSafely(session, '/remote.txt', destination);
  assert.equal(await fs.readFile(destination, 'utf8'), 'complete');
  assert.deepEqual(await fs.readdir(root), ['existing.txt']);
});
