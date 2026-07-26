// queue.test.js — headless state-machine tests for main/queue.js with a STUB
// engine (injected via the createQueue factory; no Electron, no real shared/
// modules — everything the queue composes text with is injected). The stub
// copy strings are verbatim Copy.swift ports so status assertions double as a
// contract check for shared/copy.js.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createQueue, createSystemAdapter, outputPaths, DELAYS } = require('../../main/queue');
const { createSettings } = require('../../main/settings');

// MARK: Injected stand-ins for the shared modules

const stubCopy = {
  waiting: 'Waiting…',
  lookingUp: 'Looking up video…',
  downloadingUnknown: 'Downloading…',
  downloading: (pct) => `Downloading — ${pct}%`,
  preparing: 'Preparing audio…',
  estimating: 'estimating time…',
  transcribing: (pct, eta) => `Transcribing — ${pct}% · ${eta || 'estimating time…'}`,
  continuingAfterSleep: 'Continuing after sleep — updating the time estimate…',
  canceled: 'Canceled',
  transcriptCopied: 'Transcript copied.',
  doneFile: (d) => `Done in ${d} · transcript saved next to the original`,
  doneLink: (d, folder) => `Done in ${d} · saved in ${folder}`,
  fileGoneNote: 'That file isn\'t there anymore — it may have been moved or deleted. Use Transcribe Again to redo it.',
  failTranscription: 'Transcription didn\'t finish. Press Retry — if it keeps failing, try the Best quality model.',
  failEngineMissing: 'The speech engine is missing.',
  failYtDlpMissing: 'Downloading videos from the internet needs a small helper that isn\'t installed yet.',
  failDownloadNetwork: 'Couldn\'t download — check your internet connection, then press Retry.',
  failDownloadPrivateOrRemoved: 'Couldn\'t download — the video may be private or removed.',
  failLookup: 'Couldn\'t find a video at this link.',
  failLivestream: 'This is a live stream, and Transcribe can\'t record live video.',
  failPlaylist: (n) => `This link points to a whole playlist or channel (${n} videos), not one video.`,
  failModelMissing: (display) => `The '${display}' model isn't downloaded.`,
  failFileMissing: (name) => `Skipped '${name}' — the file can't be found any more.`,
  failZeroLength: (name) => `Skipped '${name}' — the file is empty, so there is nothing to transcribe.`,
  failOutputDirReadOnly: (name) => `The folder holding '${name}' doesn't allow saving.`,
  failFolderUnwritable: (folder) => `Transcribe can't save downloads into '${folder}'.`,
  noSpeechNote: (name) => `Finished '${name}', but no speech was found — the transcript is empty.`,
  footerTranscribing: (name, n, total, eta) =>
    `Transcribing "${name}" — ${n} of ${total}` + (eta ? ` · ${eta}` : ''),
  footerDownloading: (title, n, total) => `Downloading "${title}" — ${n} of ${total}`,
  footerFinished: (done, failed) => {
    if (failed === 0) return done === 1 ? 'All done — transcript ready' : `All done — ${done} transcripts ready`;
    return `Finished — ${done} done, ${failed} failed`;
  },
  durationPhrase: (seconds) => {
    if (seconds < 60) return 'under a minute';
    const m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60); const r = m % 60;
    return r === 0 ? `${h} hr` : `${h} hr ${r} min`;
  },
  notifOneTitle: 'Transcript ready',
  notifOneBody: (txtName) => `"${txtName}" was saved next to your video.`,
  notifAllTitle: 'All transcriptions finished',
  notifAllBody: (n) => `${n} transcripts are ready.`,
  notifMixedTitle: 'Transcriptions finished',
  notifMixedBody: (done, failed) => `${done} done, ${failed} failed. Open Transcribe for details.`,
  notifFailedTitle: 'Transcription failed',
  notifFailedBody: (name) => `"${name}" couldn't be transcribed. Open Transcribe for details.`,
  // Platform-varying setup chrome the snapshot forwards to the renderer.

  // Settings ▸ Updates.
  settingsVersion: (v) => `Version ${v}`,
  updateAvailable: (v) => `Version ${v} is available.`,
  updateChecking: 'Checking…',
  updateUpToDate: "You're on the latest version.",
  updateCheckFailed: "Couldn't check for updates just now.",
  updateCheckUnavailable: 'The update service had no answer.',
  updateCheckOff: 'This copy was built locally.',
};

const stubCatalog = {
  all: [
    { sel: 'best', display: 'Best quality', technical: 'large-v3', fileName: 'ggml-large-v3.bin',
      minBytes: 1, blurb: 'most accurate', caption: 'cap-best', menuTitle: 'mt-best' },
    { sel: 'fast', display: 'Fast', technical: 'large-v3-turbo', fileName: 'ggml-large-v3-turbo.bin',
      minBytes: 1, blurb: 'faster', caption: 'cap-fast', menuTitle: 'mt-fast' },
  ],
  by(sel) { return this.all.find((m) => m.sel === sel) || this.all[0]; },
};

