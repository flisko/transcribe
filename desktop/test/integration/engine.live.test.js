// engine.live.test.js — REAL engine integration on this mac (C10): real
// whisper-cli/ffmpeg/yt-dlp, real network, real cancellation with pgrep
// orphan checks. Run explicitly:
//   node --test desktop/test/integration/engine.live.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../unit/engine.shim.js').ensureShared(); // no-op once shared/ landed
const engine = require('../../main/engine.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SAMPLE = path.join(REPO_ROOT, 'IMG_2827.mov');
const ZOO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const BIGGER_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // 3:32 — long enough to cancel mid-download
const SCRATCH_BASE = process.env.TRANSCRIBE_TEST_SCRATCH || os.tmpdir();

const scratchDirs = [];
function scratch(label) {
  const d = fs.mkdtempSync(path.join(SCRATCH_BASE, `transcribe-live-${label}-`));
  scratchDirs.push(d);
  return d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Survivor search, real on both platforms: pgrep on mac, tasklist on win.
function pgrep(args) {
  if (process.platform === 'win32') {
    const name = args[args.length - 1];
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' });
      return out.split('\n').filter((l) => l.includes(`${name}.exe`));
    } catch (_) { return []; }
  }
  try {
    return execFileSync('/usr/bin/pgrep', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch (_) {
    return []; // exit 1 = no match
  }
}

function groupAlive(pid) {
  try {
    // Negative-pid group signaling is POSIX-only; a plain liveness probe is
    // the right equivalent on Windows (taskkill /T killed the whole tree).
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// GitHub-hosted runners are datacenter IPs that YouTube often bot-walls. A
// CLASSIFIED failure still proves the whole pipeline (spawn, deno challenge
// runtime, stderr classification) — only an unclassified crash is a bug.
const copy = require('../../shared/copy.js');
const TOLERATED_BLOCKS = [
  copy.failDownloadNetwork, copy.failStaleDownloader,
  copy.failDownloadPrivateOrRemoved, copy.failLookup,
];
function toleratedBlock(t, e) {
  if (e && TOLERATED_BLOCKS.includes(e.message)) {
    t.diagnostic('video site blocked this network — classified cleanly: ' + e.message);
    return true;
  }
  return false;
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(200);
  }
  assert.ok(cond(), `timed out waiting for: ${label}`);
}

function ffprobeCodec(file) {
  return execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` } }).trim();
}

function tmpLogsNewerThan(t0) {
  return fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('transcribe_log_'))
    .filter((n) => {
      try { return fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= t0; } catch (_) { return false; }
    });
}

test.after(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

// CI runners install the tools but never the multi-GB models, so model and
// setup flags are only asserted where the models actually exist.
const HAS_MODELS = engine.probeDeps().bestModelOK && engine.probeDeps().fastModelOK;

test('probeDeps: tools installed; model flags asserted only when models exist', () => {
  const r = engine.probeDeps();
  console.log('probeDeps:', JSON.stringify(r));
  assert.equal(r.whisperOK, true);
  assert.equal(r.ffmpegOK, true);
  assert.equal(r.ytDlpOK, true);
  assert.equal(r.folderOK, true);
  assert.equal(r.linksLimited, false);
  if (HAS_MODELS) {
    assert.equal(r.bestModelOK, true);
    assert.equal(r.fastModelOK, true);
    assert.equal(r.setupNeeded, false);
  }
});

test('transcribe: diacritics+spaces name, fast/hr → txt+srt, early 1%, progress rose', { skip:
  (!fs.existsSync(SAMPLE) && 'local sample fixture not present (never committed)') ||
  (!HAS_MODELS && 'models not downloaded (CI never fetches them)') }, async () => {
  const dir = scratch('tx');
  const workDir = scratch('txwork');
  const input = path.join(dir, 'Čćžšđ – proba škola (v šoli).mov');
  fs.copyFileSync(SAMPLE, input);

  const pcts = [];
  const { txt, srt } = await engine.transcribe({
    input, modelSel: 'fast', lang: 'hr', workDir,
    onProgress: (p) => pcts.push(p),
  });
  console.log('transcribe progress:', JSON.stringify(pcts));
  console.log('txt:', txt);

  assert.equal(txt, path.join(dir, 'Čćžšđ – proba škola (v šoli).txt'));
  assert.equal(srt, path.join(dir, 'Čćžšđ – proba škola (v šoli).srt'));
  assert.ok(fs.existsSync(txt), 'txt exists');
  assert.ok(fs.existsSync(srt), 'srt exists');
  const text = fs.readFileSync(txt, 'utf8').trim();
  console.log('transcript head:', text.slice(0, 120));
  assert.ok(text.length > 0, 'transcript non-empty');

  // Early 1% (short-clip fix) must arrive before anything larger, and rise to 100.
  assert.ok(pcts.includes(1), 'saw the early 1%');
  const idx1 = pcts.indexOf(1);
  assert.ok(pcts.slice(0, idx1).every((p) => p < 1), '1% precedes larger values');
  assert.ok(pcts[pcts.length - 1] === 100, 'ends at 100');
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] > pcts[i - 1], 'monotone');
  assert.ok(!fs.existsSync(path.join(workDir, 'audio.wav')), 'wav cleaned');
});

test('dlInfo: zoo video → title/duration', async (t) => {
  let info;
  try { info = await engine.dlInfo(ZOO_URL); }
  catch (e) { if (toleratedBlock(t, e)) return; throw e; }
  console.log('dlInfo:', JSON.stringify(info));
  assert.equal(info.title, 'Me at the zoo');
  assert.equal(info.durationSec, 19);
  assert.equal(info.isLive, false);
});

test('dlGet audio: zoo video → .m4a in dest, aac stream, staging cleaned', async (t) => {
  const dest = scratch('dl');
  const pcts = [];
  let file;
  try { ({ file } = await engine.dlGet({
    url: ZOO_URL, mode: 'audio', destDir: dest,
    onProgress: (p) => pcts.push(p),
  })); }
  catch (e) {
    if (toleratedBlock(t, e)) {
      const leftovers = fs.readdirSync(dest).filter((n) => n.startsWith('.transcribe-dl.'));
      assert.deepEqual(leftovers, [], 'staging removed even on failure');
      return;
    }
    throw e;
  }
  console.log('dlGet file:', file, 'progress:', JSON.stringify(pcts));
  assert.ok(file.startsWith(dest + path.sep), 'file is in destDir');
  assert.ok(file.endsWith('.m4a'), 'm4a extension');
  assert.ok(file.includes('[jNQXAC9IVRw]'), 'id in filename');
  assert.ok(fs.statSync(file).size > 0, 'non-empty');
  assert.equal(ffprobeCodec(file), 'aac');
  assert.equal(pcts[pcts.length - 1], 100, 'reached 100 after move');
  assert.ok(pcts.filter((p) => p > 0 && p < 100).every((p) => p <= 99), 'held ≤99 until final path');
  const leftovers = fs.readdirSync(dest).filter((n) => n.startsWith('.transcribe-dl.'));
  assert.deepEqual(leftovers, [], 'staging removed');
});

test('cancel transcribe (best model): killTree → zero whisper/ffmpeg survivors, temp cleaned', { skip:
  (!fs.existsSync(SAMPLE) && 'local sample fixture not present (never committed)') ||
  (!HAS_MODELS && 'models not downloaded (CI never fetches them)') }, async () => {
  const dir = scratch('cancel');
  const workDir = scratch('cancelwork');
  const input = path.join(dir, 'Čudni šum đaka (káncel).mov');
  fs.copyFileSync(SAMPLE, input);
  const t0 = Date.now();

  const children = [];
  const p = engine.transcribe({
    input, modelSel: 'best', lang: 'hr', workDir,
    onChild: (c) => children.push(c),
  });
  await sleep(2000);
  const victim = children[children.length - 1];
  console.log('children spawned:', children.map((c) => c.pid), '→ killing', victim.pid);
  engine.killTree(victim);

  await assert.rejects(p, (e) => e.canceled === true, 'rejects as canceled');

  await waitFor(() => children.every((c) => !groupAlive(c.pid)), 6000, 'process groups dead');
  const whisperLeft = pgrep(['-x', 'whisper-cli']);
  const ffmpegLeft = pgrep(['-x', 'ffmpeg']);
  console.log('pgrep whisper-cli:', JSON.stringify(whisperLeft), 'pgrep ffmpeg:', JSON.stringify(ffmpegLeft));
  assert.deepEqual(whisperLeft, [], 'no whisper-cli survivors');
  assert.deepEqual(ffmpegLeft, [], 'no ffmpeg survivors');

  assert.ok(!fs.existsSync(input.replace(/\.mov$/, '.txt')), 'partial txt removed');
  assert.ok(!fs.existsSync(input.replace(/\.mov$/, '.srt')), 'partial srt removed');
  assert.ok(!fs.existsSync(path.join(workDir, 'audio.wav')), 'wav cleaned');
  const logs = tmpLogsNewerThan(t0);
  console.log('leftover transcribe logs:', JSON.stringify(logs));
  assert.deepEqual(logs, [], 'whisper log cleaned on cancel');
});

test('cancel dlGet: killTree after ~1s → zero yt-dlp survivors, staging gone', async (t) => {
  const dest = scratch('dlcancel');
  const children = [];
  let sawProgress = false;
  // Video mode (two download stages) gives a real cancellation window — the
  // audio-only fetch of this clip can finish in under a second and race the kill.
  const p = engine.dlGet({
    url: BIGGER_URL, mode: 'video', destDir: dest,
    onChild: (c) => children.push(c),
    onProgress: () => { sawProgress = true; },
  });
  await waitFor(() => sawProgress || children.length > 0, 15000, 'download visibly started');
  if (children.length === 0) {
    // Blocked before spawn-visible progress — accept only a clean classified failure.
    try { await p; } catch (e) { if (toleratedBlock(t, e)) return; throw e; }
    return;
  }
  assert.equal(children.length, 1);
  const child = children[0];
  console.log('killing yt-dlp pid', child.pid);
  engine.killTree(child);

  try {
    await assert.rejects(p, (e) => e.canceled === true, 'rejects as canceled');
  } catch (err) {
    // Photo-finish: the download completed before SIGTERM landed. The cancel
    // semantics are still covered by the transcribe-cancel test; survivor and
    // staging assertions below remain meaningful either way.
    const settled = await p.then(() => true, () => false);
    if (!settled) throw err;
    t.diagnostic('download finished before the kill — proceeding to survivor checks');
  }

  await waitFor(() => !groupAlive(child.pid), 6000, 'yt-dlp group dead');
  const ytLeft = pgrep(['-f', 'yt-dlp']);
  console.log('pgrep -f yt-dlp:', JSON.stringify(ytLeft));
  assert.deepEqual(ytLeft, [], 'no yt-dlp survivors');

  const litter = fs.readdirSync(dest).filter((n) =>
    n.startsWith('.transcribe-dl.') || n.endsWith('.part') || n.endsWith('.ytdl'));
  assert.deepEqual(litter, [], 'no staging dirs or partial files in dest');
});
