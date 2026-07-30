// paths.js — folder root + per-platform tool/model discovery (C1 + C2).
//
// Every function takes an optional `opts` override ({platform, execPath,
// isPackaged, env, extraPathDirs}) so tests can exercise the mac/win matrix
// from any host. Filesystem-facing joins use the ambient `path` module (it is
// the right flavor on each real OS); only execPath dissection is done with the
// injected platform's flavor, because a win exe path must parse on a mac test.
'use strict';

const fs = require('fs');
const path = require('path');

// GUI apps don't inherit the shell profile, so Homebrew's directories must be
// probed explicitly on top of whatever PATH launchd gave us.
const MAC_EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

// <folderRoot>/tools/win/<sub>/<exe> — fixed layout shipped by setup.ps1.
const WIN_TOOLS = {
  whisper: ['whisper', 'whisper-cli.exe'],
  ffmpeg: ['ffmpeg', 'ffmpeg.exe'],
  ytDlp: ['yt-dlp', 'yt-dlp.exe'],
  deno: ['deno', 'deno.exe'],
};
const WIN_TOOL_SUBDIRS = ['whisper', 'ffmpeg', 'yt-dlp', 'deno'];

function defaultIsPackaged() {
  try {
    // In plain Node the electron package resolves to a string (binary path),
    // so `.app` is undefined and we correctly fall back to dev semantics.
    const electron = require('electron');
    return !!(electron && electron.app && electron.app.isPackaged);
  } catch (_) {
    return false;
  }
}

function ctx(opts = {}) {
  return {
    platform: opts.platform || process.platform,
    execPath: opts.execPath || process.execPath,
    isPackaged: opts.isPackaged !== undefined ? opts.isPackaged : defaultIsPackaged(),
    env: opts.env || process.env,
    extraPathDirs: opts.extraPathDirs || MAC_EXTRA_DIRS,
  };
}

// C1: TRANSCRIBE_ROOT > packaged layout > dev repo root.
function folderRoot(opts) {
  const c = ctx(opts);
  if (c.env.TRANSCRIBE_ROOT) return path.resolve(String(c.env.TRANSCRIBE_ROOT));
  if (!c.isPackaged) return path.resolve(__dirname, '..', '..');
  const p = c.platform === 'win32' ? path.win32 : path.posix;
  if (c.platform === 'win32') return p.dirname(c.execPath);
  // mac: <folder>/Transcribe.app/Contents/MacOS/Transcribe
  return p.resolve(p.dirname(c.execPath), '..', '..', '..');
}

function modelsDir(opts) {
  return path.join(folderRoot(opts), 'models');
}

function modelPath(fileName, opts) {
  return path.join(modelsDir(opts), fileName);
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

// mac which(): PATH dirs first, then the extra dirs appended (same order as 2.0).
function whichSync(name, c) {
  const dirs = String(c.env.PATH || '').split(':').filter(Boolean);
  for (const d of c.extraPathDirs) if (!dirs.includes(d)) dirs.push(d);
  for (const d of dirs) {
    const candidate = path.join(d, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/// kind: 'whisper' | 'ffmpeg' | 'ytDlp' | 'deno' → absolute path or null.
function findTool(kind, opts) {
  const c = ctx(opts);
  if (c.platform === 'win32') {
    const spec = WIN_TOOLS[kind];
    if (!spec) return null;
    const candidate = path.join(folderRoot(opts), 'tools', 'win', spec[0], spec[1]);
    try {
      return fs.statSync(candidate).isFile() ? candidate : null;
    } catch (_) {
      return null;
    }
  }
  if (kind === 'whisper') {
    return whichSync('whisper-cli', c) || whichSync('whisper-cpp', c) || whichSync('main', c);
  }
  const names = { ffmpeg: 'ffmpeg', ytDlp: 'yt-dlp', deno: 'deno' };
  return names[kind] ? whichSync(names[kind], c) : null;
}

// PATH handed to every engine child: tool dirs prepended, deduped.
function childPATH(opts) {
  const c = ctx(opts);
  if (c.platform === 'win32') {
    const root = folderRoot(opts);
    const dirs = WIN_TOOL_SUBDIRS.map((d) => path.join(root, 'tools', 'win', d));
    const base = String(c.env.Path || c.env.PATH || '');
    for (const d of base.split(';').filter(Boolean)) if (!dirs.includes(d)) dirs.push(d);
    return dirs.join(';');
  }
  const dirs = c.extraPathDirs.slice();
  const base = String(c.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin');
  for (const d of base.split(':').filter(Boolean)) if (!dirs.includes(d)) dirs.push(d);
  return dirs.join(':');
}

function childEnv(opts) {
  const c = ctx(opts);
  const env = Object.assign({}, c.env);
  env.PATH = childPATH(opts);
  if (c.platform === 'win32') env.Path = env.PATH;
  return env;
}

// The setup entry point ships beside the app in every release zip, so it is
// what "this is a real Transcribe folder" is measured by.
function markerNames(platform) {
  return platform === 'win32' ? ['setup.ps1', 'Transcribe Setup.bat'] : ['setup.command'];
}

/// Folder integrity (2.0's engineScriptPresent), as three outcomes rather than
/// two: 'present' | 'missing' | 'blocked'.
///
/// WHY THE THIRD ONE. A folder living in ~/Downloads (or ~/Desktop, ~/Documents)
/// is TCC-protected on macOS: without the user's "allow" the app's own siblings
/// stat with EPERM, not ENOENT. Collapsing that into false told a user whose
/// setup.command was plainly visible in Finder to go find the file — the one
/// instruction that could not help. errno is the whole difference between "put
/// the file back" and "macOS is refusing to let Transcribe read this folder".
function folderMarkerStatus(opts) {
  const c = ctx(opts);
  const root = folderRoot(opts);
  let blocked = false;
  for (const name of markerNames(c.platform)) {
    try {
      if (fs.statSync(path.join(root, name)).isFile()) return 'present';
    } catch (e) {
      // EPERM: macOS TCC. EACCES: ordinary directory permissions (and what the
      // test reproduces, since TCC can't be provoked from a test runner).
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) blocked = true;
    }
  }
  return blocked ? 'blocked' : 'missing';
}

function folderMarkerPresent(opts) {
  return folderMarkerStatus(opts) === 'present';
}

module.exports = {
  folderRoot,
  modelPath,
  findTool,
  childPATH,
  childEnv,
  folderMarkerPresent,
  folderMarkerStatus,
  markerNames,
};
