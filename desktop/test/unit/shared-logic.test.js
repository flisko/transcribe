// shared-logic.test.js — port of every prior pure-logic assertion (the Swift
// quickcheck, the scratchpad classify/main.swift runner, tests/main.swift) plus
// the yt-dlp PROGRESS-tab parser new to the JS engine.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Copy = require('../../shared/copy');
const Models = require('../../shared/catalog');
const {
  EtaSmoother,
  ETAEstimator,
  versionIsNewer,
  parseProgressLine,
  parseYtdlpProgress,
  parseFinalFilePath,
  parseInfoLine,
  looksLikeWebLink,
  classifyDownloadFailure,
  classifyTranscribeFailure,
  filterLanguages,
} = require('../../shared/logic');

// MARK: download failure classification

function cls(s, code = 1, lookup = false) {
  return classifyDownloadFailure(code, s, lookup);
}

test('classify: no-video-formats ERROR → photo-post copy, not stale (quickcheck)', () => {
  const igStderr = [
    'WARNING: [Instagram] xyz: No CSRF token set by Instagram API',
    'ERROR: [Instagram] DRVjOzaEVsI: No video formats found!; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using yt-dlp -U',
  ].join('\n');
  const r = cls(igStderr);
  assert.equal(r.message, Copy.failNoVideoAtLink);
  assert.equal(r.stale, false);
});

test('classify: genuine stale ERROR stays stale (quickcheck)', () => {
  const r = cls('ERROR: [youtube] abc: nsig extraction failed; Some formats may be missing');
  assert.equal(r.stale, true);
  assert.equal(r.message, Copy.failStaleDownloader);
});

test('classify: nsig WARNING + network ERROR → network, not stale', () => {
  const nsigPlusNetwork = [
    'WARNING: [youtube] abc123: nsig extraction failed: Some formats may be missing',
    'WARNING: [youtube] abc123: Some formats may be missing',
    'ERROR: unable to download video data: <urlopen error [Errno 60] Operation timed out>',
  ].join('\n');
  const r = cls(nsigPlusNetwork);
  assert.equal(r.message, Copy.failDownloadNetwork);
  assert.equal(r.stale, false);
});

test('classify: "took too long" (lookup watchdog phrasing) → network', () => {
  const r = cls('ERROR: The video lookup took too long and was stopped — check the internet connection.', 1, true);
  assert.equal(r.message, Copy.failDownloadNetwork);
});

test('classify: WARNING-only nsig must NOT decide stale (lookup default applies)', () => {
  const warningsOnly = [
    'WARNING: [youtube] abc123: nsig extraction failed: Some formats may be missing',
    'WARNING: [youtube] abc123: Some formats may be missing',
  ].join('\n');
  const r = cls(warningsOnly, 1, true);
  assert.equal(r.message, Copy.failLookup);
  assert.equal(r.stale, false);
});

test('classify: ERROR http 403 → stale (regression guard)', () => {
  assert.equal(cls('ERROR: unable to download video data: HTTP Error 403: Forbidden').message,
    Copy.failStaleDownloader);
});

test('classify: private video → private/removed copy', () => {
  assert.equal(cls("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video").message,
    Copy.failDownloadPrivateOrRemoved);
});

test('classify: removed video → private/removed copy', () => {
  assert.equal(cls('ERROR: [youtube] aaaaaaaaaaa: Video unavailable').message,
    Copy.failDownloadPrivateOrRemoved);
});

test('classify: geo wins over "Video unavailable"', () => {
  assert.equal(cls('ERROR: [youtube] abc: Video unavailable. The uploader has not made this video available in your country').message,
    Copy.failGeoBlocked);
});

test('classify: age-restricted (checked before bot-check "Sign in")', () => {
  assert.equal(cls('ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.').message,
    Copy.failAgeRestricted);
});

test('classify: bot-check ERROR → stale downloader', () => {
  assert.equal(cls("ERROR: [youtube] abc: Sign in to confirm you're not a bot.").message,
    Copy.failStaleDownloader);
});

