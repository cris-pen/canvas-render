// Gives the window what a plain web page cannot have: real file paths for
// dropped files, native pickers, and Finder.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('canvasRender', {
  platform: process.platform,
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  reveal: (file, open) => ipcRenderer.invoke('reveal', file, !!open),
  notify: (title, body) => ipcRenderer.send('notify', title, body),
  onOpenPath: (fn) => ipcRenderer.on('open-path', (_e, file) => fn(file)),
});
