// engine.winpaths.test.js — FIX 2 (Windows ANSI-codepage filename corruption).
// whisper-cli.exe parses argv through the system ANSI codepage, so a -of path
// carrying non-codepage chars (Croatian č/š/ž, CJK, emoji from yt-dlp titles)
// gets mangled and the transcript lands nowhere. whisperOutputPlan reroutes -of
// through an ASCII name inside the app-controlled workDir on win32 and maps the
// produced out.txt/out.srt back to the real Unicode destination; darwin writes
// straight to the destination with no rename. Pure + platform-injectable so the
// win32 mapping is verifiable from a mac.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./engine.shim.js').ensureShared();
const { _internals } = require('../../main/engine.js');
const copy = require('../../shared/copy.js');
const { whisperOutputPlan, moveOutput, moveOutputWithRetry, outputWriteError } = _internals;

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

// The PRIMARY Croatian case: a yt-dlp download whose title is full of
// diacritics. On win32 the -of base must be ASCII 'out' inside workDir, and the
// produced files must map back to the Unicode destination next to the source.
test('win32: -of is ASCII "out" inside workDir; out.{txt,srt} map to the Unicode dest', () => {
  const dir = 'C:\\Users\\ana\\Downloads';
  const input = path.win32.join(dir, 'Čćžšđ – proba [dQw4w9WgXcQ].mp4');
  const workDir = 'C:\\Users\\ana\\AppData\\Local\\Temp\\com.flisko.transcribe\\job-1';

  const plan = whisperOutputPlan({ platform: 'win32', input, workDir });

  // -of points at an ASCII base *inside* workDir — no title char reaches whisper.
  assert.equal(plan.ofBase, path.win32.join(workDir, 'out'));
  assert.equal(path.win32.basename(plan.ofBase), 'out');
  assert.ok(isAscii(plan.ofBase), 'ofBase carries no non-codepage chars (ASCII username here)');
  assert.ok(!/[čćžšđ]/i.test(plan.ofBase), 'the diacritic title never leaks into the -of arg');

  // The real destination keeps the full Unicode stem, next to the source.
  assert.equal(plan.txt, path.win32.join(dir, 'Čćžšđ – proba [dQw4w9WgXcQ].txt'));
  assert.equal(plan.srt, path.win32.join(dir, 'Čćžšđ – proba [dQw4w9WgXcQ].srt'));

  // Fresh-mtime check runs against what whisper actually wrote (workDir/out.*).
  assert.equal(plan.producedTxt, path.win32.join(workDir, 'out.txt'));
  assert.equal(plan.producedSrt, path.win32.join(workDir, 'out.srt'));

  // The rename map moves out.txt -> Čćžšđ….txt (and .srt) after success.
  assert.deepEqual(plan.renames, [
    { from: path.win32.join(workDir, 'out.txt'), to: plan.txt },
    { from: path.win32.join(workDir, 'out.srt'), to: plan.srt },
  ]);
});

// darwin must be byte-identical to the prior inline logic: -of writes straight
// to the destination stem, nothing is renamed.
test('darwin: -of is the direct destination stem; no rename', () => {
  const dir = '/Users/ana/Downloads';
  const input = path.posix.join(dir, 'Čćžšđ – proba škola (v šoli).mov');
  const workDir = '/tmp/com.flisko.transcribe/job-1';

  const plan = whisperOutputPlan({ platform: 'darwin', input, workDir });

  const base = path.posix.join(dir, 'Čćžšđ – proba škola (v šoli)');
  assert.equal(plan.ofBase, base, '-of points straight at the Unicode dest stem');
  assert.equal(plan.txt, `${base}.txt`);
  assert.equal(plan.srt, `${base}.srt`);
  assert.equal(plan.producedTxt, plan.txt, 'whisper writes the dest directly');
  assert.equal(plan.producedSrt, plan.srt);
  assert.deepEqual(plan.renames, [], 'darwin never renames');
  // No workDir reference at all on darwin.
  assert.ok(!plan.ofBase.includes(workDir));
});

