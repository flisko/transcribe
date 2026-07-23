// Copy.swift — every user-facing string in one place.
// Strings are verbatim from the UX spec; failure copy merges the error catalog
// (UX wording wins wherever both define a string). Keep this file free of
// AppKit/SwiftUI so the pure-logic test runner can compile it.
import Foundation

enum Copy {

    // MARK: Window / input header
    static let windowTitle = "Transcribe"
    static let dropZoneTitle = "Drop audio or video files here"
    static let dropZoneSubtitle = "MP3, MP4, MOV, M4A and most other formats"
    static let browse = "Browse…"
    static let linkPrompt = "Paste a video link — YouTube, TikTok, Instagram…"
    static let addLink = "Add"
    static let invalidLink = "That doesn't look like a link. Copy the video's address and paste it here."
    static let searchLanguages = "Search languages"
    static let autoDetect = "Auto-detect"
    static let modelMenuBest = "Best quality — most accurate, slower (recommended)"
    static let modelMenuFast = "Fast — about 4x faster, slightly less accurate"
    static let modelDisplayBest = "Best quality"
    static let modelDisplayFast = "Fast"
    static let emptyTitle = "Ready to transcribe"
    static let emptySubtitle = "Drop a file above, or paste a video link.\nEach file gets a transcript (.txt) and subtitles (.srt)."
    static let dropOverlay = "Drop to add to the queue"
    static let dropOverlaySetup = "Finish setup to start transcribing"
    static let clearDone = "Clear Done"
    static let clearDoneTooltip = "Remove finished items from the list"
    static let settingsTooltip = "Settings"
    static let addFilesMenu = "Add Files…"
    static let addLinkMenu = "Add Video Link…"
    static let cancelItemMenu = "Cancel Item"

    // MARK: Row status
    static let waiting = "Waiting…"
    static let lookingUp = "Looking up video…"
    static let downloadingUnknown = "Downloading…"
    static func downloading(_ pct: Int) -> String { "Downloading — \(pct)%" }
    static let preparing = "Preparing audio…"
    static let estimating = "estimating time…"
    static func transcribing(_ pct: Int, eta: String?) -> String {
        "Transcribing — \(pct)% · \(eta ?? estimating)"
    }
    static let continuingAfterSleep = "Continuing after sleep — updating the time estimate…"
    static let canceled = "Canceled"
    static let transcriptCopied = "Transcript copied."
    static func doneFile(_ duration: String) -> String { "Done in \(duration) · transcript saved next to the original" }
    static func doneLink(_ duration: String, folder: String) -> String { "Done in \(duration) · saved in \(folder)" }

    // MARK: Row actions
    static let open = "Open"
    static let openTranscript = "Open Transcript"
    static let openSubtitles = "Open Subtitles (.srt)"
    static let showInFinder = "Show in Finder"
    static let copyTranscript = "Copy Transcript Text"
    static let transcribeAgain = "Transcribe Again"
    static let removeFromList = "Remove from List"
    static let retry = "Retry"
    static let startAgain = "Start Again"
    static let copyErrorDetails = "Copy Error Details"
    static let cancelTooltip = "Cancel"
    static let removeTooltip = "Remove"

    // MARK: Failure reasons (UX copy — wins over the error catalog)
    static let failDownloadPrivateOrRemoved = "Couldn't download — the video may be private or removed."
    static let failDownloadNetwork = "Couldn't download — check your internet connection, then press Retry."
    static let failLookup = "Couldn't find a video at this link."
    static let failNoAudio = "This file has no audio track."
    static let failUnreadable = "Couldn't read this file — it may be damaged or not an audio/video file."
    static let failDisk = "Not enough disk space. Free up some space, then press Retry."
    static let failTranscription = "Transcription didn't finish. Press Retry — if it keeps failing, try the Best quality model."
    static let failFastModelMissing = "The Fast model isn't downloaded. Run setup.command, or switch to Best quality."
    static let failEngineMissing = "The speech engine is missing. Run setup.command, then press Retry."

    // MARK: Failure reasons (error catalog — cases the UX copy doesn't cover)
    static let failAgeRestricted = "This video is age-restricted, and the site only shows it to signed-in viewers, so Transcribe can't download it."
    static let failGeoBlocked = "This video isn't available in your country, so it can't be downloaded."
    static let failLoginRequired = "This site only shows that video to signed-in users, so it can't be downloaded directly (this is common with Instagram). If you can watch it in your browser, save the video from there and drop the file into Transcribe instead."
    static func failPlaylist(_ n: Int) -> String { "This link points to a whole playlist or channel (\(n) videos), not one video. Open the video you want, copy its own link, and paste that instead." }
    static let failLivestream = "This is a live stream, and Transcribe can't record live video. Once the stream has ended and the replay is available on the same page, paste the link again and it will work."
    static let failStaleDownloader = "The download didn't work — the video site has probably changed something on their end. This is normal and there's an easy fix: double-click setup.command (in the Transcribe folder), let it update the downloader, then press Retry."
    static let failDiskDownload = "Your Mac's disk is full, so the download stopped. Free up some space, then press Retry to download it again."
    static let failYtDlpMissing = "Downloading videos from the internet needs a small helper that isn't installed yet. Double-click setup.command (in the Transcribe folder) once to install it. You can still transcribe files that are already on this Mac."
    static let failFfmpegMissing = "A helper that reads sound from video files (ffmpeg) is missing on this Mac. Please double-click setup.command (in the Transcribe folder) to install it, then try again."
    static let failModelCorrupt = "The speech model file on this Mac looks damaged — usually this means its download was interrupted at some point. Please double-click setup.command; it will download a fresh copy for you."
    static let failBestModelMissing = "The 'Best quality' speech model isn't on this Mac. Double-click setup.command to download the missing model (this is a few-GB download)."
    static func failOutOfMemory(_ name: String) -> String { "Transcribing '\(name)' stopped because your Mac ran out of memory. Close some other apps and try again — or choose the Fast model, which needs much less memory." }
    static func failFileMissing(_ name: String) -> String { "Skipped '\(name)' — the file can't be found any more. It may have been moved, renamed, or deleted, or it's on a drive that isn't connected." }
    static func failZeroLength(_ name: String) -> String { "Skipped '\(name)' — the file is empty, so there is nothing to transcribe." }
    static func failFolderUnwritable(_ folder: String) -> String { "Transcribe can't save downloads into '\(folder)' — it may have been deleted or isn't allowed. Choose a different folder for downloads." }
    static func failOutputDirReadOnly(_ name: String) -> String { "Transcripts are saved next to the video, but the folder holding '\(name)' doesn't allow saving. Choose another folder for this transcript, or copy the video to your Mac first." }
    static func noSpeechNote(_ name: String) -> String { "Finished '\(name)', but no speech was found — the transcript is empty. If you expected words here, check that the video's sound is audible and the right language was chosen." }

