// engine.shim.js — TEST-ONLY helper (not a test file; the runner only picks up
// *.test.js). The shared/ lane is built in parallel; when shared/catalog.js or
// shared/logic.js has not landed yet, this shim redirects engine.js's requires
// to thin stubs written OUTSIDE the repo (scratchpad/tmp), per the lane rules.
// Once the real files exist the shim is a no-op and the real modules are used.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SHARED_DIR = path.resolve(__dirname, '..', '..', 'shared');

const CATALOG_STUB = `// TEST STUB of shared/catalog.js (pinned API: { all, by }) — models from Logic.swift.
'use strict';
const all = [
  { sel: 'best', display: 'Best', technical: 'large-v3', fileName: 'ggml-large-v3.bin', minBytes: 2500000000 },
  { sel: 'fast', display: 'Fast', technical: 'large-v3-turbo', fileName: 'ggml-large-v3-turbo.bin', minBytes: 1200000000 },
  { sel: 'medium', display: 'Medium', technical: 'medium', fileName: 'ggml-medium.bin', minBytes: 1300000000 },
  { sel: 'small', display: 'Small', technical: 'small', fileName: 'ggml-small.bin', minBytes: 400000000 },
  { sel: 'base', display: 'Base', technical: 'base', fileName: 'ggml-base.bin', minBytes: 120000000 },
  { sel: 'tiny', display: 'Tiny', technical: 'tiny', fileName: 'ggml-tiny.bin', minBytes: 60000000 },
];
function by(sel) { return all.find((m) => m.sel === sel) || all[0]; }
module.exports = { all, by };
`;

const LOGIC_STUB = `// TEST STUB of shared/logic.js classifiers (pinned signatures; stub-marked strings).
'use strict';
function classifyTranscribeFailure(exitCode, stderr, usedModel, fileName) {
  const s = String(stderr || '').toLowerCase();
  const has = (ps) => ps.some((p) => s.includes(p));
  if (exitCode === 3) {
    if (has(['ffmpeg'])) return '[stub] ffmpeg missing';
    if (has(['model'])) return '[stub] model missing: ' + usedModel;
    return '[stub] engine missing';
  }
  if (has(['no space left on device'])) return '[stub] disk full';
  if (has(['out of memory', 'failed to allocate', 'ggml_aligned_malloc'])) return '[stub] out of memory: ' + fileName;
  if (has(['failed to load model', 'invalid model'])) return '[stub] model corrupt';
  if (has(['no sound track', 'no audio track', 'does not contain any stream'])) return '[stub] no audio';
  if (has(['not a file', 'no such file'])) return '[stub] file missing: ' + fileName;
  if (has(['could not read audio', 'invalid data found', 'moov atom'])) return '[stub] unreadable';
  return '[stub] transcription failed';
}
function classifyDownloadFailure(exitCode, stderr, lookupStage) {
  const s = String(stderr || '').toLowerCase();
  const has = (ps) => ps.some((p) => s.includes(p));
  if (exitCode === 3) return { message: '[stub] yt-dlp missing', stale: false };
  if (has(['no space left on device'])) return { message: '[stub] disk full (download)', stale: false };
  if (has(['confirm your age', 'age-restricted', 'age restricted'])) return { message: '[stub] age restricted', stale: false };
  if (has(['private video', 'video is private', 'been granted access'])) return { message: '[stub] private or removed', stale: false };
  if (has(['available in your country', 'available in your location', 'geo restriction', 'geo-restricted'])) return { message: '[stub] geo blocked', stale: false };
  if (has(['video unavailable', 'has been removed', 'has been terminated', 'account associated with this video', 'http error 404', '404 not found'])) return { message: '[stub] private or removed', stale: false };
  if (has(['login required', 'rate-limit reached', 'you need to log in', 'login to access', 'log in for access', 'requested content is not available'])) return { message: '[stub] login required', stale: false };
  if (has(['this live event will begin', 'premieres in'])) return { message: '[stub] livestream', stale: false };
  if (has(['unable to download webpage', 'unable to download api page', 'failed to resolve', 'nodename nor servname', 'getaddrinfo', 'network is unreachable', '[errno 8]', 'timed out', 'timeout', 'took too long', 'connection refused', 'connection reset', 'temporary failure in name resolution', 'no route to host', 'network is down'])) return { message: '[stub] network', stale: false };
  const errorLines = s.split('\\n').map((l) => l.trim()).filter((l) => l.startsWith('error:')).join('\\n');
  if (errorLines.includes('no video formats found')) return { message: '[stub] no video at link', stale: false };
  if (['some formats may be missing', 'challenge solving failed', 'nsig', "confirm you're not a bot", 'confirm you are not a bot', 'unable to extract', 'failed to parse json', 'please report this issue', 'confirm you are on the latest version', 'http error 403'].some((p) => errorLines.includes(p))) return { message: '[stub] stale downloader', stale: true };
  if (has(['is not a valid url', 'unsupported url'])) return { message: '[stub] lookup failed', stale: false };
  return { message: lookupStage ? '[stub] lookup failed' : '[stub] private or removed', stale: false };
}
module.exports = { classifyTranscribeFailure, classifyDownloadFailure };
`;

let installed = false;

/// Call BEFORE require()ing engine.js. Returns the list of stubbed module names.
function ensureShared() {
  const stubs = {};
  const wanted = { 'catalog.js': CATALOG_STUB, 'logic.js': LOGIC_STUB };
  for (const [name, source] of Object.entries(wanted)) {
    if (!fs.existsSync(path.join(SHARED_DIR, name))) stubs[name] = source;
  }
  const names = Object.keys(stubs);
  if (names.length === 0 || installed) return names;

  const stubDir = fs.mkdtempSync(path.join(
    process.env.TRANSCRIBE_TEST_STUBDIR || os.tmpdir(), 'transcribe-shared-stub-'));
  const stubPaths = {};
  for (const name of names) {
    stubPaths[name] = path.join(stubDir, name);
    fs.writeFileSync(stubPaths[name], stubs[name]);
  }
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    for (const name of names) {
      if (String(request).endsWith(`shared/${name}`)) return stubPaths[name];
    }
    return orig.call(this, request, ...rest);
  };
  installed = true;
  return names;
}

module.exports = { ensureShared };
