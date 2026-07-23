// AppModel.swift — the app's single source of truth: dependency state, the
// queue, the two work lanes (one transcription + one download, in parallel),
// update check, notifications, dock badge, and sleep suppression.
// All state mutation happens on the main thread (EngineJob and ProgressPoller
// both call back there).
import AppKit
import os
import SwiftUI
import UserNotifications

// MARK: - Queue item

enum ItemSource: Equatable {
    case file(URL)
    case link(String)

    var isLink: Bool { if case .link = self { return true } ; return false }
}

enum RowState: Equatable {
    case waiting, lookingUp, downloading, preparing, transcribing, done, failed, canceled

    var isActive: Bool {
        switch self {
        case .lookingUp, .downloading, .preparing, .transcribing: return true
        default: return false
        }
    }
    var isUnfinished: Bool { self == .waiting || isActive }
    var isFinished: Bool { self == .done || self == .failed || self == .canceled }
}

struct QueueItem: Identifiable, Equatable {
    let id = UUID()
    let source: ItemSource
    var title: String
    var state: RowState = .waiting

    // Captured at START (not enqueue) — changing quick settings mid-queue
    // affects every item that hasn't begun yet.
    var capturedModel: String?
    var capturedLanguage: String?
    var capturedKeepVideo = false
    var destFolder: URL?

    var downloadedFile: URL?       // links: set once the download lane finishes
    var startedAt: Date?           // pipeline start (drives "Done in …")
    var stageStartedAt: Date?
    var progressPct: Int?          // 0–100 for determinate bars
    var etaText: String?
    var estimator = ETAEstimator()
    var afterSleep = false         // show the post-wake status until the ETA recovers
    var errorMessage: String?
    var errorDetails: String?      // full engine stderr, for "Copy Error Details"
    var doneNote: String?          // empty-transcript note
    var copiedFlash = false        // "Transcript copied." for 2 s
    var actionNote: String?        // transient feedback when a row action can't run
    var finishedAt: Date?
    var txtURL: URL?
    var srtURL: URL?
    var retryPriority: Int?        // retried items jump the waiting line

    var isLink: Bool { source.isLink }

    /// The media file transcription will read.
    var inputFile: URL? {
        switch source {
        case .file(let u): return u
        case .link: return downloadedFile
        }
    }
}

enum AppPhase { case checking, setupNeeded, ready }

struct UpdateInfo: Equatable {
    let version: String
    let url: String?
}

// MARK: - Model