test('classify: ERROR unable-to-extract → stale', () => {
  assert.equal(cls('WARNING: nsig extraction failed\nERROR: Unable to extract player version').message,
    Copy.failStaleDownloader);
  assert.equal(cls('ERROR: [youtube] abc: Unable to extract player response; please report this issue').message,
    Copy.failStaleDownloader);
});

test('classify: staleness flag set on ERROR-line formats-missing', () => {
  assert.equal(cls('ERROR: Signature solving failed: Some formats may be missing').stale, true);
});

test('classify: offline / connection errors → network copy', () => {
  assert.equal(cls('ERROR: [youtube] abc: Unable to download API page: <urlopen error [Errno 8] nodename nor servname provided, or not known>').message,
    Copy.failDownloadNetwork);
  assert.equal(cls('ERROR: Unable to download webpage: Connection refused').message,
    Copy.failDownloadNetwork);
});

test('classify: invalid / unsupported URL → lookup copy', () => {
  assert.equal(cls("ERROR: [generic] 'definitely not a url' is not a valid URL").message,
    Copy.failLookup);
  assert.equal(cls('ERROR: Unsupported URL: https://www.google.com/').message,
    Copy.failLookup);
});

test('classify: disk full during download', () => {
  assert.equal(cls('ERROR: unable to write data: [Errno 28] No space left on device').message,
    Copy.failDiskDownload);
});

test('classify: login required', () => {
  assert.equal(cls('ERROR: [instagram] abc: login required').message, Copy.failLoginRequired);
});

test('classify: upcoming live event → livestream copy', () => {
  assert.equal(cls('ERROR: [youtube] abc: This live event will begin in 3 hours').message,
    Copy.failLivestream);
});

test('classify: unknown fallback per stage', () => {
  assert.equal(cls('ERROR: something entirely new').message, Copy.failDownloadPrivateOrRemoved);
  assert.equal(cls('ERROR: something entirely new', 1, true).message, Copy.failLookup);
});

test('classify: exit 3 → yt-dlp missing', () => {
  assert.equal(cls('', 3).message, Copy.failYtDlpMissing);
});

// MARK: transcription failure classification

test('transcribe classify: exit-3 dependency mapping', () => {
  assert.equal(classifyTranscribeFailure(3, 'whisper.cpp not found. Please run setup.command first.', 'best', 'a.mov'),
    Copy.failEngineMissing);
  assert.equal(classifyTranscribeFailure(3, 'Model not found at /x/models/ggml-large-v3-turbo.bin', 'fast', 'a.mov'),
    Copy.failModelMissing('Fast'));
  assert.equal(classifyTranscribeFailure(3, 'Model not found at /x/models/ggml-large-v3.bin', 'garbage', 'a.mov'),
    Copy.failModelMissing('Best quality'));   // unknown selector falls back to Best
  assert.equal(classifyTranscribeFailure(3, 'ffmpeg not found. Please run setup.command first.', 'best', 'a.mov'),
    Copy.failFfmpegMissing);
});

test('transcribe classify: runtime failures', () => {
  assert.equal(classifyTranscribeFailure(1, 'SKIP (could not read audio): a.mov', 'best', 'a.mov'),
    Copy.failUnreadable);
  assert.equal(classifyTranscribeFailure(1, 'moov atom not found', 'best', 'a.mov'),
    Copy.failUnreadable);
  assert.equal(classifyTranscribeFailure(1, "error: failed to load model '/models/ggml-large-v3.bin'", 'best', 'a.mov'),
    Copy.failModelCorrupt);
  assert.equal(classifyTranscribeFailure(1, 'ggml_aligned_malloc: insufficient memory', 'best', 'clip.mov'),
    Copy.failOutOfMemory('clip.mov'));
  assert.equal(classifyTranscribeFailure(1, 'write error: No space left on device', 'best', 'a.mov'),
    Copy.failDisk);
  assert.equal(classifyTranscribeFailure(1, 'Output file does not contain any stream', 'best', 'a.mov'),
    Copy.failNoAudio);
  assert.equal(classifyTranscribeFailure(1, '/x/a.mov: No such file or directory', 'best', 'a.mov'),
    Copy.failFileMissing('a.mov'));
  assert.equal(classifyTranscribeFailure(1, 'whatever', 'best', 'a.mov'),
    Copy.failTranscription);
});