const stubLanguages = {
  displayOrder: [
    { code: 'auto', name: 'Auto-detect' },
    { code: 'hr', name: 'Croatian' },
    { code: 'sl', name: 'Slovenian' },
  ],
  name: (c) => c,
  isValid: () => true,
};

class StubEtaSmoother {
  reset() { }
  resetBaseline() { }
  update() { return null; }
}
const stubLogic = {
  EtaSmoother: StubEtaSmoother,
  looksLikeWebLink: (t) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(t),
};

// MARK: Stub engine (C3 shape; promises augmented with cancel())

function makeEngine() {
  const calls = { transcribe: [], dlInfo: [], dlGet: [], probeDeps: 0 };
  function job(extra) {
    let resolveFn; let rejectFn;
    const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    p.cancelCalled = false;
    p.cancel = () => {
      p.cancelCalled = true;
      rejectFn(Object.assign(new Error('canceled'), { canceled: true }));
    };
    p.resolveWith = resolveFn;
    p.rejectWith = rejectFn;
    Object.assign(p, extra);
    return p;
  }
  return {
    calls,
    probeDeps() {
      calls.probeDeps += 1;
      return { whisperOK: true, ffmpegOK: true, ytDlpOK: true, bestModelOK: true,
               fastModelOK: true, folderOK: true, setupNeeded: false, linksLimited: false };
    },
    transcribe(args) { const j = job({ args }); calls.transcribe.push(j); return j; },
    dlInfo(url) { const j = job({ url }); calls.dlInfo.push(j); return j; },
    dlGet(args) { const j = job({ args }); calls.dlGet.push(j); return j; },
  };
}

// MARK: Harness

const tickOnce = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 4; i++) await tickOnce(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_DELAYS = { flash: 25, copied: 40, note: 40, lookupWatchdog: 80 };

function harness(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-qt-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });
  const logFile = path.join(dir, 'actions.jsonl');
  const settings = createSettings({ file: path.join(dir, 'settings.json'), downloadsDir: dir });
  for (const [k, v] of Object.entries(opts.settings || {})) settings.set(k, v);
  const engine = makeEngine();
  const sys = createSystemAdapter({ env: { TRANSCRIBE_TEST_LOG: logFile } });
  const queue = createQueue({
    engine, settings, sys,
    copy: stubCopy, catalog: stubCatalog, languages: stubLanguages, logic: stubLogic,
    modelPresent: opts.modelPresent || (() => true),
    delays: { ...TEST_DELAYS, ...(opts.delays || {}) },
    appVersion: opts.appVersion === undefined ? '1.0.42' : opts.appVersion,
  });
  queue.probeDeps();
  const mkFile = (name, content = 'media-bytes') => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return fs.realpathSync(p);
  };
  const logLines = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []);
  const items = () => queue.snapshot().items;
  return { dir, logFile, settings, engine, queue, mkFile, logLines, items };
}

// MARK: Tests

test('spec-pinned delay values (dup flash 0.4s, copied 2s, note 4s, lookup watchdog 60s)', () => {
  assert.deepStrictEqual({ ...DELAYS },
    { flash: 400, copied: 2000, note: 4000, lookupWatchdog: 60000 });
});

test('outputPaths stems from the last path component only', () => {
  const input = path.join(path.sep + 'tmp', 'videos v2.0', 'clip.mov');
  const o = outputPaths(input);
  assert.strictEqual(o.txt, path.join(path.sep + 'tmp', 'videos v2.0', 'clip.txt'));
  assert.strictEqual(o.srt, path.join(path.sep + 'tmp', 'videos v2.0', 'clip.srt'));
});

