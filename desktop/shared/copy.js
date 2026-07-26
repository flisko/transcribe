// copy.js — every user-facing string in one place (verbatim port of app/Copy.swift).
// Strings that name the setup entry point derive from SETUP_NAME (contract C7):
// mac = "setup.command", win = "Transcribe Setup". Platform is decided at require
// time from process.platform; TRANSCRIBE_FAKE_PLATFORM overrides it for tests.
//
// C7 extended (the app now ships on Windows too): the same substitution applies
// to every other string that named a mac-only thing — "your Mac", "this Mac",
// "Finder", "Transcribe.app", "the Terminal". Windows users were being told to
// free space on a Mac they don't own. The macOS wording is unchanged byte for
// byte (the port-verbatim tests assert it); only the win32 branch is new.
'use strict';

const platform = process.env.TRANSCRIBE_FAKE_PLATFORM || process.platform;
const IS_MAC = platform === 'darwin';
const SETUP_NAME = IS_MAC ? 'setup.command' : 'Transcribe Setup';
const THIS_COMPUTER = IS_MAC ? 'this Mac' : 'this PC';
const YOUR_COMPUTER = IS_MAC ? 'your Mac' : 'your PC';
const YOUR_COMPUTER_CAP = IS_MAC ? 'Your Mac' : 'Your PC';
const FILE_MANAGER = IS_MAC ? 'Finder' : 'File Explorer';
// What has to stay beside the app for folderMarkerPresent() to find the folder:
// mac looks for setup.command next to Transcribe.app, win for the setup pair
// next to Transcribe.exe.
const APP_FILE = IS_MAC ? 'Transcribe.app' : 'Transcribe.exe';
const SETUP_CONSOLE = IS_MAC ? 'the Terminal' : 'a PowerShell window';

