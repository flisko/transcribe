// logic.js — pure logic: ETA smoothing, version comparison, progress/engine
// output parsing, link validation, and failure classification (port of
// app/Logic.swift). No Electron imports here so `node --test` can load it.
'use strict';

const Copy = require('./copy');
const Models = require('./catalog');
const Languages = require('./languages');

// MARK: - ETA estimation

// Exponentially-smoothed percent-per-second rate with coarse, monotone display:
// the shown estimate never jumps upward by more than one bucket per refresh
// (an ETA that thrashes reads as broken).
class EtaSmoother {
  // Coarse minute ladder; 0 means "less than a minute left".
  static bucketsMinutes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30,
    40, 50, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720];

  constructor() { this.reset(); }

  reset() {
    this.lastPercent = null;
    this.lastTime = null;
    this.rate = null;        // smoothed percent/second
    this.lastBucket = null;
    this.samples = 0;
  }

  // After the machine wakes from sleep: drop the rate baseline (elapsed sleep
  // time would poison it) but keep the displayed bucket so the estimate stays
  // monotone.
  resetBaseline() {
    this.lastPercent = null;
    this.lastTime = null;
    this.rate = null;
    this.samples = 0;
  }

  // Feed a progress reading (percent 0-100, now in SECONDS). Returns display
  // text, or null while still estimating.
  update(percent, now) {
    if (!(percent > 0)) return null;
    if (this.lastPercent != null && this.lastTime != null) {
      // Only a percent *change* carries rate information; repeated polls of the
      // same value would make the eventual jump look instantaneous.
      if (percent > this.lastPercent && now > this.lastTime) {
        const instant = (percent - this.lastPercent) / (now - this.lastTime);
        this.rate = this.rate != null ? 0.7 * this.rate + 0.3 * instant : instant;
        this.samples += 1;
        this.lastPercent = percent;
        this.lastTime = now;
      }
    } else {
      this.lastPercent = percent;
      this.lastTime = now;
    }
    if (!(this.rate > 0) || this.samples < 2) {
      return this.lastBucket != null ? EtaSmoother.label(this.lastBucket) : null;
    }
    const secondsLeft = (100.0 - percent) / this.rate;
    const target = EtaSmoother.bucketIndex(secondsLeft);
    // Never jump up more than one step per refresh.
    const display = this.lastBucket != null && target > this.lastBucket + 1
      ? this.lastBucket + 1
      : target;
    this.lastBucket = display;
    return EtaSmoother.label(display);
  }

  static bucketIndex(seconds) {
    if (seconds < 60) return 0;
    const m = Math.ceil(seconds / 60);
    for (let i = 0; i < EtaSmoother.bucketsMinutes.length; i++) {
      if (EtaSmoother.bucketsMinutes[i] >= m) return i;
    }
    return EtaSmoother.bucketsMinutes.length - 1;
  }

  static label(bucketIndex) {
    const b = EtaSmoother.bucketsMinutes;
    const m = b[Math.max(0, Math.min(bucketIndex, b.length - 1))];
    if (m === 0) return 'less than a minute left';
    if (m <= 90) return `about ${m} min left`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r === 0 ? `about ${h} hr left` : `about ${h} hr ${r} min left`;
  }
}

// MARK: - Version comparison (update check)

// Numeric component-wise compare; tolerates a leading "v" and stray non-digits.
function versionIsNewer(remote, local) {
  const components = (s) => {
    let t = String(s ?? '').trim();
    if (t.toLowerCase().startsWith('v')) t = t.slice(1);
    return t.split('.')
      .filter((seg) => seg.length > 0)
      .map((seg) => {
        const digits = seg.replace(/[^0-9]/g, '');
        return digits ? parseInt(digits, 10) : 0;
      });
  };
  const r = components(remote);
  const l = components(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = i < r.length ? r[i] : 0;
    const b = i < l.length ? l[i] : 0;
    if (a !== b) return a > b;
  }
  return false;
}

// MARK: - Engine protocol parsing

// Split on the first `maxSplits` separators only; the remainder stays intact.
function splitMax(s, sep, maxSplits) {
  const parts = [];
  let rest = s;
  while (parts.length < maxSplits) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  parts.push(rest);
  return parts;
}