test('file flow: add -> waiting -> preparing -> transcribing -> done; capture-at-start', async (t) => {
  const h = harness(t);
  const f1 = h.mkFile('first.mp4');
  const f2 = h.mkFile('second.mp3');

  h.queue.addFiles([f1, f2]);
  let snap = h.queue.snapshot();
  assert.strictEqual(snap.phase, 'ready');
  assert.strictEqual(snap.items.length, 2);
  assert.strictEqual(snap.items[0].state, 'preparing');
  assert.strictEqual(snap.items[0].statusText, 'Preparing audio…');
  assert.strictEqual(snap.items[0].indeterminate, true);
  assert.strictEqual(snap.items[0].kind, 'file');
  assert.strictEqual(snap.items[1].state, 'waiting');
  assert.strictEqual(snap.items[1].statusText, 'Waiting…');
  assert.strictEqual(snap.items[1].kind, 'audio');
  assert.strictEqual(h.engine.calls.transcribe.length, 1, 'single transcription lane');
  const job1 = h.engine.calls.transcribe[0];
  assert.strictEqual(job1.args.input, f1);
  assert.strictEqual(job1.args.modelSel, 'best');
  assert.strictEqual(job1.args.lang, 'hr');
  assert.ok(job1.args.workDir, 'engine gets a private workDir');

  // Mid-queue setting change must only affect items that have not begun.
  h.settings.set('model', 'fast');

  job1.args.onProgress(0);   // 0% baseline = still extracting
  assert.strictEqual(h.items()[0].state, 'preparing');
  job1.args.onProgress(45);
  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].state, 'transcribing');
  assert.strictEqual(snap.items[0].progressPct, 45);
  assert.strictEqual(snap.items[0].statusText, 'Transcribing — 45% · estimating time…');
  assert.strictEqual(snap.footer.text, 'Transcribing "first.mp4" — 1 of 2');
  assert.strictEqual(snap.footer.showCancelAll, true);

  const out1 = outputPaths(f1);
  fs.writeFileSync(out1.txt, 'hello transcript');
  fs.writeFileSync(out1.srt, '1\n');
  job1.resolveWith({ txt: out1.txt, srt: out1.srt });
  await settle();

  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].state, 'done');
  assert.strictEqual(snap.items[0].canOpen, true);
  assert.strictEqual(snap.items[0].statusText,
    'Done in under a minute · transcript saved next to the original');
  assert.strictEqual(snap.items[0].statusTitle, snap.items[0].statusText);
  assert.strictEqual(snap.items[1].state, 'preparing', 'lane hands over to next item');
  assert.strictEqual(h.engine.calls.transcribe.length, 2);
  const job2 = h.engine.calls.transcribe[1];
  assert.strictEqual(job2.args.input, f2);
  assert.strictEqual(job2.args.modelSel, 'fast', 'model captured at START, not enqueue');

  const out2 = outputPaths(f2);
  fs.writeFileSync(out2.txt, 'more words');
  job2.resolveWith({ txt: out2.txt, srt: out2.srt });
  await settle();

  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[1].state, 'done');
  assert.strictEqual(snap.footer.text, 'All done — 2 transcripts ready');
  assert.strictEqual(snap.footer.showCancelAll, false);
  assert.strictEqual(snap.selectionHint.clearDoneVisible, true);
});

test('cancelAll: 1 active + 3 waiting all canceled, one engine start, zero failed', async (t) => {
  const h = harness(t);
  const files = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'].map((n) => h.mkFile(n));
  h.queue.addFiles(files);
  assert.strictEqual(h.engine.calls.transcribe.length, 1);
  assert.deepStrictEqual(h.items().map((i) => i.state),
    ['preparing', 'waiting', 'waiting', 'waiting']);

  h.queue.cancelAll();
  assert.deepStrictEqual(h.items().map((i) => i.state),
    ['canceled', 'canceled', 'canceled', 'canceled']);
  assert.strictEqual(h.engine.calls.transcribe.length, 1,
    'cancelAll must not start the next waiting item');
  assert.strictEqual(h.engine.calls.transcribe[0].cancelCalled, true);

  await settle();   // the canceled job's rejection must not flip anything to failed
  const states = h.items().map((i) => i.state);
  assert.deepStrictEqual(states, ['canceled', 'canceled', 'canceled', 'canceled']);
  assert.strictEqual(h.items().every((i) => i.statusText === 'Canceled'), true);
  assert.strictEqual(h.engine.calls.transcribe.length, 1);
  assert.strictEqual(h.queue.snapshot().footer.showCancelAll, false);
});

test('retry goes to the front of the waiting line (and re-probes deps)', async (t) => {
  const h = harness(t);
  const [fa, fb, fc] = ['ra.mp4', 'rb.mp4', 'rc.mp4'].map((n) => h.mkFile(n));
  h.queue.addFiles([fa, fb, fc]);
  const probesBefore = h.engine.calls.probeDeps;

  h.engine.calls.transcribe[0].rejectWith({ message: 'boom', details: 'stderr detail' });
  await settle();

  let snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].state, 'failed');
  assert.strictEqual(snap.items[0].canRetry, true);
  assert.strictEqual(snap.items[0].statusText, 'boom');
  assert.strictEqual(snap.items[1].state, 'preparing', 'B started after A failed');
  assert.strictEqual(snap.items[2].state, 'waiting');

  h.queue.retry(snap.items[0].id);
  assert.strictEqual(h.engine.calls.probeDeps, probesBefore + 1, 'retry re-probes deps');
  assert.strictEqual(h.items()[0].state, 'waiting');

  const outB = outputPaths(fb);
  fs.writeFileSync(outB.txt, 'b text');
  h.engine.calls.transcribe[1].resolveWith({ txt: outB.txt, srt: outB.srt });
  await settle();

  assert.strictEqual(h.engine.calls.transcribe.length, 3);
  assert.strictEqual(h.engine.calls.transcribe[2].args.input, fa,
    'retried item jumps ahead of the still-waiting C');
  assert.strictEqual(h.items()[2].state, 'waiting');
});