// Even an emoji title (yt-dlp keeps these) is fully stripped from the -of arg.
test('win32: emoji title never reaches whisper argv', () => {
  const input = 'C:\\dl\\🎉 Party [abc123].m4a';
  const workDir = 'C:\\tmp\\job';
  const plan = whisperOutputPlan({ platform: 'win32', input, workDir });
  assert.equal(path.win32.basename(plan.ofBase), 'out');
  assert.ok(isAscii(plan.ofBase));
  assert.equal(plan.txt, 'C:\\dl\\🎉 Party [abc123].txt');
  assert.equal(plan.renames[0].to, plan.txt);
});

// A non-ASCII Windows *username* leaks into workDir, so ofBase's DIRECTORY here
// is still non-ASCII — but the -of LEAF is always ASCII 'out', which is all this
// pure mapping is responsible for (the title-derived corruption is gone). The
// non-ASCII-DIRECTORY problem (measured on real Windows to CRASH whisper —
// 0xC0000409 — even for cp1250-representable C:\Users\Žiga\…) is fixed at the RUN
// level, not here: queue.js chooseJobBase gives an ASCII workDir and the engine
// hardlinks a non-ASCII model into it (see win-username-codepage.test.js). So this
// asserts only the boundary of whisperOutputPlan, which by design leaves the
// workDir untouched.
test('win32: non-ASCII username — whisperOutputPlan leaves workDir as-is (leaf still ASCII "out")', () => {
  const input = 'C:\\Users\\Žiga\\Downloads\\Čćžšđ [id].mp4';
  const workDir = 'C:\\Users\\Žiga\\AppData\\Local\\Temp\\job';
  const plan = whisperOutputPlan({ platform: 'win32', input, workDir });
  assert.equal(path.win32.basename(plan.ofBase), 'out', 'the -of leaf is always ASCII');
  assert.ok(!/[čćžšđ]/i.test(path.win32.basename(plan.ofBase)), 'no title chars in the leaf');
  assert.ok(!isAscii(plan.ofBase), 'residual: the username dir is still non-ASCII (documented)');
});

// Stem rules must match bin/transcribe on both platforms: dotted parent folders
// don't eat the name; a leading-dot filename keeps its whole name.
test('stem rules: dotted folder and dotfile (both platforms)', () => {
  // Dotted parent folder, extensionless file → whole basename is the stem.
  const win = whisperOutputPlan({
    platform: 'win32', input: 'C:\\my.stuff\\lecture', workDir: 'C:\\tmp\\j',
  });
  assert.equal(win.txt, 'C:\\my.stuff\\lecture.txt');
  assert.equal(win.renames[0].to, win.txt);

  // Leading-dot filename: dot at index 0 → not an extension separator.
  const mac = whisperOutputPlan({
    platform: 'darwin', input: '/home/x/.hidden', workDir: '/tmp/j',
  });
  assert.equal(mac.ofBase, '/home/x/.hidden');
  assert.equal(mac.txt, '/home/x/.hidden.txt');
});