// PCT\tINDEX\tTOTAL\tNAME — split on the first three tabs only (the name may
// contain anything the engine failed to sanitize), clamp percent to 0–100.
function parseProgressLine(raw) {
  const text = String(raw ?? '');
  const segs = text.split('\n').filter((s) => s.length > 0);
  const line = segs.length ? segs[segs.length - 1] : text;
  const parts = splitMax(line, '\t', 3);
  if (parts.length < 3) return null;
  const p0 = parts[0].trim();
  if (!/^[+-]?\d+$/.test(p0)) return null;
  const pct = Math.min(100, Math.max(0, parseInt(p0, 10)));
  const idx = /^[+-]?\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 1;
  const tot = Math.max(1, /^[+-]?\d+$/.test(parts[2]) ? parseInt(parts[2], 10) : 1);
  const name = parts.length > 3 ? parts[3] : '';
  return { percent: pct, index: idx, total: tot, name };
}

// yt-dlp --progress-template line (research_ytdlp.json, verified):
//   PROGRESS\t<percent_str>\t<eta>\t<filename>
// percent_str is space-padded with a trailing % ("  0.2%"); eta is integer
// seconds or "NA" (before it's known and at completion). Percent is a float
// 0-100; eta null when unknown. Filename keeps any further tabs.
function parseYtdlpProgress(raw) {
  const text = String(raw ?? '');
  const segs = text.split('\n').filter((s) => s.length > 0);
  const line = segs.length ? segs[segs.length - 1] : text;
  if (!line.startsWith('PROGRESS\t')) return null;
  const parts = splitMax(line.slice('PROGRESS\t'.length), '\t', 2);
  const pct = Number(parts[0].trim().replace(/%$/, ''));
  if (!Number.isFinite(pct)) return null;
  const percent = Math.min(100, Math.max(0, pct));
  const etaRaw = (parts[1] ?? '').trim();
  const eta = /^\d+$/.test(etaRaw) ? parseInt(etaRaw, 10) : null;
  const filename = parts.length > 2 ? parts[2] : '';
  return { percent, eta, filename };
}

// bin/download's success contract: the LAST stdout line is FILE\t<absolute path>.
function parseFinalFilePath(stdout) {
  const lines = String(stdout ?? '').split('\n').filter((s) => s.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('FILE\t')) {
      const path = lines[i].slice('FILE\t'.length).trim();
      return path === '' ? null : path;
    }
  }
  return null;
}

// bin/download info contract: TITLE\t<title>\t<duration_s>\t<is_live>\t<playlist_count>,
// NA where unknown.
function parseInfoLine(stdout) {
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw.startsWith('TITLE\t')) continue;
    const parts = raw.split('\t');
    const field = (i) => {
      if (i >= parts.length) return null;
      const v = parts[i].trim();
      return v === '' || v === 'NA' ? null : v;
    };
    const durRaw = field(2);
    const dur = durRaw != null ? Number(durRaw) : NaN;
    return {
      title: field(1),
      durationSeconds: Number.isFinite(dur) && dur >= 0 ? Math.trunc(dur) : null,
      isLive: (field(3) ?? '').toLowerCase() === 'true',
      playlistCount: (() => {
        const v = field(4);
        return v != null && /^[+-]?\d+$/.test(v) ? parseInt(v, 10) : null;
      })(),
    };
  }
  return null;
}

// MARK: - Link validation