// MARK: ETA smoother

test('ETA: alias + gating before two rate samples', () => {
  assert.equal(EtaSmoother, ETAEstimator);
  const eta = new EtaSmoother();
  assert.equal(eta.update(0, 0), null);     // nil at 0%
  assert.equal(eta.update(5, 0), null);     // first sample only sets baseline
  assert.equal(eta.update(10, 10), null);   // one rate sample not enough
  const e1 = eta.update(15, 20);            // two samples → text appears
  assert.ok(e1 != null);
  assert.ok(e1.includes('min left'), e1);
});

function bucketIdxOfLabel(text) {
  for (let i = 0; i < EtaSmoother.bucketsMinutes.length; i++) {
    if (EtaSmoother.label(i) === text) return i;
  }
  return -1;
}

test('ETA: display never jumps up more than one bucket; steady run ends <1 min', () => {
  const eta = new EtaSmoother();
  let t = 0;
  let pct = 5;
  eta.update(pct, t);
  let prevIdx = Number.MAX_SAFE_INTEGER - 1;
  let sawIncrease = false;
  let lastText = null;
  for (let i = 0; i < 18; i++) {
    pct += 5;
    t += 10;
    const text = eta.update(Math.min(pct, 99), t);
    if (text != null) {
      lastText = text;
      const idx = bucketIdxOfLabel(text);
      if (idx > prevIdx + 1) sawIncrease = true;
      prevIdx = idx;
    }
  }
  assert.equal(sawIncrease, false);
  assert.equal(lastText, 'less than a minute left');
});

test('ETA: sudden stall capped to one bucket step', () => {
  const eta = new EtaSmoother();
  eta.update(10, 0);
  eta.update(20, 10);                 // 1 pct/s
  const fast = eta.update(30, 20);    // ~70 s left
  const slow = eta.update(31, 620);   // 10-min stall → true ETA collapses
  assert.ok(fast != null && slow != null);
  assert.ok(bucketIdxOfLabel(slow) <= bucketIdxOfLabel(fast) + 1, `${fast} → ${slow}`);
});

test('ETA: resetBaseline keeps the displayed bucket (wake-from-sleep)', () => {
  const eta = new EtaSmoother();
  eta.update(10, 0);
  eta.update(20, 10);
  const before = eta.update(30, 20);
  assert.ok(before != null);
  eta.resetBaseline();
  // Rate gone, samples 0 → shows the retained bucket instead of dropping to nil.
  assert.equal(eta.update(40, 1000), before);
});

test('ETA: repeated identical percents add no samples', () => {
  const eta = new EtaSmoother();
  eta.update(10, 0);
  eta.update(10, 5);
  eta.update(10, 10);
  assert.equal(eta.samples, 0);
  assert.equal(eta.update(10, 15), null);
});

test('ETA: coarse labels + bucket math', () => {
  assert.equal(EtaSmoother.label(0), 'less than a minute left');
  assert.equal(EtaSmoother.label(8), 'about 8 min left');
  assert.equal(EtaSmoother.label(EtaSmoother.bucketsMinutes.indexOf(90)), 'about 90 min left');
  assert.equal(EtaSmoother.label(EtaSmoother.bucketsMinutes.indexOf(120)), 'about 2 hr left');
  assert.equal(EtaSmoother.label(EtaSmoother.bucketsMinutes.indexOf(150)), 'about 2 hr 30 min left');
  assert.equal(EtaSmoother.label(EtaSmoother.bucketsMinutes.indexOf(720)), 'about 12 hr left');
  assert.equal(EtaSmoother.label(999), 'about 12 hr left');   // clamped
  assert.equal(EtaSmoother.bucketIndex(30), 0);
  assert.equal(EtaSmoother.bucketIndex(800), EtaSmoother.bucketsMinutes.indexOf(15));
  assert.equal(EtaSmoother.bucketIndex(1e9), EtaSmoother.bucketsMinutes.length - 1);
});

