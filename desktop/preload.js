// preload.js — the ONLY bridge between renderer and main (C4 + preload pin).
// The renderer is fully dumb: it invokes commands and paints state snapshots.
// webUtils.getPathForFile is the sole way to resolve dropped File objects to
// paths (Electron >= 32 removed file.path).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (cmd, payload) => ipcRenderer.invoke('cmd', cmd, payload),
  onState: (cb) => { ipcRenderer.on('state', (_event, snapshot) => cb(snapshot)); },
  onFocusLink: (cb) => { ipcRenderer.on('focus-link', () => cb()); },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
