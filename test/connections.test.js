const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ConnectionStore } = require('../lib/connections');

function encryption() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simple-transfer-logins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'connections.json');
  const storage = encryption();
  const store = new ConnectionStore(filename, storage);
  await store.load();
  return { root, store, filename, storage };
}

test('saved passwords persist encrypted and never appear in renderer profiles', async (t) => {
  const { store, filename, storage } = await fixture(t);
  const input = { protocol: 'ftps', host: 'example.com', username: 'erik', auth: 'password', password: 'a-test-secret' };
  const id = await store.save(input, await store.resolve(input));
  const disk = await fs.readFile(filename, 'utf8');
  assert.ok(!disk.includes(input.password));
  const profile = store.list()[0];
  assert.equal(profile.hasPassword, true);
  assert.equal(profile.encryptedSecrets, undefined);
  assert.equal(profile.password, undefined);
  assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  const reloaded = new ConnectionStore(filename, storage);
  await reloaded.load();
  const resolved = await reloaded.resolve({ ...input, savedId: id, password: '' });
  assert.equal(resolved.password, input.password);
  for (const edit of [
    { host: 'other.example.com' }, { port: 2121 }, { username: 'someone-else' }, { protocol: 'ftp' },
  ]) {
    assert.equal((await reloaded.resolve({ ...input, savedId: id, password: '', ...edit })).password, '');
  }
});

test('imported SSH keys reconnect after the original is removed and can be forgotten', async (t) => {
  const { root, store, filename, storage } = await fixture(t);
  const keyPath = path.join(root, 'private-key');
  const privateKey = 'test-only-private-key-content';
  await fs.writeFile(keyPath, privateKey);
  const input = { protocol: 'sftp', host: 'localhost', username: 'test', auth: 'key', keyPath, passphrase: 'key-secret' };
  const id = await store.save(input, await store.resolve(input));
  await fs.rm(keyPath);
  const disk = await fs.readFile(filename, 'utf8');
  assert.ok(!disk.includes(privateKey));
  assert.ok(!disk.includes(Buffer.from(privateKey).toString('base64')));
  assert.ok(!disk.includes(input.passphrase));
  assert.equal(store.list()[0].hasKey, true);
  const loaded = new ConnectionStore(filename, storage);
  await loaded.load();
  const savedInput = { ...input, savedId: id, keyPath: '', passphrase: '' };
  const config = await loaded.resolve(savedInput);
  assert.equal(config.privateKey.toString(), privateKey);
  assert.equal(config.passphrase, input.passphrase);
  assert.equal(config.keyPath, undefined);
  await assert.rejects(loaded.resolve({ ...savedInput, host: 'different-host' }), /Choose a private SSH key/);
  await loaded.remove(id);
  await store.load();
  assert.deepEqual(store.list(), []);
  await assert.rejects(store.resolve(savedInput), /Choose a private SSH key/);
});

test('encryption failures never fall back to plain text', async (t) => {
  const { store, storage, filename } = await fixture(t);
  const input = { protocol: 'ftp', host: 'localhost', username: 'test', auth: 'password', password: 'secret' };
  const config = await store.resolve(input);
  storage.isEncryptionAvailable = () => false;
  await assert.rejects(store.save(input, config), /Keychain encryption is unavailable/);
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  assert.deepEqual(store.list(), []);
});

test('saving edits updates the selected connection and preserves its stored password', async (t) => {
  const { store, filename, storage } = await fixture(t);
  const input = {
    name: 'Original', protocol: 'sftp', host: 'offline.invalid',
    username: 'test', auth: 'password', password: 'stored-test-password',
  };
  const id = await store.save(input, await store.resolve(input));
  const edited = { ...input, savedId: id, name: 'Renamed', password: '' };
  assert.equal(await store.save(edited, await store.resolve(edited)), id);
  const reloaded = new ConnectionStore(filename, storage);
  await reloaded.load();
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.list()[0].name, 'Renamed');
  assert.equal((await reloaded.resolve(edited)).password, input.password);
});