// MARK: version comparison (10 cases incl. v-prefix + junk tags)

test('version compare', () => {
  assert.ok(versionIsNewer('v1.0.2', '1.0.1'));                 // 1  v-prefix
  assert.ok(versionIsNewer('1.10.0', '1.9.9'));                 // 2  numeric, not lexicographic
  assert.ok(!versionIsNewer('1.0.0', '1.0.0'));                 // 3  equal is not newer
  assert.ok(!versionIsNewer('v1.0', '1.0.1'));                  // 4  shorter older
  assert.ok(versionIsNewer('2.0', '1.9.9'));                    // 5  missing component = 0
  assert.ok(!versionIsNewer('garbage', '1.0.0'));               // 6  garbage never newer
  assert.ok(versionIsNewer('2.0.0-beta.2', '2.0.0'));           // 7  junk tag digits count
  assert.ok(versionIsNewer('3.0.rc1', '3.0'));                  // 8  non-digit tag stripped
  assert.ok(versionIsNewer('  v1.2.3\n', '1.2.2'));             // 9  whitespace tolerated
  assert.ok(!versionIsNewer('1.2.3', 'v1.2.3'));                // 10 v-prefix on local
});

// MARK: progress line parsing (PCT-tab protocol)

test('progress: basic line (trailing newline)', () => {
  assert.deepEqual(parseProgressLine('42\t1\t1\tIMG_2827.mov\n'),
    { percent: 42, index: 1, total: 1, name: 'IMG_2827.mov' });
});

test('progress: clamps out-of-range percent', () => {
  assert.equal(parseProgressLine('1005\t1\t1\tx').percent, 100);
  assert.equal(parseProgressLine('-5\t1\t1\tx').percent, 0);
});

test('progress: name keeps extra tabs (split on first 3 only)', () => {
  assert.equal(parseProgressLine('37\t1\t1\tweird\tname\twith tabs').name,
    'weird\tname\twith tabs');
});

test('progress: garbage / empty / non-integer rejected', () => {
  assert.equal(parseProgressLine('garbage'), null);
  assert.equal(parseProgressLine(''), null);
  assert.equal(parseProgressLine('4.2\t1\t1\tx'), null);
});

test('progress: missing name and defaulted index/total', () => {
  assert.deepEqual(parseProgressLine('5\t2\t3'),
    { percent: 5, index: 2, total: 3, name: '' });
  assert.deepEqual(parseProgressLine(' 42 \tjunk\t0\tx'),
    { percent: 42, index: 1, total: 1, name: 'x' });   // pct trimmed; junk idx → 1, total floor 1
});

test('progress: multi-line reads the last non-empty line', () => {
  assert.equal(parseProgressLine('10\t1\t1\ta\n50\t1\t1\tb\n').percent, 50);
});

// MARK: yt-dlp PROGRESS-tab parsing

test('ytdlp progress: space-padded percent, NA eta', () => {
  assert.deepEqual(parseYtdlpProgress('PROGRESS\t  0.2%\tNA\t/tmp/Rick Astley [dQw4w9WgXcQ].f133.mp4'),
    { percent: 0.2, eta: null, filename: '/tmp/Rick Astley [dQw4w9WgXcQ].f133.mp4' });
});

test('ytdlp progress: numeric eta + completion', () => {
  assert.deepEqual(parseYtdlpProgress('PROGRESS\t 12.1%\t35\tclip.f140.m4a'),
    { percent: 12.1, eta: 35, filename: 'clip.f140.m4a' });
  assert.deepEqual(parseYtdlpProgress('PROGRESS\t100.0%\t0\tclip.f140.m4a'),
    { percent: 100, eta: 0, filename: 'clip.f140.m4a' });
});

