// queue-settings.test.js — main/settings.js: defaults, persistence roundtrip,
// corrupt-file recovery, and the vanished-download-folder repair.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSettings } = require('../../main/settings');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-st-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });
  return dir;
}

test('defaults: model=best language=hr keepVideo=false notifyOnFinish=true, downloads dir', (t) => {
  const dir = tmp(t);
  const s = createSettings({ file: path.join(dir, 'settings.json'), downloadsDir: dir });
  assert.strictEqual(s.get('model'), 'best');
  assert.strictEqual(s.get('language'), 'hr');
  assert.strictEqual(s.get('keepVideo'), false);
  assert.strictEqual(s.get('notifyOnFinish'), true);
  assert.strictEqual(s.get('downloadFolder'), dir);
  assert.strictEqual(s.downloadFolder(), dir);
});

test('roundtrip: values persist across instances', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'settings.json');
  const custom = path.join(dir, 'my-downloads');
  fs.mkdirSync(custom);

  const a = createSettings({ file, downloadsDir: dir });
  a.set('model', 'fast');
  a.set('language', 'sl');
  a.set('keepVideo', true);
  a.set('notifyOnFinish', false);
  a.set('downloadFolder', custom);

  const b = createSettings({ file, downloadsDir: dir });
  assert.strictEqual(b.get('model'), 'fast');
  assert.strictEqual(b.get('language'), 'sl');
  assert.strictEqual(b.get('keepVideo'), true);
  assert.strictEqual(b.get('notifyOnFinish'), false);
  assert.strictEqual(b.downloadFolder(), custom);
});

test('corrupt file -> defaults, no crash', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{{{ definitely not json');
  const s = createSettings({ file, downloadsDir: dir });
  assert.strictEqual(s.get('model'), 'best');
  assert.strictEqual(s.get('language'), 'hr');
  // a set() after corruption must produce a valid file again
  s.set('model', 'fast');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'fast');
});

test('non-object JSON (array/string) -> defaults', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '"hello"');
  assert.strictEqual(createSettings({ file, downloadsDir: dir }).get('model'), 'best');
  fs.writeFileSync(file, '[1,2,3]');
  assert.strictEqual(createSettings({ file, downloadsDir: dir }).get('language'), 'hr');
});

test('vanished download folder falls back and repairs the stored setting', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'settings.json');
  const s = createSettings({ file, downloadsDir: dir });
  s.set('downloadFolder', path.join(dir, 'never-created'));
  assert.strictEqual(s.downloadFolder(), dir, 'falls back to the downloads dir');
  assert.strictEqual(s.get('downloadFolder'), dir, 'setting repaired in memory');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).downloadFolder, dir,
    'setting repaired on disk');
});

test('no file (in-memory) still works', () => {
  const s = createSettings({});
  assert.strictEqual(s.get('model'), 'best');
  s.set('model', 'fast');
  assert.strictEqual(s.get('model'), 'fast');
});
