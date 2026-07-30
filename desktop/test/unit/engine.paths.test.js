// engine.paths.test.js — C1/C2: folderRoot matrix, tool discovery, child PATH.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../main/paths.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-paths-'));
}

test('folderRoot: TRANSCRIBE_ROOT override wins on every platform', () => {
  for (const platform of ['darwin', 'win32']) {
    const root = paths.folderRoot({
      platform,
      isPackaged: true,
      execPath: '/ignored/Transcribe',
      env: { TRANSCRIBE_ROOT: '/fake/rooted' },
    });
    assert.equal(root, path.resolve('/fake/rooted'));
  }
});

test('folderRoot: packaged mac resolves 3 levels above the exe', () => {
  const root = paths.folderRoot({
    platform: 'darwin',
    isPackaged: true,
    execPath: '/Users/x/My Folder/Transcribe.app/Contents/MacOS/Transcribe',
    env: {},
  });
  assert.equal(root, '/Users/x/My Folder');
});

test('folderRoot: packaged win is the exe directory', () => {
  const root = paths.folderRoot({
    platform: 'win32',
    isPackaged: true,
    execPath: 'C:\\Users\\x\\Transcribe\\Transcribe.exe',
    env: {},
  });
  assert.equal(root, 'C:\\Users\\x\\Transcribe');
});

test('folderRoot: dev (not packaged) is the repo root', () => {
  const root = paths.folderRoot({ platform: 'darwin', isPackaged: false, env: {} });
  assert.equal(root, REPO_ROOT);
});

test('modelPath joins <root>/models/<file>', () => {
  const p = paths.modelPath('ggml-large-v3.bin', {
    platform: 'darwin', isPackaged: false, env: { TRANSCRIBE_ROOT: '/fake/r' },
  });
  assert.equal(p, path.join(path.resolve('/fake/r'), 'models', 'ggml-large-v3.bin'));
});