test('ytdlp progress: clamps, keeps tabs in filename, rejects non-progress lines', () => {
  assert.equal(parseYtdlpProgress('PROGRESS\t150.0%\t5\tx').percent, 100);
  assert.equal(parseYtdlpProgress('PROGRESS\t 50.0%\t9\ta\tb').filename, 'a\tb');
  assert.equal(parseYtdlpProgress('/final/path [abc].mp4'), null);
  assert.equal(parseYtdlpProgress('PROGRESS\tNA\tNA\tx'), null);
  assert.equal(parseYtdlpProgress(''), null);
});

test('ytdlp progress: multi-line chunk reads the last tick', () => {
  const chunk = 'PROGRESS\t 10.0%\t50\ta.mp4\nPROGRESS\t 20.0%\t40\ta.mp4\n';
  assert.equal(parseYtdlpProgress(chunk).percent, 20);
});

// MARK: FILE / TITLE line parsing (bin/download protocol)

test('download: FILE line parsed / missing → null', () => {
  assert.equal(parseFinalFilePath('PROGRESS junk\nFILE\t/Users/x/Downloads/Video [abc123].m4a\n'),
    '/Users/x/Downloads/Video [abc123].m4a');
  assert.equal(parseFinalFilePath('no file line here'), null);
});

test('info: TITLE line parsed, NA → null', () => {
  const info = parseInfoLine('TITLE\tMe at the zoo\t19\tFalse\tNA\n');
  assert.deepEqual(info,
    { title: 'Me at the zoo', durationSeconds: 19, isLive: false, playlistCount: null });
  assert.equal(parseInfoLine('TITLE\tLive thing\tNA\tTrue\tNA').isLive, true);
  assert.equal(parseInfoLine('TITLE\tPlaylist\tNA\tFalse\t25').playlistCount, 25);
  assert.equal(parseInfoLine('ERROR: nope'), null);
});

// MARK: link validation

test('link validation', () => {
  assert.ok(looksLikeWebLink('https://www.youtube.com/watch?v=jNQXAC9IVRw'));
  assert.ok(looksLikeWebLink('  http://tiktok.com/@x/video/1 '));
  assert.ok(looksLikeWebLink('HTTPS://EXAMPLE.COM/x'));
  assert.ok(!looksLikeWebLink('definitely not a url'));
  assert.ok(!looksLikeWebLink('ftp://example.com/x'));
  assert.ok(!looksLikeWebLink('file:///etc/passwd'));
  assert.ok(!looksLikeWebLink(''));
  assert.ok(!looksLikeWebLink('http://localhost/x'));   // host without a dot
});

test('link validation edges (differentially verified against Foundation URL)', () => {
  assert.ok(looksLikeWebLink('https://youtu.be/abc watch this'));  // space in path encoded
  assert.ok(looksLikeWebLink('https://x.com/a b c?q=d e'));
  assert.ok(!looksLikeWebLink('http://foo bar.com/x'));            // whitespace in host
  assert.ok(!looksLikeWebLink('http://exa\tmple.com'));            // tab in host
  assert.ok(!looksLikeWebLink('check this out https://x.com'));    // scheme not at start
  assert.ok(!looksLikeWebLink('http:x.com/a'));                    // no literal ://
  assert.ok(!looksLikeWebLink('https://'));
  assert.ok(!looksLikeWebLink('http://[::1]/a'));                  // IPv6 host has no dot
  assert.ok(looksLikeWebLink('http://192.168.1.1/a'));
  assert.ok(looksLikeWebLink('http://x.com:8080/a'));
  assert.ok(looksLikeWebLink('http://user:pw@x.com/a'));
  assert.ok(looksLikeWebLink('https://müller.de/a'));
});

// MARK: language search re-export

test('logic re-exports the language search filter', () => {
  assert.deepEqual(filterLanguages('cro').map((l) => l.code), ['hr']);
  assert.ok(filterLanguages('sl').some((l) => l.code === 'sl'));
});
