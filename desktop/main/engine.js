// engine.js — in-process port of bin/transcribe + bin/download (C3):
// probeDeps, transcribe, dlInfo, dlGet, killTree.
//
// Spawn hygiene (C3 SECURITY): shell:false everywhere, args as arrays, URLs
// validated ^https?:// before any spawn (a URL can then never be read as an
// option), user paths never string-interpolated into shells.
//
// Process-group contract: on mac every child is spawned detached (its own
// group leader), so kill(-pid) reaches the whole tree — including
// grandchildren like the ffmpeg that yt-dlp spawns for merging.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./paths.js');
const catalog = require('../shared/catalog.js');
const logic = require('../shared/logic.js');
const copy = require('../shared/copy.js');

const IS_WIN = process.platform === 'win32';

// Absolute System32 path for taskkill — a bare 'taskkill' is resolved via the
// child search path, which on Windows includes the process cwd, so a taskkill.exe
// planted in a download/output folder could run instead. (Same exe-planting
// footgun setup.ps1 avoids for curl and queue.js for whoami/icacls.)
const TASKKILL = IS_WIN
  ? path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe')
  : 'taskkill';

// ---------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canceledError() {
  const e = new Error('canceled');
  e.canceled = true;
  return e;
}

// Bounded stderr accumulator: classification only needs the tail, and whisper
// on a long file can emit megabytes of -pp lines.
function makeTail(limit = 65536) {
  let s = '';
  return {
    push(t) {
      s += t;
      if (s.length > limit) s = s.slice(-limit);
    },
    get value() {
      return s;
    },
  };
}

function lastLines(text, n) {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n).join('\n');
}

function lastNonEmptyLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') return lines[i];
  }
  return '';
}

// Chunk → line re-assembly (child stdio arrives in arbitrary chunks).
function lineSplitter(onLine) {
  let buf = '';
  const feed = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
  feed.flush = () => {
    if (buf) {
      onLine(buf.replace(/\r$/, ''));
      buf = '';
    }
  };
  return feed;
}

// Monotone 0-100 reporter: repeated/backward readings never reach the UI.
function progressReporter(onProgress) {
  let last = -1;
  return (p) => {
    p = Math.max(0, Math.min(100, Math.floor(p)));
    if (p > last) {
      last = p;
      if (onProgress) {
        try { onProgress(p); } catch (_) { /* renderer callback must not kill the job */ }
      }
    }
  };
}

// Protocol names travel in tab-separated lines / status text — same
// sanitization as the bash engines.
function sanitizeName(name) {
  return String(name || '').replace(/[\t\n\r]/g, ' ');
}

// A path whisper-cli.exe can pass through its ANSI-codepage argv intact iff it is
// pure ASCII (a non-ASCII byte outside — or even inside — the active codepage
// makes whisper crash or lose the file; see the win path codepage note below).
function isAsciiPath(p) {
  return /^[\x00-\x7F]*$/.test(String(p == null ? '' : p));
}

function spawnTool(bin, args) {
  const child = spawn(bin, args, {
    shell: false,
    windowsHide: true,
    detached: !IS_WIN, // own process group so killTree(-pid) reaches the tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: paths.childEnv(),
  });
  return child;
}

function waitClose(child) {
  return new Promise((resolve) => {
    let settled = false;
    child.on('error', () => {
      if (!settled) {
        settled = true;
        resolve({ code: -1, signal: null });
      }
    });
    child.on('close', (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
  });
}

function isNonEmptyFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch (_) {
    return false;
  }
}

async function removeDirWithRetry(dir, totalMs = 4000) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    if (!fs.existsSync(dir) || Date.now() > deadline) return;
    // A just-killed child may still hold files for a beat — retry, don't fail.
    await sleep(150);
  }
}

// ---------------------------------------------------------------- URL guard

// SSRF guard: reject loopback / private / link-local / metadata targets so a
// pasted link like http://169.254.169.254/latest/meta-data/ or
// http://localhost:8080/admin can't be turned into an internal request by yt-dlp.
// (Literal-host defense; a public name that DNS-rebinds to a private IP is out of
// scope here — the concrete, easy-to-abuse cases are blocked.)
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::') return true;                 // IPv6 loopback / unspecified
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;             // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;             // fc00::/7 unique-local
  if (/^::ffff:/i.test(h)) return true;                       // IPv4-mapped IPv6 — treat as private, be safe
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true;
    if (o[0] === 0 || o[0] === 127 || o[0] === 10) return true;         // this-host, loopback, private
    if (o[0] === 169 && o[1] === 254) return true;                      // link-local incl. 169.254.169.254 metadata
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;          // 172.16/12
    if (o[0] === 192 && o[1] === 168) return true;                      // 192.168/16
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;         // 100.64/10 CGNAT
  }
  return false;
}

