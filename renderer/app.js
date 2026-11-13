const api = window.transfer;
const $ = (id) => document.getElementById(id);
const state = {
  connected: false,
  connecting: false,
  busy: false,
  profiles: [],
  selectedId: '',
  local: { path: '', parent: '', entries: [], selected: new Set() },
  remote: { path: '', parent: '', entries: [], selected: new Set() },
};

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let number = value / 1024;
  let unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
  return `${number.toFixed(number < 10 ? 1 : 0)} ${units[unit]}`;
}

function syncControls() {
  const busy = state.busy;
  for (const id of ['new-connection', 'save-connection', 'connection-name', 'remember', 'protocol', 'host', 'port', 'username', 'auth', 'password', 'key-path', 'passphrase', 'choose-key', 'connect', 'use-proxy', 'proxy-host', 'proxy-port']) {
    $(id).disabled = busy || state.connected;
  }
  $('forget-connection').disabled = busy || state.connected || !state.selectedId;
  for (const button of $('saved-connections').querySelectorAll('button')) {
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(button.dataset.id === state.selectedId));
  }
  $('disconnect').disabled = !state.connected && !busy;
  $('disconnect').textContent = state.connecting ? 'Cancel connection' : 'Disconnect';
  for (const side of ['local', 'remote']) {
    for (const suffix of ['up', 'path', 'go', 'refresh', 'all', 'mkdir']) {
      $(`${side}-${suffix}`).disabled = busy || (side === 'remote' && !state.connected);
    }
  }
  $('choose-local').disabled = busy;
  $('upload').disabled = busy || !state.connected || !state.local.selected.size;
  $('download').disabled = busy || !state.connected || !state.remote.selected.size;
  for (const element of document.querySelectorAll('tbody input, tbody button')) element.disabled = busy;
  $('connection-state').textContent = state.connecting ? 'Connecting...' : state.connected ? 'Connected' : 'Not connected';
  $('connection-state').classList.toggle('connected', state.connected);
}

async function run(action, message) {
  if (state.busy) return;
  state.busy = true;
  syncControls();
  if (message) status(message);
  try {
    await action();
  } catch (error) {
    status(error.message, true);
  } finally {
    state.busy = false;
    $('progress').hidden = true;
    syncControls();
  }
}

function join(directory, name) {
  return `${directory.replace(/\/$/, '')}/${name}`;
}

function icon(directory) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.classList.add('entry-icon');
  if (directory) svg.classList.add('folder');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('fill', 'currentColor');
  shape.setAttribute('d', directory ? 'M2 4h6l2 2h8v11H2z' : 'M4 2h8l4 4v12H4zm8 1v4h4');
  svg.append(shape);
  return svg;
}

function render(side, listing) {
  const pane = state[side];
  Object.assign(pane, listing);
  pane.selected.clear();
  $(`${side}-path`).value = pane.path;
  const body = $(`${side}-files`);
  body.replaceChildren();
  for (const item of pane.entries) {
    const row = document.createElement('tr');
    const isDirectory = item.type === 'directory';
    const selectable = item.type === 'file' || item.type === 'link';
    const checkCell = document.createElement('td');
    if (selectable) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Select ${item.name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) pane.selected.add(item.name);
        else pane.selected.delete(item.name);
        row.classList.toggle('selected', checkbox.checked);
        updateSelection(side);
      });
      checkCell.append(checkbox);
    }
    const nameCell = document.createElement('td');
    const name = document.createElement('div');
    name.className = 'file-name';
    name.append(icon(isDirectory));
    const label = document.createElement(isDirectory || item.type === 'link' ? 'button' : 'span');
    label.textContent = item.type === 'link' ? `${item.name} (link)` : item.name;
    label.title = item.name;
    if (label.tagName === 'BUTTON') {
      label.type = 'button';
      label.className = 'folder-button';
      label.addEventListener('click', () => openFolder(side, join(pane.path, item.name)));
    }
    name.append(label);
    nameCell.append(name);
    const size = document.createElement('td');
    size.className = 'size';
    size.textContent = isDirectory ? '--' : bytes(item.size || 0);
    const date = document.createElement('td');
    date.className = 'date';
    date.textContent = item.modified ? new Date(item.modified).toLocaleDateString() : '--';
    row.append(checkCell, nameCell, size, date);
    row.addEventListener('dblclick', (event) => {
      if (event.target.closest('button, input')) return;
      if (isDirectory || item.type === 'link') openFolder(side, join(pane.path, item.name));
    });
    row.addEventListener('click', (event) => {
      if (state.busy || !selectable || event.target.closest('button, input')) return;
      const checkbox = checkCell.querySelector('input');
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });
    body.append(row);
  }
  $(`${side}-empty`).hidden = Boolean(pane.entries.length);
  $(`${side}-empty`).textContent = 'This folder is empty.';
  updateSelection(side);
}

