// main/update.js — GitHub releases/latest banner check (C9). Silent on any
// failure — an update hint must never get in the way. The repo slug comes from
// packaged metadata (package.json `updateRepo`, baked by CI via extraMetadata);
// empty or absent means the check is off. Ran once per launch by main.js.
'use strict';

const https = require('node:https');

// A release payload is a few KB; anything approaching this is not the API
// answering us, and buffering it would grow main's heap for a banner nobody
// asked for. Stop at the cap and let the failure path (silent) take over.
const MAX_BODY_BYTES = 1 << 20;

function defaultFetcher(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'transcribe-app',
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length + chunk.length > MAX_BODY_BYTES) {
          req.destroy(new Error('response too large'));
          return;
        }
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const NOTHING = Object.freeze({ version: null, url: null, reason: null, asset: null });

// The release zip for THIS platform, out of the assets GitHub lists. CI names
// them Transcribe-macos-v1.0.42.zip / Transcribe-windows-v1.0.42.zip, so match on
// the stable part and ignore the version. Returns null when the running platform
// has no asset in that release — which must degrade to "open the page", never to
// installing the wrong OS's build.
function pickAsset(assets, platform) {
  const pattern = platform === 'darwin' ? /^Transcribe-macos-.*\.zip$/i
    : platform === 'win32' ? /^Transcribe-windows-.*\.zip$/i
      : null;
  if (!pattern || !Array.isArray(assets)) return null;
  for (const a of assets) {
    if (a && typeof a.name === 'string' && pattern.test(a.name)
        && typeof a.browser_download_url === 'string'
        && /^https:\/\//i.test(a.browser_download_url)) {
      return { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 };
    }
  }
  return null;
}

/// Resolves {status, version, url, reason}. Never rejects. status is one of:
///   'available' — a newer release exists (version/url populated)
///   'upToDate'  — the API answered and we are current
///   'failed'    — no usable answer; `reason` says which kind
///   'off'       — no update source configured (a locally built app)
///
/// The 'upToDate' vs 'failed' split is what the manual "Check Now" button needs:
/// the automatic banner can treat both as "say nothing", but telling a user
/// "You're on the latest version" when the request never got through is a lie.
///
/// `reason` matters just as much: 'network' means the request never completed
/// (offline, DNS, TLS, timeout) and blaming the connection is fair. 'server'
/// means the request DID complete and the answer was unusable — a 404 against a
/// private repo, a 403 rate-limit, a 5xx. Telling that user to check their
/// internet connection sends them to debug a network that is working fine.
async function checkForUpdateResult({ slug, currentVersion, fetcher, isNewer, timeoutMs = 5000, platform = process.platform } = {}) {
  if (!slug || typeof slug !== 'string' || !currentVersion) return { status: 'off', ...NOTHING };
  const fetch = fetcher || defaultFetcher;
  const newer = isNewer || require('../shared/logic').versionIsNewer;
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, timeoutMs);
  } catch {
    return { status: 'failed', ...NOTHING, reason: 'network' };   // offline, DNS, timeout, TLS
  }
  // We got an answer, it just wasn't usable: 404 (private repo / no releases),
  // 403 (anonymous rate limit), 5xx. The user's connection is demonstrably fine.
  if (!res || res.status !== 200) return { status: 'failed', ...NOTHING, reason: 'server' };
  try {
    const obj = JSON.parse(res.body);
    const tag = obj && obj.tag_name;
    if (typeof tag !== 'string') return { status: 'failed', ...NOTHING, reason: 'server' };
    if (!newer(tag, currentVersion)) return { status: 'upToDate', ...NOTHING };
    let clean = tag.trim();
    if (/^v/i.test(clean)) clean = clean.slice(1);
    return {
      status: 'available',
      version: clean,
      url: typeof obj.html_url === 'string' ? obj.html_url : null,
      reason: null,
      // The zip this platform would install. null (no matching asset) keeps the
      // release page as the only offer.
      asset: pickAsset(obj.assets, platform),
    };
  } catch {
    return { status: 'failed', ...NOTHING, reason: 'server' };
  }
}

/// Resolves {version, url} when a newer release exists, else null. Never rejects.
/// (The banner's original contract, kept: it only ever cared about 'available'.)
async function checkForUpdate(opts) {
  const r = await checkForUpdateResult(opts);
  return r.status === 'available' ? { version: r.version, url: r.url } : null;
}

module.exports = { checkForUpdate, checkForUpdateResult, pickAsset };
