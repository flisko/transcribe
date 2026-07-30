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
  Notification, powerSaveBlocker, powerMonitor, nativeTheme, session,
} = require('electron');

const copy = require('./shared/copy');
const catalog = require('./shared/catalog');
const languages = require('./shared/languages');
const { createQueue, createSystemAdapter } = require('./main/queue');
const { createSettings } = require('./main/settings');
const { checkForUpdateResult } = require('./main/update');
const { installUpdate } = require('./main/installer');
const menus = require('./main/menus');
const { registerIpc } = require('./main/ipc');
const { filterStartupArgs, resolveOpenArg } = require('./main/startup-args');
const { createInstagram } = require('./main/instagram');
const paths = require('./main/paths');
const relocate = require('./main/relocate');
const { ensureSetupScript } = require('./main/setup-script');

app.setName('Transcribe');

// Windows toasts (queue-finished notifications, C5) are dropped silently unless
// the process has an AppUserModelID. This app ships as a plain zip (no
// installer, no Start Menu shortcut carrying an AUMID), so main must set one
// itself, before any Notification is constructed. A stable reverse-DNS string —
// the same appId electron-builder stamps (C9) — is used rather than
// process.execPath so notification identity and taskbar grouping stay constant
// even when the user moves the portable folder.
if (process.platform === 'win32') app.setAppUserModelId('com.flisko.transcribe');

// One list, shared with the queue's dropped-folder scan, so the Browse… filter
// and what a dropped folder picks up can never drift apart.
const MEDIA_EXTS = [...require('./main/queue').MEDIA_EXTS];