// ^https?:// doubles as arg-injection immunity: an accepted value can never start
// with '-' and file:// / raw paths never reach a spawn. The URL is then parsed and
// internal/loopback hosts rejected (SSRF).
function isAllowedUrl(text) {
  const s = String(text || '').trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return false;
  let u;
  try { u = new URL(s); } catch (_) { return false; }
  return !isPrivateHost(u.hostname);
}

// ---------------------------------------------------------------- probe (C2)

function modelPresent(sel, opts) {
  const m = catalog.by(sel);
  try {
    return fs.statSync(paths.modelPath(m.fileName, opts)).size > m.minBytes;
  } catch (_) {
    return false;
  }
}

function probeDeps(opts) {
  const whisperOK = !!paths.findTool('whisper', opts);
  const ffmpegOK = !!paths.findTool('ffmpeg', opts);
  const ytDlpOK = !!paths.findTool('ytDlp', opts);
  const bestModelOK = modelPresent('best', opts);
  const fastModelOK = modelPresent('fast', opts);
  const folderOK = paths.folderMarkerPresent(opts);
  return {
    whisperOK,
    ffmpegOK,
    ytDlpOK,
    bestModelOK,
    fastModelOK,
    folderOK,
    setupNeeded: !folderOK || !whisperOK || !ffmpegOK || !bestModelOK,
    linksLimited: !ytDlpOK,
  };
}

// ------------------------------------------------------ win path codepage safety
//
// WHY (finding, major): whisper-cli.exe has no wide-char argv handling. On
// Windows, Node's UTF-16 argv is down-converted to the system ANSI codepage
// before it reaches whisper's narrow main(); any character outside that
// codepage (Croatian č/š/ž on a cp1250 box, CJK, emoji straight out of a yt-dlp
// title) turns into '?' — an illegal NTFS filename char — or a best-fit
// substitute. whisper then writes the transcript to the wrong path, or fails to
// create it, the fresh-mtime success check misses, and the run surfaces the
// misleading "is the language 'hr' valid?" error. This breaks the PRIMARY
// Croatian use case, whose titles are full of diacritics.
//
// FIX (win32): point whisper's -of at an ASCII-only base ('out') inside the
// app-controlled job workDir, then move the produced out.txt/out.srt to the
// real — possibly Unicode — destination stem with Node's fs, which IS
// Unicode-safe (libuv calls the wide Win32 APIs). darwin is untouched: -of
// points straight at the destination stem and nothing is renamed.
//
// NON-ASCII USERNAME (the -m/-f/-of *directory* case, now handled): -of's leaf is
// ASCII 'out', but its directory (workDir under %TEMP% = C:\Users\<name>\…) and
// the -m model directory can still carry a non-ASCII Windows profile name. MEASURED
// on real Windows (ACP cp1250): this broke EVERY transcription, and NOT only for
// chars outside the codepage — even cp1250-REPRESENTABLE diacritics (C:\Users\Žiga\…)
// crashed whisper-cli outright (STATUS_STACK_BUFFER_OVERRUN 0xC0000409); emoji/CJK
// degraded to "input file not found". Two coordinated fixes make -f/-of/-m ASCII:
//   (1) queue.js chooseJobBase roots the workDir at an ASCII %ProgramData% base
//       (per-user hashed) when %TEMP% is non-ASCII, so the wav (-f) and out (-of)
//       are ASCII; and
//   (2) transcribe() below hardlinks a non-ASCII model into that ASCII workDir and
//       passes the ASCII link as -m.
// Both win32-only and no-ops for ASCII usernames. Verified end-to-end on real
// Windows. Remaining residual (documented, narrow): if the model lives on a
// DIFFERENT volume than %ProgramData% the hardlink can't be made and -m falls back
// to the real path — no worse than before. GetShortPathNameW (8.3) was rejected:
// no Node binding without a native addon (the codebase is pure JS, no bundler).
//
// Pure + platform-injectable so the mapping is unit-testable from a mac (uses
// the injected platform's path flavor, which equals the ambient one on the real
// OS, so production behavior is byte-identical to the previous inline logic).
function whisperOutputPlan({ platform, input, workDir }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Stem from the FILENAME only: a dotted parent folder must not eat the name;
  // dotfiles keep their full name (same rules as bin/transcribe).
  const fname = p.basename(input);
  const dot = fname.lastIndexOf('.');
  const stem = dot > 0 ? fname.slice(0, dot) : fname;
  const base = p.join(p.dirname(input), stem);
  const txt = `${base}.txt`;
  const srt = `${base}.srt`;
  if (platform !== 'win32') {
    return { ofBase: base, txt, srt, producedTxt: txt, producedSrt: srt, renames: [] };
  }
  const ofBase = p.join(workDir, 'out');
  const producedTxt = `${ofBase}.txt`;
  const producedSrt = `${ofBase}.srt`;
  return {
    ofBase,
    txt,
    srt,
    producedTxt,
    producedSrt,
    renames: [
      { from: producedTxt, to: txt },
      { from: producedSrt, to: srt },
    ],
  };
}

