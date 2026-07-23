// main-lifecycle.test.js — pure pieces of main.js's startup-open handling
// (FIX C). main.js itself requires electron and can't load under `node --test`,
// so the arg-filtering + relative-path resolution live in main/startup-args.js
// and are tested here in isolation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { filterStartupArgs, resolveOpenArg } = require('../../main/startup-args.js');

// ---- filterStartupArgs ----------------------------------------------------

test('filterStartupArgs packaged: drops argv[0] (the .exe), keeps operands', () => {
  const argv = ['C:\\Apps\\Transcribe\\Transcribe.exe', 'C:\\Users\\me\\clip.mp4'];
  assert.deepEqual(filterStartupArgs(argv, { packaged: true }), ['C:\\Users\\me\\clip.mp4']);
});

test('filterStartupArgs dev: drops electron exe + main script (argv[0], argv[1])', () => {
  const argv = ['/path/to/electron', '/repo/desktop/main.js', '/repo/sample.mp4'];
  assert.deepEqual(filterStartupArgs(argv, { packaged: false }), ['/repo/sample.mp4']);
});

test('filterStartupArgs: Chromium/Electron switches (leading "-") are dropped', () => {
  const argv = [
    'Transcribe.exe',
    '--enable-logging',
    '--inspect=9229',
    '-psn_0_12345',
    'C:\\a\\video.mkv',
    'https://youtu.be/abc',
  ];
  assert.deepEqual(filterStartupArgs(argv, { packaged: true }),
    ['C:\\a\\video.mkv', 'https://youtu.be/abc']);
});

test('filterStartupArgs: empty / non-string entries are ignored, order preserved', () => {
  const argv = ['exe', '', 'a.mp4', null, undefined, 42, 'b.mp4'];
  assert.deepEqual(filterStartupArgs(argv, { packaged: true }), ['a.mp4', 'b.mp4']);
});

test('filterStartupArgs: no operands → empty list; bad input → empty list', () => {
  assert.deepEqual(filterStartupArgs(['Transcribe.exe'], { packaged: true }), []);
  assert.deepEqual(filterStartupArgs(['electron', 'main.js'], { packaged: false }), []);
  assert.deepEqual(filterStartupArgs(null, { packaged: true }), []);
  assert.deepEqual(filterStartupArgs(undefined, {}), []);
});

test('filterStartupArgs: default (no opts) behaves as dev (slice 2)', () => {
  assert.deepEqual(filterStartupArgs(['electron', 'main.js', 'x.mp4']), ['x.mp4']);
});

// ---- resolveOpenArg -------------------------------------------------------

test('resolveOpenArg: relative path resolves against the given workingDir', () => {
  const cwd = process.platform === 'win32' ? 'C:\\Users\\me\\Videos' : '/Users/me/Videos';
  assert.equal(resolveOpenArg('clip.mp4', cwd), path.resolve(cwd, 'clip.mp4'));
  assert.equal(resolveOpenArg(path.join('sub', 'a.mkv'), cwd),
    path.resolve(cwd, 'sub', 'a.mkv'));
});

test('resolveOpenArg: absolute path passes through unchanged', () => {
  const abs = process.platform === 'win32' ? 'C:\\media\\a.mp4' : '/media/a.mp4';
  assert.equal(resolveOpenArg(abs, '/some/other/cwd'), abs);
});

test('resolveOpenArg: http(s) URLs pass through untouched (never path-resolved)', () => {
  assert.equal(resolveOpenArg('https://youtu.be/abc', '/cwd'), 'https://youtu.be/abc');
  assert.equal(resolveOpenArg('http://example.com/x', '/cwd'), 'http://example.com/x');
  assert.equal(resolveOpenArg('HTTPS://EXAMPLE.COM/Y', '/cwd'), 'HTTPS://EXAMPLE.COM/Y');
});

test('resolveOpenArg: missing workingDir falls back to process.cwd()', () => {
  assert.equal(resolveOpenArg('rel.mp4'), path.resolve(process.cwd(), 'rel.mp4'));
  assert.equal(resolveOpenArg('rel.mp4', ''), path.resolve(process.cwd(), 'rel.mp4'));
});

test('resolveOpenArg: empty / non-string input returned as-is', () => {
  assert.equal(resolveOpenArg('', '/cwd'), '');
  assert.equal(resolveOpenArg(null, '/cwd'), null);
  assert.equal(resolveOpenArg(undefined, '/cwd'), undefined);
});

// A second-instance drop of a relative path is resolved against the SECOND
// process's cwd, not this process's — the two-arg pipeline end to end.
test('filter + resolve pipeline: relative second-instance arg uses provided cwd', () => {
  const secondCwd = process.platform === 'win32' ? 'D:\\downloads' : '/downloads';
  const argv = ['Transcribe.exe', '--some-switch', 'movie.mp4'];
  const resolved = filterStartupArgs(argv, { packaged: true })
    .map((a) => resolveOpenArg(a, secondCwd));
  assert.deepEqual(resolved, [path.resolve(secondCwd, 'movie.mp4')]);
});
