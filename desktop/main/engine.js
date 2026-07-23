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

const IS_WIN = process.platform === 'win32';

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

// ^https?:// doubles as arg-injection immunity: an accepted value can never
// start with '-' and file:// / raw paths never reach a spawn.
function isAllowedUrl(text) {
  return /^https?:\/\/\S+$/i.test(String(text || '').trim());
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
// RESIDUAL (documented; common case handled): the model path (-m) and wav path
// (-f) are still handed to whisper verbatim. Their leaves are ASCII ('out',
// 'audio.wav', 'ggml-*.bin'), so they only carry non-codepage bytes when their
// *directory* does — i.e. when the Windows user-profile name itself is
// non-ASCII (workDir lives under %TEMP%, the model under the app folder). That
// is the harder case the finding flags; the overwhelmingly common
// ASCII-username install is fully fixed by the -of rerouting above.
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
  fs.rmSync(txt, { force: true });
  fs.rmSync(srt, { force: true });
  fs.rmSync(producedTxt, { force: true });
  fs.rmSync(producedSrt, { force: true });

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
      '-m', modelFile, '-f', wav, '-l', langCode, '-otxt', '-osrt', '-of', ofBase, '-pp',
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
    // straight to txt/srt.
    for (const r of renames) {
      if (fs.existsSync(r.from)) moveOutput(r.from, r.to);
    }
    progress(100);
    return { txt, srt };
  } finally {
    fs.rmSync(wav, { force: true });
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

function infoArgs(url) {
  // -I 1: a bare playlist/channel URL would otherwise be enumerated in full
  // (--no-playlist only trims &list= off watch URLs); playlist_count still
  // reports the real count so the queue can refuse multi-video links.
  return [
    '--no-update', '--no-playlist', '-I', '1', '--skip-download',
    '--print', '%(title)s\t%(duration)s\t%(is_live)s\t%(playlist_count)s',
    url,
  ];
}

// Verified flag sets from research_ytdlp.json — args as ARRAY so the \t
// progress template needs no shell quoting.
function dlArgs(mode, url, stagingDir) {
  const args = [
    '--no-update', '--no-playlist', '-I', '1', '--newline', '--progress',
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

  const child = spawnTool(ytDlpBin, infoArgs(url));
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

let dlSeq = 0;

/// C3: staged download with 2-stage progress mapping and hold-99.
async function dlGet({ url, mode, destDir, onProgress, onChild }) {
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

  const err = makeTail();
  let finalSrc = '';
  // Multi-stage mapping: a merged video is TWO sequential 0→100 downloads; a
  // changed filename means the next stage began. Hold ≤99 until the finished
  // file is actually in place.
  const STAGES = mode === 'video' ? 2 : 1;
  let doneStages = 0;
  let prevName = '';

  const child = spawnTool(ytDlpBin, dlArgs(mode, url, staging));
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
    if (code !== 0 || signal || !finalSrc || !isNonEmptyFile(finalSrc)) {
      throw downloadError(code, err.value, false);
    }
    const target = moveIntoDest(finalSrc, destDir);
    if (!isNonEmptyFile(target)) throw downloadError(1, err.value, false);
    progress(100);
    return { file: target };
  } finally {
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
      spawn('taskkill', taskkillArgs(child.pid), { shell: false, windowsHide: true, stdio: 'ignore' });
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
        tk = spawn('taskkill', taskkillArgs(child.pid), { shell: false, windowsHide: true, stdio: 'ignore' });
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
  },
};