// EXDEV-safe move: the ASCII workDir (under %TEMP%) and the destination folder
// can live on different volumes on Windows, where rename() throws EXDEV.
function moveOutput(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.rmSync(from, { force: true });
    } else {
      throw e;
    }
  }
}

// Windows-only reality: a file can be *momentarily* unmovable because Defender
// (or the search indexer) has the just-written out.txt open for a scan. Those
// clear in well under a second, so retry the lock codes a few times before
// giving up. A destination the user really does have open in Word never clears:
// it gives up after ~0.5 s and outputWriteError turns it into a sentence.
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function moveOutputWithRetry(from, to, attempts = 4, delayMs = 150) {
  for (let i = 1; ; i++) {
    try {
      moveOutput(from, to);
      return;
    } catch (e) {
      if (i >= attempts || !e || !LOCK_CODES.has(e.code)) throw e;
      await sleep(delayMs);
    }
  }
}

// The transcription itself succeeded; only putting the finished file in place
// failed. Never let the raw fs message ("EPERM: operation not permitted, rename
// 'C:\…\out.txt' -> …") reach the row's status line.
//
// EPERM/EACCES has TWO very different causes with opposite cures, and the queue's
// pre-flight can't tell them apart (MEASURED on Windows: fs.accessSync(dir, W_OK)
// PASSES on a directory whose write ACE is denied, and only the real write fails).
// The destination file itself is the discriminator — the stale-clear just tried to
// delete it, so:
//   • it still exists  -> something holds it open. Cure: close that program.
//   • it doesn't exist -> creating a file in that folder is what was refused.
//     Cure: pick a different folder. Telling this user to "close Word" would send
//     them looking for a program that isn't there.
function outputWriteError(e, dest, modelSel, fileName) {
  const raw = String((e && e.message) || e);
  if (e && LOCK_CODES.has(e.code)) {
    let destExists = false;
    try { destExists = fs.existsSync(dest); } catch (_) { /* treat as absent */ }
    const err = new Error(destExists
      ? copy.failOutputLocked(path.basename(dest))
      : copy.failOutputDirReadOnly(fileName));
    err.details = raw;
    return err;
  }
  return transcribeError(1, raw, modelSel, fileName, raw);
}

// ---------------------------------------------------------------- transcribe

// Same aliases as bin/transcribe so terminal-style selectors keep working.
function normalizeLang(raw) {
  const l = String(raw || '').toLowerCase().replace(/\s+/g, '');
  if (l === 'hr' || l === 'croatian' || l === 'hrvatski') return 'hr';
  if (l === 'sl' || l === 'slovenian' || l === 'slovene' || l === 'slovenscina' || l === 'slovenščina') return 'sl';
  return l || 'hr';
}

function transcribeError(exitCode, stderr, modelSel, fileName, details) {
  const e = new Error(logic.classifyTranscribeFailure(exitCode, stderr, modelSel, fileName));
  e.details = details !== undefined ? details : lastLines(stderr, 15);
  return e;
}

