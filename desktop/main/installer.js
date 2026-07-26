// main/installer.js — one-click self-update for the portable folder.
//
// WHY THIS SHAPE. Transcribe ships as an unsigned portable folder, so the usual
// answer (electron-updater) is out: Squirrel.Mac refuses to apply an update to an
// unsigned .app, and the Windows path wants an NSIS installer this project
// deliberately doesn't have — an installer would put the app somewhere its own
// 4.6 GB of models can't live beside it, and would wipe them on the next upgrade.
//
// So the update is a folder merge, which is exactly what the release zip already
// is. The zip contains ONLY app files (models/ and tools/ are never shipped), so
// copying it over the install folder replaces the app and leaves the multi-GB
// downloads untouched. That is the whole trick.
//
// The one thing a running app cannot do is overwrite itself, so the copy is done
// by a small helper the app spawns detached, which waits for this process to
// exit, merges the files, and relaunches. Nothing is touched until the download
// has been fetched, extracted, and CHECKED — a half-downloaded zip must never
// reach the install folder.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const IS_WIN = process.platform === 'win32';

// Absolute, and built with path.win32 so it is a valid Windows path on ANY host.
// These functions take `platform` as an argument — they are meant to be able to
// produce a Windows helper from a mac and vice versa — so nothing here may be
// derived from the machine we happen to be running on. (A host-derived constant
// here is what broke the macOS build: it was null off Windows.)
function psExe(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Redirects are the norm here: a GitHub asset URL 302s to objects.githubusercontent.com,
// and node:https does not follow on its own.
const MAX_REDIRECTS = 5;

function download(url, dest, { onProgress, timeoutMs = 30000, redirectsLeft = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'transcribe-app', Accept: 'application/octet-stream' },
      timeout: timeoutMs,
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        const next = new URL(headers.location, url).toString();
        if (!/^https:\/\//i.test(next)) { reject(new Error('refusing a non-https redirect')); return; }
        resolve(download(next, dest, { onProgress, timeoutMs, redirectsLeft: redirectsLeft - 1 }));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${statusCode}`));
        return;
      }
      const total = Number(headers['content-length']) || 0;
      let received = 0;
      let lastPct = -1;
      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (!onProgress || !total) return;
        const pct = Math.floor((received / total) * 100);
        if (pct > lastPct) { lastPct = pct; try { onProgress(pct); } catch (_) { /* UI must not kill the download */ } }
      });
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', () => file.close(() => resolve({ bytes: received, total })));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the download timed out')));
    req.on('error', reject);
  });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { reject(e); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${path.basename(bin)} exited ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`))));
  });
}

function extract(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  if (IS_WIN) {
    // -LiteralPath so a folder with [] in its name still works.
    return run(psExe(), ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(into)} -Force`]);
  }
  // ditto, not unzip: the mac zip is made with ditto and carries the .app's
  // resource forks and permission bits, which plain unzip mangles.
  return run('/usr/bin/ditto', ['-x', '-k', zip, into]);
}

// PowerShell single-quoted string: the only escape inside is a doubled quote.
function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// The zip's top-level folder ("Transcribe/"), verified to actually hold an app.
// Refusing here is the difference between "the update didn't apply" and "the
// install folder now contains half of something".
function findPayload(extractedDir, platform = process.platform) {
  const appName = platform === 'darwin' ? 'Transcribe.app' : 'Transcribe.exe';
  const candidates = [extractedDir];
  let entries = [];
  try { entries = fs.readdirSync(extractedDir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) if (e.isDirectory()) candidates.push(path.join(extractedDir, e.name));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, appName))) return dir;
  }
  return null;
}

// Merge `src` over `dst` after this process exits, then relaunch. Everything the
// zip does not mention — models/, tools/, the user's transcripts — is left alone,
// which is what makes an in-place update safe for a 4.6 GB folder.
function writeHelper(dir, { src, dst, pid, platform = process.platform }) {
  if (platform === 'win32') {
    const file = path.join(dir, 'apply-update.ps1');
    fs.writeFileSync(file, [
      '$ErrorActionPreference = "SilentlyContinue"',
      `try { Wait-Process -Id ${pid} -Timeout 120 } catch { }`,
      'Start-Sleep -Milliseconds 800',
      `Copy-Item -Path (Join-Path ${psQuote(src)} '*') -Destination ${psQuote(dst)} -Recurse -Force`,
      `Start-Process -FilePath (Join-Path ${psQuote(dst)} 'Transcribe.exe')`,
      `Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force`,
      '',
    ].join('\r\n'), 'utf8');
    return { bin: psExe(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] };
  }
  const file = path.join(dir, 'apply-update.sh');
  fs.writeFileSync(file, [
    '#!/bin/bash',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done`,
    'sleep 1',
    // ditto merges into an existing directory and preserves the bundle.
    `/usr/bin/ditto ${shQuote(src)} ${shQuote(dst)}`,
    // path.posix, not the ambient path: this string goes INTO a bash script, and
    // generating it on a Windows host (as the tests do) would otherwise emit
    // backslashes. Same reason whisperOutputPlan takes the platform's flavor
    // rather than the host's.
    `/usr/bin/open ${shQuote(path.posix.join(dst, 'Transcribe.app'))}`,
    `rm -rf ${shQuote(dir)}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin: '/bin/bash', args: [file] };
}

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/// installUpdate({ asset, folderRoot, onProgress, onStage }) -> { helper } or throws.
///
/// Resolves ONLY when everything is staged and the helper is running; the caller
/// then quits the app. Throws before touching anything if the folder is not
/// writable, the download fails, or the payload doesn't look like Transcribe —
/// in every one of those cases the existing install is untouched.
async function installUpdate({ asset, folderRoot, onProgress, onStage, platform = process.platform, quit }) {
  if (!asset || !asset.url) throw new Error('no downloadable asset for this platform');
  if (!folderRoot) throw new Error('cannot locate the Transcribe folder');

  // Checked FIRST: a read-only install (Program Files, a mounted dmg, a
  // locked-down machine) can never be updated in place, and the user needs to
  // hear that before a 100 MB download rather than after it.
  try {
    fs.accessSync(folderRoot, fs.constants.W_OK);
  } catch (_) {
    const e = new Error('the Transcribe folder is not writable');
    e.readOnly = true;
    throw e;
  }

  const work = path.join(os.tmpdir(), `transcribe-update-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  let ok = false;
  try {
    if (onStage) onStage('downloading');
    const zip = path.join(work, 'update.zip');
    await download(asset.url, zip, { onProgress });

    const size = fs.statSync(zip).size;
    if (!(size > 0) || (asset.size && Math.abs(size - asset.size) > 1024)) {
      throw new Error(`the download is incomplete (${size} of ${asset.size} bytes)`);
    }

    if (onStage) onStage('installing');
    const extracted = path.join(work, 'x');
    await extract(zip, extracted);

    const src = findPayload(extracted, platform);
    if (!src) throw new Error("the downloaded update doesn't contain Transcribe");

    const helper = writeHelper(work, { src, dst: folderRoot, pid: process.pid, platform });
    // Detached and fully unparented: it has to outlive us, since its whole job
    // starts the moment we exit.
    const child = spawn(helper.bin, helper.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { });
    child.unref();
    ok = true;
    if (quit) setTimeout(quit, 400).unref();
    return { work, helper };
  } finally {
    // Only on the failure path: on success the helper owns this directory and
    // deletes it once the copy is done.
    if (!ok) { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { } }
  }
}

module.exports = { installUpdate, findPayload, writeHelper, download, psQuote, shQuote, psExe };
