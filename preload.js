const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => async (...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

contextBridge.exposeInMainWorld('transfer', {
  init: invoke('init'),
  saveConnection: invoke('save-connection'),
  forgetConnection: invoke('forget-connection'),
  connect: invoke('connect'),
  disconnect: invoke('disconnect'),
  listLocal: invoke('list-local'),
  listRemote: invoke('list-remote'),
  chooseLocal: invoke('choose-local'),
  chooseKey: invoke('choose-key'),
  upload: invoke('upload'),
  download: invoke('download'),
  mkdir: invoke('mkdir'),
  onConnectionStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('connection-status', listener);
    return () => ipcRenderer.removeListener('connection-status', listener);
  },
  onProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('transfer-progress', listener);
    return () => ipcRenderer.removeListener('transfer-progress', listener);
  },
  onDisconnect: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('disconnected', listener);
    return () => ipcRenderer.removeListener('disconnected', listener);
  },
});
