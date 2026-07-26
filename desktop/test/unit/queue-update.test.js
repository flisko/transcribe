// queue-update.test.js — main/update.js banner logic against an injected
// fetcher. The version comparator is injected too (shared/logic.js is built by
// another lane); the inline comparator mirrors versionIsNewer's semantics.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { checkForUpdate, checkForUpdateResult } = require('../../main/update');

// Numeric component-wise compare; tolerates a leading "v" and stray non-digits
// (mirror of Logic.swift versionIsNewer).
function isNewer(remote, local) {
  const comp = (s) => {
    let t = String(s).trim();
    if (/^v/i.test(t)) t = t.slice(1);
    return t.split('.').map((p) => parseInt(p.replace(/\D/g, ''), 10) || 0);
  };
  const r = comp(remote);
  const l = comp(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

function fetcherReturning(status, obj) {
  const calls = [];
  const fn = (url, timeoutMs) => {
    calls.push({ url, timeoutMs });
    return Promise.resolve({ status, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  };
  fn.calls = calls;
  return fn;
}

test('newer tag -> banner with cleaned version and release url', async () => {
  const fetcher = fetcherReturning(200, {
    tag_name: 'v2.1.0',
    html_url: 'https://github.com/x/y/releases/tag/v2.1.0',
  });
  const info = await checkForUpdate({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer });
  assert.deepStrictEqual(info, {
    version: '2.1.0',
    url: 'https://github.com/x/y/releases/tag/v2.1.0',
  });
  assert.strictEqual(fetcher.calls.length, 1);
  assert.strictEqual(fetcher.calls[0].url, 'https://api.github.com/repos/x/y/releases/latest');
  assert.strictEqual(fetcher.calls[0].timeoutMs, 5000, 'pinned 5 s timeout');
});

test('equal tag -> no banner', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'v2.0.5', html_url: 'https://x' });
  assert.strictEqual(await checkForUpdate({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer }), null);
});

test('older tag -> no banner', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'v1.9.9', html_url: 'https://x' });
  assert.strictEqual(await checkForUpdate({ slug: 'x/y', currentVersion: '2.0.0', fetcher, isNewer }), null);
});

test('junk tag -> no banner', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'garbage', html_url: 'https://x' });
  assert.strictEqual(await checkForUpdate({ slug: 'x/y', currentVersion: '1.0.0', fetcher, isNewer }), null);
});

test('junk body / missing tag / bad status / fetcher error -> silently no banner', async () => {
  assert.strictEqual(await checkForUpdate({
    slug: 'x/y', currentVersion: '1.0.0', isNewer,
    fetcher: fetcherReturning(200, 'this is not json'),
  }), null);
  assert.strictEqual(await checkForUpdate({
    slug: 'x/y', currentVersion: '1.0.0', isNewer,
    fetcher: fetcherReturning(200, { html_url: 'https://x' }),
  }), null);
  assert.strictEqual(await checkForUpdate({
    slug: 'x/y', currentVersion: '1.0.0', isNewer,
    fetcher: fetcherReturning(404, { tag_name: 'v9.9.9' }),
  }), null);
  assert.strictEqual(await checkForUpdate({
    slug: 'x/y', currentVersion: '1.0.0', isNewer,
    fetcher: () => Promise.reject(new Error('offline')),
  }), null);
});

test('missing/empty slug -> check is off, fetcher never called', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'v9.9.9' });
  assert.strictEqual(await checkForUpdate({ slug: '', currentVersion: '1.0.0', fetcher, isNewer }), null);
  assert.strictEqual(await checkForUpdate({ currentVersion: '1.0.0', fetcher, isNewer }), null);
  assert.strictEqual(await checkForUpdate({ slug: 'x/y', fetcher, isNewer }), null);
  assert.strictEqual(fetcher.calls.length, 0);
});

test('non-string html_url -> banner with url null', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'v9.9.9', html_url: 42 });
  const info = await checkForUpdate({ slug: 'x/y', currentVersion: '1.0.0', fetcher, isNewer });
  assert.deepStrictEqual(info, { version: '9.9.9', url: null });
});

// ---- checkForUpdateResult -------------------------------------------------
//
// The manual "Check Now" button needs the distinction the banner never did:
// "the API said we're current" is a different sentence from "we never got an
// answer". Reporting the second as the first is the bug this guards.

test('result: newer tag -> available with cleaned version + url', async () => {
  const fetcher = fetcherReturning(200, {
    tag_name: 'v2.1.0', html_url: 'https://github.com/x/y/releases/tag/v2.1.0',
  });
  assert.deepStrictEqual(
    await checkForUpdateResult({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer, platform: 'win32' }),
    {
      status: 'available',
      version: '2.1.0',
      url: 'https://github.com/x/y/releases/tag/v2.1.0',
      reason: null,
      asset: null,   // this release lists no assets
    });
});

