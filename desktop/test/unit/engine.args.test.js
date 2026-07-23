// engine.args.test.js — C3: pinned yt-dlp arg arrays, taskkill construction,
// URL validation, info-line parsing.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./engine.shim.js').ensureShared();
const { _internals } = require('../../main/engine.js');
const { infoArgs, dlArgs, taskkillArgs, isAllowedUrl, parseInfoLine, normalizeLang } = _internals;

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const DL_TEMPLATE = 'download:PROGRESS\t%(progress._percent_str)s\t%(progress.eta)s\t%(progress.filename)s';
const PP_TEMPLATE = 'postprocess:PP\t%(progress.status)s\t%(progress.postprocessor)s';

function hasPair(args, flag, value) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] === value;
}

test('infoArgs: pinned lookup flags, URL as the single final element', () => {
  const args = infoArgs(URL);
  for (const f of ['--no-update', '--no-playlist', '--skip-download']) assert.ok(args.includes(f), f);
  assert.ok(hasPair(args, '-I', '1'));
  assert.ok(hasPair(args, '--print', '%(title)s\t%(duration)s\t%(is_live)s\t%(playlist_count)s'));
  assert.equal(args[args.length - 1], URL);
});

test('dlArgs video: pinned flag set incl. formats, res cap, merge, staging', () => {
  const args = dlArgs('video', URL, '/stage/dir');
  for (const f of ['--no-update', '--no-playlist', '--newline', '--progress', '--no-simulate']) {
    assert.ok(args.includes(f), f);
  }
  assert.ok(hasPair(args, '-I', '1'));
  assert.ok(args.includes(DL_TEMPLATE), 'download progress template with real tabs');
  assert.ok(args.includes(PP_TEMPLATE), 'postprocess template (video only)');
  assert.ok(hasPair(args, '-f', 'bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b'));
  assert.ok(hasPair(args, '-S', 'res:1080'));
  assert.ok(hasPair(args, '--merge-output-format', 'mp4'));
  assert.ok(hasPair(args, '-P', '/stage/dir'));
  assert.ok(hasPair(args, '-o', '%(title).120B [%(id)s].%(ext)s'));
  assert.ok(hasPair(args, '--print', 'after_move:filepath'));
  assert.equal(args[args.length - 1], URL);
});

test('dlArgs audio: pinned extraction flags, no video-only flags', () => {
  const args = dlArgs('audio', URL, '/stage/dir');
  assert.ok(args.includes(DL_TEMPLATE));
  assert.ok(!args.includes(PP_TEMPLATE), 'no postprocess template in audio mode');
  assert.ok(hasPair(args, '-f', 'ba[ext=m4a]/ba/b'));
  assert.ok(args.includes('-x'));
  assert.ok(hasPair(args, '--audio-format', 'm4a'));
  assert.ok(hasPair(args, '--audio-quality', '0'));
  assert.ok(!args.includes('-S'));
  assert.ok(!args.includes('--merge-output-format'));
  assert.ok(hasPair(args, '-P', '/stage/dir'));
  assert.ok(hasPair(args, '--print', 'after_move:filepath'));
  assert.ok(args.includes('--no-simulate'));
  assert.equal(args[args.length - 1], URL);
});

test('taskkillArgs: /pid <pid> /T /F', () => {
  assert.deepEqual(taskkillArgs(1234), ['/pid', '1234', '/T', '/F']);
  assert.deepEqual(taskkillArgs('567'), ['/pid', '567', '/T', '/F']);
});

test('URL validation: accepts http(s) links only', () => {
  assert.ok(isAllowedUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw'));
  assert.ok(isAllowedUrl('http://example.com/a'));
  assert.ok(isAllowedUrl('  https://example.com/a  '), 'trims whitespace');
  assert.ok(isAllowedUrl('HTTPS://EXAMPLE.COM/A'), 'scheme is case-insensitive');
});

test('URL validation: rejects option-shaped, file:// and other non-links', () => {
  for (const bad of [
    '-o/tmp/evil', '--exec=rm -rf ~', '-U',
    'file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)',
    '/Users/x/video.mp4', 'youtube.com/watch?v=x', 'https://', 'https:// evil.com',
    '', '   ', null, undefined,
  ]) {
    assert.equal(isAllowedUrl(bad), false, `should reject: ${bad}`);
  }
});

test('parseInfoLine: normal line', () => {
  assert.deepEqual(parseInfoLine('Me at the zoo\t19\tFalse\t1'), {
    title: 'Me at the zoo', durationSec: 19, isLive: false, playlistCount: 1,
  });
});

test('parseInfoLine: NA fields → null, live True, float duration truncates', () => {
  assert.deepEqual(parseInfoLine('NA\tNA\tNA\tNA'), {
    title: null, durationSec: null, isLive: false, playlistCount: null,
  });
  assert.deepEqual(parseInfoLine('Live now\t37.9\tTrue\tNA'), {
    title: 'Live now', durationSec: 37, isLive: true, playlistCount: null,
  });
});

test('parseInfoLine: tab inside the title must not shift the fields', () => {
  const got = parseInfoLine('Weird\ttitle\t19\tFalse\t3');
  assert.deepEqual(got, { title: 'Weird title', durationSec: 19, isLive: false, playlistCount: 3 });
});

test('normalizeLang mirrors bin/transcribe aliases', () => {
  assert.equal(normalizeLang('Croatian'), 'hr');
  assert.equal(normalizeLang('slovenščina'), 'sl');
  assert.equal(normalizeLang(''), 'hr');
  assert.equal(normalizeLang('AUTO'), 'auto');
  assert.equal(normalizeLang('en'), 'en');
});
