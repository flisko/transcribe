// shared-catalog.test.js — the six-model catalog (port of the Swift quickcheck
// asserts plus per-field verification against Logic.swift's Models table).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Models = require('../../shared/catalog');

test('catalog has exactly 6 models in order', () => {
  assert.equal(Models.all.length, 6);
  assert.deepEqual(Models.all.map((m) => m.sel),
    ['best', 'fast', 'medium', 'small', 'base', 'tiny']);
});

test('by() resolves selectors; unknown falls back to best', () => {
  assert.equal(Models.by('fast').fileName, 'ggml-large-v3-turbo.bin');
  assert.equal(Models.by('garbage').sel, 'best');
  assert.equal(Models.by(undefined).sel, 'best');
  assert.equal(Models.by('tiny').sel, 'tiny');
});

test('every field matches the Swift table', () => {
  const want = {
    best: ['Best quality', 'large-v3', 'ggml-large-v3.bin', 2_500_000_000,
      'most accurate, slower (recommended)',
      'Most accurate for Croatian, Slovenian, and other smaller languages. Slower. Recommended.'],
    fast: ['Fast', 'large-v3-turbo', 'ggml-large-v3-turbo.bin', 1_200_000_000,
      'about 4x faster, slightly less accurate',
      'About 4x faster. Slightly less accurate, mainly on smaller languages.'],
    medium: ['Medium', 'medium', 'ggml-medium.bin', 1_300_000_000,
      'lighter and quicker, still solid',
      'A good middle ground when the big models feel slow. Half the size of Fast.'],
    small: ['Small', 'small', 'ggml-small.bin', 400_000_000,
      'much faster, noticeably less accurate',
      'Much faster and much smaller. Fine for clear speech in major languages.'],
    base: ['Base', 'base', 'ggml-base.bin', 120_000_000,
      'very fast, rough transcripts',
      'Very fast rough drafts. Expect mistakes, especially outside English.'],
    tiny: ['Tiny', 'tiny', 'ggml-tiny.bin', 60_000_000,
      'fastest, lowest accuracy',
      'The fastest possible pass. Only for quick gist checks.'],
  };
  for (const m of Models.all) {
    const [display, technical, fileName, minBytes, blurb, caption] = want[m.sel];
    assert.equal(m.display, display, m.sel);
    assert.equal(m.technical, technical, m.sel);
    assert.equal(m.fileName, fileName, m.sel);
    assert.equal(m.minBytes, minBytes, m.sel);
    assert.equal(m.blurb, blurb, m.sel);
    assert.equal(m.caption, caption, m.sel);
  }
});

test('menuTitle format is "Display (technical) — blurb" for all 6', () => {
  for (const m of Models.all) {
    assert.equal(m.menuTitle, `${m.display} (${m.technical}) — ${m.blurb}`);
  }
  assert.equal(Models.by('tiny').menuTitle, 'Tiny (tiny) — fastest, lowest accuracy');
  assert.equal(Models.by('best').menuTitle,
    'Best quality (large-v3) — most accurate, slower (recommended)');
  assert.equal(Models.by('fast').menuTitle,
    'Fast (large-v3-turbo) — about 4x faster, slightly less accurate');
});
