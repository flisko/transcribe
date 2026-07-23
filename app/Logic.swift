// Logic.swift — pure, Foundation-only logic: language list, ETA smoothing,
// version comparison, progress/engine-output parsing, and failure
// classification. No AppKit/SwiftUI here so the test runner can compile it.
import Foundation

// MARK: - Whisper languages

struct WhisperLanguage: Identifiable, Equatable {
    let code: String
    let name: String
    var id: String { code }
}

enum Languages {
    static let auto = WhisperLanguage(code: "auto", name: "Auto-detect")

    /// The 99 languages whisper.cpp knows, in whisper's own order (from whisper_languages.tsv).
    static let all: [WhisperLanguage] = [
        WhisperLanguage(code: "en", name: "English"),
        WhisperLanguage(code: "zh", name: "Chinese"),
        WhisperLanguage(code: "de", name: "German"),
        WhisperLanguage(code: "es", name: "Spanish"),
        WhisperLanguage(code: "ru", name: "Russian"),
        WhisperLanguage(code: "ko", name: "Korean"),
        WhisperLanguage(code: "fr", name: "French"),
        WhisperLanguage(code: "ja", name: "Japanese"),
        WhisperLanguage(code: "pt", name: "Portuguese"),
        WhisperLanguage(code: "tr", name: "Turkish"),
        WhisperLanguage(code: "pl", name: "Polish"),
        WhisperLanguage(code: "ca", name: "Catalan"),
        WhisperLanguage(code: "nl", name: "Dutch"),
        WhisperLanguage(code: "ar", name: "Arabic"),
        WhisperLanguage(code: "sv", name: "Swedish"),
        WhisperLanguage(code: "it", name: "Italian"),
        WhisperLanguage(code: "id", name: "Indonesian"),
        WhisperLanguage(code: "hi", name: "Hindi"),
        WhisperLanguage(code: "fi", name: "Finnish"),
        WhisperLanguage(code: "vi", name: "Vietnamese"),
        WhisperLanguage(code: "he", name: "Hebrew"),
        WhisperLanguage(code: "uk", name: "Ukrainian"),
        WhisperLanguage(code: "el", name: "Greek"),
        WhisperLanguage(code: "ms", name: "Malay"),
        WhisperLanguage(code: "cs", name: "Czech"),
        WhisperLanguage(code: "ro", name: "Romanian"),
        WhisperLanguage(code: "da", name: "Danish"),
        WhisperLanguage(code: "hu", name: "Hungarian"),
        WhisperLanguage(code: "ta", name: "Tamil"),
        WhisperLanguage(code: "no", name: "Norwegian"),
        WhisperLanguage(code: "th", name: "Thai"),
        WhisperLanguage(code: "ur", name: "Urdu"),
        WhisperLanguage(code: "hr", name: "Croatian"),
        WhisperLanguage(code: "bg", name: "Bulgarian"),
        WhisperLanguage(code: "lt", name: "Lithuanian"),
        WhisperLanguage(code: "la", name: "Latin"),
        WhisperLanguage(code: "mi", name: "Maori"),
        WhisperLanguage(code: "ml", name: "Malayalam"),
        WhisperLanguage(code: "cy", name: "Welsh"),
        WhisperLanguage(code: "sk", name: "Slovak"),
        WhisperLanguage(code: "te", name: "Telugu"),
        WhisperLanguage(code: "fa", name: "Persian"),
        WhisperLanguage(code: "lv", name: "Latvian"),
        WhisperLanguage(code: "bn", name: "Bengali"),
        WhisperLanguage(code: "sr", name: "Serbian"),
        WhisperLanguage(code: "az", name: "Azerbaijani"),
        WhisperLanguage(code: "sl", name: "Slovenian"),
        WhisperLanguage(code: "kn", name: "Kannada"),
        WhisperLanguage(code: "et", name: "Estonian"),
        WhisperLanguage(code: "mk", name: "Macedonian"),
        WhisperLanguage(code: "br", name: "Breton"),
        WhisperLanguage(code: "eu", name: "Basque"),
        WhisperLanguage(code: "is", name: "Icelandic"),
        WhisperLanguage(code: "hy", name: "Armenian"),
        WhisperLanguage(code: "ne", name: "Nepali"),
        WhisperLanguage(code: "mn", name: "Mongolian"),
        WhisperLanguage(code: "bs", name: "Bosnian"),
        WhisperLanguage(code: "kk", name: "Kazakh"),
        WhisperLanguage(code: "sq", name: "Albanian"),
        WhisperLanguage(code: "sw", name: "Swahili"),
        WhisperLanguage(code: "gl", name: "Galician"),
        WhisperLanguage(code: "mr", name: "Marathi"),
        WhisperLanguage(code: "pa", name: "Punjabi"),
        WhisperLanguage(code: "si", name: "Sinhala"),
        WhisperLanguage(code: "km", name: "Khmer"),
        WhisperLanguage(code: "sn", name: "Shona"),
        WhisperLanguage(code: "yo", name: "Yoruba"),
        WhisperLanguage(code: "so", name: "Somali"),
        WhisperLanguage(code: "af", name: "Afrikaans"),
        WhisperLanguage(code: "oc", name: "Occitan"),
        WhisperLanguage(code: "ka", name: "Georgian"),
        WhisperLanguage(code: "be", name: "Belarusian"),
        WhisperLanguage(code: "tg", name: "Tajik"),
        WhisperLanguage(code: "sd", name: "Sindhi"),
        WhisperLanguage(code: "gu", name: "Gujarati"),
        WhisperLanguage(code: "am", name: "Amharic"),
        WhisperLanguage(code: "yi", name: "Yiddish"),
        WhisperLanguage(code: "uz", name: "Uzbek"),
        WhisperLanguage(code: "fo", name: "Faroese"),
        WhisperLanguage(code: "ht", name: "Haitian Creole"),
        WhisperLanguage(code: "ps", name: "Pashto"),
        WhisperLanguage(code: "tk", name: "Turkmen"),
        WhisperLanguage(code: "nn", name: "Nynorsk"),
        WhisperLanguage(code: "mt", name: "Maltese"),
        WhisperLanguage(code: "sa", name: "Sanskrit"),
        WhisperLanguage(code: "lb", name: "Luxembourgish"),
        WhisperLanguage(code: "my", name: "Myanmar"),
        WhisperLanguage(code: "bo", name: "Tibetan"),
        WhisperLanguage(code: "tl", name: "Tagalog"),
        WhisperLanguage(code: "mg", name: "Malagasy"),
        WhisperLanguage(code: "as", name: "Assamese"),
        WhisperLanguage(code: "tt", name: "Tatar"),
        WhisperLanguage(code: "haw", name: "Hawaiian"),
        WhisperLanguage(code: "ln", name: "Lingala"),
        WhisperLanguage(code: "ha", name: "Hausa"),
        WhisperLanguage(code: "ba", name: "Bashkir"),
        WhisperLanguage(code: "jw", name: "Javanese"),
        WhisperLanguage(code: "su", name: "Sundanese"),
        WhisperLanguage(code: "yue", name: "Cantonese"),
    ]

