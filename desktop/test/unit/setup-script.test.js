// setup-script.test.js — the setup entry point is shipped INSIDE the bundle too,
// so a folder that lost it (an app dragged out on its own, an over-eager
// unarchiver, antivirus eating an unsigned .command) can be repaired instead of
// dead-ended. The copy inside Contents/Resources is the source of truth; the
// sibling beside the app is what actually gets run, because setup.command does
// `cd "$(dirname "$0")"` and downloads 4.6GB of models next to itself.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureSetupScript, setupScriptName } = require('../../main/setup-script.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-setupscript-'));
}

// A stand-in for Contents/Resources, holding the scripts electron-builder
// copies there via extraResources.
function resourcesWith(names) {
  const dir = tmpdir();
  for (const n of names) fs.writeFileSync(path.join(dir, n), `# bundled ${n}\n`);
  return dir;
}

const canDenyAccess = process.platform !== 'win32'
  && typeof process.getuid === 'function' && process.getuid() !== 0;

test('setupScriptName: what the app actually launches, per platform', () => {
  assert.equal(setupScriptName('darwin'), 'setup.command');
  assert.equal(setupScriptName('win32'), 'Transcribe Setup.bat');
});

test('ensureSetupScript: an existing sibling is used as-is, never overwritten', () => {
  const root = tmpdir();
  const resources = resourcesWith(['setup.command']);
  fs.writeFileSync(path.join(root, 'setup.command'), '# the users own copy\n');

  const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'darwin' });

  assert.equal(got.status, 'present');
  assert.equal(got.path, path.join(root, 'setup.command'));
  assert.equal(fs.readFileSync(got.path, 'utf8'), '# the users own copy\n');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(resources, { recursive: true, force: true });
});

test('ensureSetupScript: a missing sibling is restored from the bundle, executable', () => {
  const root = tmpdir();
  const resources = resourcesWith(['setup.command']);

  const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'darwin' });

  assert.equal(got.status, 'restored');
  assert.equal(got.path, path.join(root, 'setup.command'));
  assert.equal(fs.readFileSync(got.path, 'utf8'), '# bundled setup.command\n');
  // Without the exec bit Terminal refuses to run it — restoring a file that
  // can't be launched would just move the dead end one step later.
  assert.equal(fs.statSync(got.path).mode & 0o111, 0o111);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(resources, { recursive: true, force: true });
});

test('ensureSetupScript: Windows restores the whole pair, and launches the .bat', () => {
  const root = tmpdir();
  const resources = resourcesWith(['Transcribe Setup.bat', 'setup.ps1']);

  const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'win32' });

  assert.equal(got.status, 'restored');
  assert.equal(got.path, path.join(root, 'Transcribe Setup.bat'));
  // The .bat is a two-line launcher; without setup.ps1 beside it, it does nothing.
  assert.equal(fs.existsSync(path.join(root, 'setup.ps1')), true, 'setup.ps1 restored too');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(resources, { recursive: true, force: true });
});

test('ensureSetupScript: nothing to restore from reports unavailable, not a crash', () => {
  const root = tmpdir();
  const resources = resourcesWith([]);

  const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'darwin' });

  assert.equal(got.status, 'unavailable');
  assert.equal(got.path, path.join(root, 'setup.command'), 'still says where it looked');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(resources, { recursive: true, force: true });
});

// The ~/Downloads case: the file may well be there, the app just isn't allowed
// to look. Restoring would be the wrong move and would fail anyway.
test('ensureSetupScript: a folder the OS refuses to read reports blocked, and copies nothing',
  { skip: !canDenyAccess }, () => {
    const root = tmpdir();
    const resources = resourcesWith(['setup.command']);
    fs.writeFileSync(path.join(root, 'setup.command'), '# the users own copy\n');
    fs.chmodSync(root, 0o000);
    try {
      const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'darwin' });
      assert.equal(got.status, 'blocked');
    } finally {
      fs.chmodSync(root, 0o700);
      assert.equal(fs.readFileSync(path.join(root, 'setup.command'), 'utf8'), '# the users own copy\n');
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(resources, { recursive: true, force: true });
    }
  });

test('ensureSetupScript: a read-only folder reports unwritable', { skip: !canDenyAccess }, () => {
  const root = tmpdir();
  const resources = resourcesWith(['setup.command']);
  fs.chmodSync(root, 0o500);
  try {
    const got = ensureSetupScript({ root, resourcesPath: resources, platform: 'darwin' });
    assert.equal(got.status, 'unwritable');
  } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
  }
});