let mainWindow = null;
let settingsWindow = null;
let queue = null;
let settings = null;
let instagram = null;
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
  app.on('second-instance', (_event, argv, workingDirectory) => {
    showMainWindow();
    // Windows: files/URLs arrive as argv of the second launch. Relative paths
    // are relative to the SECOND process's cwd (workingDirectory), not ours.
    // The second process ran the same binary we did, so its argv has the same
    // shape — packaged drops argv[0], dev drops argv[0]+the main script. (A
    // hardcoded `packaged: true` made `npm start` treat the dev launcher's "."
    // as a file to open, adding a bogus row for the app directory.)
    const args = filterStartupArgs(argv, { packaged: app.isPackaged })
      .map((a) => resolveOpenArg(a, workingDirectory));
    enqueueOpens(args);
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
  if (/^https?:\/\//i.test(item)) { queue.addLink(item); return; }
  // A FILE, not merely something that exists: dragging a folder onto the exe (or
  // a stray directory operand in argv) would otherwise enqueue a row that can
  // only fail with the engine's "not a file" error.
  let isFile = false;
  try { isFile = fs.statSync(item).isFile(); } catch { /* gone or unreadable */ }
  if (isFile) queue.addFiles([item]);
}

// MARK: Windows

// Navigation lock (backstop). A file/URL dropped on a page that doesn't
// preventDefault it makes Chromium navigate the privileged renderer to that
// target; because preload.js re-attaches on every load, the new page would
// inherit the `invoke('cmd', …)` IPC bridge. Both windows only ever load their
// own local file, so: block any navigation/redirect away from the current URL,
// and never open child windows internally — https links go to the OS browser,
// everything else is denied.
function hardenWindow(win) {
  const wc = win.webContents;
  wc.on('will-navigate', (event, url) => {
    if (url !== wc.getURL()) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (url !== wc.getURL()) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

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
  hardenWindow(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    sendStrings(mainWindow);
    sendState();
    // Once, and only after there is a window for the sheet to hang off — a
    // modal fired before first paint appears over a grey rectangle.
    if (!relocationChecked) {
      relocationChecked = true;
      setTimeout(maybeOfferRelocationAtStartup, 400);
    }
  });
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
  hardenWindow(settingsWindow);
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.webContents.on('did-finish-load', () => { sendStrings(settingsWindow); sendState(); });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Every plain-string entry of the copy table, in the UI language. The renderer
// cannot require shared/copy.js (contextIsolation), which is why its static text
// used to be a second, English-only copy hardcoded in the HTML. Functions are
// dropped: anything needing an argument is composed by main and arrives in the
// state snapshot instead.
function sendStrings(win) {
  if (!win || win.isDestroyed()) return;
  const strings = {};
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') strings[key] = value;
  }
  win.webContents.send('strings', strings);
}

function sendState() {
  if (!queue) return;
  const snap = queue.snapshot();
  // ONLY the app's own local-file windows — never the remote Instagram login
  // window, which must not receive the queue snapshot (local paths, settings).
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', snap);
  }
}

// The Instagram login window loads REMOTE content, so the strict hardenWindow
// (which forbids all navigation) can't apply — the login flow moves between
// instagram.com pages. Instead: allow only http(s) navigation, block every other
// scheme (file:, etc.), and never open child windows in-app (https → OS browser).
// It has no preload and is sandboxed, so it has no bridge to app IPC regardless.
function hardenLoginWindow(win) {
  const wc = win.webContents;
  const guard = (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
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

// Cleanup must finish before the process exits: on Windows the job's audio.wav
// can't be deleted while ffmpeg/whisper still hold it, so prepareForTermination
// awaits each child's death (taskkill close / group-kill) before removing the
// job dirs. will-quit is synchronous, so hold the quit, run the async cleanup,
// then quit for real — with a hard safety cap so a stuck kill never hangs quit.
let terminationDone = false;
app.on('will-quit', (event) => {
  if (terminationDone || !queue) return;
  event.preventDefault();
  const cleanup = Promise.resolve(queue.prepareForTermination({ waitMs: 3000 })).catch(() => { });
  // NOT unref'd. An unref'd timer does not hold the loop open, and this one has
  // to fire during a quit that has already been preventDefault'd — precisely
  // when there may be nothing else keeping the loop busy. Unref'd, the "hard
  // safety cap" could simply never arrive and the quit would hang forever, which
  // is the opposite of a safety cap.
  const safety = new Promise((resolve) => { setTimeout(resolve, 5000); });
  Promise.race([cleanup, safety]).finally(() => {
    terminationDone = true;
    app.quit();
  });
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

// ABSOLUTE System32 path, never the bare name: a bare 'cmd.exe' is resolved
// through the child search path, which on Windows includes the app's own
// directory and the cwd — both writable by the user, so a planted cmd.exe would
// run instead. Same exe-planting footgun engine.js avoids for taskkill and
// queue.js for whoami/icacls.
const CMD_EXE = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe')
  : 'cmd.exe';

// macOS: `shell.openPath('…/setup.command')` was doing NOTHING for a real user.
// It hands the file to LaunchServices' default handler, which silently fails
// whenever any of these hold — and for a folder unzipped from a release, at
// least one usually does:
//   • the script lost its executable bit (a plain `unzip`, a copy through
//     iCloud/Drive, or an editor rewriting it) — Terminal refuses to run it;
//   • the download carries com.apple.quarantine — Gatekeeper blocks the
//     unsigned script and the user never sees why;
//   • .command is bound to some other app (an editor) in LaunchServices.
// openPath's promise carries the reason, and it was being discarded.
//
// So: repair what we own (exec bit + the quarantine flag on OUR OWN sibling
// script — exactly the `xattr -dr` the README asks users to run by hand), then
// hand it to Terminal EXPLICITLY rather than trusting the file association. Only
// if all of that fails do we fall back to openPath, and a failure now tells the
// user instead of looking like a dead button.
// Run a short helper to completion. Never rejects — every one of these is
// best-effort repair, and its failure must not stop the next step.
function runQuietly(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore' });
    } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function openMacSetup(script) {
  try { fs.chmodSync(script, 0o755); } catch { /* not ours / read-only volume */ }
  // AWAIT the de-quarantine before opening — otherwise `open` races it and
  // Gatekeeper can still see the flag. `-d` exits non-zero when the attribute
  // isn't there, which is the normal case; the result is deliberately ignored.
  await runQuietly('/usr/bin/xattr', ['-d', 'com.apple.quarantine', script]);
  // -a Terminal, not the default handler: a .command bound to an editor (or to
  // nothing) is a common reason the button appeared to do nothing.
  return runQuietly('/usr/bin/open', ['-a', 'Terminal', script]);
}

function runSetup() {
  let root;
  try { root = paths.folderRoot(); } catch { return; }
  const isWin = process.platform === 'win32';

  // Three outcomes, not two. The setup entry point ships inside the bundle as
  // well as beside it, so a folder that merely LOST it gets it put back here and
  // setup runs as if nothing happened. What can't be repaired in place is a
  // folder macOS refuses to let us read (~/Downloads and friends) — for that the
  // answer is to leave, which offerRelocation does in one click.
  const found = ensureSetupScript({ root, resourcesPath: process.resourcesPath });
  if (found.status === 'blocked') {
    if (!offerRelocation({ trigger: 'setup' })) setupBlocked(root);
    return;
  }
  if (found.status !== 'present' && found.status !== 'restored') {
    if (!offerRelocation({ trigger: 'setup' })) setupNotFound(found.path);
    return;
  }
  const script = found.path;

  if (isWin) {
    try {
      const child = spawn(CMD_EXE, ['/c', 'start', '', script], { detached: true, stdio: 'ignore' });
      // A failed spawn arrives ASYNCHRONOUSLY as an 'error' event the try/catch
      // can't see; with no listener Node re-throws it as an uncaught exception
      // and the whole app dies the moment the user clicks Run Setup.
      child.on('error', () => setupLaunchFailed(script));
      child.unref();
    } catch { setupLaunchFailed(script); }
    return;
  }
  openMacSetup(script)
    .then((ok) => (ok ? null : shell.openPath(script)))
    .then((err) => { if (typeof err === 'string' && err) setupLaunchFailed(script); })
    .catch(() => setupLaunchFailed(script));
}

function setupDialog(message, detail, script) {
  const opts = {
    type: 'warning',
    buttons: [copy.setupLaunchFailedShow, copy.setupLaunchFailedOK],
    defaultId: 0,
    cancelId: 1,
    message,
    detail,
  };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  // "Show in Finder" on a path that doesn't exist reveals nothing; fall back to
  // the folder we were looking in, which is the thing the user needs to see.
  if (choice !== 0) return;
  if (fs.existsSync(script)) shell.showItemInFolder(script);
  else shell.openPath(path.dirname(script));
}

// A button that does nothing is the worst outcome; say what happened and give
// the one instruction that always works.
function setupLaunchFailed(script) {
  setupDialog(copy.setupLaunchFailedTitle, copy.setupLaunchFailedBody(script), script);
}

function setupNotFound(script) {
  setupDialog(copy.setupNotFoundTitle, copy.setupNotFoundBody(script), script);
}

// The file is almost certainly right there and macOS simply won't let us look.
// Only reached when relocation isn't on offer — otherwise the user gets the
// button that fixes it instead of an explanation.
function setupBlocked(root) {
  setupDialog(copy.setupBlockedTitle, copy.setupBlockedBody(root), root);
}

// ---------------------------------------------------------------- relocation
//
// macOS breaks a release folder kept in ~/Downloads two ways — App Translocation
// (a read-only randomized copy with no sibling files) and TCC (siblings there,
// every stat EPERM) — and both surface as "Transcribe can't find setup.command".
// See main/relocate.js. This is the one-click cure: move the folder somewhere
// that works, clear the download flag, put setup.command back, restart there.
// The user never opens Terminal and never types xattr.

let relocationInFlight = false;
let relocationChecked = false;

async function performRelocation(plan, target) {
  const bundleName = path.basename(relocate.appBundlePath(process.execPath));
  let appPath;
  if (plan.action === 'move-folder') {
    // A rename on the same volume: instant even with 4.6GB of models in there.
    relocate.moveFolder(plan.source, target);
    appPath = path.join(target, bundleName);
  } else {
    // Translocated or loose: there is no folder to move, only the bundle.
    appPath = await relocate.copyAppInto(plan.appPath, target);
  }
  // Both halves of what the README used to ask users to do by hand.
  await relocate.clearQuarantine(target);
  ensureSetupScript({ root: target, resourcesPath: process.resourcesPath });
  return appPath;
}

/// Returns true when a relocation was offered (so the caller shows nothing
/// else), false when this install has nowhere better to be.
function offerRelocation({ trigger }) {
  if (relocationInFlight) return true;
  let plan = null;
  try { plan = relocate.planRelocation(); } catch (_) { plan = null; }
  if (!plan) return false;

  const translocated = plan.reason === 'translocated';
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  // Resolved BEFORE the dialog: a name collision picks "Transcribe 2", and a
  // dialog that named the colliding path would be promising somewhere the app
  // is not about to go.
  const target = relocate.chooseFreeTarget(path.dirname(plan.target), path.basename(plan.target));
  const opts = {
    type: 'warning',
    buttons: [copy.relocateMove, copy.relocateNotNow],
    defaultId: 0,
    cancelId: 1,
    message: translocated ? copy.relocateTranslocatedTitle : copy.relocateTitle(plan.folder),
    detail: translocated
      ? copy.relocateTranslocatedBody(target)
      : copy.relocateBody(plan.folder, target),
  };
  const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
  if (choice !== 0) {
    // Only a startup nag is dismissible. A user who clicked Run Setup and got
    // here has an install that is broken right now, and will be asked again.
    if (trigger === 'startup' && settings) {
      settings.set('relocateDismissedFor', plan.source || plan.appPath);
    }
    return true;
  }

  relocationInFlight = true;
  performRelocation(plan, target)
    .then((appPath) => {
      spawn('/bin/bash', ['-c', relocate.relaunchScript(process.pid, appPath)],
        { detached: true, stdio: 'ignore' }).unref();
      quitApproved = true;
      app.quit();
      // BACKSTOP, and not a theoretical one: observed in the v1.0.23 flow test.
      // The helper waits on THIS pid before it opens the new copy, so a quit
      // that gets held up leaves the user staring at an apparently unchanged
      // window while the move silently never finishes — the same "the button did
      // nothing" failure this whole change exists to remove. will-quit holds the
      // quit for async cleanup; if anything in there stalls, leave anyway.
      // Safe here specifically because relocation is offered at startup, with no
      // transcription running and nothing to clean up.
      setTimeout(() => app.exit(0), 4000);
    })
    .catch((e) => {
      relocationInFlight = false;
      const reason = (e && e.message) ? String(e.message) : String(e);
      dialog.showMessageBoxSync(win || undefined, {
        type: 'error',
        buttons: [copy.setupLaunchFailedOK],
        message: copy.relocateFailedTitle,
        detail: copy.relocateFailedBody(target, reason),
      });
    });
  return true;
}

function maybeOfferRelocationAtStartup() {
  let plan = null;
  try { plan = relocate.planRelocation(); } catch (_) { return; }
  if (!plan) return;
  // Translocation is always broken, and a folder we can't read is broken right
  // now — offer the cure however many times it takes. A protected folder that
  // happens to work today is only worth asking about once.
  const brokenNow = plan.reason === 'translocated' || paths.folderMarkerStatus() !== 'present';
  const key = plan.source || plan.appPath;
  if (!brokenNow && settings && settings.get('relocateDismissedFor') === key) return;
  offerRelocation({ trigger: 'startup' });
}

function openReleasePage() {
  const url = queue && queue.getUpdateUrl();
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
}

// One click: fetch the release zip for this platform, merge it over the install
// folder, restart. The install folder is the right target precisely because the
// zip carries only app files — models/ and tools/ are never in it, so a 4.6 GB
// download survives an update untouched.
//
// Falls back to the release page whenever it cannot do that: a release with no
// asset for this OS, a folder the user can't write to, a download that failed.
// Nothing on disk is touched until the new version is downloaded, size-checked
// and verified to contain Transcribe, so every failure leaves a working app.
let installInFlight = false;

function beginInstallUpdate() {
  if (!queue) return;
  const asset = queue.getUpdateAsset();
  if (!asset) { openReleasePage(); return; }   // nothing installable — hand over the page
  if (installInFlight) return;
  installInFlight = true;
  queue.setUpdateState({ installing: true, installPct: 0, installError: null });

  let folderRoot = null;
  try { folderRoot = require('./main/paths').folderRoot(); } catch { /* reported below */ }

  installUpdate({
    asset,
    folderRoot,
    onProgress: (pct) => { if (queue) queue.setUpdateState({ installPct: pct }); },
    // Past the download there is no percentage to show, so the status switches
    // to the "restarting in a moment" sentence.
    onStage: (stage) => { if (queue) queue.setUpdateState({ installPct: stage === 'installing' ? null : 0 }); },
    quit: () => { quitApproved = true; app.quit(); },
  }).catch((e) => {
    installInFlight = false;
    if (!queue) return;
    // A read-only folder has a different cure than a failed download, and saying
    // "opening the download page" to someone whose real problem is where the app
    // lives would just repeat the failure.
    const readOnly = !!(e && e.readOnly);
    queue.setUpdateState({
      installing: false,
      installPct: null,
      installError: readOnly ? copy.updateFolderReadOnly : copy.updateInstallFailed,
    });
    if (!readOnly) openReleasePage();
  });
}

// MARK: Instagram (in-app login → transient yt-dlp cookies; see main/instagram.js)

function instagramDialog(message, detail) {
  const opts = { type: 'info', buttons: ['OK'], defaultId: 0, message, detail };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (win) dialog.showMessageBox(win, opts); else dialog.showMessageBox(opts);
}

function connectInstagram() {
  if (!instagram) return;
  Promise.resolve(instagram.login())
    .then(() => instagram.isConnected())
    .then((ok) => instagramDialog(
      ok ? copy.instagramConnectedTitle : copy.instagramNotConnectedTitle,
      ok ? copy.instagramConnectedBody : copy.instagramNotConnectedBody))
    .catch(() => { });
}

function disconnectInstagram() {
  if (!instagram) return;
  Promise.resolve(instagram.logout())
    .then(() => instagramDialog(copy.instagramDisconnectedTitle, copy.instagramDisconnectedBody))
    .catch(() => { });
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

function updateSlug() {
  try { return require('./package.json').updateRepo || null; } catch { return null; }
}

let updateInFlight = false;

// One code path for both the automatic launch check and the Settings ▸ Check Now
// button. `manual` only decides whether the once-per-launch guard and the
// auto-check preference apply — pressing the button always checks.
function runUpdateCheck({ manual }) {
  if (!queue) return;
  const slug = updateSlug();
  if (!slug) { queue.setUpdateState({ supported: false, checking: false }); return; }
  queue.setUpdateState({ supported: true });
  if (updateInFlight) return;
  if (!manual) {
    if (updateChecked) return;                            // banner at most once per launch
    if (!settings.get('autoCheckUpdates')) return;        // user turned the check off
    updateChecked = true;
  }
  updateInFlight = true;
  queue.setUpdateState({ checking: true });
  checkForUpdateResult({ slug, currentVersion: app.getVersion() })
    .then((r) => {
      updateInFlight = false;
      if (!queue) return;
      queue.setUpdateState({
        checking: false,
        result: r.status === 'off' ? 'failed' : r.status,
        reason: r.reason || null,
        latestVersion: r.version,
        url: r.url,
        asset: r.asset || null,
        installError: null,
      });
      // The banner is the automatic, dismissible notice; a manual check raises
      // it too, so the main window agrees with what Settings just said.
      // (Lowering it again when a later check finds we're current is the queue's
      // job — setUpdateState owns that invariant, so no caller can forget it.)
      if (r.status === 'available') queue.setBanner({ version: r.version, url: r.url });
    })
    .catch(() => {
      updateInFlight = false;
      if (queue) queue.setUpdateState({ checking: false, result: 'failed', reason: 'network' });
    });
}

app.whenReady().then(() => {
  // A SECOND instance still reaches whenReady: app.quit() above is asynchronous
  // and this handler is registered unconditionally. Without this guard the
  // losing process builds a whole queue — and its constructor sweeps the job
  // base and the download folder's staging dirs, which belong to the FIRST,
  // still-running instance. Launching the app twice mid-download would delete
  // the live download out from under it. Nothing after this line may run in a
  // process that does not own the single-instance lock.
  if (!gotLock) return;

  settings = createSettings({
    file: path.join(app.getPath('userData'), 'settings.json'),
    downloadsDir: app.getPath('downloads'),
  });
  const engine = require('./main/engine');
  instagram = createInstagram({
    session, BrowserWindow,
    getParent: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    hardenLoginWindow,
  });
  const sys = createSystemAdapter({
    electron: { shell, clipboard, Notification, powerSaveBlocker, BrowserWindow, app },
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    instagramCookies: (url) => instagram.cookiesForUrl(url),
  });
  queue = createQueue({ engine, settings, sys, appVersion: app.getVersion() });
  queue.onChange(sendState);

  registerIpc({
    ipcMain, queue, settings, catalog, languages,
    actions: {
      browse, chooseDownloadFolder, runSetup, openReleasePage, rowMenu, openSettingsWindow,
      checkForUpdates: () => runUpdateCheck({ manual: true }),
      installUpdate: beginInstallUpdate,
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
      connectInstagram, disconnectInstagram,
      // Open Settings first so the result of the check is on screen when it
      // lands, then check.
      checkForUpdates: () => { openSettingsWindow(); runUpdateCheck({ manual: true }); },
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
  // Windows: files/URLs from 'Open with' or drag-onto-exe when the app was NOT
  // already running arrive only in this first process's argv — there is no
  // open-file event as on mac. Resolve relative paths against our own cwd (the
  // launching shell's cwd for a first launch) and feed the same enqueue path.
  if (process.platform === 'win32') {
    const args = filterStartupArgs(process.argv, { packaged: app.isPackaged })
      .map((a) => resolveOpenArg(a, process.cwd()));
    enqueueOpens(args);
  }
  for (const item of pendingOpens.splice(0)) deliverOpen(item);
  runUpdateCheck({ manual: false });
});