test('duplicate add flashes the existing row while unfinished, re-adds when done', async (t) => {
  const h = harness(t);
  const f = h.mkFile('dup.mp4');
  h.queue.addFiles([f]);
  assert.strictEqual(h.items().length, 1);

  h.queue.addFiles([f]);
  let snap = h.queue.snapshot();
  assert.strictEqual(snap.items.length, 1, 'active duplicate not re-added');
  assert.strictEqual(snap.items[0].flash, true);
  await sleep(TEST_DELAYS.flash + 30);
  assert.strictEqual(h.items()[0].flash, false, 'flash clears after the delay');

  const out = outputPaths(f);
  fs.writeFileSync(out.txt, 'text');
  h.engine.calls.transcribe[0].resolveWith({ txt: out.txt, srt: out.srt });
  await settle();
  assert.strictEqual(h.items()[0].state, 'done');

  h.queue.addFiles([f]);
  assert.strictEqual(h.items().length, 2, 'finished duplicate re-adds');
});

test('duplicate LINK add flashes the existing row via a synchronous broadcast, cleared ~400ms later', async (t) => {
  const h = harness(t);
  const ok = h.queue.addLink('https://example.com/watch?v=dup');
  assert.strictEqual(ok, true);
  const id = h.items()[0].id;
  assert.strictEqual(h.items()[0].state, 'lookingUp', 'link is active (unfinished) so a re-add flashes');

  // Spy on the broadcast seam the queue pushes snapshots through to the renderer.
  const broadcasts = [];
  h.queue.onChange((snap) => broadcasts.push(snap));

  // Re-adding the same still-active link must NOT re-add, and must flash the
  // existing row. Regression: the old flash() only scheduled the 400ms CLEAR,
  // never broadcasting flash:true, so the renderer never saw the flash.
  const before = broadcasts.length;
  const ok2 = h.queue.addLink('https://example.com/watch?v=dup');
  assert.strictEqual(ok2, true);
  assert.strictEqual(h.items().length, 1, 'active duplicate not re-added');

  const flashOn = broadcasts.slice(before).filter(
    (s) => s.items.length === 1 && s.items[0].id === id && s.items[0].flash === true);
  assert.ok(flashOn.length >= 1, 'duplicate link add broadcasts flash:true synchronously');
  assert.strictEqual(h.queue.snapshot().items[0].flash, true);

  // ~400ms later (delays.flash) the flash clears with its own broadcast.
  const beforeClear = broadcasts.length;
  await sleep(TEST_DELAYS.flash + 30);
  const flashOff = broadcasts.slice(beforeClear).filter(
    (s) => s.items[0] && s.items[0].flash === false);
  assert.ok(flashOff.length >= 1, 'flash clears with a broadcast after the delay');
  assert.strictEqual(h.items()[0].flash, false, 'flash cleared (400ms pin preserved)');
});

test('missing-file actions: fileGoneNote + Finder fallback to containing folder (test log)', async (t) => {
  const h = harness(t);
  const f = h.mkFile('gone.mp4');
  h.queue.addFiles([f]);
  const out = outputPaths(f);
  fs.writeFileSync(out.txt, 'text');
  fs.writeFileSync(out.srt, '1\n');
  h.engine.calls.transcribe[0].resolveWith({ txt: out.txt, srt: out.srt });
  await settle();
  const id = h.items()[0].id;

  const opens = () => h.logLines().filter(
    (l) => l.action === 'openPath' || l.action === 'showItemInFolder');

  fs.unlinkSync(out.txt);
  h.queue.openTranscript(id);
  assert.strictEqual(h.items()[0].statusText, stubCopy.fileGoneNote);
  assert.strictEqual(opens().length, 0, 'nothing opened for a missing file');

  fs.unlinkSync(f);   // source gone too -> reveal falls back to the folder
  h.queue.showInFinder(id);
  const lines = opens();
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].action, 'openPath');
  assert.strictEqual(lines[0].arg, path.dirname(out.txt));
  assert.ok(Number.isFinite(lines[0].ts));
  assert.strictEqual(h.items()[0].statusText, stubCopy.fileGoneNote);

  await sleep(TEST_DELAYS.note + 30);
  assert.match(h.items()[0].statusText, /^Done in /, 'note is transient (4 s pin)');
});

