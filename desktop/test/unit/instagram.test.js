// instagram.test.js — pure helpers of the in-app Instagram login feature:
// URL matching + Electron-cookie → Netscape formatting (what yt-dlp --cookies reads).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./engine.shim.js').ensureShared();
const { toNetscape, isInstagramUrl } = require('../../main/instagram.js');

test('isInstagramUrl: matches instagram.com hosts only (not lookalikes)', () => {
  for (const u of [
    'https://www.instagram.com/reel/abc/', 'https://instagram.com/p/x',
    'http://m.instagram.com/x', 'https://instagram.com/',
  ]) assert.equal(isInstagramUrl(u), true, `should match: ${u}`);
  for (const u of [
    'https://www.tiktok.com/@x/video/1', 'https://youtube.com/watch?v=x',
    'https://instagram.com.evil.com/x', 'https://notinstagram.com/x',
    'https://fakeinstagram.com/x', 'not a url', '', null, undefined,
  ]) assert.equal(isInstagramUrl(u), false, `should NOT match: ${u}`);
});

test('toNetscape: formats Electron cookies into a valid cookie file', () => {
  const out = toNetscape([
    { name: 'sessionid', value: 'abc123', domain: '.instagram.com', path: '/', secure: true, expirationDate: 1893456000 },
    { name: 'csrftoken', value: 'tok', domain: '.instagram.com', path: '/', secure: true, session: true },
    { name: 'x', value: 'y', domain: 'instagram.com', path: '/foo', secure: false, expirationDate: 100.9 },
  ]);
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith('# Netscape HTTP Cookie File'));
  assert.equal(lines[2], ['.instagram.com', 'TRUE', '/', 'TRUE', '1893456000', 'sessionid', 'abc123'].join('\t'));
  assert.equal(lines[3], ['.instagram.com', 'TRUE', '/', 'TRUE', '0', 'csrftoken', 'tok'].join('\t'), 'session cookie → expiry 0');
  assert.equal(lines[4], ['instagram.com', 'FALSE', '/foo', 'FALSE', '100', 'x', 'y'].join('\t'), 'no-dot domain → includeSub FALSE, float expiry floored');
  assert.ok(out.endsWith('\n'), 'trailing newline');
});

test('toNetscape: strips tab/newline from values; skips nameless or domainless cookies', () => {
  const out = toNetscape([
    { name: 'a', value: 'has\ttab\nand nl', domain: '.instagram.com', path: '/' },
    { name: '', value: 'x', domain: '.instagram.com' },   // no name → skipped
    { name: 'b', value: 'y', domain: '' },                // no domain → skipped
  ]);
  const rows = out.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(rows.length, 1, 'only the valid cookie is emitted');
  // \t and \n stripped (they'd corrupt the tab-separated file); the space stays.
  assert.equal(rows[0], ['.instagram.com', 'TRUE', '/', 'FALSE', '0', 'a', 'hastaband nl'].join('\t'));
});

test('toNetscape: empty / nullish input → just the header', () => {
  for (const v of [[], null, undefined]) {
    const out = toNetscape(v);
    assert.ok(out.startsWith('# Netscape HTTP Cookie File'));
    assert.equal(out.split('\n').filter((l) => l && !l.startsWith('#')).length, 0);
  }
});
