// setup-script.js — find, or put back, the setup entry point beside the app.
//
// WHY A SECOND COPY. Until now the only setup.command in existence was the one
// shipped loose in the release folder, and "it isn't beside the app" was a dead
// end: the app had nothing to offer but instructions. It ships inside the bundle
// as well now (electron-builder extraResources -> Contents/Resources), so a
// folder that lost the sibling — an app dragged out on its own, an unarchiver
// that skipped it, antivirus eating an unsigned .command — can be repaired in
// place instead of sending the user back to the download page.
//
// The restored copy goes NEXT TO THE APP rather than being run from Resources,
// because setup.command starts with `cd "$(dirname "$0")"` and downloads ~4.6GB
// of models relative to itself. Run from inside the bundle it would fill
// Contents/Resources — and the next update would throw the models away.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Everything that has to be beside the app for setup to work. Windows needs the
// pair: "Transcribe Setup.bat" is a launcher that does nothing without setup.ps1.
function bundledNames(platform) {
  return platform === 'win32' ? ['Transcribe Setup.bat', 'setup.ps1'] : ['setup.command'];
}

/// The file the app actually hands to Terminal / cmd.
function setupScriptName(platform) {
  return platform === 'win32' ? 'Transcribe Setup.bat' : 'setup.command';
}

// present | missing | blocked, from errno — see paths.folderMarkerStatus for
// why the third one has to exist.
function probe(file) {
  try {
    return fs.statSync(file).isFile() ? 'present' : 'missing';
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return 'blocked';
    return 'missing';
  }
}

/// ensureSetupScript({ root, resourcesPath, platform }) -> { status, path }
///
///   present     — the sibling is there; nothing was touched.
///   restored    — it was missing and has been copied back out of the bundle.
///   blocked     — the OS refuses to look (macOS TCC on ~/Downloads and friends).
///                 The file is probably right there; copying is neither possible
///                 nor the answer. Relocation is.
///   unwritable  — the folder allows no changes (read-only volume, a locked-down
///                 install), so the sibling cannot be put back.
///   unavailable — no bundled copy to restore from (a build predating this, or a
///                 dev run outside a packaged app).
///
/// `path` is always the place the sibling belongs, so callers can name it in an
/// error even when nothing could be done.
function ensureSetupScript({ root, resourcesPath, platform = process.platform } = {}) {
  const target = path.join(root, setupScriptName(platform));
  const names = bundledNames(platform);

  const statuses = names.map((n) => probe(path.join(root, n)));
  if (statuses.every((s) => s === 'present')) return { status: 'present', path: target };
  if (statuses.includes('blocked')) return { status: 'blocked', path: target };

  if (!resourcesPath) return { status: 'unavailable', path: target };
  const sources = names.map((n) => path.join(resourcesPath, n));
  if (!sources.every((s) => probe(s) === 'present')) return { status: 'unavailable', path: target };

  try {
    for (const name of names) {
      const dest = path.join(root, name);
      fs.copyFileSync(path.join(resourcesPath, name), dest);
      // A .command without the exec bit is one Terminal refuses to run, which
      // would just move the dead end one step later.
      if (platform !== 'win32') fs.chmodSync(dest, 0o755);
    }
  } catch (_) {
    return { status: 'unwritable', path: target };
  }
  return { status: 'restored', path: target };
}

// Everything else the release folder normally holds beside the app. mac only:
// bin/ is a pair of bash helpers, and there is no Windows equivalent.
function companionNames(platform) {
  return platform === 'win32' ? [] : ['bin', 'README.md'];
}

/// restoreCompanions({ root, resourcesPath, platform }) -> names restored
///
/// The copy-app relocation path has only the bundle to work from: a translocated
/// app runs from a read-only mount that contains Transcribe.app and nothing else,
/// so the release folder's bin/ and README.md are simply not reachable. Without
/// this, relocating out of ~/Downloads produced a folder holding the app and
/// setup.command alone and the user quietly lost the CLI helpers.
///
/// Purely additive and entirely best-effort: existing files are never touched
/// (a move-folder relocation already brought the real ones across), and nothing
/// here may fail a relocation that otherwise succeeded — these are conveniences,
/// and the app itself never reads them.
function restoreCompanions({ root, resourcesPath, platform = process.platform } = {}) {
  if (!root || !resourcesPath) return [];
  const restored = [];
  for (const name of companionNames(platform)) {
    const dest = path.join(root, name);
    const src = path.join(resourcesPath, name);
    try {
      if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
      // recursive: bin/ is a directory. Mode bits ride along, which matters —
      // bin/transcribe without its exec bit is not a helper.
      fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
      restored.push(name);
    } catch (_) { /* cosmetic: never fail the relocation over a README */ }
  }
  return restored;
}

module.exports = {
  ensureSetupScript, setupScriptName, bundledNames, restoreCompanions, companionNames,
};