function looksLikeWebLink(text) {
  const t = String(text ?? '').trim();
  // Matches Foundation's URL(string:) behavior (differentially verified against
  // the Swift implementation): stray whitespace in the PATH is tolerated
  // (percent-encoded), but the scheme must be a literal http(s)://, and any
  // whitespace in the authority rejects — WHATWG alone is laxer on both
  // (it strips tabs pre-parse and accepts scheme-relative "http:host").
  const m = /^https?:\/\//i.exec(t);
  if (!m) return false;
  const authority = t.slice(m[0].length).split(/[/?#]/, 1)[0];
  if (/\s/.test(authority)) return false;
  let u;
  try { u = new URL(t); } catch { return false; }
  return u.hostname.includes('.');
}

// MARK: - Download failure classification (yt-dlp stderr patterns)

// Pattern-match the captured stderr. Order matters: specific refusals first
// (geo before removed — YouTube's geo message contains "Video unavailable";
// age before the generic bot-check "Sign in"). Returns {message, stale};
// stale → the app should suggest re-running setup (already baked into the
// message).
function classifyDownloadFailure(exitCode, stderr, lookupStage = false) {
  const s = String(stderr ?? '').toLowerCase();
  const has = (patterns) => patterns.some((p) => s.includes(p));

  if (exitCode === 3) {
    return { message: Copy.failYtDlpMissing, stale: false };
  }
  if (has(['no space left on device'])) {
    return { message: Copy.failDiskDownload, stale: false };
  }
  if (has(['confirm your age', 'age-restricted', 'age restricted'])) {
    return { message: Copy.failAgeRestricted, stale: false };
  }
  if (has(['private video', 'video is private', 'been granted access'])) {
    return { message: Copy.failDownloadPrivateOrRemoved, stale: false };
  }
  // "available in your country" also covers YouTube's phrasing
  // "The uploader has not made this video available in your country".
  if (has(['available in your country', 'available in your location', 'geo restriction', 'geo-restricted'])) {
    return { message: Copy.failGeoBlocked, stale: false };
  }
  if (has(['video unavailable', 'has been removed', 'has been terminated',
    'account associated with this video', 'http error 404', '404 not found'])) {
    return { message: Copy.failDownloadPrivateOrRemoved, stale: false };
  }
  if (has(['login required', 'rate-limit reached', 'you need to log in',
    'login to access', 'log in for access', 'requested content is not available'])) {
    return { message: Copy.failLoginRequired, stale: false };
  }
  if (has(['this live event will begin', 'premieres in'])) {
    return { message: Copy.failLivestream, stale: false };
  }
  // Real network errors outrank the stale-downloader heuristics below —
  // yt-dlp prints benign nsig/extraction WARNINGs even when the actual
  // failure is a dropped connection. "took too long" is the engine's own
  // lookup-watchdog phrasing.
  if (has(['unable to download webpage', 'unable to download api page', 'failed to resolve',
    'nodename nor servname', 'getaddrinfo', 'network is unreachable', '[errno 8]',
    'timed out', 'timeout', 'took too long', 'connection refused', 'connection reset',
    'temporary failure in name resolution', 'no route to host', 'network is down'])) {
    return { message: Copy.failDownloadNetwork, stale: false };
  }
  // Stale-downloader patterns are warning-shaped: they occur on healthy runs
  // too, so only ERROR: lines may decide this classification.
  const errorLines = s.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('error:'))
    .join('\n');
  // An Instagram image post (or other no-video item) errors with "No video
  // formats found" PLUS the generic report-this-issue boilerplate — check it
  // before the stale patterns or the user is sent into a futile setup loop.
  if (errorLines.includes('no video formats found')) {
    return { message: Copy.failNoVideoAtLink, stale: false };
  }
  if (['some formats may be missing', 'challenge solving failed', 'nsig',
    "confirm you're not a bot", 'confirm you are not a bot', 'unable to extract',
    'failed to parse json', 'please report this issue',
    'confirm you are on the latest version', 'http error 403']
    .some((p) => errorLines.includes(p))) {
    return { message: Copy.failStaleDownloader, stale: true };
  }
  if (has(['is not a valid url', 'unsupported url'])) {
    return { message: Copy.failLookup, stale: false };
  }
  return {
    message: lookupStage ? Copy.failLookup : Copy.failDownloadPrivateOrRemoved,
    stale: false,
  };
}

// MARK: - Transcription failure classification (engine exit codes + stderr)

// Engine contract: 0 = ok, 1 = ran but the file failed, 2 = usage, 3 = dependency missing.
function classifyTranscribeFailure(exitCode, stderr, usedModel, fileName) {
  const s = String(stderr ?? '').toLowerCase();
  const has = (patterns) => patterns.some((p) => s.includes(p));

  if (exitCode === 3) {
    if (has(['ffmpeg'])) return Copy.failFfmpegMissing;
    if (has(['model'])) return Copy.failModelMissing(Models.by(usedModel).display);
    return Copy.failEngineMissing;
  }
  if (has(['no space left on device'])) return Copy.failDisk;
  if (has(['out of memory', 'failed to allocate', 'ggml_aligned_malloc'])) {
    return Copy.failOutOfMemory(fileName);
  }
  if (has(['failed to load model', 'invalid model'])) return Copy.failModelCorrupt;
  if (has(['no sound track', 'no audio track', 'does not contain any stream'])) return Copy.failNoAudio;
  if (has(['not a file', 'no such file'])) return Copy.failFileMissing(fileName);
  if (has(['could not read audio', 'invalid data found', 'moov atom'])) return Copy.failUnreadable;
  return Copy.failTranscription;
}

module.exports = {
  EtaSmoother,
  ETAEstimator: EtaSmoother,   // Swift name, for greppability
  versionIsNewer,
  parseProgressLine,
  parseYtdlpProgress,
  parseFinalFilePath,
  parseInfoLine,
  looksLikeWebLink,
  classifyDownloadFailure,
  classifyTranscribeFailure,
  filterLanguages: Languages.filtered,   // language search filter (lives in languages.js)
};
