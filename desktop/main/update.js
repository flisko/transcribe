// main/update.js — GitHub releases/latest banner check (C9). Silent on any
// failure — an update hint must never get in the way. The repo slug comes from
// packaged metadata (package.json `updateRepo`, baked by CI via extraMetadata);
// empty or absent means the check is off. Ran once per launch by main.js.
'use strict';

const https = require('node:https');

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
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/// Resolves {version, url} when a newer release exists, else null. Never rejects.
async function checkForUpdate({ slug, currentVersion, fetcher, isNewer, timeoutMs = 5000 } = {}) {
  if (!slug || typeof slug !== 'string' || !currentVersion) return null;
  const fetch = fetcher || defaultFetcher;
  const newer = isNewer || require('../shared/logic').versionIsNewer;
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, timeoutMs);
    if (!res || res.status !== 200) return null;
    const obj = JSON.parse(res.body);
    const tag = obj && obj.tag_name;
    if (typeof tag !== 'string' || !newer(tag, currentVersion)) return null;
    let clean = tag.trim();
    if (/^v/i.test(clean)) clean = clean.slice(1);
    return { version: clean, url: typeof obj.html_url === 'string' ? obj.html_url : null };
  } catch {
    return null;
  }
}

module.exports = { checkForUpdate };