    /// Display order: Auto-detect, then pinned Croatian + Slovenian, then the rest A–Z by English name.
    static let displayOrder: [WhisperLanguage] = {
        let pinnedCodes = ["hr", "sl"]
        let pinned = pinnedCodes.compactMap { c in all.first { $0.code == c } }
        let rest = all.filter { !pinnedCodes.contains($0.code) }.sorted { $0.name < $1.name }
        return [auto] + pinned + rest
    }()

    /// Search matches the English name (contains) or the code (prefix).
    static func filtered(_ query: String) -> [WhisperLanguage] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return displayOrder }
        return displayOrder.filter {
            $0.name.lowercased().contains(q) || $0.code.lowercased().hasPrefix(q)
        }
    }

    static func name(for code: String) -> String {
        if code == auto.code { return auto.name }
        return all.first { $0.code == code }?.name ?? code
    }

    static func isValid(_ code: String) -> Bool {
        code == auto.code || all.contains { $0.code == code }
    }
}

// MARK: - ETA estimation

/// Exponentially-smoothed percent-per-second rate with coarse, monotone display:
/// the shown estimate never jumps upward by more than one bucket per refresh
/// (an ETA that thrashes reads as broken).
struct ETAEstimator: Equatable {
    private var lastPercent: Double?
    private var lastTime: TimeInterval?
    private var rate: Double?        // smoothed percent/second
    private var lastBucket: Int?
    private var samples = 0