    // MARK: Footer
    static func footerTranscribing(name: String, n: Int, total: Int, eta: String?) -> String {
        var s = "Transcribing \"\(name)\" — \(n) of \(total)"
        if let eta = eta { s += " · \(eta)" }
        return s
    }
    static func footerDownloading(title: String, n: Int, total: Int) -> String {
        "Downloading \"\(title)\" — \(n) of \(total)"
    }
    static func footerFinished(done: Int, failed: Int) -> String {
        if failed == 0 {
            return done == 1 ? "All done — transcript ready" : "All done — \(done) transcripts ready"
        }
        return "Finished — \(done) done, \(failed) failed"
    }
    static let cancelAll = "Cancel All"

    // MARK: Setup state
    static let setupTitle = "One-time setup"
    static let setupIntro = "Transcribe needs a few free components before it can start. Everything runs on your Mac — nothing is uploaded."
    static let setupWhisper = "Speech recognition (whisper)"
    static let setupFfmpeg = "Audio converter (ffmpeg)"
    static let setupModels = "Language models (4.6 GB download)"
    static let setupYtDlp = "Link downloader (yt-dlp) — optional, only needed for video links"
    static let installed = "Installed"
    static let notInstalled = "Not installed"
    static let runSetup = "Run Setup…"
    static let checkAgain = "Check Again"
    static let setupFootnote = "Setup opens the Terminal and takes a few minutes, mostly downloading. It's safe to run more than once."
    static let engineMissing = "Transcribe can't find its engine. Keep Transcribe.app inside the Transcribe folder, next to \"bin\" and \"models\", then click Check Again."
    static let linksLimitedPrompt = "Video links need one more component"
    static let linksLimitedInstall = "Install…"
    static let linksLimitedCaption = "Everything else works — this only affects video links."

    // MARK: Dialogs & notifications
    static let quitTitle = "Quit Transcribe?"
    static let quitMessage = "Work is still in progress. Quitting now will stop the current item — anything unfinished will be canceled."
    static let quitKeepWorking = "Keep Working"
    static let quitAnyway = "Quit Anyway"
    static let notifOneTitle = "Transcript ready"
    static func notifOneBody(_ txtName: String) -> String { "\"\(txtName)\" was saved next to your video." }
    static let notifAllTitle = "All transcriptions finished"
    static func notifAllBody(_ n: Int) -> String { "\(n) transcripts are ready." }
    static let notifMixedTitle = "Transcriptions finished"
    static func notifMixedBody(done: Int, failed: Int) -> String { "\(done) done, \(failed) failed. Open Transcribe for details." }
    static let notifFailedTitle = "Transcription failed"
    static func notifFailedBody(_ name: String) -> String { "\"\(name)\" couldn't be transcribed. Open Transcribe for details." }

    // MARK: Settings pane
    static let settingsSectionTranscription = "Transcription"
    static let settingsModel = "Model"
    static let settingsBestCaption = "Most accurate for Croatian, Slovenian, and other smaller languages. Slower. Recommended."
    static let settingsFastCaption = "About 4x faster. Slightly less accurate, mainly on smaller languages."
    static let settingsModelMissingTooltip = "This model isn't downloaded — run setup.command."
    static let settingsLanguage = "Language"
    static let settingsLanguageHelp = "The language spoken in your files. Choose Auto-detect if it varies or you're not sure."
    static let settingsSectionLinks = "Video links"
    static let settingsKeepVideo = "Keep the downloaded video file"
    static let settingsKeepVideoCaption = "When off, only the audio is downloaded — faster and smaller. Your transcript is saved either way."
    static let settingsDownloadFolder = "Save downloads to"
    static let settingsChooseFolder = "Choose…"
    static let settingsSectionNotifications = "Notifications"
    static let settingsNotify = "Notify me when the queue finishes"

    // MARK: Update banner
    static func updateAvailable(_ version: String) -> String { "Version \(version) is available." }
    static let updateDownload = "Download"

    // MARK: Shared helpers
    /// "under a minute" / "12 min" / "1 hr 20 min" — used by "Done in …" status lines.
    static func durationPhrase(_ seconds: TimeInterval) -> String {
        if seconds < 60 { return "under a minute" }
        let m = max(1, Int((seconds / 60).rounded()))
        if m < 60 { return "\(m) min" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h) hr" : "\(h) hr \(r) min"
    }
}