test('findTool mac: found via injected PATH; whisper-cpp fallback order', { skip: process.platform === 'win32' &&
  'mac PATH semantics cannot be simulated on a Windows filesystem (drive-letter colons break the ":" delimiter)' }, () => {
  const bin = tmpdir();
  const empty = tmpdir();
  fs.writeFileSync(path.join(bin, 'whisper-cpp'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
  const opts = { platform: 'darwin', env: { PATH: bin }, extraPathDirs: [empty] };
  // whisper-cli absent → falls back to whisper-cpp
  assert.equal(paths.findTool('whisper', opts), path.join(bin, 'whisper-cpp'));
  assert.equal(paths.findTool('ffmpeg', opts), path.join(bin, 'ffmpeg'));
  assert.equal(paths.findTool('ytDlp', opts), null);
  // whisper-cli wins over whisper-cpp when both exist
  fs.writeFileSync(path.join(bin, 'whisper-cli'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(paths.findTool('whisper', opts), path.join(bin, 'whisper-cli'));
  fs.rmSync(bin, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('findTool mac: non-executable candidates are skipped', { skip: process.platform === 'win32' &&
  'mac whichSync path is unsimulable on Windows: PATH.split(":") shatters the drive-letter colon, and fs.accessSync(X_OK) ignores the POSIX execute bit so a 0o644 file still reads as executable (findTool takes the win32 isFile() branch in production — this asserts the mac-only branch)' }, () => {
  const bin = tmpdir();
  fs.writeFileSync(path.join(bin, 'yt-dlp'), '', { mode: 0o644 });
  const opts = { platform: 'darwin', env: { PATH: bin }, extraPathDirs: [] };
  assert.equal(paths.findTool('ytDlp', opts), null);
  fs.rmSync(bin, { recursive: true, force: true });
});

test('findTool win: fixed tools/win layout under folderRoot', () => {
  const root = tmpdir();
  const wdir = path.join(root, 'tools', 'win', 'whisper');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, 'whisper-cli.exe'), 'MZ');
  const opts = { platform: 'win32', env: { TRANSCRIBE_ROOT: root } };
  assert.equal(paths.findTool('whisper', opts), path.join(root, 'tools', 'win', 'whisper', 'whisper-cli.exe'));
  assert.equal(paths.findTool('ffmpeg', opts), null); // not installed → null
  fs.rmSync(root, { recursive: true, force: true });
});

test('childPATH mac: extra dirs prepended, deduped, base order kept', () => {
  const got = paths.childPATH({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/opt/homebrew/bin:/bin' },
  });
  assert.equal(got, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
});

test('childPATH mac: missing PATH falls back to the standard dirs', () => {
  const got = paths.childPATH({ platform: 'darwin', env: {} });
  assert.equal(got, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
});

test('childPATH win: all four tool dirs prepended before the base PATH', () => {
  const root = path.resolve('/fake/winroot');
  const got = paths.childPATH({
    platform: 'win32',
    env: { TRANSCRIBE_ROOT: root, PATH: 'C:\\Windows\\System32' },
  });
  const parts = got.split(';');
  assert.deepEqual(parts.slice(0, 4), ['whisper', 'ffmpeg', 'yt-dlp', 'deno']
    .map((d) => path.join(root, 'tools', 'win', d)));
  assert.equal(parts[4], 'C:\\Windows\\System32');
});

test('childEnv sets PATH (and Path on win) without dropping other vars', () => {
  const env = paths.childEnv({ platform: 'darwin', env: { PATH: '/usr/bin', HOME: '/Users/x' } });
  assert.equal(env.HOME, '/Users/x');
  assert.ok(env.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:'));
  const wenv = paths.childEnv({ platform: 'win32', env: { TRANSCRIBE_ROOT: '/r', PATH: 'X' } });
  assert.equal(wenv.Path, wenv.PATH);
});

test('folderMarkerPresent: platform-specific setup entry point beside the app', () => {
  const root = tmpdir();
  const opts = (platform) => ({ platform, env: { TRANSCRIBE_ROOT: root } });
  assert.equal(paths.folderMarkerPresent(opts('darwin')), false);
  assert.equal(paths.folderMarkerPresent(opts('win32')), false);
  fs.writeFileSync(path.join(root, 'setup.command'), '#!/bin/bash\n');
  assert.equal(paths.folderMarkerPresent(opts('darwin')), true);
  assert.equal(paths.folderMarkerPresent(opts('win32')), false);
  fs.writeFileSync(path.join(root, 'setup.ps1'), '# ps1\n');
  assert.equal(paths.folderMarkerPresent(opts('win32')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- folderMarkerStatus: "not there" is NOT the same as "not allowed" -------
//
// The bug this exists for: a folder in ~/Downloads that macOS won't let the app
// read makes statSync throw EPERM, which the old boolean flattened into "the
// file isn't there" — and the user was told to go looking for a file that was
// sitting right in front of them in Finder.

test('folderMarkerStatus: present when the setup entry point is readable', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'setup.command'), '#!/bin/bash\n');
  assert.equal(paths.folderMarkerStatus({ platform: 'darwin', env: { TRANSCRIBE_ROOT: root } }), 'present');
  fs.rmSync(root, { recursive: true, force: true });
});

test('folderMarkerStatus: missing when the folder is readable but has no marker', () => {
  const root = tmpdir();
  assert.equal(paths.folderMarkerStatus({ platform: 'darwin', env: { TRANSCRIBE_ROOT: root } }), 'missing');
  fs.rmSync(root, { recursive: true, force: true });
});

// Real EACCES, not a mock: the whole point is that the code reads errno off a
// genuine filesystem refusal. Skipped where the premise can't hold — root
// ignores the mode bits, and Windows ACLs don't work like this.
const canDenyRead = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

test('folderMarkerStatus: blocked when the OS refuses to stat inside the folder', { skip: !canDenyRead }, () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'setup.command'), '#!/bin/bash\n');
  fs.chmodSync(root, 0o000);
  try {
    assert.equal(paths.folderMarkerStatus({ platform: 'darwin', env: { TRANSCRIBE_ROOT: root } }), 'blocked');
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folderMarkerStatus: a readable marker wins over a blocked sibling (win pair)', { skip: !canDenyRead }, () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'setup.ps1'), '# ps1\n');
  assert.equal(paths.folderMarkerStatus({ platform: 'win32', env: { TRANSCRIBE_ROOT: root } }), 'present');
  fs.rmSync(root, { recursive: true, force: true });
});

test('folderMarkerPresent stays true only for the present status', { skip: !canDenyRead }, () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'setup.command'), '#!/bin/bash\n');
  fs.chmodSync(root, 0o000);
  try {
    assert.equal(paths.folderMarkerPresent({ platform: 'darwin', env: { TRANSCRIBE_ROOT: root } }), false);
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
