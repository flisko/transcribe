// shared-srt.test.js — the .srt -> readable timestamped .txt conversion.
// The .txt is one of the two files every run produces, so this is a
// user-visible contract, not a helper.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSrt, toReadableText, stripTimestamps, parseTimestamp, formatStamp } =
  require('../../shared/srt.js');

const SAMPLE = [
  '1',
  '00:00:00,000 --> 00:00:04,120',
  'Hello, this is a test recording.',
  '',
  '2',
  '00:00:04,120 --> 00:00:08,000',
  'The quick brown fox jumps over the lazy dog.',
  '',
].join('\n');

test('parseSrt: indices, times and text', () => {
  const cues = parseSrt(SAMPLE);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 4.12, text: 'Hello, this is a test recording.' });
  assert.equal(cues[1].start, 4.12);
  assert.equal(cues[1].text, 'The quick brown fox jumps over the lazy dog.');
});

test('parseSrt: CRLF, a missing index line, and multi-line cue text', () => {
  const cues = parseSrt('00:00:01,000 --> 00:00:02,000\r\nfirst line\r\nsecond line\r\n');
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'first line second line', 'wrapped cue text joins into one paragraph');
});

test('parseSrt: damaged blocks are skipped, not thrown on', () => {
  const cues = parseSrt(['1', 'not a timestamp', 'orphan text', '',
    '2', '00:00:05,000 --> 00:00:06,000', 'good', ''].join('\n'));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'good');
});

test('parseSrt: empty / junk input yields no cues rather than an error', () => {
  for (const input of ['', null, undefined, 'nonsense', '\n\n\n']) {
    assert.deepEqual(parseSrt(input), [], JSON.stringify(input));
  }
});

test('parseTimestamp: comma and dot decimals, hours over 9', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1.5);
  assert.equal(parseTimestamp('00:00:01.500'), 1.5);
  assert.equal(parseTimestamp('01:02:03,000'), 3723);
  assert.equal(parseTimestamp('12:00:00,000'), 43200);
  assert.ok(Number.isNaN(parseTimestamp('bad')));
});

// Under an hour, "[0:04]" reads better than "[0:00:04]"; past an hour the hour
// is the whole point.
test('formatStamp: m:ss under an hour, h:mm:ss beyond', () => {
  assert.equal(formatStamp(4, false), '0:04');
  assert.equal(formatStamp(754, false), '12:34');
  assert.equal(formatStamp(3723, true), '1:02:03');
  assert.equal(formatStamp(0, true), '0:00:00');
});

test('toReadableText: consecutive cues merge into one stamped paragraph', () => {
  const out = toReadableText(parseSrt(SAMPLE));
  assert.equal(out,
    '[0:00] Hello, this is a test recording. The quick brown fox jumps over the lazy dog.\n');
});

test('toReadableText: a real pause starts a new paragraph', () => {
  const cues = [
    { start: 0, end: 2, text: 'Before the pause.' },
    { start: 30, end: 32, text: 'After the pause.' },
  ];
  assert.equal(toReadableText(cues), '[0:00] Before the pause.\n\n[0:30] After the pause.\n');
});

test('toReadableText: a long unbroken stretch is split so paragraphs stay readable', () => {
  const cues = [];
  for (let i = 0; i < 40; i++) cues.push({ start: i * 2, end: i * 2 + 2, text: 'Sentence number ' + i + '.' });
  const paras = toReadableText(cues).trimEnd().split('\n\n');
  assert.ok(paras.length > 1, 'splits rather than emitting one enormous line');
  for (const p of paras) assert.ok(p.length < 400, 'no paragraph runs away: ' + p.length);
});

test('toReadableText: switches to hours once the media passes an hour', () => {
  const out = toReadableText([{ start: 3600, end: 3605, text: 'Late in the interview.' }]);
  assert.equal(out, '[1:00:00] Late in the interview.\n');
});

test('toReadableText: no cues -> empty string (drives the "no speech" note)', () => {
  assert.equal(toReadableText([]), '');
  assert.equal(toReadableText(null), '');
});

// The file carries times; the clipboard must not, or every paste into an email
// needs hand-cleaning.
test('stripTimestamps: removes the stamps this module writes, leaves prose alone', () => {
  assert.equal(stripTimestamps('[0:00] Hello.\n\n[1:02:03] Later.'), 'Hello.\n\nLater.');
  assert.equal(stripTimestamps('[12:34] Words.'), 'Words.');
  assert.equal(stripTimestamps('No stamp here.'), 'No stamp here.');
  // Not a stamp we wrote — a citation the user typed mid-line stays put.
  assert.equal(stripTimestamps('She said [0:15] was the moment.'), 'She said [0:15] was the moment.');
});

test('round trip: srt -> readable -> stripped is the original sentences', () => {
  const stripped = stripTimestamps(toReadableText(parseSrt(SAMPLE))).trim();
  assert.equal(stripped, 'Hello, this is a test recording. The quick brown fox jumps over the lazy dog.');
});