test('copyTranscript: clipboard via test log + copiedFlash for the pinned window', async (t) => {
  const h = harness(t);
  const f = h.mkFile('copy.mp4');
  h.queue.addFiles([f]);
  const out = outputPaths(f);
  fs.writeFileSync(out.txt, 'hello world');
  h.engine.calls.transcribe[0].resolveWith({ txt: out.txt, srt: out.srt });
  await settle();
  const id = h.items()[0].id;

  h.queue.copyTranscript(id);
  const lines = h.logLines().filter((l) => l.action === 'copyText');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].arg, 'hello world');
  assert.strictEqual(h.items()[0].statusText, 'Transcript copied.');
  await sleep(TEST_DELAYS.copied + 30);
  assert.match(h.items()[0].statusText, /^Done in /, 'copied flash clears (2 s pin)');
});

test('empty transcript gets the no-speech doneNote', async (t) => {
  const h = harness(t);
  const f = h.mkFile('silent.mp4');
  h.queue.addFiles([f]);
  const out = outputPaths(f);
  fs.writeFileSync(out.txt, '  \n');
  h.engine.calls.transcribe[0].resolveWith({ txt: out.txt, srt: out.srt });
  await settle();
  const row = h.items()[0];
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(row.statusText, stubCopy.noSpeechNote('silent.mp4'));
});

test('model-missing preflight fails with the display name, engine never starts', async (t) => {
  const h = harness(t, { modelPresent: () => false });
  const f = h.mkFile('nomodel.mp4');
  h.queue.addFiles([f]);
  await settle();
  const row = h.items()[0];
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.statusText, stubCopy.failModelMissing('Best quality'));
  assert.strictEqual(h.engine.calls.transcribe.length, 0);
});

test('zero-length file preflight fails without the engine', async (t) => {
  const h = harness(t);
  const f = h.mkFile('empty.mp4', '');
  h.queue.addFiles([f]);
  await settle();
  assert.strictEqual(h.items()[0].state, 'failed');
  assert.strictEqual(h.items()[0].statusText, stubCopy.failZeroLength('empty.mp4'));
  assert.strictEqual(h.engine.calls.transcribe.length, 0);
});

test('link flow: lookingUp -> downloading -> waiting -> transcribing -> done', async (t) => {
  const h = harness(t);
  const ok = h.queue.addLink('  https://example.com/watch?v=abc  ');
  assert.strictEqual(ok, true);
  assert.strictEqual(h.queue.addLink('not a link'), false);

  let snap = h.queue.snapshot();
  assert.strictEqual(snap.items.length, 1);
  assert.strictEqual(snap.items[0].kind, 'link');
  assert.strictEqual(snap.items[0].state, 'lookingUp');
  assert.strictEqual(snap.items[0].statusText, 'Looking up video…');
  assert.strictEqual(snap.items[0].title, 'example.com/watch');
  const id = snap.items[0].id;

  h.settings.set('model', 'fast');   // links capture at DOWNLOAD start — too late

  const info = h.engine.calls.dlInfo[0];
  assert.strictEqual(info.url, 'https://example.com/watch?v=abc');
  info.resolveWith({ title: 'Zoo Tour', durationSec: 90, isLive: false, playlistCount: null });
  await settle();

  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].title, 'Zoo Tour');
  assert.strictEqual(snap.items[0].state, 'downloading');
  assert.strictEqual(snap.items[0].statusText, 'Downloading…');
  assert.strictEqual(snap.items[0].indeterminate, true);
  const get = h.engine.calls.dlGet[0];
  assert.strictEqual(get.args.mode, 'audio', 'keepVideo=false -> audio mode');
  assert.strictEqual(get.args.destDir, h.settings.downloadFolder());
  assert.strictEqual(snap.footer.text, 'Downloading "Zoo Tour" — 1 of 1');

  get.args.onProgress(40);
  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].progressPct, 40);
  assert.strictEqual(snap.items[0].statusText, 'Downloading — 40%');
  assert.strictEqual(snap.items[0].indeterminate, false);

  const media = path.join(h.dir, 'Zoo Tour [abc].m4a');
  fs.writeFileSync(media, 'audio-bytes');
  get.resolveWith({ file: media });
  await settle();

  assert.strictEqual(h.engine.calls.transcribe.length, 1, 'handed to the transcription lane');
  const tj = h.engine.calls.transcribe[0];
  assert.strictEqual(tj.args.input, media);
  assert.strictEqual(tj.args.modelSel, 'best', 'link captured settings when the download began');

  const out = outputPaths(media);
  fs.writeFileSync(out.txt, 'zoo words');
  tj.resolveWith({ txt: out.txt, srt: out.srt });
  await settle();

  snap = h.queue.snapshot();
  assert.strictEqual(snap.items[0].state, 'done');
  assert.strictEqual(snap.items[0].statusText,
    `Done in under a minute · saved in ${path.basename(h.dir)}`);
  assert.strictEqual(h.queue.stateOf(id), 'done');
});

test('keepVideo=true downloads in video mode', async (t) => {
  const h = harness(t, { settings: { keepVideo: true } });
  h.queue.addLink('https://example.com/v');
  h.engine.calls.dlInfo[0].resolveWith({ title: 'V', durationSec: 5, isLive: false, playlistCount: null });
  await settle();
  assert.strictEqual(h.engine.calls.dlGet[0].args.mode, 'video');
});

