// main/queue.js — port of app/AppModel.swift: dependency state, the queue, the
// two work lanes (one transcription + one download, in parallel), banner state,
// notifications, badge/progress, and sleep suppression. Main process computes
// ALL user-visible text (C4); the renderer only paints snapshots.
//
// Injection seams (unit tests run under plain node, no Electron):
// - `engine` (required): C3 module API. transcribe/dlInfo/dlGet return a
//   Promise augmented with .cancel() (kills the process tree; the promise then
//   rejects). probeDeps() is synchronous.
// - `sys`: system adapter (createSystemAdapter below) — the only place that
//   touches Electron shell/clipboard/Notification/window APIs.
// - `copy`/`catalog`/`languages`/`logic`/`modelPresent`: default to the shared
//   modules; tests inject stubs so nothing outside this file loads.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Spec-pinned durations (ms): dup-flash 0.4 s, copied 2 s, action note 4 s,
// lookup watchdog 60 s. Tests inject smaller values.
const DELAYS = Object.freeze({ flash: 400, copied: 2000, note: 4000, lookupWatchdog: 60000 });

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg',
                            'opus', 'wma', 'aiff', 'aif', 'caf']);

// Everything ffmpeg can read the sound out of. Shared with main.js so the file
// dialog's filter and the dropped-folder scan can never drift apart.
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv',
                            'mts', 'm2ts', '3gp', 'mpg', 'mpeg', 'ts']);
const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);

const ACTIVE_STATES = new Set(['lookingUp', 'downloading', 'preparing', 'transcribing']);
const FINISHED_STATES = new Set(['done', 'failed', 'canceled']);

function isActive(state) { return ACTIVE_STATES.has(state); }
function isUnfinished(state) { return state === 'waiting' || isActive(state); }
function isFinished(state) { return FINISHED_STATES.has(state); }

// Stem from the last path component only — "videos v2.0/clip" must not become
// "videos v2.txt" (the engine had this exact latent bug).
function outputPaths(input) {
  const dir = path.dirname(input);
  const base = path.basename(input);
  const ext = path.extname(base);
  let stem = ext ? base.slice(0, -ext.length) : base;
  if (!stem) stem = base;
  return { txt: path.join(dir, stem + '.txt'), srt: path.join(dir, stem + '.srt') };
}

// whisper-cli.exe reads argv (the -f wav and -of output it gets from the job
// workDir) through the ANSI codepage, so a scratch dir under a non-ASCII %TEMP%
// — a non-ASCII Windows profile like C:\Users\Žiga\AppData\Local\Temp — makes it
// crash or lose the wav (measured on real Windows). Root the job dirs at an ASCII
// base in that case: %ProgramData% is ASCII and standard users may create subdirs
// there; namespace by an ASCII hash of the username so co-existing users neither
// collide nor sweep each other's job dirs. ASCII profiles (the vast majority, and
// every non-Windows host) keep the exact per-user %TEMP% location as before.
// Pure + fully injectable so the win/mac × ascii/non-ascii matrix unit-tests from
// any host.
function chooseJobBase({ platform, tmpdir, programData, username }) {
  const NAME = 'com.flisko.transcribe';
  const isAscii = (s) => /^[\x00-\x7F]*$/.test(String(s == null ? '' : s));
  const tmpBase = path.join(String(tmpdir == null ? '' : tmpdir), NAME);
  if (platform !== 'win32' || isAscii(tmpdir)) return tmpBase;
  if (programData && isAscii(programData)) {
    const tag = crypto.createHash('sha256').update(String(username == null ? '' : username)).digest('hex').slice(0, 12);
    return path.join(String(programData), NAME, tag);
  }
  return tmpBase; // no ASCII base available — unchanged (still hard for non-ASCII users, but no regression)
}