// One-click update needs the actual zip, not just the release page.
test('result: picks the asset for THIS platform, and only over https', async () => {
  const assets = [
    { name: 'Transcribe-macos-v2.1.0.zip', browser_download_url: 'https://x/mac.zip', size: 11 },
    { name: 'Transcribe-windows-v2.1.0.zip', browser_download_url: 'https://x/win.zip', size: 22 },
  ];
  const fetcher = fetcherReturning(200, { tag_name: 'v2.1.0', html_url: 'https://x', assets });

  const win = await checkForUpdateResult({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer, platform: 'win32' });
  assert.deepStrictEqual(win.asset, { name: 'Transcribe-windows-v2.1.0.zip', url: 'https://x/win.zip', size: 22 });

  const mac = await checkForUpdateResult({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer, platform: 'darwin' });
  assert.deepStrictEqual(mac.asset, { name: 'Transcribe-macos-v2.1.0.zip', url: 'https://x/mac.zip', size: 11 });

  // A platform with no build must fall back to the page, never to another OS's zip.
  const linux = await checkForUpdateResult({ slug: 'x/y', currentVersion: '2.0.5', fetcher, isNewer, platform: 'linux' });
  assert.strictEqual(linux.asset, null);
  assert.strictEqual(linux.status, 'available', 'the banner still appears');
});

test('result: a non-https asset URL is refused', async () => {
  const fetcher = fetcherReturning(200, {
    tag_name: 'v9.9.9',
    assets: [{ name: 'Transcribe-windows-v9.9.9.zip', browser_download_url: 'http://x/win.zip', size: 1 }],
  });
  const r = await checkForUpdateResult({ slug: 'x/y', currentVersion: '1.0.0', fetcher, isNewer, platform: 'win32' });
  assert.strictEqual(r.asset, null, 'plain http is never a download target');
});

test('result: same or older tag -> upToDate', async () => {
  for (const tag of ['v2.0.5', 'v1.9.9']) {
    const r = await checkForUpdateResult({
      slug: 'x/y', currentVersion: '2.0.5', isNewer,
      fetcher: fetcherReturning(200, { tag_name: tag, html_url: 'https://x' }),
    });
    assert.strictEqual(r.status, 'upToDate', tag);
    assert.strictEqual(r.version, null);
  }
});

// Two kinds of failure, and the distinction decides which sentence the user
// reads. Blaming the connection when GitHub answered 404 sends someone to debug
// a network that is demonstrably working — which is exactly what a PRIVATE repo
// produces on every single launch.
test('result: every no-answer case is failed, with the right reason, never upToDate', async () => {
  const cases = {
    offline: { reason: 'network', fetcher: () => Promise.reject(new Error('offline')) },
    // A private repo (or one with no releases yet) answers 404 anonymously.
    private404: { reason: 'server', fetcher: fetcherReturning(404, { message: 'Not Found' }) },
    rateLimited: { reason: 'server', fetcher: fetcherReturning(403, { message: 'rate limit' }) },
    serverError: { reason: 'server', fetcher: fetcherReturning(500, {}) },
    notJson: { reason: 'server', fetcher: fetcherReturning(200, 'this is not json') },
    noTag: { reason: 'server', fetcher: fetcherReturning(200, { html_url: 'https://x' }) },
    resolvedNothing: { reason: 'server', fetcher: () => Promise.resolve(null) },
  };
  for (const [name, { fetcher, reason }] of Object.entries(cases)) {
    const r = await checkForUpdateResult({ slug: 'x/y', currentVersion: '1.0.0', fetcher, isNewer });
    assert.strictEqual(r.status, 'failed', name);
    assert.strictEqual(r.reason, reason, name);
  }
});

test('result: no slug -> off, and the network is never touched', async () => {
  const fetcher = fetcherReturning(200, { tag_name: 'v9.9.9' });
  assert.strictEqual((await checkForUpdateResult({ slug: '', currentVersion: '1.0.0', fetcher, isNewer })).status, 'off');
  assert.strictEqual((await checkForUpdateResult({ currentVersion: '1.0.0', fetcher, isNewer })).status, 'off');
  assert.strictEqual(fetcher.calls.length, 0);
});

test('result: a throwing comparator is a failed check, not a crash', async () => {
  const r = await checkForUpdateResult({
    slug: 'x/y', currentVersion: '1.0.0',
    fetcher: fetcherReturning(200, { tag_name: 'v9.9.9' }),
    isNewer: () => { throw new Error('boom'); },
  });
  assert.strictEqual(r.status, 'failed');
});
