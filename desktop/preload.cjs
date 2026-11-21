// Limited desktop capabilities: folder operations, notifications, navigation, and
// write-only secure credential management. Secret values are never readable by the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duoDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('duo:pick-folder'),
  openPath: (p) => ipcRenderer.invoke('duo:open-path', p),
  notify: (o) => ipcRenderer.invoke('duo:notify', o),
  onNavigate: (fn) => ipcRenderer.on('duo:navigate', (_e, route) => fn(route)),
  deepseekKeyStatus: () => ipcRenderer.invoke('duo:deepseek-key-status'),
  saveDeepseekKey: (key) => ipcRenderer.invoke('duo:deepseek-key-save', key),
  removeDeepseekKey: () => ipcRenderer.invoke('duo:deepseek-key-remove'),
});