    /// Coarse minute ladder; 0 means "less than a minute left".
    static let bucketsMinutes: [Int] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30,
                                        40, 50, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720]

    mutating func reset() { self = ETAEstimator() }

    /// After the Mac wakes from sleep: drop the rate baseline (elapsed sleep time would
    /// poison it) but keep the displayed bucket so the estimate stays monotone.
    mutating func resetBaseline() {
        lastPercent = nil
        lastTime = nil
        rate = nil
        samples = 0
    }

    /// Feed a progress reading. Returns display text, or nil while still estimating.
    mutating func update(percent: Double, at now: TimeInterval) -> String? {
        guard percent > 0 else { return nil }
        if let lp = lastPercent, let lt = lastTime {
            // Only a percent *change* carries rate information; repeated polls of the
            // same value would make the eventual jump look instantaneous.
            if percent > lp, now > lt {
                let instant = (percent - lp) / (now - lt)
                rate = rate.map { 0.7 * $0 + 0.3 * instant } ?? instant
                samples += 1
                lastPercent = percent
                lastTime = now
            }
        } else {
            lastPercent = percent
            lastTime = now
        }
        guard let r = rate, r > 0, samples >= 2 else { return lastBucket.map { Self.label(bucketIndex: $0) } }
        let secondsLeft = (100.0 - percent) / r
        let target = Self.bucketIndex(forSeconds: secondsLeft)
        let display: Int
        if let lb = lastBucket, target > lb + 1 {
            display = lb + 1   // never jump up more than one step per refresh
        } else {
            display = target
        }
        lastBucket = display
        return Self.label(bucketIndex: display)
    }

    static func bucketIndex(forSeconds s: Double) -> Int {
        if s < 60 { return 0 }
        let m = Int((s / 60).rounded(.up))
        for (i, b) in bucketsMinutes.enumerated() where b >= m { return i }
        return bucketsMinutes.count - 1
    }

    static func label(bucketIndex i: Int) -> String {
        let m = bucketsMinutes[max(0, min(i, bucketsMinutes.count - 1))]
        if m == 0 { return "less than a minute left" }
        if m <= 90 { return "about \(m) min left" }
        let h = m / 60, r = m % 60
        return r == 0 ? "about \(h) hr left" : "about \(h) hr \(r) min left"
    }
}

// MARK: - Version comparison (update check)

/// Numeric component-wise compare; tolerates a leading "v" and stray non-digits.
func versionIsNewer(_ remote: String, than local: String) -> Bool {
    func components(_ s: String) -> [Int] {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.lowercased().hasPrefix("v") { t.removeFirst() }
        return t.split(separator: ".").map { Int($0.filter { $0.isNumber }) ?? 0 }
    }
    let r = components(remote), l = components(local)
    for i in 0..<max(r.count, l.count) {
        let a = i < r.count ? r[i] : 0
        let b = i < l.count ? l[i] : 0
        if a != b { return a > b }
    }
    return false
}

// MARK: - Engine protocol parsing

struct ProgressLine: Equatable {
    let percent: Int
    let index: Int
    let total: Int
    let name: String
}

/// PCT\tINDEX\tTOTAL\tNAME — split on the first three tabs only (the name may
/// contain anything the engine failed to sanitize), clamp percent to 0–100.
func parseProgressLine(_ raw: String) -> ProgressLine? {
    let line = raw.split(separator: "\n", omittingEmptySubsequences: true).last.map(String.init) ?? raw
    let parts = line.split(separator: "\t", maxSplits: 3, omittingEmptySubsequences: false)
    guard parts.count >= 3,
          let p = Int(parts[0].trimmingCharacters(in: .whitespaces)) else { return nil }
    let pct = min(100, max(0, p))
    let idx = Int(parts[1]) ?? 1
    let tot = max(1, Int(parts[2]) ?? 1)
    let name = parts.count > 3 ? String(parts[3]) : ""
    return ProgressLine(percent: pct, index: idx, total: tot, name: name)
}

/// bin/download's success contract: the LAST stdout line is FILE\t<absolute path>.
func parseFinalFilePath(fromStdout stdout: String) -> String? {
    let lines = stdout.split(separator: "\n").map(String.init)
    for line in lines.reversed() where line.hasPrefix("FILE\t") {
        let path = String(line.dropFirst("FILE\t".count)).trimmingCharacters(in: .whitespaces)
        return path.isEmpty ? nil : path
    }
    return nil
}

struct LinkInfo: Equatable {
    var title: String?
    var durationSeconds: Int?
    var isLive = false
    var playlistCount: Int?
}

/// bin/download info contract: TITLE\t<title>\t<duration_s>\t<is_live>\t<playlist_count>, NA where unknown.
func parseInfoLine(fromStdout stdout: String) -> LinkInfo? {
    for raw in stdout.split(separator: "\n").map(String.init) where raw.hasPrefix("TITLE\t") {
        let parts = raw.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        var info = LinkInfo()
        func field(_ i: Int) -> String? {
            guard i < parts.count else { return nil }
            let v = parts[i].trimmingCharacters(in: .whitespaces)
            return (v.isEmpty || v == "NA") ? nil : v
        }
        info.title = field(1)
        info.durationSeconds = field(2).flatMap { Double($0) }.flatMap { $0 >= 0 ? Int($0) : nil }
        info.isLive = (field(3)?.lowercased() == "true")
        info.playlistCount = field(4).flatMap { Int($0) }
        return info
    }
    return nil
}

// MARK: - Link validation

func looksLikeWebLink(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let u = URL(string: t), let scheme = u.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = u.host, host.contains(".") else { return false }
    return true
}

// MARK: - Download failure classification (yt-dlp stderr patterns)

struct DownloadFailure: Equatable {
    let message: String
    /// Staleness → the app should suggest re-running setup (already baked into the message).
    let stale: Bool
}