/// C3: ffmpeg extract → whisper → {txt, srt}. onProgress(1) fires right after
/// extraction (short-clip fix); pre-existing txt/srt are deleted first
/// (stale-output fix); success = txt exists with fresh mtime. `onChild` (extra,
/// optional) surfaces each spawned child so the queue can killTree() it.
async function transcribe({ input, modelSel, lang, workDir, onProgress, onChild }) {
  if (!path.isAbsolute(String(input || ''))) throw new Error('transcribe: absolute input path required');
  if (!path.isAbsolute(String(workDir || ''))) throw new Error('transcribe: absolute workDir required');

  // Cancel token shared by both children: killTree() on the ffmpeg child must
  // also stop the not-yet-spawned whisper.
  const job = { canceled: false };
  const fileName = sanitizeName(path.basename(input));
  const model = catalog.by(modelSel);
  const modelFile = paths.modelPath(model.fileName);
  const langCode = normalizeLang(lang);

  let st = null;
  try { st = fs.statSync(input); } catch (_) {}
  if (!st || !st.isFile()) throw transcribeError(1, `SKIP (not a file): ${input}`, modelSel, fileName);

  const whisperBin = paths.findTool('whisper');
  if (!whisperBin) throw transcribeError(3, 'whisper.cpp not found. Please run setup.', modelSel, fileName);
  const ffmpegBin = paths.findTool('ffmpeg');
  if (!ffmpegBin) throw transcribeError(3, 'ffmpeg not found. Please run setup.', modelSel, fileName);

  // failModelMissing preflight — size floor, not just existence: an
  // interrupted download leaves a truncated model whisper rejects at load.
  let modelSt = null;
  try { modelSt = fs.statSync(modelFile); } catch (_) {}
  if (!modelSt || modelSt.size <= model.minBytes) {
    throw transcribeError(3, `Model not found at ${modelFile}. Please run setup.`, modelSel, fileName);
  }

  // -of / rename plan. win32: whisper writes ASCII out.* into workDir, then we
  // move them to the real (possibly-Unicode) destination — see
  // whisperOutputPlan for why. darwin: whisper writes straight to the dest and
  // renames is empty (byte-identical to the prior inline logic).
  const plan = whisperOutputPlan({ platform: process.platform, input, workDir });
  const { ofBase, txt, srt, producedTxt, producedSrt, renames } = plan;
  const wav = path.join(workDir, 'audio.wav');

  const progress = progressReporter(onProgress);
  progress(0);

  // -- stage 1: audio extraction --
  const ffErr = makeTail();
  {
    const child = spawnTool(ffmpegBin, [
      '-y', '-nostdin', '-loglevel', 'error',
      '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
    ]);
    child.__job = job;
    if (onChild) onChild(child);
    child.stdout.resume();
    child.stderr.on('data', (d) => ffErr.push(String(d)));
    const { code, signal } = await waitClose(child);
    if (job.canceled || child.__killRequested) {
      fs.rmSync(wav, { force: true });
      throw canceledError();
    }
    if (code !== 0 || signal) {
      fs.rmSync(wav, { force: true });
      throw transcribeError(1, `${ffErr.value}\nSKIP (could not read audio): ${fileName}`, modelSel, fileName);
    }
  }

  // Whisper's -pp prints per-30s-window percentages, so short clips only ever
  // print 0% — without this nudge the UI would sit on "Preparing…" until Done.
  progress(1);

  // A transcript left over from an earlier run must not be mistaken for this
  // run's result — whisper can fail while exiting 0. Clear the destination (on
  // failure nothing stale is left next to the source) and, on win32, the ASCII
  // workDir targets whisper writes to (producedTxt/producedSrt === txt/srt on
  // darwin, so those two are harmless no-ops there).
  // force:true suppresses ENOENT but NOT EPERM/EBUSY: on Windows a prior
  // transcript the user still has open in Word/Excel/VLC holds an exclusive
  // lock, so deleting it throws — which, sitting before the try below, would
  // abort the whole run before whisper even starts (macOS unlinks open files
  // fine). Tolerate a locked destination here; a truly stuck lock resurfaces at
  // moveOutput, but only after the transcription work is actually done.
  for (const stale of [txt, srt, producedTxt, producedSrt]) {
    try { fs.rmSync(stale, { force: true }); } catch (_) { /* locked prior output — deal with it at move time */ }
  }

  // win32 codepage safety for -m (the last of whisper's three path args): the wav
  // (-f) and out (-of) already live in the workDir, which the queue roots at an
  // ASCII base when the Windows profile name is non-ASCII (chooseJobBase). The
  // model path can still be non-ASCII on its own — the app folder unzipped under
  // C:\Users\<non-ascii>\… — and whisper's ANSI argv then crashes on it. Hardlink
  // the model into the ASCII workDir (instant, no data copy on the same volume)
  // and hand whisper that ASCII path. Only when the workDir really is ASCII (else
  // the link is no better); cross-volume / perms failures fall back to the real
  // path — no worse than before. The link sits in workDir, so the queue's
  // teardown reclaims it with everything else. darwin: IS_WIN gate skips this.
  let modelForWhisper = modelFile;
  let modelLink = null;
  if (IS_WIN && !isAsciiPath(modelFile) && isAsciiPath(workDir)) {
    const linked = path.join(workDir, path.basename(modelFile));
    try {
      if (!fs.existsSync(linked)) fs.linkSync(modelFile, linked);
      if (isAsciiPath(linked)) { modelForWhisper = linked; modelLink = linked; }
    } catch (_) { /* cross-volume or perms — keep the original model path */ }
  }

  // Whisper stderr goes to a per-job log kept on failure (path lands in
  // error.details), deleted on success/cancel — mirrors bin/transcribe.
  const logFile = path.join(os.tmpdir(), `transcribe_log_${process.pid}_${crypto.randomBytes(4).toString('hex')}.log`);
  const logStream = fs.createWriteStream(logFile);
  const wErr = makeTail();
  const whisperStart = Date.now();
  let keepLog = false;
  try {
    if (job.canceled) throw canceledError();
    const child = spawnTool(whisperBin, [
      '-m', modelForWhisper, '-f', wav, '-l', langCode, '-otxt', '-osrt', '-of', ofBase, '-pp',
    ]);
    child.__job = job;
    if (onChild) onChild(child);
    child.stdout.resume();
    const feed = lineSplitter((line) => {
      // Anchor on the "progress = NN%" token: no other digit on the line
      // (thread id, timestamp) may leak into the percentage.
      const m = /progress\s*=\s*(\d+)\s*%/.exec(line);
      if (m && +m[1] <= 100) progress(Math.max(1, +m[1]));
    });
    child.stderr.on('data', (d) => {
      const t = String(d);
      logStream.write(t);
      wErr.push(t);
      feed(t);
    });
    const { code, signal } = await waitClose(child);
    feed.flush();
    await new Promise((resolve) => logStream.end(resolve));

    if (job.canceled || child.__killRequested) {
      // Partial outputs must not be mistaken for a finished transcript (these
      // are the paths whisper actually wrote — workDir/out.* on win32).
      fs.rmSync(producedTxt, { force: true });
      fs.rmSync(producedSrt, { force: true });
      throw canceledError();
    }

    let fresh = false;
    try {
      const ts = fs.statSync(producedTxt);
      fresh = ts.isFile() && ts.mtimeMs >= whisperStart - 2000;
    } catch (_) {}
    if (code !== 0 || signal || !fresh) {
      keepLog = true;
      const stderrText = `${wErr.value}\nSKIP (transcription failed — is the language '${langCode}' valid?): ${fileName}`;
      throw transcribeError(1, stderrText, modelSel, fileName,
        `${lastLines(wErr.value, 15)}\nDetails: ${logFile}`);
    }
    // win32: move the ASCII workDir outputs to the real destination with
    // Node's Unicode-safe fs. darwin: renames is empty — whisper already wrote
    // straight to txt/srt. A destination the user still has open (the case the
    // stale-clear above deliberately tolerated) surfaces here, as a sentence
    // that says which file to close rather than a raw EPERM.
    for (const r of renames) {
      if (!fs.existsSync(r.from)) continue;
      try {
        await moveOutputWithRetry(r.from, r.to);
      } catch (e) {
        throw outputWriteError(e, r.to, modelSel, fileName);
      }
    }
    progress(100);
    return { txt, srt };
  } finally {
    fs.rmSync(wav, { force: true });
    // Drop the model hardlink (win32 non-ASCII path) once whisper has released its
    // mmap. It lives in workDir so the queue's teardown would reclaim it too, but
    // an NTFS hardlink pins the model's data blocks even after the model file
    // itself is deleted — removing it here avoids invisible disk retention if the
    // queue's whole-dir rmrf later loses a lock race. maxRetries covers the beat
    // after a cancel while whisper is still unmapping.
    if (modelLink) { try { fs.rmSync(modelLink, { force: true, maxRetries: 10, retryDelay: 150 }); } catch (_) { /* queue teardown will retry */ } }
    if (!keepLog) {
      logStream.destroy();
      fs.rmSync(logFile, { force: true });
    }
  }
}

