// relocate.test.js — the "don't run from ~/Downloads" guard.
//
// THE BUG THIS IS FOR. A release folder left in ~/Downloads breaks two ways on
// macOS, and both look identical to the user ("Transcribe can't find
// setup.command"):
//   • quarantine still set  -> App Translocation runs the app from a random
//     read-only /private/var/…/AppTranslocation/<uuid>/d copy that has NO
//     sibling files at all;
//   • quarantine cleared    -> ~/Downloads is TCC-protected, so the siblings
//     are there but every stat comes back EPERM.
// Neither is fixable from inside the folder, so the app has to leave it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const relocate = require('../../main/relocate.js');

const HOME = '/Users/tejav';
const packagedMac = (execPath, extra = {}) => ({
  platform: 'darwin', isPackaged: true, home: HOME, execPath, env: {}, ...extra,
});

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-relocate-'));
}

// ---- planRelocation -------------------------------------------------------

test('planRelocation: a folder inside ~/Downloads is moved out whole', () => {
  const plan = relocate.planRelocation(packagedMac(
    `${HOME}/Downloads/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`));
  assert.equal(plan.action, 'move-folder');
  assert.equal(plan.reason, 'protected');
  assert.equal(plan.folder, 'Downloads');
  assert.equal(plan.source, `${HOME}/Downloads/Transcribe`);
  assert.equal(plan.target, `${HOME}/Applications/Transcribe`);
});

test('planRelocation: ~/Desktop and ~/Documents are protected the same way', () => {
  for (const folder of ['Desktop', 'Documents']) {
    const plan = relocate.planRelocation(packagedMac(
      `${HOME}/${folder}/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`));
    assert.equal(plan.action, 'move-folder', folder);
    assert.equal(plan.folder, folder);
  }
});

test('planRelocation: the folder keeps its own name at the destination', () => {
  const plan = relocate.planRelocation(packagedMac(
    `${HOME}/Downloads/Transcribe 2/Transcribe.app/Contents/MacOS/Transcribe`));
  assert.equal(plan.target, `${HOME}/Applications/Transcribe 2`);
});

// The folder to move must never BE ~/Downloads. An app dropped loose in
// Downloads has folderRoot === ~/Downloads, and "move the folder somewhere
// safe" would then mean moving the user's entire Downloads directory.
test('planRelocation: an app sitting loose in ~/Downloads copies only itself', () => {
  const plan = relocate.planRelocation(packagedMac(
    `${HOME}/Downloads/Transcribe.app/Contents/MacOS/Transcribe`));
  assert.equal(plan.action, 'copy-app');
  assert.equal(plan.reason, 'loose');
  assert.equal(plan.folder, 'Downloads', 'still names the folder it is escaping');
  assert.equal(plan.appPath, `${HOME}/Downloads/Transcribe.app`);
  assert.equal(plan.target, `${HOME}/Applications/Transcribe`);
});

test('planRelocation: a translocated app copies itself out of the read-only mount', () => {
  const plan = relocate.planRelocation(packagedMac(
    '/private/var/folders/c3/xx/T/AppTranslocation/7C13B1F5-6827-4C2E-9945-F55B7B66E9B4/d'
    + '/Transcribe.app/Contents/MacOS/Transcribe'));
  assert.equal(plan.action, 'copy-app');
  assert.equal(plan.reason, 'translocated');
  assert.equal(plan.target, `${HOME}/Applications/Transcribe`);
});

test('planRelocation: nothing to do from a normal location', () => {
  assert.equal(relocate.planRelocation(packagedMac(
    '/Applications/Transcribe/Transcribe.app/Contents/MacOS/Transcribe')), null);
  assert.equal(relocate.planRelocation(packagedMac(
    `${HOME}/Applications/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`)), null);
  assert.equal(relocate.planRelocation(packagedMac(
    `${HOME}/Work/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`)), null);
});

// A folder merely NAMED Downloads elsewhere is not the protected one.
test('planRelocation: only the real ~/Downloads counts, not any folder so named', () => {
  assert.equal(relocate.planRelocation(packagedMac(
    `${HOME}/Work/Downloads/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`)), null);
  assert.equal(relocate.planRelocation(packagedMac(
    '/Volumes/Big/Downloads/Transcribe/Transcribe.app/Contents/MacOS/Transcribe')), null);
});

test('planRelocation: Windows and dev builds are never relocated', () => {
  assert.equal(relocate.planRelocation({
    platform: 'win32', isPackaged: true, home: 'C:\\Users\\tejav', env: {},
    execPath: 'C:\\Users\\tejav\\Downloads\\Transcribe\\Transcribe.exe',
  }), null);
  assert.equal(relocate.planRelocation(packagedMac(
    `${HOME}/Downloads/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`,
    { isPackaged: false })), null);
});

// TRANSCRIBE_ROOT is how the tests and CI point the app at a checkout; it also
// means folderRoot() is no longer derived from execPath, so the guard must
// respect it rather than second-guessing where the app "really" is.
test('planRelocation: an explicit TRANSCRIBE_ROOT outside the protected dirs is honored', () => {
  assert.equal(relocate.planRelocation(packagedMac(
    `${HOME}/Downloads/Transcribe/Transcribe.app/Contents/MacOS/Transcribe`,
    { env: { TRANSCRIBE_ROOT: '/opt/transcribe' } })), null);
});

// ---- chooseFreeTarget -----------------------------------------------------

