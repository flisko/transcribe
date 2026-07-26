// preload.js — the ONLY bridge between renderer and main (C4 + preload pin).
// The renderer is fully dumb: it invokes commands and paints state snapshots.
// webUtils.getPathForFile is the sole way to resolve dropped File objects to
// paths (Electron >= 32 removed file.path).
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (cmd, payload) => ipcRenderer.invoke('cmd', cmd, payload),
  onState: (cb) => { ipcRenderer.on('state', (_event, snapshot) => cb(snapshot)); },
  // Static UI text, pushed once per window load rather than inside every state
  // snapshot — the snapshot is re-sent on each progress tick, and the string
  // table is ~120 entries that never change while the app is running.
  onStrings: (cb) => { ipcRenderer.on('strings', (_event, strings) => cb(strings)); },
  onFocusLink: (cb) => { ipcRenderer.on('focus-link', () => cb()); },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