// %ProgramData% is world-readable by default (an inheritable BUILTIN\Users:(RX)
// ACE), so a job tree there would let every local account read one user's staged
// audio.wav and transcript — a privacy regression from the per-user %TEMP% it
// replaces. Lock the base to the current user + SYSTEM + Administrators (by SID,
// which is ASCII and locale-independent — a non-ASCII account NAME can't be
// resolved reliably), stripping the inherited Users read. Best-effort; the caller
// falls back to %TEMP% when this can't be done rather than write world-readable
// private data. win32-only; a no-op everywhere else.
function hardenWindowsDir(dir) {
  if (process.platform !== 'win32') return false;
  // ABSOLUTE System32 paths, never the bare names: on a machine where another
  // 'whoami'/'icacls' shadows System32 on PATH (Git for Windows ships a GNU
  // whoami, for one) the bare name resolves to the wrong tool and hardening
  // silently fails — the same footgun setup.ps1 avoids for curl.exe.
  const sys32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  const whoamiExe = path.join(sys32, 'whoami.exe');
  const icaclsExe = path.join(sys32, 'icacls.exe');
  let sid = '';
  try {
    const out = execFileSync(whoamiExe, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000 }).toString();
    const m = out.match(/S-1-[0-9-]+/);
    if (m) sid = m[0];
  } catch (_) { /* whoami unavailable — can't harden */ }
  if (!sid) return false;
  try {
    execFileSync(icaclsExe, [
      dir, '/inheritance:r',
      '/grant:r', `*${sid}:(OI)(CI)F`,
      '/grant:r', '*S-1-5-18:(OI)(CI)F',     // SYSTEM
      '/grant:r', '*S-1-5-32-544:(OI)(CI)F', // Administrators
    ], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

// MARK: System adapter

// TEST HOOK (pinned): with env TRANSCRIBE_TEST_LOG set, side-effecting calls
// (shell.openPath / shell.showItemInFolder / clipboard.writeText /
// Notification fire) are NOT executed — a JSON line {action, arg, ts} is
// appended to that file instead so Playwright can verify row actions.
function createSystemAdapter(opts = {}) {
  const env = opts.env || process.env;
  const electron = opts.electron || null;
  const getWindow = opts.getWindow || (() => null);
  // Async provider (url -> Netscape cookie content | null) for authenticated
  // sites (Instagram). Defaults to "no cookies", so downloads work unchanged
  // until a login is connected. Only ever invoked by the engine, per download.
  const instagramCookies = opts.instagramCookies || (async () => null);
  let blockerId = null;

  function testLog(action, arg) {
    const file = env.TRANSCRIBE_TEST_LOG;
    if (!file) return false;
    try {
      fs.appendFileSync(file, JSON.stringify({ action, arg, ts: Date.now() }) + '\n');
    } catch { /* logging must never break the action path */ }
    return true;
  }

  return {
    openPath(p) {
      if (testLog('openPath', p)) return;
      if (electron && electron.shell) electron.shell.openPath(p);
    },
    showItemInFolder(p) {
      if (testLog('showItemInFolder', p)) return;
      if (electron && electron.shell) electron.shell.showItemInFolder(p);
    },
    copyText(text) {
      if (testLog('copyText', text)) return;
      if (electron && electron.clipboard) electron.clipboard.writeText(text);
    },
    notify(title, body) {
      if (testLog('notify', { title, body })) return;
      if (!electron || !electron.Notification || !electron.Notification.isSupported()) return;
      new electron.Notification({ title, body }).show();
    },
    isWindowFocused() {
      if (!electron || !electron.BrowserWindow) return false;
      return electron.BrowserWindow.getFocusedWindow() != null;
    },
    setProgressBar(v) {
      const win = getWindow();
      if (!win || win.isDestroyed()) return;
      if (v > 1) {
        // Indeterminate is Windows-only; macOS dock gets an empty bar instead
        // of a bogus 100%.
        if (process.platform === 'win32') win.setProgressBar(2, { mode: 'indeterminate' });
        else win.setProgressBar(0);
      } else {
        win.setProgressBar(v);
      }
    },
    setBadge(text) {
      if (process.platform !== 'darwin') return;
      if (electron && electron.app && electron.app.dock) electron.app.dock.setBadge(text || '');
    },
    startPowerBlocker() {
      if (blockerId != null || !electron || !electron.powerSaveBlocker) return;
      blockerId = electron.powerSaveBlocker.start('prevent-app-suspension');
    },
    stopPowerBlocker() {
      if (blockerId == null || !electron || !electron.powerSaveBlocker) return;
      if (electron.powerSaveBlocker.isStarted(blockerId)) electron.powerSaveBlocker.stop(blockerId);
      blockerId = null;
    },
    instagramCookies,
  };
}

// MARK: Queue

function createQueue(opts) {
  const engine = opts.engine;
  const settings = opts.settings;
  const sys = opts.sys || createSystemAdapter({});
  const copy = opts.copy || require('../shared/copy');
  const catalog = opts.catalog || require('../shared/catalog');
  const languages = opts.languages || require('../shared/languages');
  const logic = opts.logic || require('../shared/logic');
  const delays = { ...DELAYS, ...(opts.delays || {}) };
  const now = opts.now || Date.now;

  // Model presence is size > minBytes from the catalog (C2), resolved through
  // engine/paths — injectable so tests never stat real model files.
  const modelPresent = opts.modelPresent || ((sel) => {
    if (typeof engine.modelPresent === 'function') return engine.modelPresent(sel);
    const m = catalog.by(sel);
    try {
      const paths = require('./paths');
      return fs.statSync(paths.modelPath(m.fileName)).size > m.minBytes;
    } catch { return false; }
  });

  let phase = 'checking';
  let deps = {};
  let items = [];
  let selection = null;
  let flashId = null;
  let banner = null;
  // Settings ▸ Updates. `banner` is the dismissible top-of-window notice; this is
  // the persistent panel, which must keep saying "a new version exists" after the
  // banner has been dismissed, and has to distinguish "checked, we're current"
  // from "couldn't check". main.js drives it (it owns the network call and the
  // app version); the queue only stores it and composes the sentence.
  const appVersion = opts.appVersion || null;
  let update = {
    supported: false, checking: false, result: null, reason: null,
    latestVersion: null, url: null,
    asset: null,          // the zip for this platform, when the release has one
    installing: false,    // download/install in flight
    installPct: null,     // 0-100 while downloading
    installError: null,   // a composed sentence, shown in place of the status
  };

  let transcribingID = null;
  let downloadingID = null;
  const jobs = new Map();       // id -> engine promise handle (identity ties callbacks to THIS run)
  const watchdogs = new Map();  // id -> lookup watchdog timer
  const jobDirs = new Map();    // id -> per-job scratch dir (transcribe workDir)
  let retryCounter = 0;
  const watchdogKilledLookup = new Set();
  let wasWorking = false;
  let powerBlocking = false;
  let sessionDone = 0;
  let sessionFailed = 0;
  let sessionLastTxtName = null;
  let sessionLastFailedName = null;

  const listeners = [];

  // ASCII scratch root when the Windows profile name is non-ASCII (see
  // chooseJobBase). If the chosen ASCII base can't be created (locked-down
  // %ProgramData%), fall back to %TEMP% — no worse than before.
  const tmpBase = path.join(os.tmpdir(), 'com.flisko.transcribe');
  let username = '';
  try { username = os.userInfo().username; } catch { /* keep '' */ }
  let jobBase = chooseJobBase({
    platform: process.platform,
    tmpdir: os.tmpdir(),
    programData: process.env.ProgramData,
    username,
  });
  if (jobBase !== tmpBase) {
    // The ASCII %ProgramData% base is world-readable and never OS-reclaimed by
    // default, so create it AND lock it to this user; if either step fails, fall
    // back to the private per-user %TEMP% base rather than leave scratch exposed.
    let ok = false;
    try { fs.mkdirSync(jobBase, { recursive: true }); ok = hardenWindowsDir(jobBase); } catch { ok = false; }
    if (!ok) jobBase = tmpBase;
  }
  // Sweep job dirs orphaned by a prior crash / force-kill / OS reboot, when
  // neither cleanupJob nor the quit-time rmrf(jobBase) got to run. Safe: the app
  // is single-instance (requestSingleInstanceLock), so nothing here is live, and
  // job dirs hold only disposable scratch (audio.wav, out.*, a model hardlink — no
  // resume data). Essential for the %ProgramData% base, which the OS never
  // reclaims; a bonus for %TEMP%. Run SYNCHRONOUSLY at construction — before any
  // makeJobDir can add a live dir (an open-with launch calls addFiles inside the
  // same whenReady tick) — using the hoisted rmrf. Best-effort; a locked leftover
  // just waits for the next run.
  try { for (const n of fs.readdirSync(jobBase)) rmrf(path.join(jobBase, n)); } catch { /* base absent — nothing to sweep */ }
  // Same reclaim for the DOWNLOAD side. dlGet stages into
  // `<downloadFolder>/.transcribe-dl.<pid>.<n>` and removes it in a finally, so
  // a normal finish/cancel/failure never leaks. A crash, force-kill, or power
  // loss skips that finally and strands a half-downloaded video in the user's
  // Downloads folder forever.
  //
  // DEFERRED, unlike the job-dir sweep above, and not for tidiness: this one
  // reads the user's download folder, which on macOS defaults to ~/Downloads —
  // a TCC-protected location. Doing it at construction meant merely launching the
  // app raised "Transcribe would like to access files in your Downloads folder"
  // before the user had asked for anything, and a "Don't Allow" there silently
  // breaks every later download. So it happens at the first download instead,
  // where touching that folder is precisely what the user just asked for.
  //
  // Once per launch, before the first download starts: the app is single-instance
  // and nothing of ours is downloading yet, so every .transcribe-dl.* found is
  // certainly stale. Sweeping again later could delete a live staging dir.
  let downloadStagingSwept = false;
  function sweepStaleDownloadStaging() {
    if (downloadStagingSwept) return;
    downloadStagingSwept = true;
    try {
      const dest = settings.downloadFolder();
      for (const n of fs.readdirSync(dest)) {
        if (n.startsWith('.transcribe-dl.')) rmrf(path.join(dest, n));
      }
    } catch { /* folder gone or unreadable — nothing to sweep */ }
  }

  function byId(id) { return items.find((it) => it.id === id) || null; }
  function indexOf(id) { return items.findIndex((it) => it.id === id); }

  function inputFile(it) {
    return it.source.type === 'file' ? it.source.path : it.downloadedFile;
  }

  function changed() {
    const snap = snapshot();
    for (const cb of listeners) cb(snap);
  }

  function later(ms, fn) {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  }

  function makeJobDir() {
    // Never shared between jobs — two engines writing one dir would collide.
    const dir = path.join(jobBase, crypto.randomUUID());
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    return dir;
  }

  function rmrf(p) {
    // maxRetries/retryDelay matters on Windows: cancel()/quit fire taskkill
    // ASYNCHRONOUSLY, so a just-killed whisper/ffmpeg can still hold
    // workDir/audio.wav for a beat when this runs — a plain rmSync would hit
    // EPERM/EBUSY on the locked wav, abort, and leak the job dir under %TEMP%.
    // Node retries the unlink on those codes; a no-op cushion on macOS, where
    // SIGKILL releases handles synchronously. (Mirrors engine.removeDirWithRetry.)
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch { }
  }

  // One engine run as a cancelable handle. The real engine surfaces children
  // via onChild and is killed with engine.killTree; stub engines may instead
  // return a Promise carrying its own .cancel(). Handle identity ties every
  // callback to THIS run — a later attempt for the same item is a new handle.
  function startEngineJob(invoke) {
    const children = [];
    const promise = invoke((child) => children.push(child));
    return {
      promise,
      cancel() {
        if (promise && typeof promise.cancel === 'function') { promise.cancel(); return; }
        if (typeof engine.killTree === 'function') {
          for (const c of children) engine.killTree(c);
        }
      },
      // Quit path: kill AND await each child's death (win: taskkill close;
      // mac: process-group TERM→KILL) so the job dir can be removed without
      // racing a still-open audio.wav that Windows refuses to unlink.
      async cancelAndWait(timeoutMs) {
        if (promise && typeof promise.cancel === 'function') promise.cancel();
        if (typeof engine.killTreeAndWait === 'function') {
          await Promise.all(children.map((c) =>
            Promise.resolve(engine.killTreeAndWait(c, timeoutMs)).catch(() => { })));
        } else if (typeof engine.killTree === 'function') {
          for (const c of children) engine.killTree(c);
        }
      },
    };
  }

  function newItem(source, title) {
    return {
      id: crypto.randomUUID(),
      source,
      title,
      state: 'waiting',
      // Captured at START (not enqueue) — changing quick settings mid-queue
      // affects every item that hasn't begun yet.
      capturedModel: null,
      capturedLanguage: null,
      capturedKeepVideo: false,
      destFolder: null,
      downloadedFile: null,
      startedAt: null,
      stageStartedAt: null,
      progressPct: null,
      etaText: null,
      estimator: new logic.EtaSmoother(),
      afterSleep: false,
      errorMessage: null,
      errorDetails: null,
      doneNote: null,
      copiedFlash: false,
      actionNote: null,
      finishedAt: null,
      txtPath: null,
      srtPath: null,
      retryPriority: null,
    };
  }

  // MARK: Dependency probing

  function probeDeps() {
    let result;
    try { result = engine.probeDeps(); } catch { result = { setupNeeded: true }; }
    deps = result || { setupNeeded: true };
    const newPhase = deps.setupNeeded ? 'setup' : 'ready';
    if (newPhase !== phase) {
      phase = newPhase;
      if (newPhase === 'ready') pump();
    }
    changed();
  }

  // MARK: Adding work

  // Dropping a FOLDER of lectures is the first thing people try with a batch,
  // and it used to make one row that failed with "the file can't be found any
  // more" — a message that is not merely unhelpful but false, since the folder is
  // right there. Expand it into the media files it holds, in name order. One
  // level only: predictable, and it matches what "drop this folder" means to a
  // person who has a folder of recordings, not a tree of them.
  function expandFolders(list) {
    const out = [];
    for (const raw of list) {
      let st = null;
      try { st = fs.statSync(raw); } catch { /* gone — let addFiles report it */ }
      if (!st || !st.isDirectory()) { out.push(raw); continue; }
      let names = [];
      try { names = fs.readdirSync(raw).sort((a, b) => a.localeCompare(b)); } catch { }
      for (const name of names) {
        // Skip dotfiles. On macOS, copying to a FAT/exFAT volume (a USB stick,
        // an SD card off a camera — exactly where a folder of recordings comes
        // from) leaves an AppleDouble "._clip.mp4" beside every real file: a few
        // KB of metadata that passes the extension test and would enqueue a row
        // that can only fail. Nothing a user means to transcribe starts with a dot.
        if (name.startsWith('.')) continue;
        if (!MEDIA_EXTS.has(path.extname(name).slice(1).toLowerCase())) continue;
        const p = path.join(raw, name);
        try { if (fs.statSync(p).isFile()) out.push(p); } catch { }
      }
    }
    return out;
  }

  function addFiles(paths) {
    if (phase !== 'ready') return;
    for (const raw of expandFolders(Array.isArray(paths) ? paths : [])) {
      if (typeof raw !== 'string' || !raw) continue;
      let p;
      try { p = fs.realpathSync(raw); } catch { p = path.resolve(raw); }
      const dup = items.find((it) => it.source.type === 'file' && it.source.path === p
                                     && isUnfinished(it.state));
      if (dup) { flash(dup.id); continue; }
      items.push(newItem({ type: 'file', path: p }, path.basename(p)));
    }
    pump();
    changed();
  }

  /// false when the text doesn't look like a link (renderer shows the inline error).
  function addLink(text) {
    if (phase !== 'ready') return false;
    const trimmed = String(text == null ? '' : text).trim();
    if (!logic.looksLikeWebLink(trimmed)) return false;
    const dup = items.find((it) => it.source.type === 'link' && it.source.url === trimmed
                                   && isUnfinished(it.state));
    if (dup) { flash(dup.id); return true; }
    let display = trimmed;
    try {
      const u = new URL(trimmed);
      display = (u.host || '') + u.pathname;
    } catch { }
    items.push(newItem({ type: 'link', url: trimmed }, display));
    pump();
    changed();
    return true;
  }

  function flash(id) {
    // Broadcast the flash immediately (mirrors @Published flashID auto-render
    // in AppModel.swift). Callers that don't otherwise end in changed() — the
    // addLink dup path — depend on this; without it a duplicate add sets flashId
    // but the renderer never sees a flash:true snapshot, only the later clear.
    flashId = id;
    changed();
    later(delays.flash, () => {
      if (flashId === id) { flashId = null; changed(); }
    });
  }

  // MARK: Scheduler — one transcription lane + one download lane, queue order

  function pump() {
    try {
      if (phase !== 'ready') return;
      if (transcribingID == null) {
        const next = eligible((it) => it.source.type !== 'link' || it.downloadedFile != null);
        if (next) beginTranscription(next.id);
      }
      if (downloadingID == null) {
        const next = eligible((it) => it.source.type === 'link' && it.downloadedFile == null);
        if (next) beginDownload(next.id);
      }
    } finally {
      updateWorkSideEffects();
    }
  }

  function eligible(pred) {
    // Retried items go to the front of the waiting line, oldest retry first.
    const candidates = items.filter((it) => it.state === 'waiting' && pred(it));
    const prioritized = candidates.filter((it) => it.retryPriority != null)
      .sort((a, b) => a.retryPriority - b.retryPriority)[0];
    return prioritized || candidates[0] || null;
  }

  // MARK: Transcription lane

  function beginTranscription(id) {
    const it = byId(id);
    if (!it) return;
    transcribingID = id;

    if (it.capturedModel == null) {
      it.capturedModel = settings.get('model');
      it.capturedLanguage = settings.get('language');
    }
    if (it.startedAt == null) it.startedAt = now();
    it.stageStartedAt = now();
    it.estimator.reset();
    it.etaText = null;
    it.progressPct = null;

    const input = inputFile(it);
    if (!input) { finishItem(id, copy.failTranscription, null); return; }
    if (!fs.existsSync(input)) {
      finishItem(id, copy.failFileMissing(path.basename(input)), null);
      return;
    }
    let size = 0;
    try { size = fs.statSync(input).size; } catch { }
    if (!(size > 0)) {
      finishItem(id, copy.failZeroLength(path.basename(input)), null);
      return;
    }
    let writable = true;
    try { fs.accessSync(path.dirname(input), fs.constants.W_OK); } catch { writable = false; }
    if (!writable) {
      finishItem(id, copy.failOutputDirReadOnly(path.basename(input)), null);
      return;
    }
    const modelSel = it.capturedModel || 'best';
    if (!modelPresent(modelSel)) {
      finishItem(id, copy.failModelMissing(catalog.by(modelSel).display), null);
      return;
    }

    it.state = 'preparing';

    const dir = makeJobDir();
    jobDirs.set(id, dir);

    let handle;
    try {
      handle = startEngineJob((onChild) => engine.transcribe({
        input,
        modelSel,
        lang: it.capturedLanguage || 'hr',
        workDir: dir,
        onChild,
        onProgress: (pct) => transcriptionProgress(id, handle, pct),
      }));
    } catch (e) {
      cleanupJob(id);
      transcribingID = null;
      finishItem(id, (e && e.message) || copy.failEngineMissing,
                 (e && e.details) || String((e && e.message) || e));
      return;
    }
    jobs.set(id, handle);
    handle.promise.then(
      (res) => transcriptionSettled(id, handle, null, res),
      (err) => transcriptionSettled(id, handle, err || {}, null),
    );
  }

  function transcriptionProgress(id, handle, pct) {
    if (handle !== undefined && jobs.get(id) !== handle) return;
    const it = byId(id);
    if (!it || (it.state !== 'preparing' && it.state !== 'transcribing')) return;
    if (!(pct >= 1)) return;   // 0% baseline = still extracting audio
    it.state = 'transcribing';
    it.progressPct = Math.min(100, Math.max(0, Math.round(pct)));
    const eta = it.estimator.update(it.progressPct, now() / 1000);
    if (eta != null) it.afterSleep = false;
    it.etaText = eta == null ? null : eta;
    changed();
  }

  function transcriptionSettled(id, handle, err, res) {
    // A cancel/retry already replaced or removed this job — its late settle
    // must not touch the item (the watchdog-tied-to-job hardening).
    if (jobs.get(id) !== handle) { pump(); changed(); return; }
    cleanupJob(id);
    if (transcribingID === id) transcribingID = null;
    const it = byId(id);
    if (!it || (it.state !== 'preparing' && it.state !== 'transcribing')) { pump(); changed(); return; }

    if (!err && res && res.txt) {
      it.txtPath = res.txt;
      it.srtPath = res.srt || null;
      it.finishedAt = now();
      it.progressPct = 100;
      let content = '';
      try { content = fs.readFileSync(res.txt, 'utf8'); } catch { }
      if (content.trim() === '') it.doneNote = copy.noSpeechNote(it.title);
      it.state = 'done';
      sessionDone += 1;
      sessionLastTxtName = path.basename(res.txt);
      pump();
      changed();
    } else {
      finishItem(id, (err && err.message) || copy.failTranscription,
                 (err && err.details) || null);
    }
  }

  // MARK: Download lane

  function beginDownload(id) {
    const it = byId(id);
    if (!it || it.source.type !== 'link') return;
    const url = it.source.url;
    downloadingID = id;

    it.capturedModel = settings.get('model');
    it.capturedLanguage = settings.get('language');
    it.capturedKeepVideo = !!settings.get('keepVideo');
    // Before destFolder is read, so the folder is touched once, here, rather than
    // at launch (see sweepStaleDownloadStaging).
    sweepStaleDownloadStaging();
    it.destFolder = settings.downloadFolder();
    if (it.startedAt == null) it.startedAt = now();
    it.stageStartedAt = now();
    it.state = 'lookingUp';

    let handle;
    try {
      handle = startEngineJob((onChild) => engine.dlInfo(url, { onChild, cookies: sys.instagramCookies }));
    } catch (e) {
      cleanupJob(id);
      downloadingID = null;
      finishItem(id, (e && e.message) || copy.failYtDlpMissing,
                 (e && e.details) || String((e && e.message) || e));
      return;
    }
    jobs.set(id, handle);
    // The engine timeout-guards its own metadata fetch; this watchdog only
    // covers a hung yt-dlp that never returns at all. It guards THIS job
    // instance — a later attempt's fresh lookup for the same item must not be
    // killed by a stale timer.
    watchdogs.set(id, later(delays.lookupWatchdog, () => {
      if (jobs.get(id) !== handle) return;
      const cur = byId(id);
      if (!cur || cur.state !== 'lookingUp') return;
      watchdogKilledLookup.add(id);
      handle.cancel();
    }));
    handle.promise.then(
      (info) => lookupSettled(id, handle, url, null, info),
      (err) => lookupSettled(id, handle, url, err || {}, null),
    );
  }

  function lookupSettled(id, handle, url, err, info) {
    if (jobs.get(id) !== handle) { pump(); changed(); return; }
    cleanupJob(id);
    const killedByWatchdog = watchdogKilledLookup.delete(id);
    const it = byId(id);
    if (!it || it.state !== 'lookingUp') {
      if (downloadingID === id) downloadingID = null;
      pump();
      changed();
      return;
    }
    if (err || !info) {
      downloadingID = null;
      // A watchdog kill means the lookup hung — the killed process's stderr
      // can't say so; report the connectivity problem directly.
      const message = killedByWatchdog
        ? copy.failDownloadNetwork
        : (err && err.message) || copy.failLookup;
      finishItem(id, message, (err && err.details) || null);
      return;
    }
    if (info.title) it.title = info.title;
    if (info.isLive) {
      downloadingID = null;
      finishItem(id, copy.failLivestream, null);
      return;
    }
    if (info.playlistCount != null && info.playlistCount > 1) {
      downloadingID = null;
      finishItem(id, copy.failPlaylist(info.playlistCount), null);
      return;
    }
    startDownloadStage(id, url);
  }

  function startDownloadStage(id, url) {
    const it = byId(id);
    if (!it) { downloadingID = null; pump(); return; }

    const dest = it.destFolder || settings.downloadFolder();
    try { fs.mkdirSync(dest, { recursive: true }); } catch { }
    let ok = false;
    try { ok = fs.statSync(dest).isDirectory(); } catch { }
    if (ok) { try { fs.accessSync(dest, fs.constants.W_OK); } catch { ok = false; } }
    if (!ok) {
      downloadingID = null;
      finishItem(id, copy.failFolderUnwritable(path.basename(dest)), null);
      return;
    }

    it.state = 'downloading';
    it.progressPct = null;
    it.stageStartedAt = now();

    let handle;
    try {
      handle = startEngineJob((onChild) => engine.dlGet({
        url,
        mode: it.capturedKeepVideo ? 'video' : 'audio',
        destDir: dest,
        onChild,
        cookies: sys.instagramCookies,
        onProgress: (pct) => {
          if (handle !== undefined && jobs.get(id) !== handle) return;
          const cur = byId(id);
          if (!cur || cur.state !== 'downloading') return;
          cur.progressPct = Math.min(100, Math.max(0, Math.round(pct)));
          changed();
        },
      }));
    } catch (e) {
      cleanupJob(id);
      downloadingID = null;
      finishItem(id, (e && e.message) || copy.failYtDlpMissing,
                 (e && e.details) || String((e && e.message) || e));
      return;
    }
    jobs.set(id, handle);
    handle.promise.then(
      (res) => downloadSettled(id, handle, null, res),
      (err) => downloadSettled(id, handle, err || {}, null),
    );
    changed();
  }

  function downloadSettled(id, handle, err, res) {
    if (jobs.get(id) !== handle) { pump(); changed(); return; }
    cleanupJob(id);
    if (downloadingID === id) downloadingID = null;
    const it = byId(id);
    if (!it || it.state !== 'downloading') { pump(); changed(); return; }

    if (!err && res && res.file && fs.existsSync(res.file)) {
      it.downloadedFile = res.file;
      it.state = 'waiting';     // hand over to the transcription lane
      it.progressPct = null;
      pump();
      changed();
    } else {
      finishItem(id, (err && err.message) || copy.failDownloadPrivateOrRemoved,
                 (err && err.details) || null);
    }
  }

  // MARK: Shared completion / failure path

  function finishItem(id, message, details) {
    if (transcribingID === id) transcribingID = null;
    if (downloadingID === id) downloadingID = null;
    cleanupJob(id);
    const it = byId(id);
    if (it) {
      it.state = 'failed';
      it.errorMessage = message;
      it.errorDetails = details || null;
      it.finishedAt = now();
      it.progressPct = null;
      it.etaText = null;
      sessionFailed += 1;
      sessionLastFailedName = it.title;
    }
    pump();
    changed();
  }

  function cleanupJob(id) {
    const t = watchdogs.get(id);
    if (t) { clearTimeout(t); watchdogs.delete(id); }
    jobs.delete(id);
    const dir = jobDirs.get(id);
    if (dir) { rmrf(dir); jobDirs.delete(id); }
  }

  // MARK: Cancel / retry / remove

  function cancel(id, pumping = true) {
    const it = byId(id);
    if (!it || !isUnfinished(it.state)) return;
    const state = it.state;

    const handle = jobs.get(id);
    if (isActive(state) && handle) {
      handle.cancel();
      // Downloads need no sweep: yt-dlp writes everything (including .part /
      // .ytdl) inside the engine's private staging dir, which dlGet's finally
      // removes with retries once the killed child releases it. Transcripts do:
      // remove the partial .txt/.srt whisper may have half-written.
      if (state === 'transcribing' || state === 'preparing') {
        removeFreshOutputs(it);
      }
    }
    if (transcribingID === id) transcribingID = null;
    if (downloadingID === id) downloadingID = null;
    cleanupJob(id);
    it.state = 'canceled';
    it.progressPct = null;
    it.etaText = null;
    if (pumping) { pump(); changed(); }
  }

  function cancelAll() {
    // Waiting items are marked Canceled first, with no pump in between —
    // pumping after each cancel would start the next waiting item's real
    // process (or fail its pre-flight checks) only to kill it a moment later.
    // One pump at the end settles the side effects.
    for (const it of items.filter((x) => x.state === 'waiting')) cancel(it.id, false);
    for (const it of items.filter((x) => isActive(x.state))) cancel(it.id, false);
    pump();
    changed();
  }

  function cancelSelected() {
    if (selection == null) return;
    const it = byId(selection);
    if (!it || !isActive(it.state)) return;
    cancel(selection);
  }

  function retry(id) {
    const it = byId(id);
    if (!it || it.state !== 'failed') return;
    probeDeps();   // retry after fixing setup should see the fixed world
    retryCounter += 1;
    resetForRerun(it);
    it.retryPriority = retryCounter;
    pump();
    changed();
  }

  function startAgain(id) {
    const it = byId(id);
    if (!it || it.state !== 'canceled') return;
    resetForRerun(it);
    pump();
    changed();
  }

  function resetForRerun(it) {
    it.state = 'waiting';
    it.errorMessage = null;
    it.errorDetails = null;
    it.progressPct = null;
    it.etaText = null;
    it.estimator.reset();
    it.doneNote = null;
    it.startedAt = null;
    it.finishedAt = null;
    // Links re-run the whole pipeline; the download starts over from scratch
    // (the engine stages downloads in a temp dir it cleans on exit).
    it.downloadedFile = null;
    it.capturedModel = null;
    it.capturedLanguage = null;
  }

  function transcribeAgain(id) {
    const it = byId(id);
    if (!it) return;
    if (it.source.type === 'file') addFiles([it.source.path]);
    else addLink(it.source.url);
  }

  function remove(id) {
    let it = byId(id);
    if (!it) return;
    if (isActive(it.state)) cancel(id);
    it = byId(id);
    if (it) items.splice(indexOf(id), 1);
    if (selection === id) selection = null;
    pump();
    changed();
  }

  function clearDone() {
    items = items.filter((it) => !isFinished(it.state));
    updateWorkSideEffects();
    changed();
  }

  function hasFinishedRows() { return items.some((it) => isFinished(it.state)); }
  function hasUnfinishedWork() { return items.some((it) => isUnfinished(it.state)); }
  // The spec hides "Clear Done" while the selected row is in progress.
  function selectionIsInProgress() {
    if (selection == null) return false;
    const it = byId(selection);
    return !!it && isActive(it.state);
  }

  function removeFreshOutputs(it) {
    const input = inputFile(it);
    if (!input || it.stageStartedAt == null) return;
    const o = outputPaths(input);
    for (const p of [o.txt, o.srt]) {
      let mtime;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      if (mtime >= it.stageStartedAt - 2000) { try { fs.unlinkSync(p); } catch { } }
    }
  }

  // MARK: Row actions

  // A row action must never fail silently: if the file it needs is gone
  // (moved, deleted, on an ejected drive), say so in the status line.
  function requireFile(p, id) {
    if (p && fs.existsSync(p)) return p;
    showActionNote(id, copy.fileGoneNote);
    return null;
  }

  function showActionNote(id, note) {
    const it = byId(id);
    if (!it) return;
    it.actionNote = note;
    changed();
    later(delays.note, () => {
      const cur = byId(id);
      if (!cur) return;
      cur.actionNote = null;
      changed();
    });
  }

  function openTranscript(id) {
    const it = byId(id);
    if (!it) return;
    const txt = requireFile(it.txtPath, id);
    if (!txt) return;
    sys.openPath(txt);
  }

  function openSubtitles(id) {
    const it = byId(id);
    if (!it) return;
    const srt = requireFile(it.srtPath, id);
    if (!srt) return;
    sys.openPath(srt);
  }

  function showInFinder(id) {
    const it = byId(id);
    if (!it) return;
    // Prefer the transcript, fall back to the source media, then to the
    // containing folder — reveal *something* rather than doing nothing.
    for (const candidate of [it.txtPath, inputFile(it)].filter(Boolean)) {
      if (fs.existsSync(candidate)) {
        sys.showItemInFolder(candidate);
        return;
      }
      const folder = path.dirname(candidate);
      if (fs.existsSync(folder)) {
        sys.openPath(folder);
        showActionNote(id, copy.fileGoneNote);
        return;
      }
    }
    showActionNote(id, copy.fileGoneNote);
  }

  function copyTranscript(id) {
    const it = byId(id);
    if (!it) return;
    const txt = requireFile(it.txtPath, id);
    if (!txt) return;
    let content;
    try { content = fs.readFileSync(txt, 'utf8'); } catch {
      showActionNote(id, copy.fileGoneNote);
      return;
    }
    // The file carries timestamps; the clipboard should not. "Copy Transcript
    // Text" exists to paste into an email or a document, where "[12:04] " in
    // front of every paragraph is something the user has to delete by hand.
    sys.copyText(require('../shared/srt').stripTimestamps(content));
    it.copiedFlash = true;
    changed();
    later(delays.copied, () => {
      const cur = byId(id);
      if (!cur) return;
      cur.copiedFlash = false;
      changed();
    });
  }

  function copyErrorDetails(id) {
    const it = byId(id);
    if (!it) return;
    const details = [it.errorMessage, it.errorDetails].filter(Boolean).join('\n\n');
    sys.copyText(details);
  }

  // MARK: Working-state side effects (badge, progress, sleep, ALL DONE moment)

  function updateWorkSideEffects() {
    const unfinished = items.filter((it) => isUnfinished(it.state)).length;
    const working = unfinished > 0;

    sys.setBadge(working ? String(unfinished) : null);
    sys.setProgressBar(working ? overallProgress() : -1);

    if (working && !powerBlocking) { sys.startPowerBlocker(); powerBlocking = true; }
    else if (!working && powerBlocking) { sys.stopPowerBlocker(); powerBlocking = false; }

    if (working && !wasWorking) {
      sessionDone = 0;
      sessionFailed = 0;
      sessionLastTxtName = null;
      sessionLastFailedName = null;
    }
    if (!working && wasWorking) queueFinished();
    wasWorking = working;
  }

  function overallProgress() {
    if (transcribingID != null) {
      const it = byId(transcribingID);
      if (it && it.state === 'transcribing' && it.progressPct != null) return it.progressPct / 100;
    }
    if (downloadingID != null) {
      const it = byId(downloadingID);
      if (it && it.state === 'downloading' && it.progressPct != null) return it.progressPct / 100;
    }
    return 2;   // working, no determinate figure yet
  }

  function queueFinished() {
    if (sessionDone + sessionFailed === 0) return;
    if (!settings.get('notifyOnFinish')) return;
    if (sys.isWindowFocused()) return;   // HIG: don't notify the frontmost app

    let title;
    let body;
    if (sessionFailed === 0 && sessionDone === 1) {
      title = copy.notifOneTitle;
      body = copy.notifOneBody(sessionLastTxtName || 'transcript.txt');
    } else if (sessionFailed === 0) {
      title = copy.notifAllTitle;
      body = copy.notifAllBody(sessionDone);
    } else if (sessionDone === 0) {
      title = copy.notifFailedTitle;
      body = copy.notifFailedBody(sessionLastFailedName || 'file');
    } else {
      title = copy.notifMixedTitle;
      body = copy.notifMixedBody(sessionDone, sessionFailed);
    }
    sys.notify(title, body);
  }

  // A lid-close sleep pauses whisper mid-run; the slept hours would poison the
  // ETA rate, so drop the baseline on wake.
  function handleWake() {
    for (const it of items) {
      if (it.state !== 'transcribing') continue;
      it.estimator.resetBaseline();
      it.etaText = null;
      it.afterSleep = true;
    }
    changed();
  }

  // MARK: Quit

  // Async: quitting mid-job must AWAIT every child's death before deleting the
  // job dirs. On Windows taskkill is asynchronous and an open audio.wav can't be
  // unlinked while ffmpeg/whisper hold it, so a synchronous rmrf here would fail
  // silently and leak a multi-hundred-MB dir in %TEMP% every quit. main.js holds
  // the quit until this resolves (with its own hard safety cap).
  async function prepareForTermination(opts = {}) {
    const waitMs = opts.waitMs;
    const pending = [];
    for (const [id, handle] of jobs) {
      const it = byId(id);
      if (it && (it.state === 'transcribing' || it.state === 'preparing')) {
        removeFreshOutputs(it);
      }
      // Downloads need no sweep here — the engine's staging cleanup removes its
      // own partial files. cancelAndWait TERM/taskkill's the whole tree and
      // resolves once the children are actually gone.
      pending.push(Promise.resolve(handle.cancelAndWait(waitMs)).catch(() => { }));
    }
    jobs.clear();
    for (const t of watchdogs.values()) clearTimeout(t);
    watchdogs.clear();
    if (powerBlocking) { sys.stopPowerBlocker(); powerBlocking = false; }
    await Promise.all(pending);
    for (const dir of jobDirs.values()) rmrf(dir);
    jobDirs.clear();
    rmrf(jobBase);
  }

  // MARK: Snapshot (C4 — all text composed here)

  function statusText(it) {
    switch (it.state) {
      case 'waiting': return copy.waiting;
      case 'lookingUp': return copy.lookingUp;
      case 'downloading':
        return it.progressPct != null ? copy.downloading(it.progressPct) : copy.downloadingUnknown;
      case 'preparing': return copy.preparing;
      case 'transcribing':
        if (it.afterSleep && it.etaText == null) return copy.continuingAfterSleep;
        return copy.transcribing(it.progressPct == null ? 0 : it.progressPct, it.etaText);
      case 'done': {
        if (it.actionNote) return it.actionNote;
        if (it.copiedFlash) return copy.transcriptCopied;
        if (it.doneNote) return it.doneNote;
        const secs = it.finishedAt != null && it.startedAt != null
          ? (it.finishedAt - it.startedAt) / 1000 : 0;
        const duration = copy.durationPhrase(secs);
        if (it.source.type === 'link') {
          const folderName = it.destFolder ? path.basename(it.destFolder) : 'Downloads';
          return copy.doneLink(duration, folderName);
        }
        return copy.doneFile(duration);
      }
      case 'failed': return it.errorMessage || copy.failTranscription;
      case 'canceled': return copy.canceled;
      default: return '';
    }
  }

  function kindOf(it) {
    if (it.source.type === 'link') return 'link';
    const ext = path.extname(it.source.path).slice(1).toLowerCase();
    return AUDIO_EXTS.has(ext) ? 'audio' : 'file';
  }

  function viewItem(it) {
    const showBar = isActive(it.state);
    let pct = null;
    let indeterminate = false;
    if (it.state === 'transcribing') pct = it.progressPct == null ? 0 : it.progressPct;
    else if (it.state === 'downloading') { pct = it.progressPct; indeterminate = pct == null; }
    else if (it.state === 'lookingUp' || it.state === 'preparing') indeterminate = true;
    const text = statusText(it);
    return {
      id: it.id,
      title: it.title,
      kind: kindOf(it),
      state: it.state,
      statusText: text,
      statusTitle: text,
      progressPct: pct,
      indeterminate,
      showProgressBar: showBar,
      flash: flashId === it.id,
      canRetry: it.state === 'failed',
      canOpen: it.state === 'done',
    };
  }

  // C4: every sentence the Updates panel shows is composed here, so the renderer
  // only paints. `statusText` is null when there is genuinely nothing to say —
  // a supported build that hasn't been asked to check yet.
  function updateStatusText() {
    // Installing outranks everything: it is the only state the user is waiting on.
    if (update.installError) return update.installError;
    if (update.installing) {
      return update.installPct == null ? copy.updateInstalling : copy.updateDownloading(update.installPct);
    }
    if (update.checking) return copy.updateChecking;
    if (!update.supported) return copy.updateCheckOff;
    if (update.result === 'available') return copy.updateAvailable(update.latestVersion);
    if (update.result === 'upToDate') return copy.updateUpToDate;
    // "Check your internet connection" is only fair when the request never
    // completed. A 404 (private repo, no releases) or a 403 rate-limit means the
    // connection worked fine and the user would be debugging the wrong thing.
    if (update.result === 'failed') {
      return update.reason === 'server' ? copy.updateCheckUnavailable : copy.updateCheckFailed;
    }
    return null;
  }

  function updateView() {
    return {
      versionLabel: appVersion ? copy.settingsVersion(appVersion) : null,
      currentVersion: appVersion,
      autoCheck: !!settings.get('autoCheckUpdates'),
      supported: !!update.supported,
      checking: !!update.checking,
      canCheck: !!update.supported && !update.checking && !update.installing,
      statusText: updateStatusText(),
      // Only offer the button for a real, still-current "available" result.
      downloadUrl: update.result === 'available' ? (update.url || null) : null,
      // True when one click can actually install: a matching asset exists. Without
      // one the same button still works, it just opens the release page.
      canInstall: update.result === 'available' && !!update.asset && !update.installing,
      installing: !!update.installing,
      installPct: update.installing ? update.installPct : null,
    };
  }

  // The banner is the ONLY update UI in the main window (Settings ▸ Updates is
  // the other view, and nobody opens it to watch a download), so it has to carry
  // the install's progress too.
  //
  // WHY: `banner.text` was composed once by setBanner and never refreshed.
  // Pressing Update started a ~217MB download while the banner went on reading
  // "Version X is available." and the button stayed live — indistinguishable from
  // a click that did nothing, which is exactly how it got reported. `busy` is
  // what stops a second press landing on an install already in flight.
  function bannerForView() {
    if (!banner) return null;
    const busy = !!update.installing;
    if (!busy && !update.installError) return { ...banner, busy: false };
    return { ...banner, text: updateStatusText(), busy };
  }

  function footerText() {
    const total = items.length;
    if (transcribingID != null) {
      const i = indexOf(transcribingID);
      if (i >= 0 && (items[i].state === 'transcribing' || items[i].state === 'preparing')) {
        return copy.footerTranscribing(items[i].title, i + 1, total, items[i].etaText);
      }
    }
    if (downloadingID != null) {
      const i = indexOf(downloadingID);
      if (i >= 0) return copy.footerDownloading(items[i].title, i + 1, total);
    }
    if (hasUnfinishedWork()) return null;
    const done = items.filter((it) => it.state === 'done').length;
    const failed = items.filter((it) => it.state === 'failed').length;
    if (done + failed === 0) return null;
    return copy.footerFinished(done, failed);
  }

  function snapshot() {
    return {
      phase,
      deps: {
        whisperOK: !!deps.whisperOK,
        ffmpegOK: !!deps.ffmpegOK,
        ytDlpOK: !!deps.ytDlpOK,
        modelsOK: !!(deps.bestModelOK && deps.fastModelOK),
        bestModelOK: !!deps.bestModelOK,
        linksLimited: !!deps.linksLimited,
        setupNeeded: !!deps.setupNeeded,
        folderOK: deps.folderOK !== false,
      },
      items: items.map(viewItem),
      footer: { text: footerText(), showCancelAll: hasUnfinishedWork() },
      banner: bannerForView(),
      settings: {
        model: settings.get('model'),
        language: settings.get('language'),
        keepVideo: !!settings.get('keepVideo'),
        downloadFolder: settings.downloadFolder(),
        downloadFolderDisplay: path.basename(settings.downloadFolder()),
        notifyOnFinish: !!settings.get('notifyOnFinish'),
      },
      catalog: catalog.all.map((m) => ({
        sel: m.sel,
        display: m.display,
        technical: m.technical,
        menuTitle: m.menuTitle || `${m.display} (${m.technical}) — ${m.blurb}`,
        caption: m.caption,
        present: modelPresent(m.sel),
      })),
      languages: (languages.displayOrder || languages.all).map((l) => ({ code: l.code, name: l.name })),
      selectionHint: { clearDoneVisible: hasFinishedRows() && !selectionIsInProgress() },
      update: updateView(),
    };
  }

  return {
    probeDeps,
    addFiles,
    addLink,
    linkValid: (text) => logic.looksLikeWebLink(String(text == null ? '' : text).trim()),
    cancel: (id) => cancel(id, true),
    cancelAll,
    cancelSelected,
    retry,
    startAgain,
    remove,
    transcribeAgain,
    clearDone,
    openTranscript,
    openSubtitles,
    showInFinder,
    copyTranscript,
    copyErrorDetails,
    select(id) { selection = id == null ? null : id; changed(); },
    setBanner(info) {
      // Sentence composed here (C4), so the banner speaks the UI language like
      // everything else — the renderer used to build it from an English literal.
      banner = info
        ? { version: info.version, url: info.url || null, text: copy.updateAvailable(info.version) }
        : null;
      changed();
    },
    dismissBanner() { banner = null; changed(); },
    getBanner: () => banner,
    setUpdateState(partial) {
      update = { ...update, ...(partial || {}) };
      // The banner and the panel are two views of ONE finding, so keep them
      // consistent here rather than trusting every caller to remember. Learning
      // we're current retires the notice (a release can be pulled or rolled
      // back, and a banner advertising a version that no longer exists hands the
      // user a dead Download link). A FAILED check changes nothing — a transient
      // outage must not erase a real finding.
      if (update.result === 'upToDate') banner = null;
      changed();
    },
    // The release page the Download buttons open. The LAST CHECK wins: a banner
    // can outlive the finding that raised it (a pulled release), and sending the
    // user to a dead page is worse than sending them nowhere. The banner is the
    // fallback, for when the panel has been reset but the notice still stands.
    getUpdateUrl: () => (update.result === 'available' ? update.url : null) || (banner && banner.url) || null,
    getUpdateAsset: () => (update.result === 'available' ? update.asset : null),
    stateOf(id) { const it = byId(id); return it ? it.state : null; },
    handleWake,
    prepareForTermination,
    hasUnfinishedWork,
    snapshot,
    refresh: changed,
    onChange(cb) { listeners.push(cb); },
  };
}

module.exports = { createQueue, createSystemAdapter, outputPaths, chooseJobBase, MEDIA_EXTS, DELAYS };
