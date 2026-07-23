// shared-copy.test.js — verbatim-port checks for shared/copy.js, plus the C7
// SETUP_NAME platform switch (TRANSCRIBE_FAKE_PLATFORM decides at require time).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COPY_PATH = require.resolve('../../shared/copy.js');

function freshCopy(platform) {
  const saved = process.env.TRANSCRIBE_FAKE_PLATFORM;
  if (platform) process.env.TRANSCRIBE_FAKE_PLATFORM = platform;
  else delete process.env.TRANSCRIBE_FAKE_PLATFORM;
  delete require.cache[COPY_PATH];
  const mod = require(COPY_PATH);
  delete require.cache[COPY_PATH];
  if (saved === undefined) delete process.env.TRANSCRIBE_FAKE_PLATFORM;
  else process.env.TRANSCRIBE_FAKE_PLATFORM = saved;
  return mod;
}

const Copy = freshCopy('darwin');

// The seven strings that name the setup entry point.
function setupNameStrings(c) {
  return [
    c.failModelMissing('Fast'),
    c.failEngineMissing,
    c.failStaleDownloader,
    c.failYtDlpMissing,
    c.failFfmpegMissing,
    c.failModelCorrupt,
    c.settingsModelMissingTooltip,
  ];
}

test('SETUP_NAME is setup.command on mac', () => {
  const mac = freshCopy('darwin');
  assert.equal(mac.SETUP_NAME, 'setup.command');
  for (const s of setupNameStrings(mac)) assert.ok(s.includes('setup.command'), s);
});

test('SETUP_NAME is Transcribe Setup on windows', () => {
  const win = freshCopy('win32');
  assert.equal(win.SETUP_NAME, 'Transcribe Setup');
  for (const s of setupNameStrings(win)) {
    assert.ok(s.includes('Transcribe Setup'), s);
    assert.ok(!s.includes('setup.command'), s);
  }
});

test('platform default comes from process.platform', () => {
  const def = freshCopy(null);
  assert.equal(def.SETUP_NAME,
    process.platform === 'darwin' ? 'setup.command' : 'Transcribe Setup');
});

test('setup-name strings are otherwise verbatim (mac)', () => {
  assert.equal(Copy.failModelMissing('Fast'),
    "The 'Fast' model isn't downloaded. Run setup.command (it offers the extra models), or switch models.");
  assert.equal(Copy.failEngineMissing,
    'The speech engine is missing. Run setup.command, then press Retry.');
  assert.equal(Copy.settingsModelMissingTooltip,
    "This model isn't downloaded — run setup.command.");
});

test('key strings verbatim from Copy.swift', () => {
  assert.equal(Copy.windowTitle, 'Transcribe');
  assert.equal(Copy.dropZoneTitle, 'Drop audio or video files here');
  assert.equal(Copy.invalidLink,
    "That doesn't look like a link. Copy the video's address and paste it here.");
  assert.equal(Copy.emptySubtitle,
    'Drop a file above, or paste a video link.\nEach file gets a transcript (.txt) and subtitles (.srt).');
  assert.equal(Copy.fileGoneNote,
    "That file isn't there anymore — it may have been moved or deleted. Use Transcribe Again to redo it.");
  assert.equal(Copy.failNoVideoAtLink,
    "There's no video at this link — it may be a photo post.");
  assert.equal(Copy.continuingAfterSleep,
    'Continuing after sleep — updating the time estimate…');
  assert.equal(Copy.engineMissing,
    'Transcribe can\'t find its engine. Keep Transcribe.app inside the Transcribe folder, next to "bin" and "models", then click Check Again.');
  assert.equal(Copy.openSubtitles, 'Open Subtitles (.srt)');
  assert.equal(Copy.modelNotDownloadedSuffix, ' — not downloaded');
});

test('row status formatters', () => {
  assert.equal(Copy.downloading(37), 'Downloading — 37%');
  assert.equal(Copy.transcribing(42, 'about 3 min left'),
    'Transcribing — 42% · about 3 min left');
  assert.equal(Copy.transcribing(42, null), 'Transcribing — 42% · estimating time…');
  assert.equal(Copy.doneFile('12 min'),
    'Done in 12 min · transcript saved next to the original');
  assert.equal(Copy.doneLink('under a minute', 'Downloads'),
    'Done in under a minute · saved in Downloads');
});

test('failure formatters', () => {
  assert.equal(Copy.failPlaylist(25),
    'This link points to a whole playlist or channel (25 videos), not one video. Open the video you want, copy its own link, and paste that instead.');
  assert.equal(Copy.failOutOfMemory('clip.mov'),
    "Transcribing 'clip.mov' stopped because your Mac ran out of memory. Close some other apps and try again — or choose the Fast model, which needs much less memory.");
  assert.equal(Copy.failFileMissing('a.mov'),
    "Skipped 'a.mov' — the file can't be found any more. It may have been moved, renamed, or deleted, or it's on a drive that isn't connected.");
  assert.equal(Copy.failZeroLength('a.mov'),
    "Skipped 'a.mov' — the file is empty, so there is nothing to transcribe.");
  assert.equal(Copy.noSpeechNote('a.mov'),
    "Finished 'a.mov', but no speech was found — the transcript is empty. If you expected words here, check that the video's sound is audible and the right language was chosen.");
  // Disk-full copy no longer promises a resume.
  assert.ok(!Copy.failDiskDownload.includes('continues from where it stopped'));
});

test('footer formats', () => {
  assert.equal(Copy.footerTranscribing('a.mov', 1, 3, 'about 5 min left'),
    'Transcribing "a.mov" — 1 of 3 · about 5 min left');
  assert.equal(Copy.footerTranscribing('a.mov', 1, 3, null),
    'Transcribing "a.mov" — 1 of 3');
  assert.equal(Copy.footerDownloading('Zoo', 2, 4), 'Downloading "Zoo" — 2 of 4');
  assert.equal(Copy.footerFinished(1, 0), 'All done — transcript ready');
  assert.equal(Copy.footerFinished(3, 0), 'All done — 3 transcripts ready');
  assert.equal(Copy.footerFinished(2, 1), 'Finished — 2 done, 1 failed');
});

test('notification formats', () => {
  assert.equal(Copy.notifOneBody('a.txt'), '"a.txt" was saved next to your video.');
  assert.equal(Copy.notifAllBody(4), '4 transcripts are ready.');
  assert.equal(Copy.notifMixedBody(2, 1), '2 done, 1 failed. Open Transcribe for details.');
  assert.equal(Copy.notifFailedBody('a.mov'),
    '"a.mov" couldn\'t be transcribed. Open Transcribe for details.');
  assert.equal(Copy.updateAvailable('2.1'), 'Version 2.1 is available.');
});

test('duration phrases', () => {
  assert.equal(Copy.durationPhrase(42), 'under a minute');
  assert.equal(Copy.durationPhrase(59.9), 'under a minute');
  assert.equal(Copy.durationPhrase(60), '1 min');
  assert.equal(Copy.durationPhrase(720), '12 min');
  assert.equal(Copy.durationPhrase(90), '2 min');        // .rounded() half-up
  assert.equal(Copy.durationPhrase(3600), '1 hr');
  assert.equal(Copy.durationPhrase(4800), '1 hr 20 min');
  assert.equal(Copy.durationPhrase(7200), '2 hr');
});