/// Pattern-match bin/download's captured stderr. Order matters: specific
/// refusals first (geo before removed — YouTube's geo message contains
/// "Video unavailable"; age before the generic bot-check "Sign in").
func classifyDownloadFailure(exitCode: Int32, stderr: String, lookupStage: Bool = false) -> DownloadFailure {
    let s = stderr.lowercased()
    func has(_ patterns: [String]) -> Bool { patterns.contains { s.contains($0) } }

    if exitCode == 3 {
        return DownloadFailure(message: Copy.failYtDlpMissing, stale: false)
    }
    if has(["no space left on device"]) {
        return DownloadFailure(message: Copy.failDiskDownload, stale: false)
    }
    if has(["confirm your age", "age-restricted", "age restricted"]) {
        return DownloadFailure(message: Copy.failAgeRestricted, stale: false)
    }
    if has(["private video", "video is private", "been granted access"]) {
        return DownloadFailure(message: Copy.failDownloadPrivateOrRemoved, stale: false)
    }
    // "available in your country" also covers YouTube's phrasing
    // "The uploader has not made this video available in your country".
    if has(["available in your country", "available in your location", "geo restriction", "geo-restricted"]) {
        return DownloadFailure(message: Copy.failGeoBlocked, stale: false)
    }
    if has(["video unavailable", "has been removed", "has been terminated",
            "account associated with this video", "http error 404", "404 not found"]) {
        return DownloadFailure(message: Copy.failDownloadPrivateOrRemoved, stale: false)
    }
    if has(["login required", "rate-limit reached", "you need to log in",
            "login to access", "log in for access", "requested content is not available"]) {
        return DownloadFailure(message: Copy.failLoginRequired, stale: false)
    }
    if has(["this live event will begin", "premieres in"]) {
        return DownloadFailure(message: Copy.failLivestream, stale: false)
    }
    // Real network errors outrank the stale-downloader heuristics below —
    // yt-dlp prints benign nsig/extraction WARNINGs even when the actual
    // failure is a dropped connection. "took too long" is bin/download's own
    // lookup-watchdog phrasing.
    if has(["unable to download webpage", "unable to download api page", "failed to resolve",
            "nodename nor servname", "getaddrinfo", "network is unreachable", "[errno 8]",
            "timed out", "timeout", "took too long", "connection refused", "connection reset",
            "temporary failure in name resolution", "no route to host", "network is down"]) {
        return DownloadFailure(message: Copy.failDownloadNetwork, stale: false)
    }
    // Stale-downloader patterns are warning-shaped: they occur on healthy runs
    // too, so only ERROR: lines may decide this classification.
    let errorLines = s.split(separator: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { $0.hasPrefix("error:") }
        .joined(separator: "\n")
    if ["some formats may be missing", "challenge solving failed", "nsig",
        "confirm you're not a bot", "confirm you are not a bot", "unable to extract",
        "failed to parse json", "please report this issue",
        "confirm you are on the latest version", "http error 403"]
        .contains(where: { errorLines.contains($0) }) {
        return DownloadFailure(message: Copy.failStaleDownloader, stale: true)
    }
    if has(["is not a valid url", "unsupported url"]) {
        return DownloadFailure(message: Copy.failLookup, stale: false)
    }
    return DownloadFailure(message: lookupStage ? Copy.failLookup : Copy.failDownloadPrivateOrRemoved,
                           stale: false)
}

// MARK: - Transcription failure classification (bin/transcribe exit codes + stderr)

/// bin/transcribe contract: 0 = ok, 1 = ran but the file failed, 2 = usage, 3 = dependency missing.
func classifyTranscribeFailure(exitCode: Int32, stderr: String, usedModel: String, fileName: String) -> String {
    let s = stderr.lowercased()
    func has(_ patterns: [String]) -> Bool { patterns.contains { s.contains($0) } }

    if exitCode == 3 {
        if has(["ffmpeg"]) { return Copy.failFfmpegMissing }
        if has(["model"]) {
            return usedModel == "fast" ? Copy.failFastModelMissing : Copy.failBestModelMissing
        }
        return Copy.failEngineMissing
    }
    if has(["no space left on device"]) { return Copy.failDisk }
    if has(["out of memory", "failed to allocate", "ggml_aligned_malloc"]) {
        return Copy.failOutOfMemory(fileName)
    }
    if has(["failed to load model", "invalid model"]) { return Copy.failModelCorrupt }
    if has(["no sound track", "no audio track", "does not contain any stream"]) { return Copy.failNoAudio }
    if has(["not a file", "no such file"]) { return Copy.failFileMissing(fileName) }
    if has(["could not read audio", "invalid data found", "moov atom"]) { return Copy.failUnreadable }
    return Copy.failTranscription
}
