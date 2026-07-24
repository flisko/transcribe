// engine.collision.test.js — C3 collision contract: identical bytes reuse the
// existing file; differing bytes get " (2)"-numbered, never overwritten.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('./engine.shim.js').ensureShared();
const { _internals } = require('../../main/engine.js');
const { moveIntoDest, filesIdentical, findStagedFile } = _internals;

function setup() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-collide-'));
  const staging = path.join(dest, '.transcribe-dl.test');
  fs.mkdirSync(staging);
  return { dest, staging };
}

test('no collision: staged file moves straight into dest', () => {
  const { dest, staging } = setup();
  const src = path.join(staging, 'Clip [abc123DEF-_].m4a');
  fs.writeFileSync(src, 'AUDIO-BYTES');
  const target = moveIntoDest(src, dest);
  assert.equal(target, path.join(dest, 'Clip [abc123DEF-_].m4a'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'AUDIO-BYTES');
  assert.ok(!fs.existsSync(src));
  fs.rmSync(dest, { recursive: true, force: true });
});

test('identical bytes: reuse existing file, staged copy removed, no numbering', () => {
  const { dest, staging } = setup();
  const existing = path.join(dest, 'Clip [abc].m4a');
  fs.writeFileSync(existing, 'SAME-BYTES');
  const src = path.join(staging, 'Clip [abc].m4a');
  fs.writeFileSync(src, 'SAME-BYTES');
  const target = moveIntoDest(src, dest);
  assert.equal(target, existing);
  assert.ok(!fs.existsSync(src), 'staged duplicate deleted');
  assert.ok(!fs.existsSync(path.join(dest, 'Clip [abc] (2).m4a')), 'no numbered copy');
  fs.rmSync(dest, { recursive: true, force: true });
});

test('differing bytes: existing file untouched, new file gets " (2)"', () => {
  const { dest, staging } = setup();
  const existing = path.join(dest, 'Clip [abc].m4a');
  fs.writeFileSync(existing, 'OLD-BYTES');
  const src = path.join(staging, 'Clip [abc].m4a');
  fs.writeFileSync(src, 'NEW-DIFFERENT-BYTES');
  const target = moveIntoDest(src, dest);
  assert.equal(target, path.join(dest, 'Clip [abc] (2).m4a'));
  assert.equal(fs.readFileSync(existing, 'utf8'), 'OLD-BYTES', 'original never overwritten');
  assert.equal(fs.readFileSync(target, 'utf8'), 'NEW-DIFFERENT-BYTES');
  fs.rmSync(dest, { recursive: true, force: true });
});

test('numbering continues past taken slots: (2) exists → (3)', () => {
  const { dest, staging } = setup();
  fs.writeFileSync(path.join(dest, 'Clip [abc].m4a'), 'A');
  fs.writeFileSync(path.join(dest, 'Clip [abc] (2).m4a'), 'B');
  const src = path.join(staging, 'Clip [abc].m4a');
  fs.writeFileSync(src, 'C');
  const target = moveIntoDest(src, dest);
  assert.equal(target, path.join(dest, 'Clip [abc] (3).m4a'));
  fs.rmSync(dest, { recursive: true, force: true });
});

test('extensionless name numbers without a stray dot', () => {
  const { dest, staging } = setup();
  fs.writeFileSync(path.join(dest, 'Clipfile'), 'A');
  const src = path.join(staging, 'Clipfile');
  fs.writeFileSync(src, 'B');
  const target = moveIntoDest(src, dest);
  assert.equal(target, path.join(dest, 'Clipfile (2)'));
  fs.rmSync(dest, { recursive: true, force: true });
});

test('filesIdentical: same size different bytes is not identical', () => {
  const { dest } = setup();
  const a = path.join(dest, 'a');
  const b = path.join(dest, 'b');
  fs.writeFileSync(a, 'XXXX');
  fs.writeFileSync(b, 'XXXY');
  assert.equal(filesIdentical(a, b), false);
  fs.writeFileSync(b, 'XXXX');
  assert.equal(filesIdentical(a, b), true);
  assert.equal(filesIdentical(a, path.join(dest, 'missing')), false);
  fs.rmSync(dest, { recursive: true, force: true });
});

// findStagedFile: recover the finished download by scanning the staging dir when
// yt-dlp's printed path is unusable (Windows stdout mangling a non-ASCII name).
test('findStagedFile: returns the sole non-temp file, ignoring .part/.ytdl', () => {
  const { dest, staging } = setup();
  assert.equal(findStagedFile(staging), null, 'empty dir → null');
  fs.writeFileSync(path.join(staging, 'Čćžšđ 🎬 [id].m4a'), 'AUDIO');   // Unicode name (the real case)
  fs.writeFileSync(path.join(staging, 'Čćžšđ 🎬 [id].m4a.part'), 'PARTIAL');
  fs.writeFileSync(path.join(staging, 'frag.ytdl'), 'X');
  assert.equal(findStagedFile(staging), path.join(staging, 'Čćžšđ 🎬 [id].m4a'),
    'picks the finished Unicode-named file, skips temp artifacts');
  assert.equal(findStagedFile(path.join(dest, 'no-such-dir')), null, 'missing dir → null');
  fs.rmSync(dest, { recursive: true, force: true });
});