final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published var phase: AppPhase = .checking
    @Published var deps = DepProbeResult()
    @Published var items: [QueueItem] = []
    @Published var selection: UUID?
    @Published var flashID: UUID?          // duplicate-add highlight
    @Published var scrollTarget: UUID?
    @Published var updateBanner: UpdateInfo?
    @Published var focusLinkToken = 0      // incremented by Cmd+L / menu

    private var transcribingID: UUID?
    private var downloadingID: UUID?
    private var jobs: [UUID: EngineJob] = [:]
    private var pollers: [UUID: ProgressPoller] = [:]
    private var jobDirs: [UUID: URL] = [:]
    private var retryCounter = 0
    private var watchdogKilledLookup: Set<UUID> = []
    private var wasWorking = false
    private var sessionDone = 0
    private var sessionFailed = 0
    private var sessionLastTxtName: String?
    private var sessionLastFailedName: String?
    private var activityToken: NSObjectProtocol?
    private var updateCheckDone = false

    private init() {
        UserDefaults.standard.register(defaults: [
            "model": "best",
            "language": "hr",
            "keepVideo": false,
            "downloadFolder": ("~/Downloads" as NSString).expandingTildeInPath,
            "notifyOnFinish": true,
        ])
        probeDeps()

        // Setup finishes in Terminal; re-probe whenever the user clicks back.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.probeDeps() }

        // A lid-close sleep pauses whisper mid-run; the slept hours would poison
        // the ETA rate, so drop the baseline on wake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.handleWake() }
    }

    func onLaunch() {
        probeDeps()
        checkForUpdate()
    }

    // MARK: Settings (read at item START; the views bind the same keys via @AppStorage)

    var currentModel: String { UserDefaults.standard.string(forKey: "model") ?? "best" }
    var currentLanguage: String { UserDefaults.standard.string(forKey: "language") ?? "hr" }
    var keepVideo: Bool { UserDefaults.standard.bool(forKey: "keepVideo") }
    var notifyOnFinish: Bool { UserDefaults.standard.bool(forKey: "notifyOnFinish") }

    /// Falls back to ~/Downloads (and repairs the setting) if the stored folder vanished.
    var downloadFolder: URL {
        let fallback = ("~/Downloads" as NSString).expandingTildeInPath
        let stored = UserDefaults.standard.string(forKey: "downloadFolder") ?? fallback
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: stored, isDirectory: &isDir), isDir.boolValue {
            return URL(fileURLWithPath: stored)
        }
        UserDefaults.standard.set(fallback, forKey: "downloadFolder")
        return URL(fileURLWithPath: fallback)
    }

    // MARK: Dependency probing

    func probeDeps() {
        let result = DepProbeResult.probe()
        if result != deps { deps = result }
        let newPhase: AppPhase = result.setupNeeded ? .setupNeeded : .ready
        if newPhase != phase {
            phase = newPhase
            if newPhase == .ready { pump() }
        }
    }

    // MARK: Adding work

    func addFiles(_ urls: [URL]) {
        guard phase == .ready else { return }
        for raw in urls where raw.isFileURL {
            let url = raw.resolvingSymlinksInPath().standardizedFileURL
            if let dup = firstUnfinishedItem(matching: .file(url)) {
                flash(dup.id)
                continue
            }
            var item = QueueItem(source: .file(url), title: url.lastPathComponent)
            item.state = .waiting
            items.append(item)
            scrollTarget = item.id
        }
        pump()
    }

    /// Returns false when the text doesn't look like a link (the view shows the inline error).
    @discardableResult
    func addLink(_ text: String) -> Bool {
        guard phase == .ready else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard looksLikeWebLink(trimmed) else { return false }
        if let dup = firstUnfinishedItem(matching: .link(trimmed)) {
            flash(dup.id)
            return true
        }
        let display = (URL(string: trimmed).map { ($0.host ?? "") + $0.path }) ?? trimmed
        var item = QueueItem(source: .link(trimmed), title: display)
        item.state = .waiting
        items.append(item)
        scrollTarget = item.id
        pump()
        return true
    }

    private func firstUnfinishedItem(matching source: ItemSource) -> QueueItem? {
        items.first { $0.source == source && $0.state.isUnfinished }
    }

    private func flash(_ id: UUID) {
        flashID = id
        scrollTarget = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            if self?.flashID == id { self?.flashID = nil }
        }
    }

    func browseForFiles() {
        guard phase == .ready else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.audiovisualContent, .movie, .audio]
        panel.begin { [weak self] response in
            guard response == .OK else { return }
            self?.addFiles(panel.urls)
        }
    }

    func pasteFromClipboard() {
        guard let text = NSPasteboard.general.string(forType: .string) else { return }
        if looksLikeWebLink(text) { addLink(text) }
    }

    func openSetupCommand() {
        NSWorkspace.shared.open(EnginePaths.setupCommand)
    }

    // MARK: Scheduler — one transcription lane + one download lane, queue order

    private func pump() {
        defer { updateWorkSideEffects() }
        guard phase == .ready else { return }
        if transcribingID == nil, let idx = nextIndexForTranscription() {
            beginTranscription(items[idx].id)
        }
        if downloadingID == nil, let idx = nextIndexForDownload() {
            beginDownload(items[idx].id)
        }
    }

    private func eligibleIndexes(_ predicate: (QueueItem) -> Bool) -> Int? {
        // Retried items go to the front of the waiting line, oldest retry first.
        let candidates = items.indices.filter { items[$0].state == .waiting && predicate(items[$0]) }
        if let prioritized = candidates
            .filter({ items[$0].retryPriority != nil })
            .min(by: { items[$0].retryPriority! < items[$1].retryPriority! }) {
            return prioritized
        }
        return candidates.first
    }

    private func nextIndexForTranscription() -> Int? {
        eligibleIndexes { !$0.isLink || $0.downloadedFile != nil }
    }

    private func nextIndexForDownload() -> Int? {
        eligibleIndexes { $0.isLink && $0.downloadedFile == nil }
    }

    private func index(of id: UUID) -> Int? { items.firstIndex { $0.id == id } }

    // MARK: Transcription lane

    private func beginTranscription(_ id: UUID) {
        guard let i = index(of: id) else { return }
        transcribingID = id

        if items[i].capturedModel == nil {
            items[i].capturedModel = currentModel
            items[i].capturedLanguage = currentLanguage
        }
        if items[i].startedAt == nil { items[i].startedAt = Date() }
        items[i].stageStartedAt = Date()
        items[i].estimator.reset()
        items[i].etaText = nil
        items[i].progressPct = nil

        guard let input = items[i].inputFile else {
            finishItem(id, failed: Copy.failTranscription, details: nil)
            return
        }
        let fm = FileManager.default
        guard fm.fileExists(atPath: input.path) else {
            finishItem(id, failed: Copy.failFileMissing(input.lastPathComponent), details: nil)
            return
        }
        let size = (try? fm.attributesOfItem(atPath: input.path)[.size] as? Int64 ?? 0) ?? 0
        guard size > 0 else {
            finishItem(id, failed: Copy.failZeroLength(input.lastPathComponent), details: nil)
            return
        }
        guard fm.isWritableFile(atPath: input.deletingLastPathComponent().path) else {
            finishItem(id, failed: Copy.failOutputDirReadOnly(input.lastPathComponent), details: nil)
            return
        }
        let chosenModel = Models.by(items[i].capturedModel ?? "best")
        guard DepProbeResult.modelPresent(chosenModel) else {
            finishItem(id, failed: Copy.failModelMissing(chosenModel.display), details: nil)
            return
        }

        items[i].state = .preparing

        let dir = JobWorkspace.create()
        jobDirs[id] = dir
        let progressFile = dir.appendingPathComponent("progress")
        let model = items[i].capturedModel ?? "best"
        let lang = items[i].capturedLanguage ?? "hr"

        do {
            let job = try EngineJob(script: EnginePaths.transcribeScript,
                                    arguments: [model, lang, input.path],
                                    progressFile: progressFile)
            jobs[id] = job
            pollers[id] = ProgressPoller(file: progressFile) { [weak self] line in
                self?.transcriptionProgress(id, line: line)
            }
            job.onExit = { [weak self] code, out, err in
                self?.transcriptionExited(id, code: code, stdout: out, stderr: err)
            }
        } catch {
            cleanupJob(id)
            transcribingID = nil
            finishItem(id, failed: Copy.failEngineMissing, details: "\(error)")
        }
    }

    private func transcriptionProgress(_ id: UUID, line: ProgressLine) {
        guard let i = index(of: id), items[i].state == .preparing || items[i].state == .transcribing else { return }
        guard line.percent >= 1 else { return }   // 0% baseline = still extracting audio
        items[i].state = .transcribing
        items[i].progressPct = line.percent
        let eta = items[i].estimator.update(percent: Double(line.percent),
                                            at: Date().timeIntervalSinceReferenceDate)
        if eta != nil { items[i].afterSleep = false }
        items[i].etaText = eta
    }

    private func transcriptionExited(_ id: UUID, code: Int32, stdout: String, stderr: String) {
        cleanupJob(id)
        if transcribingID == id { transcribingID = nil }
        guard let i = index(of: id) else { pump(); return }
        guard items[i].state == .preparing || items[i].state == .transcribing else { pump(); return }

        let input = items[i].inputFile
        let outputs = input.map { Self.outputURLs(for: $0) }
        // Success requires exit 0 AND a transcript newer than this run — a stale
        // .txt from an earlier run must never count (the "100% in the progress
        // file" signal is equally untrustworthy).
        var succeeded = false
        if code == 0, let txt = outputs?.txt, let started = items[i].stageStartedAt {
            let mtime = (try? FileManager.default.attributesOfItem(atPath: txt.path)[.modificationDate] as? Date) ?? nil
            if let mtime = mtime, mtime >= started.addingTimeInterval(-2) { succeeded = true }
        }

        if succeeded, let outputs = outputs {
            items[i].txtURL = outputs.txt
            items[i].srtURL = outputs.srt
            items[i].finishedAt = Date()
            items[i].progressPct = 100
            let content = (try? String(contentsOf: outputs.txt, encoding: .utf8)) ?? ""
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                items[i].doneNote = Copy.noSpeechNote(items[i].title)
            }
            withAnimation { items[i].state = .done }
            sessionDone += 1
            sessionLastTxtName = outputs.txt.lastPathComponent
            pump()
        } else {
            let message = classifyTranscribeFailure(exitCode: code,
                                                    stderr: stderr,
                                                    usedModel: items[i].capturedModel ?? "best",
                                                    fileName: items[i].title)
            finishItem(id, failed: message, details: stderr.isEmpty ? stdout : stderr)
        }
    }

    static func outputURLs(for input: URL) -> (txt: URL, srt: URL) {
        // Stem from the last path component only — "videos v2.0/clip" must not
        // become "videos v2.txt" (the engine had this exact latent bug).
        let dir = input.deletingLastPathComponent()
        var stem = input.deletingPathExtension().lastPathComponent
        if stem.isEmpty { stem = input.lastPathComponent }
        return (dir.appendingPathComponent(stem + ".txt"),
                dir.appendingPathComponent(stem + ".srt"))
    }

    // MARK: Download lane

    private func beginDownload(_ id: UUID) {
        guard let i = index(of: id), case .link(let url) = items[i].source else { return }
        downloadingID = id

        items[i].capturedModel = currentModel
        items[i].capturedLanguage = currentLanguage
        items[i].capturedKeepVideo = keepVideo
        items[i].destFolder = downloadFolder
        if items[i].startedAt == nil { items[i].startedAt = Date() }
        items[i].stageStartedAt = Date()
        items[i].state = .lookingUp

        do {
            let job = try EngineJob(script: EnginePaths.downloadScript,
                                    arguments: ["info", url],
                                    progressFile: nil)
            jobs[id] = job
            job.onExit = { [weak self] code, out, err in
                self?.lookupExited(id, url: url, code: code, stdout: out, stderr: err)
            }
            // The engine timeout-guards its own metadata fetch; this watchdog only
            // covers a hung yt-dlp that never returns at all. It guards THIS job
            // instance — a later attempt's fresh lookup for the same item must
            // not be killed by a stale timer.
            let watched = jobs[id]
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self, weak watched] in
                guard let self = self, let watched = watched, self.jobs[id] === watched,
                      let i = self.index(of: id),
                      self.items[i].state == .lookingUp else { return }
                self.watchdogKilledLookup.insert(id)
                watched.cancel()
            }
        } catch {
            cleanupJob(id)
            downloadingID = nil
            finishItem(id, failed: Copy.failYtDlpMissing, details: "\(error)")
        }
    }

    private func lookupExited(_ id: UUID, url: String, code: Int32, stdout: String, stderr: String) {
        cleanupJob(id)
        let killedByWatchdog = watchdogKilledLookup.remove(id) != nil
        guard let i = index(of: id), items[i].state == .lookingUp else {
            if downloadingID == id { downloadingID = nil }
            pump()
            return
        }
        guard code == 0, let info = parseInfoLine(fromStdout: stdout) else {
            downloadingID = nil
            // A watchdog kill means the lookup hung — the SIGTERMed script's
            // stderr can't say so; report the connectivity problem directly.
            let message = killedByWatchdog
                ? Copy.failDownloadNetwork
                : classifyDownloadFailure(exitCode: code, stderr: stderr, lookupStage: true).message
            finishItem(id, failed: message, details: stderr)
            return
        }
        if let title = info.title { items[i].title = title }
        if info.isLive {
            downloadingID = nil
            finishItem(id, failed: Copy.failLivestream, details: stderr)
            return
        }
        if let count = info.playlistCount, count > 1 {
            downloadingID = nil
            finishItem(id, failed: Copy.failPlaylist(count), details: stderr)
            return
        }
        startDownloadStage(id, url: url)
    }

    private func startDownloadStage(_ id: UUID, url: String) {
        guard let i = index(of: id) else { downloadingID = nil; pump(); return }

        let dest = items[i].destFolder ?? downloadFolder
        let fm = FileManager.default
        try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dest.path, isDirectory: &isDir), isDir.boolValue,
              fm.isWritableFile(atPath: dest.path) else {
            downloadingID = nil
            finishItem(id, failed: Copy.failFolderUnwritable(fm.displayName(atPath: dest.path)), details: nil)
            return
        }

        items[i].state = .downloading
        items[i].progressPct = nil
        items[i].stageStartedAt = Date()

        let dir = JobWorkspace.create()
        jobDirs[id] = dir
        let progressFile = dir.appendingPathComponent("progress")
        let mode = items[i].capturedKeepVideo ? "video" : "audio"

        do {
            let job = try EngineJob(script: EnginePaths.downloadScript,
                                    arguments: ["get", mode, url, dest.path],
                                    progressFile: progressFile)
            jobs[id] = job
            pollers[id] = ProgressPoller(file: progressFile) { [weak self] line in
                guard let self = self, let i = self.index(of: id),
                      self.items[i].state == .downloading else { return }
                self.items[i].progressPct = line.percent
            }
            job.onExit = { [weak self] code, out, err in
                self?.downloadExited(id, code: code, stdout: out, stderr: err)
            }
        } catch {
            cleanupJob(id)
            downloadingID = nil
            finishItem(id, failed: Copy.failYtDlpMissing, details: "\(error)")
        }
    }

    private func downloadExited(_ id: UUID, code: Int32, stdout: String, stderr: String) {
        cleanupJob(id)
        if downloadingID == id { downloadingID = nil }
        guard let i = index(of: id), items[i].state == .downloading else { pump(); return }

        if code == 0, let path = parseFinalFilePath(fromStdout: stdout),
           FileManager.default.fileExists(atPath: path) {
            items[i].downloadedFile = URL(fileURLWithPath: path)
            items[i].state = .waiting     // hand over to the transcription lane
            items[i].progressPct = nil
            pump()
        } else {
            let failure = classifyDownloadFailure(exitCode: code, stderr: stderr)
            finishItem(id, failed: failure.message, details: stderr)
        }
    }

    // MARK: Shared completion / failure path

    private func finishItem(_ id: UUID, failed message: String, details: String?) {
        if transcribingID == id { transcribingID = nil }
        if downloadingID == id { downloadingID = nil }
        cleanupJob(id)
        if let i = index(of: id) {
            items[i].state = .failed
            items[i].errorMessage = message
            items[i].errorDetails = details
            items[i].finishedAt = Date()
            items[i].progressPct = nil
            items[i].etaText = nil
            sessionFailed += 1
            sessionLastFailedName = items[i].title
        }
        pump()
    }

    private func cleanupJob(_ id: UUID) {
        pollers[id]?.stop()
        pollers[id] = nil
        jobs[id] = nil
        if let dir = jobDirs[id] {
            JobWorkspace.remove(dir)
            jobDirs[id] = nil
        }
    }

    // MARK: Cancel / retry / remove

    func cancel(_ id: UUID) {
        cancel(id, pumping: true)
    }

    private func cancel(_ id: UUID, pumping: Bool) {
        guard let i = index(of: id) else { return }
        let state = items[i].state
        guard state.isUnfinished else { return }

        if state.isActive, let job = jobs[id] {
            job.cancel()
            // Downloads: sweep this run's partial files. Transcripts: remove the
            // partial .txt/.srt whisper may have half-written.
            if state == .downloading {
                removePartFiles(in: items[i].destFolder ?? downloadFolder, since: items[i].stageStartedAt)
            }
            if state == .transcribing || state == .preparing {
                removeFreshOutputs(for: items[i])
            }
        }
        if transcribingID == id { transcribingID = nil }
        if downloadingID == id { downloadingID = nil }
        cleanupJob(id)
        items[i].state = .canceled
        items[i].progressPct = nil
        items[i].etaText = nil
        if pumping { pump() }
    }

    func cancelAll() {
        // Waiting items are marked Canceled first, with no pump in between —
        // pumping after each cancel would start the next waiting item's real
        // process (or fail its pre-flight checks) only to kill it a moment
        // later. One pump at the end settles the side effects.
        for item in items where item.state == .waiting {
            cancel(item.id, pumping: false)
        }
        for item in items where item.state.isActive {
            cancel(item.id, pumping: false)
        }
        pump()
    }

    func cancelSelected() {
        guard let sel = selection, let i = index(of: sel), items[i].state.isActive else { return }
        cancel(sel)
    }

    func retry(_ id: UUID) {
        guard let i = index(of: id), items[i].state == .failed else { return }
        probeDeps()   // retry after fixing setup should see the fixed world
        retryCounter += 1
        resetForRerun(&items[i])
        items[i].retryPriority = retryCounter
        pump()
    }

    func startAgain(_ id: UUID) {
        guard let i = index(of: id), items[i].state == .canceled else { return }
        resetForRerun(&items[i])
        pump()
    }

    private func resetForRerun(_ item: inout QueueItem) {
        item.state = .waiting
        item.errorMessage = nil
        item.errorDetails = nil
        item.progressPct = nil
        item.etaText = nil
        item.estimator.reset()
        item.doneNote = nil
        item.startedAt = nil
        item.finishedAt = nil
        // Links re-run the whole pipeline; the download starts over from
        // scratch (the engine stages downloads in a temp dir it cleans on exit).
        item.downloadedFile = nil
        item.capturedModel = nil
        item.capturedLanguage = nil
    }

    func transcribeAgain(_ id: UUID) {
        guard let i = index(of: id) else { return }
        switch items[i].source {
        case .file(let url): addFiles([url])
        case .link(let url): addLink(url)
        }
    }

    func remove(_ id: UUID) {
        guard let i = index(of: id) else { return }
        if items[i].state.isActive { cancel(id) }
        if let j = index(of: id) {
            // Removing a link row gives up its resume data — sweep .part files.
            if items[j].isLink, items[j].state != .done {
                removePartFiles(in: items[j].destFolder ?? downloadFolder, since: items[j].startedAt)
            }
            items.remove(at: j)
        }
        if selection == id { selection = nil }
        pump()
    }

    func deleteSelected() {
        guard let sel = selection, let i = index(of: sel), !items[i].state.isActive else { return }
        remove(sel)
    }

    func clearDone() {
        items.removeAll { $0.state.isFinished }
        updateWorkSideEffects()
    }

    var hasFinishedRows: Bool { items.contains { $0.state.isFinished } }
    var hasUnfinishedWork: Bool { items.contains { $0.state.isUnfinished } }
    /// The spec hides "Clear Done" while the selected row is in progress.
    var selectionIsInProgress: Bool {
        guard let sel = selection, let i = index(of: sel) else { return false }
        return items[i].state.isActive
    }

    private func removePartFiles(in folder: URL, since: Date?) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: folder.path) else { return }
        let cutoff = since ?? .distantFuture
        for name in names where name.hasSuffix(".part") || name.hasSuffix(".ytdl") {
            let url = folder.appendingPathComponent(name)
            let mtime = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? nil
            if let mtime = mtime, mtime >= cutoff.addingTimeInterval(-2) {
                try? fm.removeItem(at: url)
            }
        }
    }

    private func removeFreshOutputs(for item: QueueItem) {
        guard let input = item.inputFile, let started = item.stageStartedAt else { return }
        let outputs = Self.outputURLs(for: input)
        let fm = FileManager.default
        for url in [outputs.txt, outputs.srt] {
            let mtime = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? nil
            if let mtime = mtime, mtime >= started.addingTimeInterval(-2) {
                try? fm.removeItem(at: url)
            }
        }
    }

    // MARK: Row actions

    private static let actionLog = Logger(subsystem: "com.flisko.transcribe", category: "row-actions")

    /// A row action must never fail silently: if the file it needs is gone
    /// (moved, deleted, on an ejected drive), say so in the status line.
    private func requireFile(_ url: URL?, for id: UUID) -> URL? {
        if let url = url, FileManager.default.fileExists(atPath: url.path) { return url }
        Self.actionLog.debug("action target missing: \(url?.path ?? "nil", privacy: .public)")
        showActionNote(id, Copy.fileGoneNote)
        return nil
    }

    private func showActionNote(_ id: UUID, _ note: String) {
        guard let i = index(of: id) else { return }
        items[i].actionNote = note
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, let i = self.index(of: id) else { return }
            self.items[i].actionNote = nil
        }
    }

    func openTranscript(_ id: UUID) {
        Self.actionLog.debug("openTranscript tapped")
        guard let i = index(of: id), let txt = requireFile(items[i].txtURL, for: id) else { return }
        NSWorkspace.shared.open(txt)
    }

    func openSubtitles(_ id: UUID) {
        Self.actionLog.debug("openSubtitles tapped")
        guard let i = index(of: id), let srt = requireFile(items[i].srtURL, for: id) else { return }
        NSWorkspace.shared.open(srt)
    }

    func showInFinder(_ id: UUID) {
        Self.actionLog.debug("showInFinder tapped")
        guard let i = index(of: id) else { return }
        let fm = FileManager.default
        // Prefer the transcript, fall back to the source media, then to the
        // containing folder — reveal *something* rather than doing nothing.
        for candidate in [items[i].txtURL, items[i].inputFile].compactMap({ $0 }) {
            if fm.fileExists(atPath: candidate.path) {
                NSWorkspace.shared.activateFileViewerSelecting([candidate])
                return
            }
            let folder = candidate.deletingLastPathComponent()
            if fm.fileExists(atPath: folder.path) {
                NSWorkspace.shared.activateFileViewerSelecting([folder])
                showActionNote(id, Copy.fileGoneNote)
                return
            }
        }
        showActionNote(id, Copy.fileGoneNote)
    }

    func copyTranscript(_ id: UUID) {
        Self.actionLog.debug("copyTranscript tapped")
        guard let i = index(of: id), let txt = requireFile(items[i].txtURL, for: id) else { return }
        guard let content = try? String(contentsOf: txt, encoding: .utf8) else {
            showActionNote(id, Copy.fileGoneNote)
            return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
        items[i].copiedFlash = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, let j = self.index(of: id) else { return }
            self.items[j].copiedFlash = false
        }
    }

    func copyErrorDetails(_ id: UUID) {
        guard let i = index(of: id) else { return }
        let details = [items[i].errorMessage, items[i].errorDetails]
            .compactMap { $0 }.joined(separator: "\n\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(details, forType: .string)
    }

    // MARK: Working-state side effects (badge, sleep, ALL DONE moment)

    private func updateWorkSideEffects() {
        let unfinished = items.filter { $0.state.isUnfinished }.count
        let working = unfinished > 0

        NSApp?.dockTile.badgeLabel = working ? "\(unfinished)" : nil

        if working && activityToken == nil {
            activityToken = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleSystemSleepDisabled],
                reason: "Transcribing")
        } else if !working, let token = activityToken {
            ProcessInfo.processInfo.endActivity(token)
            activityToken = nil
        }

        if working && !wasWorking {
            sessionDone = 0
            sessionFailed = 0
            sessionLastTxtName = nil
            sessionLastFailedName = nil
        }
        if !working && wasWorking {
            queueFinished()
        }
        wasWorking = working
    }

    private func queueFinished() {
        guard sessionDone + sessionFailed > 0 else { return }
        // A bare swiftc binary has no bundle identifier and UNUserNotificationCenter
        // would crash — the guard is load-bearing, not defensive fluff.
        guard Bundle.main.bundleIdentifier != nil, notifyOnFinish else { return }

        let title: String
        let body: String
        if sessionFailed == 0 && sessionDone == 1 {
            title = Copy.notifOneTitle
            body = Copy.notifOneBody(sessionLastTxtName ?? "transcript.txt")
        } else if sessionFailed == 0 {
            title = Copy.notifAllTitle
            body = Copy.notifAllBody(sessionDone)
        } else if sessionDone == 0 {
            title = Copy.notifFailedTitle
            body = Copy.notifFailedBody(sessionLastFailedName ?? "file")
        } else {
            title = Copy.notifMixedTitle
            body = Copy.notifMixedBody(done: sessionDone, failed: sessionFailed)
        }

        let center = UNUserNotificationCenter.current()
        // Permission is requested here, in context at the first completion —
        // never at launch (requestAuthorization is a no-op once determined).
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                guard !NSApp.isActive else { return }   // HIG: don't notify the frontmost app
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                center.add(UNNotificationRequest(identifier: UUID().uuidString,
                                                 content: content, trigger: nil))
            }
        }
    }

    private func handleWake() {
        for i in items.indices where items[i].state == .transcribing {
            items[i].estimator.resetBaseline()
            items[i].etaText = nil
            items[i].afterSleep = true
        }
    }

    // MARK: Footer aggregate

    var footerText: String? {
        let total = items.count
        if let tid = transcribingID, let i = index(of: tid),
           items[i].state == .transcribing || items[i].state == .preparing {
            return Copy.footerTranscribing(name: items[i].title, n: i + 1, total: total,
                                           eta: items[i].etaText)
        }
        if let did = downloadingID, let i = index(of: did) {
            return Copy.footerDownloading(title: items[i].title, n: i + 1, total: total)
        }
        if hasUnfinishedWork { return nil }
        let done = items.filter { $0.state == .done }.count
        let failed = items.filter { $0.state == .failed }.count
        guard done + failed > 0 else { return nil }
        return Copy.footerFinished(done: done, failed: failed)
    }

    // MARK: Quit

    func prepareForTermination() {
        for (id, job) in jobs {
            if let i = index(of: id) {
                if items[i].state == .transcribing || items[i].state == .preparing {
                    removeFreshOutputs(for: items[i])
                }
                // Downloads need no sweep here — the engine's exit trap
                // removes its own staging files.
            }
            EngineJob.killGroupAndWait(job.pid)
        }
        jobs.removeAll()
        for (_, dir) in jobDirs { JobWorkspace.remove(dir) }
        jobDirs.removeAll()
        try? FileManager.default.removeItem(at: JobWorkspace.base)
        if let token = activityToken {
            ProcessInfo.processInfo.endActivity(token)
            activityToken = nil
        }
    }

    // MARK: Update check

    private func checkForUpdate() {
        guard !updateCheckDone else { return }
        updateCheckDone = true
        guard let slug = Bundle.main.object(forInfoDictionaryKey: "TranscribeUpdateRepo") as? String,
              !slug.isEmpty,
              let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              let url = URL(string: "https://api.github.com/repos/\(slug)/releases/latest") else { return }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 5
        let session = URLSession(configuration: config)
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        // Silent on any failure — an update hint must never get in the way.
        session.dataTask(with: request) { data, response, _ in
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = obj["tag_name"] as? String,
                  versionIsNewer(tag, than: current) else { return }
            var clean = tag.trimmingCharacters(in: .whitespacesAndNewlines)
            if clean.lowercased().hasPrefix("v") { clean.removeFirst() }
            let html = obj["html_url"] as? String
            DispatchQueue.main.async { [weak self] in
                self?.updateBanner = UpdateInfo(version: clean, url: html)
            }
        }.resume()
    }

    func openUpdatePage() {
        if let s = updateBanner?.url, let u = URL(string: s) {
            NSWorkspace.shared.open(u)
        }
    }
}
