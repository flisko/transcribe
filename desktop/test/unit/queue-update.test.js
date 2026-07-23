// queue-update.test.js — main/update.js banner logic against an injected
// fetcher. The version comparator is injected too (shared/logic.js is built by
// another lane); the inline comparator mirrors versionIsNewer's semantics.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { checkForUpdate } = require('../../main/update');

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
