// copy.js — every user-facing string in one place (verbatim port of app/Copy.swift).
// Strings that name the setup entry point derive from SETUP_NAME (contract C7):
// mac = "setup.command", win = "Transcribe Setup". Platform is decided at require
// time from process.platform; TRANSCRIBE_FAKE_PLATFORM overrides it for tests.
'use strict';

const platform = process.env.TRANSCRIBE_FAKE_PLATFORM || process.platform;
const SETUP_NAME = platform === 'darwin' ? 'setup.command' : 'Transcribe Setup';

const Copy = {
  SETUP_NAME,

  // Window / input header
  windowTitle: 'Transcribe',
  dropZoneTitle: 'Drop audio or video files here',
  dropZoneSubtitle: 'MP3, MP4, MOV, M4A and most other formats',
  browse: 'Browse…',
  linkPrompt: 'Paste a video link — YouTube, TikTok, Instagram…',
  addLink: 'Add',
  invalidLink: "That doesn't look like a link. Copy the video's address and paste it here.",
  searchLanguages: 'Search languages',
  autoDetect: 'Auto-detect',
  modelDisplayBest: 'Best quality',
  modelDisplayFast: 'Fast',
  modelNotDownloadedSuffix: ' — not downloaded',
  failModelMissing(display) {
    return `The '${display}' model isn't downloaded. Run ${SETUP_NAME} (it offers the extra models), or switch models.`;
  },
  fileGoneNote: "That file isn't there anymore — it may have been moved or deleted. Use Transcribe Again to redo it.",
  emptyTitle: 'Ready to transcribe',
  emptySubtitle: 'Drop a file above, or paste a video link.\nEach file gets a transcript (.txt) and subtitles (.srt).',
  dropOverlay: 'Drop to add to the queue',
  dropOverlaySetup: 'Finish setup to start transcribing',
  clearDone: 'Clear Done',
  clearDoneTooltip: 'Remove finished items from the list',
  settingsTooltip: 'Settings',
  addFilesMenu: 'Add Files…',
  addLinkMenu: 'Add Video Link…',
  cancelItemMenu: 'Cancel Item',

  // Row status
  waiting: 'Waiting…',
  lookingUp: 'Looking up video…',
  downloadingUnknown: 'Downloading…',
  downloading(pct) { return `Downloading — ${pct}%`; },
  preparing: 'Preparing audio…',
  estimating: 'estimating time…',
  transcribing(pct, eta) { return `Transcribing — ${pct}% · ${eta ?? Copy.estimating}`; },
  continuingAfterSleep: 'Continuing after sleep — updating the time estimate…',
  canceled: 'Canceled',
  transcriptCopied: 'Transcript copied.',
  doneFile(duration) { return `Done in ${duration} · transcript saved next to the original`; },
  doneLink(duration, folder) { return `Done in ${duration} · saved in ${folder}`; },

  // Row actions
  open: 'Open',
  openTranscript: 'Open Transcript',
  openSubtitles: 'Open Subtitles (.srt)',
  showInFinder: 'Show in Finder',
  copyTranscript: 'Copy Transcript Text',
  transcribeAgain: 'Transcribe Again',
  removeFromList: 'Remove from List',
  retry: 'Retry',
  startAgain: 'Start Again',
  copyErrorDetails: 'Copy Error Details',
  cancelTooltip: 'Cancel',
  removeTooltip: 'Remove',

  // Failure reasons (UX copy — wins over the error catalog)
  failDownloadPrivateOrRemoved: "Couldn't download — the video may be private or removed.",
  failDownloadNetwork: "Couldn't download — check your internet connection, then press Retry.",
  failLookup: "Couldn't find a video at this link.",
  failNoVideoAtLink: "There's no video at this link — it may be a photo post.",
  failNoAudio: 'This file has no audio track.',
  failUnreadable: "Couldn't read this file — it may be damaged or not an audio/video file.",
  failDisk: 'Not enough disk space. Free up some space, then press Retry.',
  failTranscription: "Transcription didn't finish. Press Retry — if it keeps failing, try the Best quality model.",
  failEngineMissing: `The speech engine is missing. Run ${SETUP_NAME}, then press Retry.`,

  // Failure reasons (error catalog — cases the UX copy doesn't cover)
  failAgeRestricted: "This video is age-restricted, and the site only shows it to signed-in viewers, so Transcribe can't download it.",
  failGeoBlocked: "This video isn't available in your country, so it can't be downloaded.",
  failLoginRequired: "This site only shows that video to signed-in users, so it can't be downloaded directly (this is common with Instagram). If you can watch it in your browser, save the video from there and drop the file into Transcribe instead.",
  failPlaylist(n) { return `This link points to a whole playlist or channel (${n} videos), not one video. Open the video you want, copy its own link, and paste that instead.`; },
  failLivestream: "This is a live stream, and Transcribe can't record live video. Once the stream has ended and the replay is available on the same page, paste the link again and it will work.",
  failStaleDownloader: `The download didn't work — the video site has probably changed something on their end. This is normal and there's an easy fix: double-click ${SETUP_NAME} (in the Transcribe folder), let it update the downloader, then press Retry.`,
  failDiskDownload: "Your Mac's disk is full, so the download stopped. Free up some space, then press Retry to download it again.",
  failYtDlpMissing: `Downloading videos from the internet needs a small helper that isn't installed yet. Double-click ${SETUP_NAME} (in the Transcribe folder) once to install it. You can still transcribe files that are already on this Mac.`,
  failFfmpegMissing: `A helper that reads sound from video files (ffmpeg) is missing on this Mac. Please double-click ${SETUP_NAME} (in the Transcribe folder) to install it, then try again.`,
  failModelCorrupt: `The speech model file on this Mac looks damaged — usually this means its download was interrupted at some point. Please double-click ${SETUP_NAME}; it will download a fresh copy for you.`,
  failOutOfMemory(name) { return `Transcribing '${name}' stopped because your Mac ran out of memory. Close some other apps and try again — or choose the Fast model, which needs much less memory.`; },
  failFileMissing(name) { return `Skipped '${name}' — the file can't be found any more. It may have been moved, renamed, or deleted, or it's on a drive that isn't connected.`; },
  failZeroLength(name) { return `Skipped '${name}' — the file is empty, so there is nothing to transcribe.`; },
  failFolderUnwritable(folder) { return `Transcribe can't save downloads into '${folder}' — it may have been deleted or isn't allowed. Choose a different folder for downloads.`; },
  failOutputDirReadOnly(name) { return `Transcripts are saved next to the video, but the folder holding '${name}' doesn't allow saving. Choose another folder for this transcript, or copy the video to your Mac first.`; },
  noSpeechNote(name) { return `Finished '${name}', but no speech was found — the transcript is empty. If you expected words here, check that the video's sound is audible and the right language was chosen.`; },

  // Footer
  footerTranscribing(name, n, total, eta) {
    let s = `Transcribing "${name}" — ${n} of ${total}`;
    if (eta != null) s += ` · ${eta}`;
    return s;
  },
  footerDownloading(title, n, total) { return `Downloading "${title}" — ${n} of ${total}`; },
  footerFinished(done, failed) {
    if (failed === 0) {
      return done === 1 ? 'All done — transcript ready' : `All done — ${done} transcripts ready`;
    }
    return `Finished — ${done} done, ${failed} failed`;
  },
  cancelAll: 'Cancel All',

  // Setup state
  setupTitle: 'One-time setup',
  setupIntro: 'Transcribe needs a few free components before it can start. Everything runs on your Mac — nothing is uploaded.',
  setupWhisper: 'Speech recognition (whisper)',
  setupFfmpeg: 'Audio converter (ffmpeg)',
  setupModels: 'Language models (4.6 GB download)',
  setupYtDlp: 'Link downloader (yt-dlp) — optional, only needed for video links',
  installed: 'Installed',
  notInstalled: 'Not installed',
  runSetup: 'Run Setup…',
  checkAgain: 'Check Again',
  setupFootnote: "Setup opens the Terminal and takes a few minutes, mostly downloading. It's safe to run more than once.",
  engineMissing: 'Transcribe can\'t find its engine. Keep Transcribe.app inside the Transcribe folder, next to "bin" and "models", then click Check Again.',
  linksLimitedPrompt: 'Video links need one more component',
  linksLimitedInstall: 'Install…',
  linksLimitedCaption: 'Everything else works — this only affects video links.',

  // Dialogs & notifications
  quitTitle: 'Quit Transcribe?',
  quitMessage: 'Work is still in progress. Quitting now will stop the current item — anything unfinished will be canceled.',
  quitKeepWorking: 'Keep Working',
  quitAnyway: 'Quit Anyway',
  notifOneTitle: 'Transcript ready',
  notifOneBody(txtName) { return `"${txtName}" was saved next to your video.`; },
  notifAllTitle: 'All transcriptions finished',
  notifAllBody(n) { return `${n} transcripts are ready.`; },
  notifMixedTitle: 'Transcriptions finished',
  notifMixedBody(done, failed) { return `${done} done, ${failed} failed. Open Transcribe for details.`; },
  notifFailedTitle: 'Transcription failed',
  notifFailedBody(name) { return `"${name}" couldn't be transcribed. Open Transcribe for details.`; },

  // Settings pane
  settingsSectionTranscription: 'Transcription',
  settingsModel: 'Model',
  settingsModelMissingTooltip: `This model isn't downloaded — run ${SETUP_NAME}.`,
  settingsLanguage: 'Language',
  settingsLanguageHelp: "The language spoken in your files. Choose Auto-detect if it varies or you're not sure.",
  settingsSectionLinks: 'Video links',
  settingsKeepVideo: 'Keep the downloaded video file',
  settingsKeepVideoCaption: 'When off, only the audio is downloaded — faster and smaller. Your transcript is saved either way.',
  settingsDownloadFolder: 'Save downloads to',
  settingsChooseFolder: 'Choose…',
  settingsSectionNotifications: 'Notifications',
  settingsNotify: 'Notify me when the queue finishes',

  // Update banner
  updateAvailable(version) { return `Version ${version} is available.`; },
  updateDownload: 'Download',

  // Instagram login (in-app; File menu). Instagram gates most reels behind a
  // login, so downloading them needs a logged-in session.
  connectInstagramMenu: 'Connect Instagram…',
  disconnectInstagramMenu: 'Disconnect Instagram',
  instagramConnectedTitle: 'Instagram connected',
  instagramConnectedBody: 'Instagram links will now download using your login. You can disconnect any time from the File menu.',
  instagramNotConnectedTitle: 'Not connected',
  instagramNotConnectedBody: 'You are not logged in to Instagram yet, so Instagram links may still fail. Choose “Connect Instagram…” again and finish logging in.',
  instagramDisconnectedTitle: 'Instagram disconnected',
  instagramDisconnectedBody: 'Your Instagram login has been cleared from this app.',

  // Shared helpers
  // "under a minute" / "12 min" / "1 hr 20 min" — used by "Done in …" status lines.
  durationPhrase(seconds) {
    if (seconds < 60) return 'under a minute';
    const m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r === 0 ? `${h} hr` : `${h} hr ${r} min`;
  },
};

module.exports = Copy;