test('lookup watchdog kills a hung lookup and reports the network failure', async (t) => {
  const h = harness(t);
  h.queue.addLink('https://example.com/hang');
  assert.strictEqual(h.items()[0].state, 'lookingUp');
  await sleep(TEST_DELAYS.lookupWatchdog + 40);
  await settle();
  assert.strictEqual(h.engine.calls.dlInfo[0].cancelCalled, true);
  const row = h.items()[0];
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.statusText, stubCopy.failDownloadNetwork);
});

test('livestream and playlist lookups fail with their dedicated copy', async (t) => {
  const h = harness(t);
  h.queue.addLink('https://example.com/live');
  h.engine.calls.dlInfo[0].resolveWith({ title: 'L', durationSec: null, isLive: true, playlistCount: null });
  await settle();
  assert.strictEqual(h.items()[0].state, 'failed');
  assert.strictEqual(h.items()[0].statusText, stubCopy.failLivestream);

  h.queue.addLink('https://example.com/playlist');
  h.engine.calls.dlInfo[1].resolveWith({ title: 'P', durationSec: null, isLive: false, playlistCount: 7 });
  await settle();
  assert.strictEqual(h.items()[1].state, 'failed');
  assert.strictEqual(h.items()[1].statusText, stubCopy.failPlaylist(7));
  assert.strictEqual(h.engine.calls.dlGet.length, 0, 'no download stage for either');
});

test('queue-finished notifications: all four variants (window unfocused, test log)', async (t) => {
  const h = harness(t);

  // 1) single success
  const f1 = h.mkFile('n1.mp4');
  h.queue.addFiles([f1]);
  const o1 = outputPaths(f1);
  fs.writeFileSync(o1.txt, 'x');
  h.engine.calls.transcribe[0].resolveWith({ txt: o1.txt, srt: o1.srt });
  await settle();

  // 2) two successes
  const f2 = h.mkFile('n2.mp4');
  const f3 = h.mkFile('n3.mp4');
  h.queue.addFiles([f2, f3]);
  for (const [i, f] of [[1, f2], [2, f3]]) {
    const o = outputPaths(f);
    fs.writeFileSync(o.txt, 'x');
    h.engine.calls.transcribe[i].resolveWith({ txt: o.txt, srt: o.srt });
    await settle();
  }

  // 3) single failure — async engine failure: a synchronous preflight failure
  // never enters "working", so (as in AppModel.swift) it must not notify.
  const f4 = h.mkFile('n4.mp4');
  h.queue.addFiles([f4]);
  h.engine.calls.transcribe.at(-1).rejectWith({ message: 'fail', details: null });
  await settle();

  // 4) mixed
  const f5 = h.mkFile('n5.mp4');
  const f6 = h.mkFile('n6.mp4', '');
  h.queue.addFiles([f5, f6]);
  await settle();
  const o5 = outputPaths(f5);
  fs.writeFileSync(o5.txt, 'x');
  h.engine.calls.transcribe.at(-1).resolveWith({ txt: o5.txt, srt: o5.srt });
  await settle();

  const notifs = h.logLines().filter((l) => l.action === 'notify').map((l) => l.arg);
  assert.deepStrictEqual(notifs, [
    { title: 'Transcript ready', body: '"n1.txt" was saved next to your video.' },
    { title: 'All transcriptions finished', body: '2 transcripts are ready.' },
    { title: 'Transcription failed', body: '"n4.mp4" couldn\'t be transcribed. Open Transcribe for details.' },
    { title: 'Transcriptions finished', body: '1 done, 1 failed. Open Transcribe for details.' },
  ]);
});

test('notifyOnFinish=false suppresses the notification', async (t) => {
  const h = harness(t, { settings: { notifyOnFinish: false } });
  const f = h.mkFile('quiet.mp4');
  h.queue.addFiles([f]);
  const o = outputPaths(f);
  fs.writeFileSync(o.txt, 'x');
  h.engine.calls.transcribe[0].resolveWith({ txt: o.txt, srt: o.srt });
  await settle();
  assert.strictEqual(h.logLines().filter((l) => l.action === 'notify').length, 0);
});

