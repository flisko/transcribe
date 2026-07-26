// srt.js — turn whisper's .srt into the readable .txt the app saves.
//
// WHY: two of the app's four use cases (interviews, lectures) are really the
// question "she said that around minute 34 — where is it?". Until now the
// readable file (.txt) had no times and the timed file (.srt) was not readable,
// so answering that meant hand-correlating two files. whisper's own -otxt output
// is a wall of untimed sentences; this builds the .txt from the cues instead.
//
// Pure string work, no fs, no Electron — unit-testable and shared.
'use strict';

// "00:01:02,500" (or with a '.') -> seconds. NaN when unparsable.
function parseTimestamp(s) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

/// Parse an SRT body into [{ start, end, text }] (seconds). Tolerant: a damaged
/// block is skipped rather than throwing, because a partly-readable transcript
/// beats none.
function parseSrt(body) {
  const cues = [];
  // Blank-line separated blocks; \r stripped so CRLF files parse the same.
  const blocks = String(body == null ? '' : body).replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    // Optional leading index line, then the "start --> end" line.
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const parts = lines[timeIdx].split('-->');
    if (parts.length !== 2) continue;
    const start = parseTimestamp(parts[0]);
    const end = parseTimestamp(parts[1]);
    if (!Number.isFinite(start)) continue;
    const text = lines.slice(timeIdx + 1).join(' ').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    cues.push({ start, end: Number.isFinite(end) ? end : start, text });
  }
  return cues;
}

function pad(n) { return String(n).padStart(2, '0'); }

/// [m:ss] for short media, [h:mm:ss] once it runs past an hour — a 4-minute clip
/// reading "[00:00:12]" is noise, and an interview needs the hour.
function formatStamp(seconds, withHours) {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return withHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const PARAGRAPH_GAP_SECONDS = 3;   // a real pause — start a new paragraph
const PARAGRAPH_MAX_CHARS = 320;   // …or when one has simply run long

/// Cues -> readable transcript. Consecutive cues are merged into paragraphs so
/// it reads as prose rather than as subtitle fragments, and each paragraph is
/// stamped with the time it starts.
function toReadableText(cues) {
  const list = Array.isArray(cues) ? cues : [];
  if (list.length === 0) return '';
  const withHours = list[list.length - 1].end >= 3600;
  const paragraphs = [];
  let current = null;
  for (const cue of list) {
    const gap = current ? cue.start - current.end : 0;
    if (!current || gap >= PARAGRAPH_GAP_SECONDS
        || (current.text.length + cue.text.length + 1) > PARAGRAPH_MAX_CHARS) {
      if (current) paragraphs.push(current);
      current = { start: cue.start, end: cue.end, text: cue.text };
    } else {
      current.text += ' ' + cue.text;
      current.end = cue.end;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs
    .map((p) => `[${formatStamp(p.start, withHours)}] ${p.text}`)
    .join('\n\n') + '\n';
}

// The clipboard wants the words, not the times: "Copy Transcript Text" should
// paste into an email or a document as clean prose. Strips only a leading stamp
// this module could have written, so a line the user typed is left alone.
function stripTimestamps(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map((line) => line.replace(/^\[\d+:\d{2}(?::\d{2})?\]\s*/, ''))
    .join('\n');
}

module.exports = { parseSrt, toReadableText, stripTimestamps, parseTimestamp, formatStamp };
