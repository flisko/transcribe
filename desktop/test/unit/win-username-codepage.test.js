// win-username-codepage.test.js — the non-ASCII Windows *username* fix.
// whisper-cli reads -f/-of/-m through the ANSI codepage, so a scratch dir or
// model under a non-ASCII profile (C:\Users\Žiga\…) crashes it. The queue roots
// job dirs at an ASCII base (chooseJobBase) when %TEMP% is non-ASCII, and the
// engine hardlinks a non-ASCII model into that ASCII workDir. These are the pure
// decision helpers; both are platform-injectable so the matrix runs on any host.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

require('./engine.shim.js').ensureShared();
const { chooseJobBase } = require('../../main/queue.js');
const { _internals } = require('../../main/engine.js');
const { isAsciiPath } = _internals;

const NAME = 'com.flisko.transcribe';
const isAscii = (s) => /^[\x00-\x7F]*$/.test(String(s));
const hash12 = (u) => crypto.createHash('sha256').update(u).digest('hex').slice(0, 12);

// tmpBase is built with the ambient path.join — same as the function — so exact
// equality here is host-agnostic (both sides pick the running OS's separator).
const tmpBase = (tmp) => path.join(tmp, NAME);

test('chooseJobBase: non-win32 always keeps the %TEMP% base (even if that were non-ASCII)', () => {
  for (const tmp of ['/tmp', '/home/Žiga/tmp']) {
    assert.equal(
      chooseJobBase({ platform: 'darwin', tmpdir: tmp, programData: 'C:\\ProgramData', username: 'Žiga' }),
      tmpBase(tmp),
    );
  }
});

test('chooseJobBase: win32 + ASCII %TEMP% is unchanged (the overwhelmingly common case)', () => {
  const tmp = 'C:\\Users\\ana\\AppData\\Local\\Temp';
  assert.equal(
    chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: 'C:\\ProgramData', username: 'ana' }),
    tmpBase(tmp),
  );
});

test('chooseJobBase: win32 + non-ASCII %TEMP% → ASCII %ProgramData% base, per-user hash', () => {
  const tmp = 'C:\\Users\\Žiga\\AppData\\Local\\Temp';
  const pd = 'C:\\ProgramData';
  const got = chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: pd, username: 'Žiga' });

  assert.ok(isAscii(got), 'the chosen base is pure ASCII (whisper can open paths under it)');
  assert.ok(!got.includes('Žiga'), 'the non-ASCII profile name never leaks into the base');
  assert.ok(got.startsWith(pd), 'rooted at %ProgramData%');
  assert.ok(got.includes(NAME), 'namespaced under the app id');
  assert.ok(got.endsWith(hash12('Žiga')), 'suffixed by the 12-hex username hash');
});

test('chooseJobBase: different users get different subdirs; same user is stable', () => {
  const tmp = 'C:\\Users\\Žiga\\AppData\\Local\\Temp'; // non-ASCII → ProgramData branch
  const pd = 'C:\\ProgramData';
  const a1 = chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: pd, username: 'Žiga' });
  const a2 = chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: pd, username: 'Žiga' });
  const b = chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: pd, username: 'Šime' });
  assert.equal(a1, a2, 'stable for one user (deterministic hash)');
  assert.notEqual(a1, b, 'isolated per user — no shared sweep across accounts');
});

test('chooseJobBase: win32 + non-ASCII %TEMP% but no usable %ProgramData% → falls back to %TEMP% (no regression)', () => {
  const tmp = 'C:\\Users\\Žiga\\AppData\\Local\\Temp';
  for (const pd of [undefined, '', 'D:\\Ž_data']) {
    assert.equal(
      chooseJobBase({ platform: 'win32', tmpdir: tmp, programData: pd, username: 'Žiga' }),
      tmpBase(tmp),
      `programData=${JSON.stringify(pd)} → unchanged %TEMP% base`,
    );
  }
});

test('isAsciiPath: ASCII true; non-codepage AND codepage diacritics both false; empty true', () => {
  assert.equal(isAsciiPath('C:\\Users\\ana\\Temp\\job\\audio.wav'), true);
  assert.equal(isAsciiPath('C:\\Users\\Žiga\\Temp\\audio.wav'), false, 'cp1250 diacritic (crashes whisper) is non-ASCII');
  assert.equal(isAsciiPath('C:\\dl\\🎬\\ggml-tiny.bin'), false, 'emoji is non-ASCII');
  assert.equal(isAsciiPath('C:\\日本語\\m.bin'), false, 'CJK is non-ASCII');
  assert.equal(isAsciiPath(''), true);
  assert.equal(isAsciiPath(null), true);
  assert.equal(isAsciiPath(undefined), true);
});