test('snapshot shape: C4 fields, banner lifecycle, clear done, selection hint', async (t) => {
  const h = harness(t);
  let snap = h.queue.snapshot();
  assert.deepStrictEqual(Object.keys(snap).sort(),
    ['banner', 'catalog', 'deps', 'footer', 'items', 'languages', 'phase',
     'selectionHint', 'settings', 'update'].sort());
  assert.deepStrictEqual(snap.deps, {
    whisperOK: true, ffmpegOK: true, ytDlpOK: true, modelsOK: true, bestModelOK: true,
    linksLimited: false, setupNeeded: false, folderOK: true,
  });
  assert.strictEqual(snap.banner, null);
  assert.deepStrictEqual(snap.catalog.map((m) => m.sel), ['best', 'fast']);
  assert.strictEqual(snap.catalog[0].present, true);
  assert.strictEqual(snap.catalog[0].menuTitle, 'mt-best');
  assert.deepStrictEqual(snap.languages[0], { code: 'auto', name: 'Auto-detect' });
  assert.strictEqual(snap.settings.model, 'best');
  assert.strictEqual(snap.settings.downloadFolderDisplay, path.basename(h.dir));
  assert.strictEqual(snap.selectionHint.clearDoneVisible, false);

  h.queue.setBanner({ version: '9.9', url: 'https://example.com/rel' });
  snap = h.queue.snapshot();
  // banner.text is composed by main (C4) so the notice follows the UI language.
  assert.deepStrictEqual(snap.banner,
    { version: '9.9', url: 'https://example.com/rel', text: 'Version 9.9 is available.' });
  assert.deepStrictEqual(h.queue.getBanner(),
    { version: '9.9', url: 'https://example.com/rel', text: 'Version 9.9 is available.' });
  h.queue.dismissBanner();
  assert.strictEqual(h.queue.snapshot().banner, null);

  const f = h.mkFile('cd.mp4');
  h.queue.addFiles([f]);
  const row = h.items()[0];
  h.queue.select(row.id);
  assert.strictEqual(h.queue.snapshot().selectionHint.clearDoneVisible, false,
    'hidden while the selected row is in progress');
  const o = outputPaths(f);
  fs.writeFileSync(o.txt, 'x');
  h.engine.calls.transcribe[0].resolveWith({ txt: o.txt, srt: o.srt });
  await settle();
  assert.strictEqual(h.queue.snapshot().selectionHint.clearDoneVisible, true);
  h.queue.clearDone();
  assert.strictEqual(h.items().length, 0);
  assert.strictEqual(h.queue.snapshot().selectionHint.clearDoneVisible, false);
});

// Settings ▸ Updates. The panel must survive a dismissed banner, must never
// claim "you're on the latest version" when the check simply failed, and must
// say something useful in a locally built app that has no release to compare to.
test('update panel: version, auto-check, and every check outcome', async (t) => {
  const h = harness(t);

  // Before main reports an update source: version shown, checking impossible.
  let u = h.queue.snapshot().update;
  assert.strictEqual(u.versionLabel, 'Version 1.0.42');
  assert.strictEqual(u.currentVersion, '1.0.42');
  assert.strictEqual(u.autoCheck, true, 'the launch check defaults to on');
  assert.strictEqual(u.supported, false);
  assert.strictEqual(u.canCheck, false);
  assert.strictEqual(u.statusText, 'This copy was built locally.');
  assert.strictEqual(u.downloadUrl, null);

  h.queue.setUpdateState({ supported: true });
  u = h.queue.snapshot().update;
  assert.strictEqual(u.canCheck, true);
  assert.strictEqual(u.statusText, null, 'nothing to say until a check has run');

  h.queue.setUpdateState({ checking: true });
  u = h.queue.snapshot().update;
  assert.strictEqual(u.statusText, 'Checking…');
  assert.strictEqual(u.canCheck, false, 'no double-checking while one is in flight');

  h.queue.setUpdateState({ checking: false, result: 'upToDate', latestVersion: null, url: null });
  u = h.queue.snapshot().update;
  assert.strictEqual(u.statusText, "You're on the latest version.");
  assert.strictEqual(u.downloadUrl, null);

  // A failed check must NOT read as "up to date" — and must not blame the
  // user's connection when the server simply had no answer (a private repo
  // 404s anonymously on every launch).
  h.queue.setUpdateState({ result: 'failed', reason: 'network' });
  assert.strictEqual(h.queue.snapshot().update.statusText,
    "Couldn't check for updates just now.");
  h.queue.setUpdateState({ result: 'failed', reason: 'server' });
  assert.strictEqual(h.queue.snapshot().update.statusText,
    'The update service had no answer.');

  h.queue.setUpdateState({ result: 'available', latestVersion: '1.0.99', url: 'https://example.com/r', reason: null });
  u = h.queue.snapshot().update;
  assert.strictEqual(u.statusText, 'Version 1.0.99 is available.');
  assert.strictEqual(u.downloadUrl, 'https://example.com/r');

  // The banner is dismissible; the panel and the Download target are not.
  h.queue.setBanner({ version: '1.0.99', url: 'https://example.com/r' });
  assert.strictEqual(h.queue.getUpdateUrl(), 'https://example.com/r');
  h.queue.dismissBanner();
  assert.strictEqual(h.queue.snapshot().banner, null);
  assert.strictEqual(h.queue.snapshot().update.statusText, 'Version 1.0.99 is available.');
  assert.strictEqual(h.queue.getUpdateUrl(), 'https://example.com/r',
    'Download still works after the banner is dismissed');

  // A release can be pulled. Once a later check says we're current, the Download
  // target must NOT still be the withdrawn release's page — the freshest check
  // wins over a banner that outlived its finding.
  h.queue.setBanner({ version: '1.0.99', url: 'https://example.com/withdrawn' });
  h.queue.setUpdateState({ result: 'upToDate', latestVersion: null, url: null });
  assert.strictEqual(h.queue.snapshot().update.downloadUrl, null);
  assert.strictEqual(h.queue.getUpdateUrl(), null,
    'no dead link once the app knows it is current');

  // Turning the preference off is reflected straight away.
  h.queue.snapshot();
  h.settings.set('autoCheckUpdates', false);
  assert.strictEqual(h.queue.snapshot().update.autoCheck, false);
});

