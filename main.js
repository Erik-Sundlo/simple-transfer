const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TransferSession } = require('./lib/session');
const { ConnectionStore } = require('./lib/connections');
const { validPath, validName, listLocal, downloadSafely } = require('./lib/files');

let window;
let session;
let busy = false;
let connections;
let trustedHosts = {};
const smoke = process.argv.includes('--smoke-test');
const configFile = (name) => path.join(app.getPath('userData'), name);

async function readJSON(name) {
  try {
    return JSON.parse(await fs.readFile(configFile(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Could not read ${name}: ${error.message}`);
  }
}

async function writeJSON(name, value) {
  const destination = configFile(name);
  const temporary = `${destination}.tmp`;
  await fs.mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, destination);
}

function send(channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

async function verifyHost(host, port, hash) {
  const id = JSON.stringify([host.toLowerCase(), port]);
  const fingerprint = `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`;
  if (trustedHosts[id]) {
    if (trustedHosts[id] === hash) return true;
    await dialog.showMessageBox(window, {
      type: 'error',
      message: 'SSH host key has changed',
      detail: `The saved identity for ${host}:${port} does not match.\n\nNew fingerprint: ${fingerprint}\n\nConnection blocked. Verify the change with your server administrator before using Connection > Forget trusted SSH hosts.`,
    });
    return false;
  }
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Trust and connect'],
    defaultId: 0,
    cancelId: 0,
    message: 'Trust this SSH server?',
    detail: `${host}:${port}\n${fingerprint}\n\nCompare this fingerprint with a trusted source before connecting. Its identity will be remembered.`,
  });
  if (response !== 1) return false;
  trustedHosts[id] = hash;
  try {
    await writeJSON('trusted-hosts.json', trustedHosts);
  } catch (error) {
    delete trustedHosts[id];
    throw error;
  }
  return true;
}

function connected() {
  if (!session || session.closed) throw new Error('Connect to a server first.');
  return session;
}

function handle(channel, action, exclusive = false) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: 'Request not allowed.' };
    }
    if (exclusive && busy) return { ok: false, error: 'Wait for the current operation to finish.' };
    if (exclusive) busy = true;
    try {
      return { ok: true, value: await action(...args) };
    } catch (error) {
      if (session?.closed || session?.ftp?.closed) {
        session.close();
        session = null;
        send('disconnected');
      }
      return { ok: false, error: error.message || 'The operation failed.' };
    } finally {
      if (exclusive) busy = false;
    }
  });
}

async function confirmOverwrite(destination) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Skip', 'Replace'],
    defaultId: 0,
    cancelId: 0,
    message: 'Replace existing file?',
    detail: destination,
  });
  return response === 1;
}

function registerIPC() {
  handle('init', () => ({ profiles: connections.list(), localPath: os.homedir() }));
  handle('save-connection', async (input) => {
    const config = await connections.resolve(input);
    const savedId = await connections.save(input, config);
    return { savedId, profiles: connections.list() };
  }, true);
  handle('forget-connection', async (id) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Forget connection'], defaultId: 0, cancelId: 0,
      message: 'Forget this saved connection?',
      detail: 'Its saved password, imported SSH key, and passphrase will be removed from this app. Original key files are not changed.',
    });
    if (response === 1) await connections.remove(id);
    return { removed: response === 1, profiles: connections.list() };
  }, true);
  handle('choose-key', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a private SSH key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0];
  }, true);
  handle('choose-local', async () => {
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'showHiddenFiles'] });
    return result.canceled ? null : result.filePaths[0];
  }, true);
  handle('list-local', (directory) => listLocal(directory), true);
  handle('list-remote', (directory) => connected().list(directory), true);
  handle('connect', async (input) => {
    send('connection-status', 'Loading credentials. Check for a macOS Keychain prompt...');
    const config = await connections.resolve(input);
    if (input.remember) connections.requireEncryption();
    if (config.protocol === 'ftp') {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        buttons: ['Cancel', 'Connect without encryption'],
        defaultId: 0,
        cancelId: 0,
        message: 'FTP is not encrypted',
        detail: 'Your username, password, and files can be read in transit. Prefer SFTP or FTPS.',
      });
      if (response !== 1) return null;
    }
    session?.close();
    const next = new TransferSession({
      verifyHost,
      onProgress: (value) => send('transfer-progress', value),
      onStatus: (value) => send('connection-status', value),
      onClose: () => { if (session === next) send('disconnected'); },
    });
    session = next;
    try {
      const home = await next.connect(config);
      send('connection-status', 'Reading remote folder...');
      const listing = await next.list(home);
      const savedId = input.remember ? await connections.save(input, config) : null;
      return { listing, savedId, profiles: connections.list() };
    } catch (error) {
      next.close();
      if (session === next) session = null;
      throw error;
    }
  }, true);
  handle('disconnect', () => {
    session?.close();
    session = null;
    send('disconnected');
  });
  handle('upload', async ({ files, remotePath }) => {
    if (!Array.isArray(files) || !files.length) throw new Error('Select local files to upload.');
    const active = connected();
    const existing = new Set((await active.list(validPath(remotePath))).entries.map((item) => item.name));
    let count = 0;
    for (const local of files) {
      const name = validName(path.basename(validPath(local)));
      const destination = path.posix.join(remotePath, name);
      if (existing.has(name) && !await confirmOverwrite(destination)) continue;
      send('transfer-progress', { name, bytes: 0 });
      await active.upload(local, destination);
      existing.add(name);
      count++;
    }
    return count;
  }, true);
  handle('download', async ({ names, remotePath, localPath }) => {
    if (!Array.isArray(names) || !names.length) throw new Error('Select remote files to download.');
    const active = connected();
    validPath(remotePath);
    validPath(localPath);
    let count = 0;
    for (const item of names) {
      const name = validName(item);
      const destination = path.join(localPath, name);
      let exists = false;
      try {
        await fs.lstat(destination);
        exists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (exists && !await confirmOverwrite(destination)) continue;
      send('transfer-progress', { name, bytes: 0 });
      await downloadSafely(active, path.posix.join(remotePath, name), destination);
      count++;
    }
    return count;
  }, true);
  handle('mkdir', async ({ side, directory, name }) => {
    validName(name);
    validPath(directory);
    if (side === 'local') await fs.mkdir(path.join(directory, name));
    else if (side === 'remote') await connected().mkdir(path.posix.join(directory, name));
    else throw new Error('Invalid file browser.');
  }, true);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    show: !smoke,
    title: 'Simple Transfer',
    backgroundColor: '#f4f6fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, 'renderer/index.html'));
  window.on('closed', () => { session?.close(); session = null; window = null; });
  if (smoke) {
    const timeout = setTimeout(() => { console.error('Desktop smoke test timed out.'); app.exit(1); }, 20000);
    window.webContents.once('did-finish-load', async () => {
      try {
        const result = await window.webContents.executeJavaScript(`(async () => {
          await window.appReady;
          const settings = await window.transfer.init();
          const listing = await window.transfer.listLocal(settings.localPath);
          const auth = document.querySelector('#auth');
          auth.value = 'key';
          auth.dispatchEvent(new Event('change'));
          const keyFormWorks = !document.querySelector('#key-field').hidden && document.querySelector('#password-field').hidden;
          auth.value = 'password';
          auth.dispatchEvent(new Event('change'));
          return Boolean(document.querySelector('#connect-form') && document.querySelectorAll('.file-pane').length === 2 &&
            document.querySelector('#remember').checked && document.querySelector('#save-connection') &&
            document.querySelector('#saved-connections') && keyFormWorks && Array.isArray(listing.entries));
        })()`);
        if (!result) throw new Error('UI or isolated IPC did not initialize.');
        const probeDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'simple-transfer-smoke-'));
        const probeFile = path.join(probeDirectory, 'connections.json');
        try {
          const probeStore = new ConnectionStore(probeFile, safeStorage);
          const probe = {
            protocol: 'sftp', host: 'smoke.invalid', port: 22, username: 'smoke',
            auth: 'key', privateKey: Buffer.from('smoke-only-private-key'), passphrase: 'smoke-only-passphrase',
          };
          const id = await probeStore.save({ name: 'Encryption smoke test' }, probe);
          const reloaded = new ConnectionStore(probeFile, safeStorage);
          await reloaded.load();
          const restored = await reloaded.resolve({ ...probe, privateKey: undefined, passphrase: '', savedId: id });
          const disk = await fs.readFile(probeFile, 'utf8');
          if (!restored.privateKey.equals(probe.privateKey) || restored.passphrase !== probe.passphrase ||
            disk.includes(probe.passphrase) || disk.includes(probe.privateKey.toString('base64'))) {
            throw new Error('Encrypted SSH key persistence failed.');
          }
          const passwordProbe = { ...probe, auth: 'password', password: 'smoke-only-password' };
          const passwordId = await probeStore.save({}, passwordProbe);
          await reloaded.load();
          const restoredPassword = await reloaded.resolve({ ...passwordProbe, password: '', savedId: passwordId });
          if (restoredPassword.password !== passwordProbe.password) throw new Error('Encrypted login persistence failed.');
          await reloaded.remove(id);
          await reloaded.remove(passwordId);
        } finally {
          await fs.rm(probeFile, { force: true });
          await fs.rm(`${probeFile}.tmp`, { force: true });
          await fs.rmdir(probeDirectory);
        }
        console.log('Desktop smoke test passed: file browser, isolated IPC, and persisted logins/SSH keys encrypted using macOS Keychain.');
        clearTimeout(timeout);
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(async () => {
  connections = new ConnectionStore(configFile('connections.json'), safeStorage);
  if (!smoke) {
    await connections.load();
    trustedHosts = await readJSON('trusted-hosts.json');
  }
  registerIPC();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Connection', submenu: [{
      label: 'Forget trusted SSH hosts...',
      click: async () => {
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning', buttons: ['Cancel', 'Forget all'], defaultId: 0, cancelId: 0,
          message: 'Forget all trusted SSH server identities?',
          detail: 'You will need to verify their fingerprints again the next time you connect.',
        });
        if (response === 1) {
          try {
            await writeJSON('trusted-hosts.json', {});
            trustedHosts = {};
          } catch (error) {
            dialog.showErrorBox('Could not clear SSH identities', error.message);
          }
        }
      },
    }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!window) createWindow(); });
}).catch((error) => {
  dialog.showErrorBox('Could not start Simple Transfer', error.message);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