// moveOutput: same-volume rename (the normal case) actually moves the file.
test('moveOutput: renames on the same volume', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-mv-'));
  try {
    const from = path.join(d, 'out.txt');
    const to = path.join(d, 'Čćžšđ.txt');
    fs.writeFileSync(from, 'hello');
    moveOutput(from, to);
    assert.equal(fs.existsSync(from), false, 'source gone');
    assert.equal(fs.readFileSync(to, 'utf8'), 'hello', 'content at dest');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// moveOutput: cross-volume EXDEV (Windows temp-vs-dest) falls back to copy+unlink.
// engine.js and this test share the one fs singleton, so patching renameSync
// exercises the real fallback path.
test('moveOutput: EXDEV falls back to copy + unlink', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-exdev-'));
  const realRename = fs.renameSync;
  try {
    const from = path.join(d, 'out.srt');
    const to = path.join(d, 'moved.srt');
    fs.writeFileSync(from, 'srt-body');
    fs.renameSync = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
    moveOutput(from, to);
    assert.equal(fs.existsSync(from), false, 'source unlinked after copy');
    assert.equal(fs.readFileSync(to, 'utf8'), 'srt-body', 'content copied to dest');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// moveOutput: a non-EXDEV error propagates (we don't silently swallow real IO
// failures like a missing source).
test('moveOutput: non-EXDEV errors propagate', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-err-'));
  try {
    assert.throws(
      () => moveOutput(path.join(d, 'does-not-exist.txt'), path.join(d, 'x.txt')),
      (e) => e && e.code === 'ENOENT',
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---- locked destination (measured on real Windows: rename onto a file another
// process holds open throws EPERM; copyFileSync onto it throws EBUSY) ---------

// Defender/the indexer can hold a just-written file for a beat. Those clear, so
// the lock codes are retried before the move is called a failure.
test('moveOutputWithRetry: a transient lock is retried, then succeeds', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-retry-'));
  const realRename = fs.renameSync;
  let calls = 0;
  try {
    const from = path.join(d, 'out.txt');
    const to = path.join(d, 'Čćžšđ.txt');
    fs.writeFileSync(from, 'body');
    fs.renameSync = (a, b) => {
      calls += 1;
      if (calls < 3) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
      return realRename(a, b);
    };
    await moveOutputWithRetry(from, to, 4, 1);
    assert.equal(calls, 3, 'retried twice before succeeding');
    assert.equal(fs.readFileSync(to, 'utf8'), 'body');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('moveOutputWithRetry: a lock that never clears gives up after the last attempt', async () => {
  const realRename = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = () => { calls += 1; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
    await assert.rejects(moveOutputWithRetry('a', 'b', 3, 1), (e) => e.code === 'EPERM');
    assert.equal(calls, 3, 'exactly the requested number of attempts');
  } finally {
    fs.renameSync = realRename;
  }
});

test('moveOutputWithRetry: a non-lock error fails immediately (no pointless waiting)', async () => {
  const realRename = fs.renameSync;
  let calls = 0;
  try {
    fs.renameSync = () => { calls += 1; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    await assert.rejects(moveOutputWithRetry('a', 'b', 4, 1), (e) => e.code === 'ENOENT');
    assert.equal(calls, 1);
  } finally {
    fs.renameSync = realRename;
  }
});

// The whole point: the row's status line must never read
// "EPERM: operation not permitted, rename 'C:\…\out.txt' -> …".
test('outputWriteError: a locked destination names the file to close, raw fs text only in details', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-locked-'));
  try {
    // The destination EXISTS -> something is holding it open.
    const dest = path.join(d, 'Čćžšđ.txt');
    fs.writeFileSync(dest, 'previous transcript');
    const e = Object.assign(new Error(`EPERM: operation not permitted, rename 'C:\\w\\out.txt' -> '${dest}'`),
      { code: 'EPERM' });
    const err = outputWriteError(e, dest, 'best', 'Čćžšđ.mp4');
    assert.equal(err.message, copy.failOutputLocked('Čćžšđ.txt'));
    assert.ok(!/EPERM/.test(err.message), 'no raw errno in the user-facing message');
    assert.match(err.details, /EPERM/, 'the raw text is still available for Copy Error Details');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// Same errno, opposite cure. On Windows a directory whose write ACE is denied
// still PASSES fs.accessSync(dir, W_OK) — measured — so the queue's pre-flight
// waves it through and the refusal only lands here. "Close Word" would send this
// user hunting for a program that isn't running.
test('outputWriteError: EPERM with no destination file is a folder problem, not a lock', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'winpaths-denied-'));
  try {
    const dest = path.join(d, 'nope.txt');   // deliberately never created
    const e = Object.assign(new Error(`EPERM: operation not permitted, rename 'x' -> '${dest}'`),
      { code: 'EPERM' });
    const err = outputWriteError(e, dest, 'best', 'clip.mp4');
    assert.equal(err.message, copy.failOutputDirReadOnly('clip.mp4'));
    assert.ok(!/EPERM/.test(err.message));
    assert.match(err.details, /EPERM/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('outputWriteError: other failures go through the normal classifier', () => {
  const full = Object.assign(new Error('ENOSPC: no space left on device, rename …'), { code: 'ENOSPC' });
  assert.equal(outputWriteError(full, '/d/a.txt', 'best', 'a.mp4').message, copy.failDisk);

  const odd = Object.assign(new Error('EIO: i/o error, rename …'), { code: 'EIO' });
  const err = outputWriteError(odd, '/d/a.txt', 'best', 'a.mp4');
  assert.equal(err.message, copy.failTranscription);
  assert.ok(!/EIO/.test(err.message), 'never leaks the raw errno');
});
