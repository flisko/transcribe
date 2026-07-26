// installer.test.js — the self-update staging logic.
//
// The property that matters most here is what is NOT touched: the release zip
// carries only app files, so merging it over the install folder must leave the
// user's 4.6 GB of models and their tools/ directory exactly where they were.
// Everything else guards the "never damage a working install" rule.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findPayload, writeHelper, psQuote, shQuote, installUpdate } =
  require('../../main/installer.js');

function tmp(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `inst-${label}-`));
  test.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { } });
  return d;
}

// ---- findPayload ----------------------------------------------------------

test('findPayload: locates the zip top-level folder per platform', () => {
  const d = tmp('payload');
  fs.mkdirSync(path.join(d, 'Transcribe'));
  fs.writeFileSync(path.join(d, 'Transcribe', 'Transcribe.exe'), 'x');
  assert.equal(findPayload(d, 'win32'), path.join(d, 'Transcribe'));

  const m = tmp('payload-mac');
  fs.mkdirSync(path.join(m, 'Transcribe', 'Transcribe.app'), { recursive: true });
  assert.equal(findPayload(m, 'darwin'), path.join(m, 'Transcribe'));
});

test('findPayload: also accepts an un-nested zip', () => {
  const d = tmp('flat');
  fs.writeFileSync(path.join(d, 'Transcribe.exe'), 'x');
  assert.equal(findPayload(d, 'win32'), d);
});

// The whole point of the check: refuse rather than copy something unrecognisable
// over a working install.
test('findPayload: returns null when the app is not in there', () => {
  const d = tmp('empty');
  assert.equal(findPayload(d, 'win32'), null);

  const wrong = tmp('wrongos');
  fs.mkdirSync(path.join(wrong, 'Transcribe'));
  fs.writeFileSync(path.join(wrong, 'Transcribe', 'Transcribe.app'), 'x');
  assert.equal(findPayload(wrong, 'win32'), null, "a mac zip is not a Windows update");

  assert.equal(findPayload(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()), 'win32'), null);
});

// ---- quoting --------------------------------------------------------------

test('psQuote / shQuote survive the characters a folder path really contains', () => {
  assert.equal(psQuote("C:\\Users\\O'Brien\\Transcribe"), "'C:\\Users\\O''Brien\\Transcribe'");
  assert.equal(psQuote('C:\\Program Files (x86)\\T'), "'C:\\Program Files (x86)\\T'");
  // A path with a quote must not be able to end the string and start a command.
  assert.ok(!/[^']'[^']/.test(psQuote("a'b").slice(1, -1).replace(/''/g, '')));
  assert.equal(shQuote("/Users/O'Brien/T"), `'/Users/O'\\''Brien/T'`);
  assert.equal(shQuote('/Users/me/My Stuff'), `'/Users/me/My Stuff'`);
});

// ---- helper script --------------------------------------------------------

test('writeHelper (win32): waits for our pid, merges, relaunches, cleans up', () => {
  const d = tmp('helper-win');
  const h = writeHelper(d, { src: 'C:\\src', dst: 'C:\\dst', pid: 4242, platform: 'win32' });
  const body = fs.readFileSync(path.join(d, 'apply-update.ps1'), 'utf8');

  assert.match(body, /Wait-Process -Id 4242/, 'waits for the app to exit first');
  assert.match(body, /Copy-Item[\s\S]*'C:\\src'[\s\S]*'C:\\dst'/, 'merges src over dst');
  assert.match(body, /-Recurse -Force/);
  assert.match(body, /Start-Process[\s\S]*Transcribe\.exe/, 'relaunches');
  assert.match(body, /Remove-Item/, 'removes its own temp dir');
  // Copy, never mirror: a /MIR or Remove-Item on the destination would take the
  // user's models with it.
  assert.ok(!/Remove-Item[^\n]*'C:\\dst'/.test(body), 'never deletes the destination');
  assert.ok(h.bin.toLowerCase().endsWith('powershell.exe'));
  assert.ok(h.args.includes('-ExecutionPolicy') && h.args.includes('Bypass'));
});

test('writeHelper (darwin): polls the pid, dittos, reopens', () => {
  const d = tmp('helper-mac');
  const h = writeHelper(d, { src: '/src', dst: '/dst', pid: 777, platform: 'darwin' });
  const file = path.join(d, 'apply-update.sh');
  const body = fs.readFileSync(file, 'utf8');

  assert.match(body, /^#!\/bin\/bash/);
  assert.match(body, /kill -0 777/, 'waits for the app to exit');
  assert.match(body, /\/usr\/bin\/ditto '\/src' '\/dst'/, 'ditto preserves the .app bundle');
  assert.match(body, /\/usr\/bin\/open '\/dst\/Transcribe\.app'/);
  assert.ok(!/rm -rf '\/dst'/.test(body), 'never deletes the destination');
  assert.equal(h.bin, '/bin/bash');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(file).mode & 0o100, 'executable');
  }
});

// ---- refusal paths --------------------------------------------------------
//
// Each of these must fail BEFORE anything on disk is modified.

test('installUpdate: refuses without an asset', async () => {
  await assert.rejects(installUpdate({ asset: null, folderRoot: os.tmpdir() }),
    /no downloadable asset/);
  await assert.rejects(installUpdate({ asset: { name: 'x' }, folderRoot: os.tmpdir() }),
    /no downloadable asset/);
});

test('installUpdate: refuses without a folder to update', async () => {
  await assert.rejects(installUpdate({ asset: { url: 'https://x/a.zip' }, folderRoot: null }),
    /cannot locate the Transcribe folder/);
});

// A read-only install can never be updated in place, and the user must hear that
// before a 140 MB download rather than after it — so the check is first, and it
// is flagged so the UI can give the cure instead of "try again".
test('installUpdate: a non-writable folder fails fast and is flagged readOnly', async () => {
  const gone = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now());
  const e = await installUpdate({ asset: { url: 'https://x/a.zip' }, folderRoot: gone })
    .then(() => null, (err) => err);
  assert.ok(e, 'rejects');
  assert.equal(e.readOnly, true, 'flagged so the UI can name the cure');
  assert.match(e.message, /not writable/);
});
