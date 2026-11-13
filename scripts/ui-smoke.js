const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ConnectionStore } = require('../lib/connections');

let window;
let directory;
const timeout = setTimeout(() => { console.error('Saved-connections UI test timed out.'); app.exit(1); }, 20000);

app.whenReady().then(async () => {
  directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'simple-transfer-ui-'));
  const store = new ConnectionStore(path.join(directory, 'connections.json'), safeStorage);
  const calls = { saves: 0, connects: [], disconnects: 0 };
  for (const name of ['First', 'Second']) {
    const input = {
      name, protocol: 'sftp', host: `${name.toLowerCase()}.invalid`, port: 22,
      username: 'test', auth: 'password', password: `fixture-only-${name}`,
    };
    await store.save(input, await store.resolve(input));
  }
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, ...args) => {
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle('init', () => ({ profiles: store.list(), localPath: directory }));
  handle('list-local', () => ({ path: directory, parent: path.dirname(directory), entries: [] }));
  handle('save-connection', async (input) => {
    calls.saves++;
    const savedId = await store.save(input, await store.resolve(input));
    return { savedId, profiles: store.list() };
  });
  handle('connect', async (input) => {
    const config = await store.resolve(input);
    assert.equal(config.password, `fixture-only-${input.name}`);
    calls.connects.push(config.host);
    const savedId = input.remember ? await store.save(input, config) : null;
    return { listing: { path: '/', parent: '/', entries: [] }, savedId, profiles: store.list() };
  });
  handle('disconnect', () => {
    calls.disconnects++;
    window.webContents.send('disconnected');
  });
  window = new BrowserWindow({
    show: false, width: 1180, height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  const page = path.join(__dirname, '../renderer/index.html');
  await window.loadFile(page);
  await window.webContents.executeJavaScript('window.appReady');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.saved-connection').length"), 2);

  await window.webContents.executeJavaScript(`(async () => {
    document.getElementById('new-connection').click();
    document.getElementById('save-connection').click();
  })()`);
  assert.equal(calls.saves, 0, 'Invalid forms must not be saved.');
  await window.webContents.executeJavaScript(`(async () => {
    const value = (id, value) => { document.getElementById(id).value = value; };
    value('connection-name', 'Offline');
    value('host', 'offline.invalid');
    value('username', 'test');
    value('password', 'fixture-only-Offline');
    document.getElementById('remember').checked = false;
    const save = document.getElementById('save-connection');
    save.click();
    while (save.disabled) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!document.getElementById('status').textContent.startsWith('Connection saved.')) {
      throw new Error(document.getElementById('status').textContent);
    }
  })()`);
  assert.equal(calls.saves, 1);
  assert.equal(calls.connects.length, 0, 'Save connection must not attempt a network connection.');
  assert.equal(store.list().length, 3);
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('password').value"), '');

  await store.load();
  await window.loadFile(page);
  await window.webContents.executeJavaScript('window.appReady');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.saved-connection').length"), 3);
  assert.match(await window.webContents.executeJavaScript("document.getElementById('saved-connections').textContent"), /Offline/);

  await window.webContents.executeJavaScript(`document.querySelector('.saved-connection').click()`);
  assert.equal(calls.connects.length, 0, 'A single click must only load the connection.');
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('connection-name').value"), 'First');
  await window.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('.saved-connection');
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    while (document.querySelector('.saved-connection').disabled) await new Promise((resolve) => setTimeout(resolve, 10));
    if (document.getElementById('connection-state').textContent !== 'Connected') {
      throw new Error(document.getElementById('status').textContent);
    }
  })()`);
  assert.deepEqual(calls.connects, ['first.invalid']);

  await window.webContents.executeJavaScript(`(async () => {
    const button = [...document.querySelectorAll('.saved-connection')].find((item) => item.textContent.startsWith('Second'));
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    while (document.querySelector('.saved-connection').disabled) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!document.getElementById('remote-label').textContent.includes('second.invalid')) {
      throw new Error(document.getElementById('status').textContent);
    }
  })()`);
  assert.deepEqual(calls.connects, ['first.invalid', 'second.invalid']);
  assert.equal(calls.disconnects, 1);
  console.log('Saved-connections UI passed: offline save, startup listing, single-click editing, and double-click reconnect/switch with saved credentials.');
}).then(() => finish(0), async (error) => { console.error(error); await finish(1); });

async function finish(code) {
  clearTimeout(timeout);
  window?.destroy();
  if (directory) {
    await fs.rm(path.join(directory, 'connections.json'), { force: true });
    await fs.rm(path.join(directory, 'connections.json.tmp'), { force: true });
    await fs.rmdir(directory);
  }
  app.exit(code);
}
