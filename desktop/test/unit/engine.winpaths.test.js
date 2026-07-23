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
const { whisperOutputPlan, moveOutput } = _internals;

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

// Documents the residual: a non-ASCII Windows *username* leaks into workDir (and
// the model path), so ofBase's DIRECTORY is still non-ASCII — but the -of LEAF
// is always ASCII 'out', so the title-derived corruption (the guaranteed-broken
// common case) is gone regardless. The finding flags the username case as the
// harder residual; this asserts the boundary of the fix.
test('win32: non-ASCII username is the documented residual (leaf still ASCII "out")', () => {
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
