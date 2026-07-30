// relocate.js — macOS only: get the Transcribe folder out of the places where
// the OS will not let it work.
//
// WHY THIS EXISTS. The release is a portable folder, and users unzip it wherever
// the browser dropped it — almost always ~/Downloads. That location breaks the
// app in two different ways that produce the SAME symptom ("Transcribe can't
// find setup.command"), and neither can be fixed from inside the folder:
//
//   1. App Translocation. A still-quarantined app launched from Finder is run
//      from a randomized read-only copy at
//      /private/var/folders/…/AppTranslocation/<uuid>/d/Transcribe.app.
//      folderRoot() then points into that mount, which contains the .app and
//      NOTHING else — no setup.command, no bin/, no models/. Verified on macOS
//      26: "Open Anyway" does not prevent this; only clearing the quarantine
//      attribute does.
//   2. TCC. ~/Downloads, ~/Desktop and ~/Documents are privacy-protected. With
//      no grant, the app's own siblings stat with EPERM. The user sees
//      setup.command sitting in Finder while the app insists it is not there,
//      and the grant does not reliably survive for an ad-hoc-signed app.
//
// So the fix is not a better error message, it is leaving. ~/Applications is
// neither TCC-protected nor translocation-eligible, and needs no admin rights.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const paths = require('./paths');

// Every mac path here is POSIX, and staying on path.posix keeps the planner
// pure enough to run from a Windows test host (same reason paths.js dissects
// execPath with an injected flavor).
const p = path.posix;

const PROTECTED_DIRS = ['Downloads', 'Desktop', 'Documents'];
const TRANSLOCATED = /\/AppTranslocation\/[^/]+\/d\//;

function defaultIsPackaged() {
  try {
    const electron = require('electron');
    return !!(electron && electron.app && electron.app.isPackaged);
  } catch (_) {
    return false;
  }
}

// <folder>/Transcribe.app/Contents/MacOS/Transcribe -> <folder>/Transcribe.app
function appBundlePath(execPath) {
  return p.resolve(p.dirname(execPath), '..', '..');
}

// The real ~/Downloads, not any directory that happens to be called that.
function protectedFolderFor(root, home) {
  for (const name of PROTECTED_DIRS) {
    const dir = p.join(home, name);
    if (root === dir || root.startsWith(dir + '/')) return name;
  }
  return null;
}

/// planRelocation(opts) -> null when the install is somewhere it can work, or
/// { action, reason, target, … } describing the one move that fixes it.
///
///   action 'move-folder' — the whole folder (models and all) is renamed out of
///     the protected directory. Cheap: same volume, so it is a rename.
///   action 'copy-app' — there is no folder to move, only the bundle: either it
///     is translocated (the original location is not knowable from inside the
///     read-only copy) or it was dropped loose in ~/Downloads, where "move the
///     enclosing folder" would mean moving the user's whole Downloads.
function planRelocation(opts = {}) {
  const platform = opts.platform || process.platform;
  // Windows has neither translocation nor TCC-protected user folders, and a dev
  // checkout is not an install — leave both alone.
  if (platform !== 'darwin') return null;
  const isPackaged = opts.isPackaged !== undefined ? opts.isPackaged : defaultIsPackaged();
  if (!isPackaged) return null;

  const env = opts.env || process.env;
  const execPath = opts.execPath || process.execPath;
  const home = opts.home || os.homedir();
  const apps = p.join(home, 'Applications');
  const root = paths.folderRoot({ platform, isPackaged, env, execPath });

  // With TRANSCRIBE_ROOT set, folderRoot no longer derives from execPath, so
  // where the binary happens to be running from says nothing about the install.
  if (!env.TRANSCRIBE_ROOT && TRANSLOCATED.test(execPath)) {
    return {
      action: 'copy-app',
      reason: 'translocated',
      appPath: appBundlePath(execPath),
      target: p.join(apps, 'Transcribe'),
    };
  }

  const folder = protectedFolderFor(root, home);
  if (!folder) return null;

  if (root === p.join(home, folder)) {
    return {
      action: 'copy-app',
      reason: 'loose',
      folder,
      appPath: appBundlePath(execPath),
      target: p.join(apps, 'Transcribe'),
    };
  }

  return {
    action: 'move-folder',
    reason: 'protected',
    folder,
    source: root,
    target: p.join(apps, p.basename(root)),
  };
}

/// A free name under `dir`: "Transcribe", then "Transcribe 2", … Never returns
/// an existing path — merging into a stranger's folder is not a move.
function chooseFreeTarget(dir, name, exists = fs.existsSync) {
  let candidate = p.join(dir, name);
  for (let n = 2; exists(candidate); n += 1) candidate = p.join(dir, `${name} ${n}`);
  return candidate;
}

/// Move the install folder, models included. A rename when the destination is on
/// the same volume (instant, whatever the folder weighs); copy-then-delete when
/// it is not, because 4.6GB of models must survive a cross-volume move rather
/// than turning it into an error.
function moveFolder(from, to, io = {}) {
  const rename = io.rename || fs.renameSync;
  const copy = io.copy || ((a, b) => fs.cpSync(a, b, { recursive: true, verbatimSymlinks: true }));
  const remove = io.remove || ((a) => fs.rmSync(a, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    rename(from, to);
    return to;
  } catch (e) {
    if (!e || e.code !== 'EXDEV') throw e;
  }
  copy(from, to);
  remove(from);
  return to;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { reject(e); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${path.basename(bin)} exited ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`))));
  });
}

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/// A one-liner for a detached /bin/bash: wait out this process, then open the
/// app at its new home. Handing it to bash rather than spawning `open` directly
/// is what makes the ordering possible — LaunchServices would otherwise see the
/// still-running old instance and merely activate it.
function relaunchScript(pid, appPath) {
  return `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done; sleep 0.5; `
    + `/usr/bin/open ${shQuote(appPath)}`;
}

const QUARANTINE = 'com.apple.quarantine';

/// Strip the download flag from the relocated copy, recursively.
///
/// This is the `xattr -dr com.apple.quarantine …` the README used to ask users
/// to type into Terminal, and NOT doing it here would make the whole relocation
/// pointless: a quarantined bundle in its new home translocates exactly as it
/// did in ~/Downloads. `-d` exits non-zero when the attribute isn't there, which
/// is the ordinary case, so the exit code is deliberately ignored.
function clearQuarantine(dir) {
  return run('/usr/bin/xattr', ['-dr', QUARANTINE, dir]).catch(() => { });
}

function hasQuarantine(target) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/xattr', ['-p', QUARANTINE, target], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Test-only: there is no portable way to *set* an xattr from Node, and a test
// that can't create the precondition can't prove the removal.
function setXattrForTest(target, value) {
  return run('/usr/bin/xattr', ['-w', QUARANTINE, value, target]);
}

/// Copy an .app bundle into `target` (created if needed). ditto, not cp: the
/// bundle carries symlinks, resource forks and permission bits, and the same
/// choice is made in installer.js for the same reason.
async function copyAppInto(appPath, target) {
  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, path.basename(appPath));
  await run('/usr/bin/ditto', [appPath, dest]);
  return dest;
}

module.exports = {
  planRelocation,
  chooseFreeTarget,
  moveFolder,
  copyAppInto,
  clearQuarantine,
  relaunchScript,
  hasQuarantine,
  setXattrForTest,
  appBundlePath,
  PROTECTED_DIRS,
};