// The English table, and the fallback for every other locale: a translation file
// supplies only the keys it has translated, so a missing string degrades to
// English rather than to `undefined` in the UI.
function english(ctx) {
  return {
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
  showInFinder: `Show in ${FILE_MANAGER}`,
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
  failDiskDownload: `${YOUR_COMPUTER_CAP}'s disk is full, so the download stopped. Free up some space, then press Retry to download it again.`,
  failYtDlpMissing: `Downloading videos from the internet needs a small helper that isn't installed yet. Double-click ${SETUP_NAME} (in the Transcribe folder) once to install it. You can still transcribe files that are already on ${THIS_COMPUTER}.`,
  failFfmpegMissing: `A helper that reads sound from video files (ffmpeg) is missing on ${THIS_COMPUTER}. Please double-click ${SETUP_NAME} (in the Transcribe folder) to install it, then try again.`,
  failModelCorrupt: `The speech model file on ${THIS_COMPUTER} looks damaged — usually this means its download was interrupted at some point. Please double-click ${SETUP_NAME}; it will download a fresh copy for you.`,
  failOutOfMemory(name) { return `Transcribing '${name}' stopped because ${YOUR_COMPUTER} ran out of memory. Close some other apps and try again — or choose the Fast model, which needs much less memory.`; },
  failFileMissing(name) { return `Skipped '${name}' — the file can't be found any more. It may have been moved, renamed, or deleted, or it's on a drive that isn't connected.`; },
  failZeroLength(name) { return `Skipped '${name}' — the file is empty, so there is nothing to transcribe.`; },
  failFolderUnwritable(folder) { return `Transcribe can't save downloads into '${folder}' — it may have been deleted or isn't allowed. Choose a different folder for downloads.`; },
  failOutputDirReadOnly(name) { return `Transcripts are saved next to the video, but the folder holding '${name}' doesn't allow saving. Choose another folder for this transcript, or copy the video to ${YOUR_COMPUTER} first.`; },
  // The transcription itself succeeded but the finished file couldn't be put in
  // place — on Windows a transcript still open in Word/Notepad holds an exclusive
  // lock and rename() fails with EPERM. Without this the raw
  // "EPERM: operation not permitted, rename …" reached the row's status line.
  failOutputLocked(name) { return `Couldn't save '${name}' — a program still has that file open. Close it (Word, Notepad, a media player…), then press Retry.`; },
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
  setupIntro: `Transcribe needs a few free components before it can start. Everything runs on ${YOUR_COMPUTER} — nothing is uploaded.`,
  setupWhisper: 'Speech recognition (whisper)',
  setupFfmpeg: 'Audio converter (ffmpeg)',
  setupModels: 'Language models (4.6 GB download)',
  setupYtDlp: 'Link downloader (yt-dlp) — optional, only needed for video links',
  installed: 'Installed',
  notInstalled: 'Not installed',
  runSetup: 'Run Setup…',
  checkAgain: 'Check Again',
  setupFootnote: `Setup opens ${SETUP_CONSOLE} and takes a few minutes, mostly downloading. It's safe to run more than once.`,
  // The folder marker the app actually looks for is the setup entry point beside
  // the app (paths.folderMarkerPresent), so name what the user must keep there:
  // mac ships bin/ + setup.command, win ships "Transcribe Setup" + setup.ps1.
  engineMissing: IS_MAC
    ? 'Transcribe can\'t find its engine. Keep Transcribe.app inside the Transcribe folder, next to "bin" and "models", then click Check Again.'
    : `Transcribe can't find its engine. Keep ${APP_FILE} inside the Transcribe folder, next to "${SETUP_NAME}" and "models", then click Check Again.`,
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

  // Settings ▸ Updates. The app deliberately does NOT install anything by
  // itself (see docs/RELEASING.md) — the automatic part is the *check*, and the
  // caption has to say so or the toggle over-promises.
  checkForUpdatesMenu: 'Check for Updates…',
  settingsSectionUpdates: 'Updates',
  settingsVersion(version) { return `Version ${version}`; },
  settingsCheckNow: 'Check Now',
  settingsAutoCheck: 'Check for updates automatically',
  settingsAutoCheckCaption: 'Looks once each time Transcribe starts, and shows a banner when a new version exists. Nothing is downloaded or installed for you — you choose when to update.',
  updateChecking: 'Checking…',
  updateUpToDate: `You're on the latest version.`,
  updateCheckFailed: "Couldn't check for updates just now — check your internet connection and try again.",
  // The request DID complete and the answer was unusable (404 on a private or
  // release-less repo, a rate-limit, a server error). Don't send someone to
  // debug a connection that demonstrably works.
  updateCheckUnavailable: "Couldn't check for updates just now — the update service didn't have an answer. Your connection is fine; try again later.",
  updateCheckOff: `This copy was built locally, so it has no release to compare itself against. Release builds check on their own.`,

  // Run Setup couldn't launch the setup script (mac: a .command bound to another
  // app, a stripped exec bit, Gatekeeper). Never leave the button looking dead.
  setupLaunchFailedTitle: `Couldn't open ${SETUP_NAME}`,
  setupLaunchFailedBody(scriptPath) {
    return IS_MAC
      ? `Transcribe couldn't start the setup script automatically.\n\nOpen it yourself: double-click "setup.command" in the Transcribe folder. If macOS refuses ("unidentified developer"), Control-click it and choose Open.\n\n${scriptPath}`
      : `Transcribe couldn't start the setup script automatically.\n\nOpen it yourself: double-click "Transcribe Setup" in the Transcribe folder.\n\n${scriptPath}`;
  },
  setupLaunchFailedShow: IS_MAC ? 'Show in Finder' : 'Show in File Explorer',
  setupLaunchFailedOK: 'OK',
  // The setup script isn't where the app is looking. On macOS this is usually
  // App Translocation — a quarantined app launched straight from Downloads runs
  // from a random read-only copy with no sibling files — and the cure is to move
  // the folder and clear the quarantine, not to hunt for the script.
  setupNotFoundTitle: `Transcribe can't find ${SETUP_NAME}`,
  setupNotFoundBody(scriptPath) {
    return IS_MAC
      ? `Transcribe looked for setup.command next to itself and it isn't there.\n\nThis usually means Transcribe.app was opened straight out of the zip or on its own. Move the whole "Transcribe" folder somewhere like your Applications or Documents folder, then run this once in Terminal on that folder:\n\n    xattr -dr com.apple.quarantine /path/to/Transcribe\n\nThen open Transcribe.app from inside that folder again.\n\nLooked in: ${scriptPath}`
      : `Transcribe looked for "Transcribe Setup" next to itself and it isn't there.\n\nKeep Transcribe.exe inside the "Transcribe" folder you unzipped, alongside "Transcribe Setup" and the "models" folder, then try again.\n\nLooked in: ${scriptPath}`;
  },

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

  // MARK: - ETA phrasing (rendered by logic.js EtaSmoother.label)
  // Abbreviated units deliberately: "min"/"h" inflect in no Slavic language,
  // which keeps the running estimate out of the plural system entirely.
  etaUnderMinute: 'less than a minute left',
  etaMinutes(m) { return `about ${m} min left`; },
  etaHours(h) { return `about ${h} hr left`; },
  etaHoursMinutes(h, r) { return `about ${h} hr ${r} min left`; },
  };
}