test('update panel: no app version injected → no version label, no crash', async (t) => {
  const h = harness(t, { appVersion: null });
  const u = h.queue.snapshot().update;
  assert.strictEqual(u.versionLabel, null);
  assert.strictEqual(u.currentVersion, null);
});

// Dropping a folder used to produce ONE row that failed with "the file can't be
// found any more" — a message that is also untrue. It is the first gesture
// someone with a folder of lectures tries.
test('dropping a folder enqueues the media inside it, in name order', async (t) => {
  const h = harness(t);
  const folder = path.join(h.dir, 'Predavanja');
  fs.mkdirSync(folder);
  for (const n of ['c.mp4', 'a.mov', 'b.mp3', 'notes.txt', 'cover.jpg', '.hidden.mp4']) {
    fs.writeFileSync(path.join(folder, n), 'media-bytes');
  }
  fs.mkdirSync(path.join(folder, 'nested'));
  fs.writeFileSync(path.join(folder, 'nested', 'deep.mp4'), 'media-bytes');

  h.queue.addFiles([folder]);
  const titles = h.queue.snapshot().items.map((i) => i.title);

  assert.deepStrictEqual(titles, ['.hidden.mp4', 'a.mov', 'b.mp3', 'c.mp4'],
    'media only, sorted; no row for the folder itself');
  assert.ok(!titles.includes('notes.txt'), 'non-media ignored');
  assert.ok(!titles.includes('cover.jpg'), 'images ignored');
  assert.ok(!titles.includes('deep.mp4'), 'one level only — a nested folder is not walked');
});

test('a folder with no media adds nothing at all (no misleading failed row)', async (t) => {
  const h = harness(t);
  const folder = path.join(h.dir, 'Documents');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'readme.txt'), 'x');
  h.queue.addFiles([folder]);
  assert.deepStrictEqual(h.queue.snapshot().items, []);
});

test('files and folders can be dropped together', async (t) => {
  const h = harness(t);
  const loose = h.mkFile('loose.mp4');
  const folder = path.join(h.dir, 'batch');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'inside.mov'), 'media-bytes');
  h.queue.addFiles([loose, folder]);
  assert.deepStrictEqual(h.queue.snapshot().items.map((i) => i.title), ['loose.mp4', 'inside.mov']);
});

test('cancel of a single active item; startAgain reruns it', async (t) => {
  const h = harness(t);
  const f = h.mkFile('again.mp4');
  h.queue.addFiles([f]);
  const id = h.items()[0].id;
  h.queue.cancel(id);
  assert.strictEqual(h.items()[0].state, 'canceled');
  assert.strictEqual(h.engine.calls.transcribe[0].cancelCalled, true);
  await settle();

  h.queue.startAgain(id);
  assert.strictEqual(h.engine.calls.transcribe.length, 2, 'startAgain re-enters the lane');
  assert.strictEqual(h.items()[0].state, 'preparing');
});

test('linkValid mirrors the classifier; addFiles ignored during setup phase', (t) => {
  const h = harness(t);
  assert.strictEqual(h.queue.linkValid(' https://a.com/x '), true);
  assert.strictEqual(h.queue.linkValid('nope'), false);

  const engine = makeEngine();
  engine.probeDeps = () => ({ setupNeeded: true, linksLimited: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-setup-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });
  const q2 = createQueue({
    engine, settings: createSettings({ downloadsDir: dir }),
    sys: createSystemAdapter({ env: {} }),
    copy: stubCopy, catalog: stubCatalog, languages: stubLanguages, logic: stubLogic,
    modelPresent: () => true, delays: TEST_DELAYS,
  });
  q2.probeDeps();
  assert.strictEqual(q2.snapshot().phase, 'setup');
  q2.addFiles([path.join(dir, 'x.mp4')]);
  assert.strictEqual(q2.snapshot().items.length, 0, 'setup phase accepts no work');
  assert.strictEqual(q2.addLink('https://a.com/x'), false);
});