// ---------------------------------------------------------------- downloads

function downloadError(exitCode, stderr, lookupStage) {
  const r = logic.classifyDownloadFailure(exitCode === null ? 1 : exitCode, stderr, !!lookupStage);
  const e = new Error(r.message);
  e.details = lastLines(stderr, 15);
  e.stale = r.stale;
  return e;
}

// --encoding UTF-8 (WHY, Windows finding): yt-dlp's --print writes to stdout using
// the process codepage, which on Windows (cp1250/cp852) can't represent emoji or
// non-codepage diacritics — it drops or replaces them (a "Slej 🤏🏻" title prints as
// "Slej "). Node then reads that stdout as UTF-8, so titles surface with U+FFFD and,
// worse, the after_move:filepath path is mangled and the finished download can't be
// located → the misleading "the video may be private or removed". Forcing yt-dlp's
// own output to UTF-8 makes it match Node's decode. No-op on macOS (already UTF-8).
// --cookies <file>: an optional Netscape cookie file (e.g. an Instagram login
// captured in-app) so sites that gate anonymous access authenticate. Passed as a
// separate argv element (never interpolated); only added when a path is given.
function cookieArgs(cookieFile) {
  return cookieFile ? ['--cookies', cookieFile] : [];
}

// The caller hands us cookie CONTENT (a Netscape file body), never a path or a
// long-lived file. We write it to a per-user-PRIVATE temp — %TEMP%/$TMPDIR is
// ACL-restricted to the owner (SYSTEM/Admins/user; NOT world-readable like the
// download folder) — hand only that path to yt-dlp for a single call, and the
// caller deletes it in a finally (minimal window, guaranteed cleanup). yt-dlp is
// Python (wide argv), so a non-ASCII temp path is fine. null → no cookie file.
function writeCookieFile(cookies) {
  if (!cookies) return null;
  const p = path.join(os.tmpdir(), `transcribe-ck-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(p, String(cookies), { mode: 0o600 });
  return p;
}

function infoArgs(url, cookieFile) {
  // -I 1: a bare playlist/channel URL would otherwise be enumerated in full
  // (--no-playlist only trims &list= off watch URLs); playlist_count still
  // reports the real count so the queue can refuse multi-video links.
  return [
    '--no-update', '--encoding', 'UTF-8', '--no-playlist', '-I', '1', '--skip-download',
    ...cookieArgs(cookieFile),
    '--print', '%(title)s\t%(duration)s\t%(is_live)s\t%(playlist_count)s',
    url,
  ];
}

// Verified flag sets from research_ytdlp.json — args as ARRAY so the \t
// progress template needs no shell quoting.
function dlArgs(mode, url, stagingDir, cookieFile) {
  const args = [
    '--no-update', '--encoding', 'UTF-8', '--no-playlist', '-I', '1', '--newline', '--progress',
    ...cookieArgs(cookieFile),
    '--progress-template', 'download:PROGRESS\t%(progress._percent_str)s\t%(progress.eta)s\t%(progress.filename)s',
  ];
  if (mode === 'video') {
    args.push(
      '--progress-template', 'postprocess:PP\t%(progress.status)s\t%(progress.postprocessor)s',
      '-f', 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '-S', 'res:1080',
      '--merge-output-format', 'mp4',
    );
  } else {
    args.push('-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0');
  }
  args.push(
    '-P', stagingDir,
    '-o', '%(title).120B [%(id)s].%(ext)s',
    '--print', 'after_move:filepath', '--no-simulate',
    url,
  );
  return args;
}

// info print line, split from the RIGHT — a tab inside the title must not
// shift the fields. "NA"/empty → null.
function parseInfoLine(line) {
  const parts = String(line).split('\t');
  const rawCount = parts.length > 3 ? parts.pop() : 'NA';
  const rawLive = parts.length > 2 ? parts.pop() : 'NA';
  const rawDur = parts.length > 1 ? parts.pop() : 'NA';
  const field = (v) => {
    v = String(v == null ? '' : v).trim();
    return v === '' || v === 'NA' ? null : v;
  };
  const title = field(sanitizeName(parts.join(' ')));
  const dur = field(rawDur);
  const durNum = dur === null ? NaN : Number(dur);
  const count = field(rawCount);
  return {
    title,
    durationSec: Number.isFinite(durNum) && durNum >= 0 ? Math.trunc(durNum) : null,
    isLive: (field(rawLive) || '').toLowerCase() === 'true',
    playlistCount: count !== null && /^\d+$/.test(count) ? parseInt(count, 10) : null,
  };
}

/// C3: yt-dlp metadata lookup with a 30 s watchdog kill.
async function dlInfo(url, opts = {}) {
  url = String(url || '').trim();
  if (!isAllowedUrl(url)) throw downloadError(1, `ERROR: '${url}' is not a valid URL`, true);
  const ytDlpBin = paths.findTool('ytDlp');
  if (!ytDlpBin) throw downloadError(3, 'yt-dlp not found. Please run setup.', true);

  let cookieFile = null;
  try {
    // opts.cookies may be a string OR an async provider (url -> Netscape|null),
    // so the queue can defer the Electron cookie read to here without threading
    // async through its scheduler.
    cookieFile = writeCookieFile(typeof opts.cookies === 'function' ? await opts.cookies(url) : opts.cookies);
    const child = spawnTool(ytDlpBin, infoArgs(url, cookieFile));
    if (opts.onChild) opts.onChild(child);
    const out = makeTail();
    const err = makeTail();
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => err.push(String(d)));

    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.watchdogMs || 30000);

    const { code, signal } = await waitClose(child);
    clearTimeout(watchdog);

    if (timedOut) {
      // bin/download's watchdog phrasing so the classifier maps this to the
      // network/took-too-long message.
      throw downloadError(1,
        `${err.value}\nERROR: The video lookup took too long and was stopped — check the internet connection.`,
        true);
    }
    if (child.__killRequested) throw canceledError();
    const line = lastNonEmptyLine(out.value);
    if (code !== 0 || signal || !line) throw downloadError(code, err.value, true);
    return parseInfoLine(line);
  } finally {
    if (cookieFile) fs.rmSync(cookieFile, { force: true });
  }
}

function filesIdentical(a, b) {
  let sa; let sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch (_) {
    return false;
  }
  if (sa.size !== sb.size) return false;
  const CHUNK = 1 << 20;
  const fda = fs.openSync(a, 'r');
  const fdb = fs.openSync(b, 'r');
  try {
    const ba = Buffer.alloc(CHUNK);
    const bb = Buffer.alloc(CHUNK);
    let pos = 0;
    while (pos < sa.size) {
      const na = fs.readSync(fda, ba, 0, CHUNK, pos);
      const nb = fs.readSync(fdb, bb, 0, CHUNK, pos);
      if (na !== nb || na === 0) return false; // short read while bytes remain
      if (!ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      pos += na;
    }
    return true;
  } finally {
    fs.closeSync(fda);
    fs.closeSync(fdb);
  }
}

// Collision contract: the [id] in the name makes cross-video collisions
// impossible, so an existing identical file is the same video (reuse it);
// same name with different bytes never overwrites — it gets " (2)"-numbered.
function moveIntoDest(src, destDir) {
  const fname = path.basename(src);
  let target = path.join(destDir, fname);
  if (fs.existsSync(target) && filesIdentical(src, target)) {
    fs.rmSync(src, { force: true });
    return target;
  }
  if (fs.existsSync(target)) {
    const dot = fname.lastIndexOf('.');
    const stem = dot > 0 ? fname.slice(0, dot) : fname;
    const ext = dot > 0 ? fname.slice(dot) : '';
    let n = 2;
    while (fs.existsSync(path.join(destDir, `${stem} (${n})${ext}`))) n++;
    target = path.join(destDir, `${stem} (${n})${ext}`);
  }
  try {
    fs.renameSync(src, target);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      // Staging lives inside destDir so this can't normally happen; kept as a
      // safety net for exotic mounts.
      fs.copyFileSync(src, target);
      fs.rmSync(src, { force: true });
    } else {
      throw e;
    }
  }
  return target;
}

// Fallback locator: the finished download is the sole non-temporary file in its
// private staging dir. readdir (libuv, wide Win32 APIs) returns the true Unicode
// name, so this recovers the file when yt-dlp's stdout mangled the printed path.
function findStagedFile(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const finals = names
    .filter((n) => !/\.(part|ytdl|temp|part-Frag\d+)$/i.test(n))
    .map((n) => path.join(dir, n))
    .filter((p) => isNonEmptyFile(p));
  finals.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return finals[0] || null;
}

let dlSeq = 0;

/// C3: staged download with 2-stage progress mapping and hold-99.
async function dlGet({ url, mode, destDir, onProgress, onChild, cookies }) {
  url = String(url || '').trim();
  if (mode !== 'video' && mode !== 'audio') throw new Error('dlGet: mode must be video|audio');
  if (!path.isAbsolute(String(destDir || ''))) throw new Error('dlGet: absolute destDir required');
  if (!isAllowedUrl(url)) throw downloadError(1, `ERROR: '${url}' is not a valid URL`, false);
  const ytDlpBin = paths.findTool('ytDlp');
  if (!ytDlpBin) throw downloadError(3, 'yt-dlp not found. Please run setup.', false);
  if (!paths.findTool('ffmpeg')) throw downloadError(3, 'ffmpeg not found. Please run setup.', false);

  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (_) {
    throw downloadError(1, `ERROR: Can't create the download folder: ${destDir}`, false);
  }

  // Stage INSIDE the destination volume: half-downloaded files never appear in
  // the user's folder and the final move stays a same-volume atomic rename.
  // (.<pid>.<seq> — the seq keeps a retry from colliding with a dying run's
  // staging dir, since in-process runs all share one pid.)
  const staging = path.join(destDir, `.transcribe-dl.${process.pid}.${++dlSeq}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
  } catch (_) {
    throw downloadError(1, `ERROR: Can't write in the download folder: ${destDir}`, false);
  }

  const progress = progressReporter(onProgress);
  progress(0);

  // Cookie file in a per-user-private temp (NOT the download folder), deleted in
  // the finally alongside the staging dir. `cookies` may be a string or an async
  // provider (url -> Netscape|null) resolved here.
  const cookieFile = writeCookieFile(typeof cookies === 'function' ? await cookies(url) : cookies);
  const err = makeTail();
  let finalSrc = '';
  // Multi-stage mapping: a merged video is TWO sequential 0→100 downloads; a
  // changed filename means the next stage began. Hold ≤99 until the finished
  // file is actually in place.
  const STAGES = mode === 'video' ? 2 : 1;
  let doneStages = 0;
  let prevName = '';

  const child = spawnTool(ytDlpBin, dlArgs(mode, url, staging, cookieFile));
  if (onChild) onChild(child);
  const feed = lineSplitter((line) => {
    if (line.startsWith('PROGRESS\t')) {
      const parts = line.split('\t');
      const m = /^\s*(\d+)/.exec(parts[1] || '');
      if (!m || +m[1] > 100) return;
      const pct = +m[1];
      const name = sanitizeName(path.basename(parts.slice(3).join('\t')));
      if (prevName && name !== prevName && doneStages < STAGES - 1) doneStages++;
      prevName = name;
      progress(Math.min(99, Math.floor((doneStages * 100 + pct) / STAGES)));
    } else if (path.isAbsolute(line)) {
      finalSrc = line; // after_move:filepath — the true completion signal
    }
  });
  child.stdout.on('data', (d) => feed(String(d)));
  child.stderr.on('data', (d) => err.push(String(d)));

  try {
    const { code, signal } = await waitClose(child);
    feed.flush();
    if (child.__killRequested) throw canceledError();
    // after_move:filepath is the true completion signal, but if it's missing or
    // unreadable (a stdout that still mangled a non-ASCII name) yet yt-dlp exited
    // cleanly, recover the finished file from the single-download staging dir.
    if (code === 0 && !signal && (!finalSrc || !isNonEmptyFile(finalSrc))) {
      const staged = findStagedFile(staging);
      if (staged) finalSrc = staged;
    }
    if (code !== 0 || signal || !finalSrc || !isNonEmptyFile(finalSrc)) {
      throw downloadError(code, err.value, false);
    }
    const target = moveIntoDest(finalSrc, destDir);
    if (!isNonEmptyFile(target)) throw downloadError(1, err.value, false);
    progress(100);
    return { file: target };
  } finally {
    if (cookieFile) fs.rmSync(cookieFile, { force: true });
    await removeDirWithRetry(staging);
  }
}

