// shared-languages.test.js — language list order, pinning, and search (port of
// the Swift quickcheck runner's Language section).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Languages = require('../../shared/languages');

test('language list has 100 entries (99 + Auto-detect)', () => {
  assert.equal(Languages.all.length, 99);
  assert.equal(Languages.displayOrder.length, 100);
});

test('whisper order preserved in all', () => {
  const codes = Languages.all.map((l) => l.code);
  assert.equal(codes[0], 'en');
  assert.equal(codes[1], 'zh');
  assert.equal(codes[32], 'hr');    // whisper's own ordering, not alphabetical
  assert.equal(codes[46], 'sl');
  assert.equal(codes[98], 'yue');
});

test('Auto-detect pinned first, Croatian + Slovenian after', () => {
  const order = Languages.displayOrder;
  assert.equal(order[0].code, 'auto');
  assert.equal(order[0].name, 'Auto-detect');
  assert.equal(order[1].code, 'hr');
  assert.equal(order[2].code, 'sl');
});

test('remaining languages sorted A–Z by English name, no pinned duplicates', () => {
  const rest = Languages.displayOrder.slice(3);
  const names = rest.map((l) => l.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(!rest.some((l) => l.code === 'hr' || l.code === 'sl'));
});

test('search by name', () => {
  assert.deepEqual(Languages.filtered('cro').map((l) => l.code), ['hr']);
  assert.deepEqual(Languages.filtered('slov').map((l) => l.code).sort(), ['sk', 'sl']);
  assert.ok(Languages.filtered('auto').some((l) => l.code === 'auto'));
  assert.ok(Languages.filtered('CRO').some((l) => l.code === 'hr'));   // case-insensitive
});

test('search by code prefix', () => {
  assert.ok(Languages.filtered('hr').some((l) => l.code === 'hr'));
  assert.ok(Languages.filtered('de').some((l) => l.code === 'de'));
  assert.ok(Languages.filtered('yu').some((l) => l.code === 'yue'));
});

test('empty search returns full display order; nonsense returns nothing', () => {
  assert.equal(Languages.filtered('').length, 100);
  assert.equal(Languages.filtered('   ').length, 100);
  assert.deepEqual(Languages.filtered('zzzz'), []);
});

test('name lookup', () => {
  assert.equal(Languages.nameFor('hr'), 'Croatian');
  assert.equal(Languages.nameFor('auto'), 'Auto-detect');
  assert.equal(Languages.nameFor('xx'), 'xx');   // unknown code falls back to itself
});

test('validity', () => {
  assert.ok(Languages.isValid('auto'));
  assert.ok(Languages.isValid('sl'));
  assert.ok(Languages.isValid('haw'));
  assert.ok(!Languages.isValid('xx'));
  assert.ok(!Languages.isValid(''));
});
