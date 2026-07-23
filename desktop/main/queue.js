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

// Spec-pinned durations (ms): dup-flash 0.4 s, copied 2 s, action note 4 s,
// lookup watchdog 60 s. Tests inject smaller values.
const DELAYS = Object.freeze({ flash: 400, copied: 2000, note: 4000, lookupWatchdog: 60000 });

const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg',
                            'opus', 'wma', 'aiff', 'aif', 'caf']);

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

// MARK: System adapter

// TEST HOOK (pinned): with env TRANSCRIBE_TEST_LOG set, side-effecting calls
// (shell.openPath / shell.showItemInFolder / clipboard.writeText /
// Notification fire) are NOT executed — a JSON line {action, arg, ts} is
// appended to that file instead so Playwright can verify row actions.
function createSystemAdapter(opts = {}) {
  const env = opts.env || process.env;
  const electron = opts.electron || null;
  const getWindow = opts.getWindow || (() => null);
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

  const jobBase = path.join(os.tmpdir(), 'com.flisko.transcribe');

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
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { }
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

  function addFiles(paths) {
    if (phase !== 'ready') return;
    for (const raw of Array.isArray(paths) ? paths : []) {
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
    it.destFolder = settings.downloadFolder();
    if (it.startedAt == null) it.startedAt = now();
    it.stageStartedAt = now();
    it.state = 'lookingUp';

    let handle;
    try {
      handle = startEngineJob((onChild) => engine.dlInfo(url, { onChild }));
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
      // Downloads: sweep this run's partial files. Transcripts: remove the
      // partial .txt/.srt whisper may have half-written.
      if (state === 'downloading') {
        removePartFiles(it.destFolder || settings.downloadFolder(), it.stageStartedAt);
      }
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
    if (it) {
      // Removing a link row gives up its resume data — sweep .part files.
      if (it.source.type === 'link' && it.state !== 'done') {
        removePartFiles(it.destFolder || settings.downloadFolder(), it.startedAt);
      }
      items.splice(indexOf(id), 1);
    }
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

  function removePartFiles(folder, since) {
    let names;
    try { names = fs.readdirSync(folder); } catch { return; }
    const cutoff = since == null ? Infinity : since - 2000;
    for (const name of names) {
      if (!name.endsWith('.part') && !name.endsWith('.ytdl')) continue;
      const p = path.join(folder, name);
      let mtime;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      if (mtime >= cutoff) { try { fs.unlinkSync(p); } catch { } }
    }
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
    sys.copyText(content);
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
      banner,
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
      banner = info ? { version: info.version, url: info.url || null } : null;
      changed();
    },
    dismissBanner() { banner = null; changed(); },
    getBanner: () => banner,
    stateOf(id) { const it = byId(id); return it ? it.state : null; },
    handleWake,
    prepareForTermination,
    hasUnfinishedWork,
    snapshot,
    refresh: changed,
    onChange(cb) { listeners.push(cb); },
  };
}

module.exports = { createQueue, createSystemAdapter, outputPaths, DELAYS };