// ---------------------------------------------------------------- killTree

function taskkillArgs(pid) {
  return ['/pid', String(pid), '/T', '/F'];
}

/// C3: mac — SIGTERM the child's process group, SIGKILL any survivor after
/// 3 s (kill(-pid, 0) succeeds while ANY member is alive, so grandchildren
/// like yt-dlp's ffmpeg are caught); win — taskkill /pid <pid> /T /F.
function killTree(child) {
  if (!child || !child.pid) return;
  child.__killRequested = true;
  if (child.__job) child.__job.canceled = true; // stop a not-yet-spawned sibling
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    try {
      const tk = spawn(TASKKILL, taskkillArgs(child.pid), { shell: false, windowsHide: true, stdio: 'ignore' });
      // A failed spawn (taskkill blocked by AV/EDR, System32 off the child PATH,
      // an IFEO hijack) is delivered ASYNCHRONOUSLY as an 'error' event the
      // try/catch can't see; with no listener Node re-throws it as an uncaught
      // exception and the whole main process dies the instant the user clicks
      // Cancel. Swallow it — same guard the killTreeAndWait sibling already has.
      tk.on('error', () => {});
    } catch (_) {}
    return;
  }
  const pgid = child.pid; // detached spawn → the child is its own group leader
  try { process.kill(-pgid, 'SIGTERM'); } catch (_) {}
  const escalate = setTimeout(() => {
    let alive = false;
    try { alive = process.kill(-pgid, 0); } catch (_) {}
    if (alive) {
      try { process.kill(-pgid, 'SIGKILL'); } catch (_) {}
    }
  }, 3000);
  if (escalate.unref) escalate.unref();
}

