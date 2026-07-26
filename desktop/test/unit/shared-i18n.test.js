// shared-i18n.test.js — the locale layer. The point of these tests is not that
// the Croatian is pretty (nobody can assert that); it is that the MACHINERY
// cannot silently degrade: no missing key can render as "undefined", no locale
// can lose a string that English has, and the Slavic plural forms — the part a
// machine translation always gets wrong — are actually wired to Intl.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const COPY_PATH = require.resolve('../../shared/copy.js');

function freshCopy(locale, platform) {
  const savedLocale = process.env.TRANSCRIBE_LOCALE;
  const savedPlatform = process.env.TRANSCRIBE_FAKE_PLATFORM;
  if (locale) process.env.TRANSCRIBE_LOCALE = locale; else delete process.env.TRANSCRIBE_LOCALE;
  if (platform) process.env.TRANSCRIBE_FAKE_PLATFORM = platform;
  delete require.cache[COPY_PATH];
  const mod = require(COPY_PATH);
  delete require.cache[COPY_PATH];
  if (savedLocale === undefined) delete process.env.TRANSCRIBE_LOCALE;
  else process.env.TRANSCRIBE_LOCALE = savedLocale;
  if (savedPlatform === undefined) delete process.env.TRANSCRIBE_FAKE_PLATFORM;
  else process.env.TRANSCRIBE_FAKE_PLATFORM = savedPlatform;
  return mod;
}

const LOCALES = ['en', 'hr', 'sl'];

test('every locale resolves, and an unknown tag falls back to English', () => {
  for (const l of LOCALES) assert.equal(freshCopy(l).locale, l);
  assert.equal(freshCopy('hr-HR').locale, 'hr', 'region subtag is ignored');
  assert.equal(freshCopy('sl_SI').locale, 'sl', 'underscore form too');
  assert.equal(freshCopy('de').locale, 'en', 'untranslated language -> English');
  assert.equal(freshCopy('klingon').locale, 'en');
});

// The failure this prevents: a translator adds a key that English does not have
// (a typo), or renames one, and a sentence silently becomes "undefined" in the UI.
test('no locale is missing a key, has an extra key, or renders undefined', () => {
  const en = freshCopy('en');
  const enKeys = Object.keys(en).filter((k) => k !== 'locale').sort();
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    const t = freshCopy(locale);
    const keys = Object.keys(t).filter((k) => k !== 'locale').sort();
    assert.deepEqual(keys, enKeys, `${locale} key set must match English exactly`);
    for (const k of keys) {
      // Numeric probe: several of these take a count or a duration, and a
      // non-numeric argument would produce NaN in English too.
      const v = typeof t[k] === 'function' ? t[k](2, 2, 2, 2) : t[k];
      assert.equal(typeof v, 'string', `${locale}.${k} must be a string`);
      assert.ok(v.length > 0, `${locale}.${k} must not be empty`);
      assert.ok(!/undefined|NaN|\[object/.test(v), `${locale}.${k} renders badly: ${v}`);
    }
  }
});

// An untranslated key must inherit English rather than vanish. Proven with a key
// the translations deliberately do not override.
test('untranslated keys fall back to the English text', () => {
  const en = freshCopy('en');
  for (const locale of ['hr', 'sl']) {
    assert.equal(freshCopy(locale).windowTitle, en.windowTitle, 'product name is never translated');
  }
});

test('translations actually differ from English where it matters', () => {
  const en = freshCopy('en');
  for (const locale of ['hr', 'sl']) {
    const t = freshCopy(locale);
    for (const key of ['waiting', 'canceled', 'retry', 'cancelAll', 'settingsLanguage',
                       'failNoAudio', 'quitTitle', 'updateUpToDate', 'setupTitle']) {
      assert.notEqual(t[key], en[key], `${locale}.${key} is still English`);
    }
  }
});

// THE thing a machine translation gets wrong. Croatian: 1 / 2-4 / 5+.
// Slovenian additionally has a DUAL for exactly 2.
test('Croatian uses one/few/other and Slovenian uses the dual', () => {
  const hr = freshCopy('hr');
  const forms = (t, n) => t.notifAllBody(n);
  assert.notEqual(forms(hr, 1), forms(hr, 2), 'hr: 1 differs from 2');
  assert.notEqual(forms(hr, 2), forms(hr, 5), 'hr: paucal (2-4) differs from 5+');
  assert.equal(
    forms(hr, 3).replace('3', 'N'), forms(hr, 4).replace('4', 'N'),
    'hr: 3 and 4 share the paucal form',
  );

  const sl = freshCopy('sl');
  const one = forms(sl, 1); const two = forms(sl, 2);
  const few = forms(sl, 3); const other = forms(sl, 5);
  assert.equal(new Set([one, two, few, other].map((s, i) => s.replace(/\d+/, 'N'))).size, 4,
    'sl: one, two (dual), few and other are four distinct forms');
});