// MARK: - Locale selection
//
// The audience is Croatian and Slovenian; the app was English-only. Rivals ship
// many locales (Buzz 14, Vibe 19) and NEITHER ships hr or sl, so this is the one
// place where being small is an advantage. What matters is not the buttons: the
// whole recovery strategy is instructional prose ("double-click Transcribe Setup,
// let it update the downloader, then press Retry"), which a stuck user meets at
// the exact moment they cannot afford to be reading a foreign language.

const TRANSLATIONS = { hr: './i18n/hr', sl: './i18n/sl' };

// Language subtag of the UI locale. Intl reflects the OS locale in both Node and
// Electron's main process, so this resolves at require time with no dependency on
// app.getLocale() (which is only reliable after 'ready' — too late, half the
// modules here are required before that). TRANSCRIBE_LOCALE overrides, for tests
// and for anyone who wants English on a Croatian machine.
function resolveLocale(tag) {
  let raw = tag;
  if (!raw) raw = process.env.TRANSCRIBE_LOCALE;
  if (!raw) {
    try { raw = Intl.DateTimeFormat().resolvedOptions().locale; } catch (_) { raw = 'en'; }
  }
  const lang = String(raw || 'en').toLowerCase().split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(TRANSLATIONS, lang) ? lang : 'en';
}

// Croatian has one/few/other; Slovenian adds a dual (one/two/few/other). Getting
// this wrong is the tell of a machine translation, and Intl already knows the
// rules — the translator only has to supply the forms.
function pluralFor(locale) {
  let rules = null;
  try { rules = new Intl.PluralRules(locale); } catch (_) { rules = null; }
  return (n, forms) => {
    const category = rules ? rules.select(n) : (n === 1 ? 'one' : 'other');
    return forms[category] !== undefined ? forms[category] : forms.other;
  };
}

// One stable object identity for the whole process: modules capture `copy` at
// require time (engine.js, logic.js, catalog.js, menus.js, queue.js's default),
// so switching locale rewrites this table in place rather than replacing it.
const Copy = {};

function setLocale(tag) {
  const locale = resolveLocale(tag);
  const ctx = {
    locale,
    isMac: IS_MAC,
    setupName: SETUP_NAME,   // a filename — never translated
    appFile: APP_FILE,
    plural: pluralFor(locale),
  };
  const table = english(ctx);
  if (locale !== 'en') {
    // Overlay only: an untranslated key keeps its English text.
    try { Object.assign(table, require(TRANSLATIONS[locale])(ctx)); } catch (_) { /* ship English */ }
  }
  for (const key of Object.keys(Copy)) delete Copy[key];
  Object.assign(Copy, table, { locale });
  return Copy;
}

// Non-enumerable so it never shows up as a "string" to anything that walks the
// table (the copy tests call every enumerable function with placeholder args).
Object.defineProperty(Copy, 'setLocale', { value: setLocale, enumerable: false });
Object.defineProperty(Copy, 'availableLocales', { value: ['en', ...Object.keys(TRANSLATIONS)], enumerable: false });

setLocale();

module.exports = Copy;