function updateSelection(side) {
  const pane = state[side];
  const total = pane.entries.filter((item) => item.type === 'file' || item.type === 'link').length;
  $(`${side}-all`).checked = total > 0 && pane.selected.size === total;
  $(`${side}-all`).indeterminate = pane.selected.size > 0 && pane.selected.size < total;
  $(`${side}-count`).textContent = `${pane.entries.length} items${pane.selected.size ? ` / ${pane.selected.size} selected` : ''}`;
  syncControls();
}

async function load(side, directory = state[side].path) {
  const listing = await (side === 'local' ? api.listLocal(directory) : api.listRemote(directory));
  render(side, listing);
}

function openFolder(side, directory) {
  return run(async () => {
    await load(side, directory);
    status('Ready.');
  }, 'Opening folder...');
}

function updateAuth() {
  const sftp = $('protocol').value === 'sftp';
  const key = sftp && $('auth').value === 'key';
  $('auth-field').hidden = !sftp;
  $('key-field').hidden = !key;
  $('password-field').hidden = key;
  $('proxy-section').hidden = !sftp;
  const proxy = sftp && $('use-proxy').checked;
  $('proxy-fields').hidden = !proxy;
  $('proxy-host').required = proxy;
  $('proxy-port').required = proxy;
  const saved = state.profiles.find((item) => item.id === state.selectedId);
  $('key-path').required = key && !saved?.hasKey;
  $('security-note').textContent = $('protocol').value === 'ftp'
    ? 'Warning: FTP sends credentials and files without encryption. Saved credentials are encrypted on this Mac.'
    : 'Saved passwords and imported SSH keys use macOS Keychain-backed encryption.';
}

function updateProfiles(profiles, selected = '') {
  state.profiles = profiles;
  state.selectedId = profiles.some((profile) => profile.id === selected) ? selected : '';
  $('saved-connections').replaceChildren();
  for (const profile of profiles) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'saved-connection';
    button.dataset.id = profile.id;
    button.title = `${profile.name}\n${profile.protocol.toUpperCase()} / ${profile.username}@${profile.host}:${profile.port}\nDouble-click to connect`;
    const name = document.createElement('span');
    name.textContent = profile.name;
    const details = document.createElement('span');
    details.className = 'subtle';
    details.textContent = `${profile.protocol.toUpperCase()} / ${profile.username}@${profile.host}:${profile.port}`;
    if (profile.useProxy) details.textContent += ' / SOCKS5';
    button.append(name, details);
    button.addEventListener('click', () => {
      if (state.busy) return;
      state.selectedId = profile.id;
      chooseProfile();
    });
    button.addEventListener('dblclick', () => {
      if (state.busy) return;
      state.selectedId = profile.id;
      chooseProfile();
      connectToServer();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || state.busy) return;
      event.preventDefault();
      state.selectedId = profile.id;
      chooseProfile();
      connectToServer();
    });
    $('saved-connections').append(button);
  }
  $('connections-empty').hidden = profiles.length > 0;
  syncControls();
}

function chooseProfile() {
  const profile = state.profiles.find((item) => item.id === state.selectedId);
  $('connection-name').value = profile?.name || '';
  $('protocol').value = profile?.protocol || 'sftp';
  $('host').value = profile?.host || '';
  $('port').value = profile?.port || 22;
  $('username').value = profile?.username || '';
  $('auth').value = profile?.auth || 'password';
  $('use-proxy').checked = profile?.useProxy || false;
  $('proxy-host').value = profile?.proxyHost || '127.0.0.1';
  $('proxy-port').value = profile?.proxyPort || 1080;
  $('key-path').value = '';
  $('key-path').placeholder = profile?.hasKey ? `Stored key: ${profile.keyLabel}` : 'Choose a private SSH key';
  $('password').value = '';
  $('passphrase').value = '';
  $('password').placeholder = profile?.hasPassword ? 'Saved password (leave blank to use)' : '';
  $('passphrase').placeholder = profile?.hasPassphrase ? 'Saved passphrase (leave blank to use)' : '';
  updateAuth();
  syncControls();
}

$('new-connection').addEventListener('click', () => {
  state.selectedId = '';
  chooseProfile();
  $('host').focus();
});
$('save-connection').addEventListener('click', () => {
  if (!$('connect-form').reportValidity()) return;
  run(async () => {
    const result = await api.saveConnection(connectionInput());
    updateProfiles(result.profiles, result.savedId);
    chooseProfile();
    status('Connection saved. Double-click it above to connect.');
  }, 'Saving connection...');
});
$('forget-connection').addEventListener('click', () => run(async () => {
  const result = await api.forgetConnection(state.selectedId);
  updateProfiles(result.profiles, result.removed ? '' : state.selectedId);
  chooseProfile();
  status(result.removed ? 'Saved connection and its credentials removed.' : 'Nothing removed.');
}));

function disconnected() {
  state.connected = false;
  state.remote = { path: '', parent: '', entries: [], selected: new Set() };
  $('remote-files').replaceChildren();
  $('remote-path').value = '';
  $('remote-label').textContent = 'No connection';
  $('remote-count').textContent = 'Not connected';
  $('remote-empty').hidden = false;
  $('remote-empty').textContent = 'Your server\'s files will appear here.';
  syncControls();
}

