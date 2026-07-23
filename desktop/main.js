// main.js — Electron entry: app lifecycle, single-instance lock, open-file,
// windows, menus, quit guard, wake handling, and the composition root wiring
// queue/engine/settings/ipc together. All behavior lives in main/* and
// shared/*; this file only assembles and owns window lifetime.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const {
  app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard,
  Notification, powerSaveBlocker, powerMonitor, nativeTheme,
} = require('electron');

const copy = require('./shared/copy');
const catalog = require('./shared/catalog');
const languages = require('./shared/languages');
const { createQueue, createSystemAdapter } = require('./main/queue');
const { createSettings } = require('./main/settings');
const { checkForUpdate } = require('./main/update');
const menus = require('./main/menus');
const { registerIpc } = require('./main/ipc');

app.setName('Transcribe');

const MEDIA_EXTS = [
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mts', 'm2ts',
  '3gp', 'mpg', 'mpeg', 'ts',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'caf',
];

let mainWindow = null;
let settingsWindow = null;
let queue = null;
let settings = null;
let quitApproved = false;
let updateChecked = false;
const pendingOpens = [];   // open-file / second-instance arrivals before ready

// tokens.css --color-window-bg; the window must not flash white before the
// renderer paints.
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#282828' : '#ECECEC';
}

// MARK: Single instance + external opens

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    // Windows: files/URLs arrive as argv of the second launch.
    enqueueOpens(argv.slice(1).filter((a) => typeof a === 'string' && !a.startsWith('-')));
  });
}

app.on('open-file', (event, p) => {
  event.preventDefault();
  enqueueOpens([p]);
});

function enqueueOpens(list) {
  for (const item of list) {
    if (!item) continue;
    if (queue) deliverOpen(item);
    else pendingOpens.push(item);
  }
}

function deliverOpen(item) {
  if (/^https?:\/\//i.test(item)) queue.addLink(item);
  else if (fs.existsSync(item)) queue.addFiles([item]);
}

// MARK: Windows

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 480,
    minHeight: 460,
    title: copy.windowTitle,
    // The renderer draws the unified toolbar itself (drag region + traffic-
    // light padding), so on mac the native title bar collapses into it.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', sendState);
  mainWindow.on('close', (event) => {
    // mac: closing the window leaves the app (and its work) running — the
    // quit guard lives on before-quit. Elsewhere close means quit.
    if (process.platform === 'darwin' || quitApproved) return;
    if (queue && queue.hasUnfinishedWork() && !confirmQuit()) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 440,
    height: 620,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Settings',
    backgroundColor: windowBackground(),
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.webContents.on('did-finish-load', sendState);
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function sendState() {
  if (!queue) return;
  const snap = queue.snapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('state', snap);
  }
}

// MARK: Quit guard (C5 — Copy strings; trees killed + temp cleaned on quit)

function confirmQuit() {
  const opts = {
    type: 'warning',
    buttons: [copy.quitKeepWorking, copy.quitAnyway],
    defaultId: 0,
    cancelId: 0,
    message: copy.quitTitle,
    detail: copy.quitMessage,
  };
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBoxSync(mainWindow, opts)
    : dialog.showMessageBoxSync(opts);
  if (choice === 1) { quitApproved = true; return true; }
  return false;
}

app.on('before-quit', (event) => {
  if (quitApproved) return;
  if (queue && queue.hasUnfinishedWork()) {
    if (!confirmQuit()) { event.preventDefault(); return; }
  }
  quitApproved = true;
});

app.on('will-quit', () => {
  if (queue) queue.prepareForTermination();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (app.isReady() && (!mainWindow || mainWindow.isDestroyed())) createMainWindow();
});

// Setup finishes in Terminal; re-probe whenever the user clicks back.
app.on('browser-window-focus', () => { if (queue) queue.probeDeps(); });

// MARK: Actions shared by menu + ipc

function browse() {
  if (!queue) return;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio & Video', extensions: MEDIA_EXTS }],
  }).then(({ canceled, filePaths }) => {
    if (!canceled && filePaths && filePaths.length) queue.addFiles(filePaths);
  }).catch(() => { });
}

function chooseDownloadFolder() {
  const win = (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow)
    || (mainWindow && !mainWindow.isDestroyed() && mainWindow) || undefined;
  dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths || !filePaths.length) return;
    settings.set('downloadFolder', filePaths[0]);
    sendState();
  }).catch(() => { });
}

function runSetup() {
  let root;
  try { root = require('./main/paths').folderRoot(); } catch { return; }
  if (process.platform === 'win32') {
    const bat = path.join(root, 'Transcribe Setup.bat');
    try {
      spawn('cmd.exe', ['/c', 'start', '', bat], { detached: true, stdio: 'ignore' }).unref();
    } catch { }
  } else {
    shell.openPath(path.join(root, 'setup.command'));
  }
}

function openReleasePage() {
  const banner = queue && queue.getBanner();
  const url = banner && banner.url;
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
}

function focusLink() {
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('focus-link');
}

function rowMenu({ id, x, y }) {
  const state = queue.stateOf(id);
  if (!state) return;
  const bound = {};
  for (const a of ['remove', 'cancel', 'openTranscript', 'openSubtitles', 'showInFinder',
                   'copyTranscript', 'transcribeAgain', 'retry', 'copyErrorDetails',
                   'startAgain']) {
    bound[a] = () => queue[a](id);
  }
  menus.popupRowMenu({
    Menu,
    window: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    x, y, state, copy,
    actions: bound,
  });
}

// MARK: Launch

function startUpdateCheck() {
  if (updateChecked) return;   // banner at most once per launch
  updateChecked = true;
  let slug = null;
  try { slug = require('./package.json').updateRepo || null; } catch { }
  if (!slug) return;
  checkForUpdate({ slug, currentVersion: app.getVersion() })
    .then((info) => { if (info && queue) queue.setBanner(info); })
    .catch(() => { });
}

app.whenReady().then(() => {
  settings = createSettings({
    file: path.join(app.getPath('userData'), 'settings.json'),
    downloadsDir: app.getPath('downloads'),
  });
  const engine = require('./main/engine');
  const sys = createSystemAdapter({
    electron: { shell, clipboard, Notification, powerSaveBlocker, BrowserWindow, app },
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  });
  queue = createQueue({ engine, settings, sys });
  queue.onChange(sendState);

  registerIpc({
    ipcMain, queue, settings, catalog, languages,
    actions: {
      browse, chooseDownloadFolder, runSetup, openReleasePage, rowMenu, openSettingsWindow,
    },
  });

  menus.installAppMenu({
    Menu, app, copy,
    actions: {
      addFiles: browse,
      focusLink,
      openSettings: openSettingsWindow,
      cancelSelected: () => queue.cancelSelected(),
      showWindow: showMainWindow,
    },
  });

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(windowBackground());
    }
  });

  createMainWindow();
  powerMonitor.on('resume', () => queue.handleWake());

  queue.probeDeps();
  for (const item of pendingOpens.splice(0)) deliverOpen(item);
  startUpdateCheck();
});