test('plural selection is wired for the counted failure message too', () => {
  const sl = freshCopy('sl');
  assert.match(sl.failPlaylist(1), /videoposnetek/);
  assert.match(sl.failPlaylist(2), /videoposnetka/);   // dual
  assert.match(sl.failPlaylist(3), /videoposnetki/);
  assert.match(sl.failPlaylist(9), /videoposnetkov/);
});

// Platform substitution has to survive translation: a Croatian Windows user must
// not be told about a Mac, and the setup FILE NAME must stay untranslated.
test('platform wording is applied inside translations, filenames are not translated', () => {
  for (const locale of ['hr', 'sl']) {
    const win = freshCopy(locale, 'win32');
    const mac = freshCopy(locale, 'darwin');
    assert.ok(!/\bMac\b/.test(win.setupIntro), `${locale} win32 setupIntro mentions a Mac: ${win.setupIntro}`);
    assert.ok(/Mac/.test(mac.setupIntro), `${locale} darwin setupIntro should mention the Mac`);
    assert.ok(win.failEngineMissing.includes('Transcribe Setup'), 'win setup file name is literal');
    assert.ok(mac.failEngineMissing.includes('setup.command'), 'mac setup file name is literal');
    assert.ok(win.engineMissing.includes('Transcribe.exe'));
    assert.ok(mac.engineMissing.includes('Transcribe.app'));
  }
});

// The ETA is the string a user stares at for the whole run.
test('ETA phrasing follows the locale', () => {
  delete require.cache[require.resolve('../../shared/logic.js')];
  for (const locale of ['hr', 'sl']) {
    freshCopy(locale);
    // logic.js captures Copy at require time, so require it after the switch.
    delete require.cache[require.resolve('../../shared/logic.js')];
    delete require.cache[COPY_PATH];
    process.env.TRANSCRIBE_LOCALE = locale;
    const { EtaSmoother } = require('../../shared/logic.js');
    const label = EtaSmoother.label(6);
    assert.ok(!/left|about/.test(label), `${locale} ETA is still English: ${label}`);
    assert.match(label, /min/, 'unit abbreviation is kept');
    delete process.env.TRANSCRIBE_LOCALE;
    delete require.cache[require.resolve('../../shared/logic.js')];
    delete require.cache[COPY_PATH];
  }
});

// 99 language names come from ICU rather than the translation files.
test('language names and ordering follow the locale', () => {
  const LANG_PATH = require.resolve('../../shared/languages.js');
  const load = (locale) => {
    process.env.TRANSCRIBE_LOCALE = locale;
    delete require.cache[COPY_PATH];
    delete require.cache[LANG_PATH];
    const mod = require(LANG_PATH);
    delete require.cache[LANG_PATH];
    delete require.cache[COPY_PATH];
    delete process.env.TRANSCRIBE_LOCALE;
    return mod;
  };

  const en = load('en');
  assert.equal(en.nameFor('de'), 'German', 'English list is untouched');

  const hr = load('hr');
  assert.equal(hr.nameFor('de'), 'Njemački', 'ICU supplies the Croatian name, capitalized');
  assert.equal(hr.nameFor('auto'), 'Automatski prepoznaj', 'Auto-detect comes from the translation');

  const sl = load('sl');
  assert.equal(sl.nameFor('de'), 'Nemščina');

  // Pinned order survives localization.
  for (const mod of [en, hr, sl]) {
    assert.equal(mod.displayOrder[0].code, 'auto');
    assert.equal(mod.displayOrder[1].code, 'hr');
    assert.equal(mod.displayOrder[2].code, 'sl');
  }
  // Search still finds a language by its ENGLISH name in a Croatian UI.
  assert.ok(hr.filtered('German').some((l) => l.code === 'de'), 'English name still searchable');
  assert.ok(hr.filtered('njem').some((l) => l.code === 'de'), 'Croatian name searchable');
  assert.ok(hr.filtered('de').some((l) => l.code === 'de'), 'code prefix searchable');
});

test('setLocale switches the shared table in place (same object identity)', () => {
  const copy = require(COPY_PATH);
  const before = copy.waiting;
  const same = copy.setLocale('hr');
  assert.equal(same, copy, 'callers holding the module object see the change');
  assert.equal(copy.locale, 'hr');
  assert.notEqual(copy.waiting, before);
  copy.setLocale('en');
  assert.equal(copy.waiting, before, 'switching back restores English');
});