$('protocol').addEventListener('change', () => {
  $('port').value = $('protocol').value === 'sftp' ? 22 : $('protocol').value === 'ftps-implicit' ? 990 : 21;
  updateAuth();
});
$('auth').addEventListener('change', updateAuth);
$('use-proxy').addEventListener('change', updateAuth);
$('choose-key').addEventListener('click', () => run(async () => {
  const file = await api.chooseKey();
  if (file) $('key-path').value = file;
}));
$('choose-local').addEventListener('click', () => run(async () => {
  const directory = await api.chooseLocal();
  if (directory) await load('local', directory);
}));
$('connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  connectToServer();
});

function connectionInput() {
  return {
    protocol: $('protocol').value, host: $('host').value, port: $('port').value,
    username: $('username').value, auth: $('auth').value,
    keyPath: $('key-path').value, password: $('password').value, passphrase: $('passphrase').value,
    savedId: state.selectedId, name: $('connection-name').value, remember: $('remember').checked,
    useProxy: $('protocol').value === 'sftp' && $('use-proxy').checked,
    proxyHost: $('proxy-host').value, proxyPort: $('proxy-port').value,
  };
}

function connectToServer() {
  if (state.busy) return;
  state.connecting = true;
  return run(async () => {
    $('progress').hidden = false;
    const input = connectionInput();
    if (state.connected) {
      await api.disconnect();
      disconnected();
    }
    let result;
    try {
      result = await api.connect(input);
    } finally {
      $('password').value = '';
      $('passphrase').value = '';
    }
    if (!result) { status('Connection cancelled.'); return; }
    updateProfiles(result.profiles, result.savedId || input.savedId);
    if (result.savedId) chooseProfile();
    state.connected = true;
    render('remote', result.listing);
    $('remote-label').textContent = `${input.username}@${input.host}`;
    status(`Connected to ${input.host}.`);
  }, 'Connecting...').finally(() => {
    state.connecting = false;
    syncControls();
  });
}
$('disconnect').addEventListener('click', async () => {
  try {
    await api.disconnect();
    disconnected();
    status('Disconnected. Any active transfer was stopped.');
  } catch (error) { status(error.message, true); }
});

for (const side of ['local', 'remote']) {
  $(`${side}-path-form`).addEventListener('submit', (event) => {
    event.preventDefault();
    openFolder(side, $(`${side}-path`).value);
  });
  $(`${side}-up`).addEventListener('click', () => openFolder(side, state[side].parent));
  $(`${side}-refresh`).addEventListener('click', () => openFolder(side, state[side].path));
  $(`${side}-all`).addEventListener('change', () => {
    const selected = $(`${side}-all`).checked;
    for (const checkbox of $(`${side}-files`).querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = selected;
      checkbox.dispatchEvent(new Event('change'));
    }
  });
  $(`${side}-mkdir`).addEventListener('click', () => {
    $('folder-dialog').dataset.side = side;
    $('folder-name').value = '';
    $('folder-dialog').showModal();
    $('folder-name').focus();
  });
}

$('upload').addEventListener('click', () => run(async () => {
  $('progress').hidden = false;
  const count = await api.upload({
    files: [...state.local.selected].map((name) => join(state.local.path, name)),
    remotePath: state.remote.path,
  });
  await load('remote');
  status(`Uploaded ${count} file${count === 1 ? '' : 's'}.`);
}, 'Uploading...'));
$('download').addEventListener('click', () => run(async () => {
  $('progress').hidden = false;
  const count = await api.download({
    names: [...state.remote.selected],
    remotePath: state.remote.path,
    localPath: state.local.path,
  });
  await load('local');
  status(`Downloaded ${count} file${count === 1 ? '' : 's'}.`);
}, 'Downloading...'));
$('folder-cancel').addEventListener('click', () => $('folder-dialog').close());
$('folder-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const side = $('folder-dialog').dataset.side;
  const name = $('folder-name').value;
  $('folder-dialog').close();
  run(async () => {
    await api.mkdir({ side, directory: state[side].path, name });
    await load(side);
    status('Folder created.');
  }, 'Creating folder...');
});

let lastProgress = 0;
api.onConnectionStatus((message) => status(message));
api.onProgress(({ name, bytes: count }) => {
  const now = Date.now();
  if (count !== 0 && now - lastProgress < 100) return;
  lastProgress = now;
  status(`Transferring ${name || 'file'} / ${bytes(count)}`);
});
api.onDisconnect(() => {
  disconnected();
  status('Connection closed. Reconnect to continue.');
});

window.appReady = run(async () => {
  const { profiles, localPath } = await api.init();
  updateProfiles(profiles, profiles.at(-1)?.id);
  chooseProfile();
  await load('local', localPath);
  status(profiles.length ? 'Ready. Double-click a saved connection to connect.' : 'Ready. Enter a server to connect.');
});