test('chooseFreeTarget: an occupied name gets a numbered sibling, never a merge', () => {
  const taken = new Set(['/A/Transcribe', '/A/Transcribe 2']);
  const exists = (p) => taken.has(p);
  assert.equal(relocate.chooseFreeTarget('/A', 'Transcribe', exists), '/A/Transcribe 3');
  assert.equal(relocate.chooseFreeTarget('/A', 'Other', exists), '/A/Other');
});

// ---- relaunchScript -------------------------------------------------------

// The app cannot `open` its own new location while it is still running:
// LaunchServices sees the same bundle id already alive and just activates the
// copy that is about to quit, leaving the user with nothing on screen. So the
// relaunch waits for this process to be gone first.
test('relaunchScript: waits for the old process to exit, then opens the new app', () => {
  const script = relocate.relaunchScript(4321, "/Users/me/Applications/Trans's/Transcribe.app");
  assert.match(script, /kill -0 4321/, 'waits on the pid');
  assert.match(script, /\/usr\/bin\/open /, 'opens via LaunchServices');
  // A path with a quote in it must not be able to end the quoting and run.
  assert.match(script, /'\/Users\/me\/Applications\/Trans'\\''s\/Transcribe.app'/);
});

// ---- clearQuarantine ------------------------------------------------------

// The one-click promise: the user must never be asked to open Terminal and type
// `xattr -dr com.apple.quarantine`. Relocating without doing this would leave
// the moved copy quarantined, and it would translocate all over again.
test('clearQuarantine: strips com.apple.quarantine from the folder and its contents',
  { skip: process.platform !== 'darwin' }, async () => {
    const base = tmpdir();
    const app = path.join(base, 'Transcribe.app');
    fs.mkdirSync(app, { recursive: true });
    const inner = path.join(app, 'binary');
    fs.writeFileSync(inner, 'x');
    const QTN = '0081;6a65a817;Chrome;37671366-844B-4320-BBEE-4522D3BC9642';
    await relocate.setXattrForTest(base, QTN);
    await relocate.setXattrForTest(inner, QTN);

    await relocate.clearQuarantine(base);

    assert.equal(await relocate.hasQuarantine(base), false, 'folder');
    assert.equal(await relocate.hasQuarantine(inner), false, 'nested file');
    fs.rmSync(base, { recursive: true, force: true });
  });

test('clearQuarantine: a folder that never had the flag is not an error',
  { skip: process.platform !== 'darwin' }, async () => {
    const base = tmpdir();
    await relocate.clearQuarantine(base); // must not throw
    assert.equal(await relocate.hasQuarantine(base), false);
    fs.rmSync(base, { recursive: true, force: true });
  });

// ---- moveFolder -----------------------------------------------------------

test('moveFolder: a same-volume move is a rename, and the source is gone', () => {
  const base = tmpdir();
  const from = path.join(base, 'Transcribe');
  const to = path.join(base, 'Applications', 'Transcribe');
  fs.mkdirSync(path.join(from, 'models'), { recursive: true });
  fs.writeFileSync(path.join(from, 'setup.command'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(from, 'models', 'ggml-large-v3.bin'), 'x');

  relocate.moveFolder(from, to);

  assert.equal(fs.existsSync(from), false, 'source removed');
  assert.equal(fs.readFileSync(path.join(to, 'setup.command'), 'utf8'), '#!/bin/bash\n');
  assert.equal(fs.existsSync(path.join(to, 'models', 'ggml-large-v3.bin')), true, 'models came along');
  fs.rmSync(base, { recursive: true, force: true });
});

// ---- copyAppInto ----------------------------------------------------------

// ditto for real, not a stub: a .app is a directory of symlinks and mode bits,
// and the reason this uses ditto rather than cp is that those survive.
test('copyAppInto: the bundle lands in a fresh folder, symlinks intact',
  { skip: process.platform !== 'darwin' }, async () => {
    const base = tmpdir();
    const app = path.join(base, 'Fake.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Fake'), 'binary', { mode: 0o755 });
    fs.symlinkSync('MacOS', path.join(app, 'Contents', 'Current'));
    const target = path.join(base, 'Applications', 'Transcribe');

    await relocate.copyAppInto(app, target);

    const landed = path.join(target, 'Fake.app');
    assert.equal(fs.readFileSync(path.join(landed, 'Contents', 'MacOS', 'Fake'), 'utf8'), 'binary');
    assert.equal(fs.statSync(path.join(landed, 'Contents', 'MacOS', 'Fake')).mode & 0o111, 0o111);
    assert.equal(fs.lstatSync(path.join(landed, 'Contents', 'Current')).isSymbolicLink(), true);
    fs.rmSync(base, { recursive: true, force: true });
  });

// The folder can hold 4.6GB of models and the destination can be another
// volume; EXDEV must degrade to copy-then-delete instead of failing the move.
test('moveFolder: a cross-volume rename falls back to copy + delete', () => {
  const base = tmpdir();
  const from = path.join(base, 'Transcribe');
  const to = path.join(base, 'Applications', 'Transcribe');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'setup.command'), '#!/bin/bash\n');

  let renameTried = 0;
  relocate.moveFolder(from, to, {
    rename: () => { renameTried += 1; const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; },
  });

  assert.equal(renameTried, 1);
  assert.equal(fs.existsSync(from), false, 'source removed after the copy');
  assert.equal(fs.readFileSync(path.join(to, 'setup.command'), 'utf8'), '#!/bin/bash\n');
  fs.rmSync(base, { recursive: true, force: true });
});