/// Synchronous-ish variant for app termination: TERM, bounded wait, then KILL.
async function killTreeAndWait(child, timeoutMs = 3000) {
  if (!child || !child.pid) return;
  child.__killRequested = true;
  if (child.__job) child.__job.canceled = true;
  if (IS_WIN) {
    await new Promise((resolve) => {
      let tk;
      try {
        tk = spawn(TASKKILL, taskkillArgs(child.pid), { shell: false, windowsHide: true, stdio: 'ignore' });
      } catch (_) {
        return resolve();
      }
      tk.on('error', resolve);
      tk.on('close', resolve);
    });
    return;
  }
  const pgid = child.pid;
  try { process.kill(-pgid, 'SIGTERM'); } catch (_) { return; }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pgid, 0); } catch (_) { return; }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch (_) {}
}

module.exports = {
  probeDeps,
  modelPresent,
  transcribe,
  dlInfo,
  dlGet,
  killTree,
  killTreeAndWait,
  _internals: {
    infoArgs,
    dlArgs,
    taskkillArgs,
    isAllowedUrl,
    parseInfoLine,
    moveIntoDest,
    filesIdentical,
    lineSplitter,
    normalizeLang,
    whisperOutputPlan,
    moveOutput,
    moveOutputWithRetry,
    outputWriteError,
    isAsciiPath,
    findStagedFile,
  },
};
