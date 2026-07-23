// Engine.swift — everything that touches the engine scripts: path discovery,
// dependency probing, child-process management, and progress-file polling.
//
// Process-group contract (pinned): every engine run gets its OWN process group
// so cancel can kill the whole tree (bash → ffmpeg/whisper-cli/yt-dlp) at once.
// Foundation's Process cannot set a process group, so children are spawned with
// posix_spawn + POSIX_SPAWN_SETPGROUP(0): the child becomes its own group
// leader (pgid == pid), and kill(-pid, SIGTERM) reaches every descendant.
import Foundation

// MARK: - Engine location

enum EnginePaths {
    /// The Transcribe folder: the app bundle's parent. The whole product is
    /// portable — the folder can be moved/renamed and this still resolves.
    static var root: URL { Bundle.main.bundleURL.deletingLastPathComponent() }
    static var transcribeScript: URL { root.appendingPathComponent("bin/transcribe") }
    static var downloadScript: URL { root.appendingPathComponent("bin/download") }
    static var setupCommand: URL { root.appendingPathComponent("setup.command") }
    static var bestModel: URL { root.appendingPathComponent("models/ggml-large-v3.bin") }
    static var fastModel: URL { root.appendingPathComponent("models/ggml-large-v3-turbo.bin") }

    /// GUI apps don't inherit the shell profile, so Homebrew's directories must
    /// be probed explicitly on top of whatever PATH launchd gave us.
    static let extraPathDirs = ["/opt/homebrew/bin", "/usr/local/bin"]

    static func which(_ name: String) -> String? {
        let fm = FileManager.default
        var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":").map(String.init)
        for d in extraPathDirs where !dirs.contains(d) { dirs.append(d) }
        for d in dirs {
            let candidate = (d as NSString).appendingPathComponent(name)
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// PATH value passed to every engine child (engine scripts also export this
    /// themselves; belt and braces for anything they exec).
    static var childPATH: String {
        var dirs = extraPathDirs
        let base = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        for d in base.split(separator: ":").map(String.init) where !dirs.contains(d) { dirs.append(d) }
        return dirs.joined(separator: ":")
    }
}

// MARK: - Dependency probe

struct DepProbeResult: Equatable {
    var engineScriptPresent = false   // bin/transcribe exists at all (folder integrity)
    var engineScriptOK = false        // …and is runnable
    var downloadScriptOK = false
    var whisperOK = false
    var ffmpegOK = false
    var ytDlpOK = false
    var bestModelOK = false
    var fastModelOK = false

    var setupNeeded: Bool { !engineScriptOK || !whisperOK || !ffmpegOK || !bestModelOK }
    /// Files work but video links don't (yt-dlp or bin/download missing).
    var linksLimited: Bool { !(ytDlpOK && downloadScriptOK) }
    var modelsOK: Bool { bestModelOK && fastModelOK }

    static func probe() -> DepProbeResult {
        let fm = FileManager.default
        var r = DepProbeResult()

        // Executable-bit / quarantine self-heal: zip/AirDrop transfers strip
        // permissions on our own files — repair silently before giving up.
        func runnable(_ url: URL) -> Bool {
            guard fm.fileExists(atPath: url.path) else { return false }
            if !fm.isExecutableFile(atPath: url.path) {
                chmod(url.path, 0o755)
                removexattr(url.path, "com.apple.quarantine", 0)
            }
            return fm.isExecutableFile(atPath: url.path)
        }
        r.engineScriptPresent = fm.fileExists(atPath: EnginePaths.transcribeScript.path)
        r.engineScriptOK = runnable(EnginePaths.transcribeScript)
        r.downloadScriptOK = runnable(EnginePaths.downloadScript)
        r.whisperOK = EnginePaths.which("whisper-cli") != nil || EnginePaths.which("whisper-cpp") != nil
        r.ffmpegOK = EnginePaths.which("ffmpeg") != nil
        r.ytDlpOK = EnginePaths.which("yt-dlp") != nil

        // Size sanity, not just existence: an interrupted download leaves a
        // truncated model that whisper rejects at load time.
        func fileSize(_ url: URL) -> Int64 {
            (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int64 ?? 0) ?? 0
        }
        r.bestModelOK = fileSize(EnginePaths.bestModel) > 2_500_000_000
        r.fastModelOK = fileSize(EnginePaths.fastModel) > 1_200_000_000
        return r
    }
}

// MARK: - Engine child process

/// One engine run: /bin/bash <script> <args…> in its own process group, with
/// stdout/stderr captured and an exit callback on the main queue.
final class EngineJob {
    let pid: pid_t
    private let lock = NSLock()
    private var stdoutData = Data()
    private var stderrData = Data()
    private let group = DispatchGroup()
    private var exitStatus: Int32 = -1
    private(set) var finished = false

    /// Called exactly once on the main queue: (exitCode, stdout, stderr).
    /// Exit code is 128+signal for signal deaths.
    var onExit: ((Int32, String, String) -> Void)?

    enum SpawnError: Error { case posixSpawn(Int32), pipe }

    init(script: URL, arguments: [String], progressFile: URL?) throws {
        var outFds: [Int32] = [-1, -1]
        var errFds: [Int32] = [-1, -1]
        guard pipe(&outFds) == 0 else { throw SpawnError.pipe }
        guard pipe(&errFds) == 0 else {
            close(outFds[0]); close(outFds[1])
            throw SpawnError.pipe
        }
        // CLOEXEC on all four parent fds; the dup2 file actions below produce
        // fresh (non-cloexec) fds 1/2 in the child, so nothing leaks.
        for fd in [outFds[0], outFds[1], errFds[0], errFds[1]] { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }

        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        posix_spawn_file_actions_adddup2(&fileActions, outFds[1], 1)
        posix_spawn_file_actions_adddup2(&fileActions, errFds[1], 2)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attr, 0)   // 0 → child becomes its own group leader

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = EnginePaths.childPATH
        if let pf = progressFile { env["TRANSCRIBE_PROGRESS_FILE"] = pf.path }

        let argv = ["/bin/bash", script.path] + arguments
        var cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        cArgs.append(nil)
        var cEnv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
        cEnv.append(nil)

        var childPid: pid_t = 0
        let rc = posix_spawn(&childPid, "/bin/bash", &fileActions, &attr, cArgs, cEnv)

        posix_spawn_file_actions_destroy(&fileActions)
        posix_spawnattr_destroy(&attr)
        for p in cArgs { free(p) }
        for p in cEnv { free(p) }
        close(outFds[1])
        close(errFds[1])

        guard rc == 0 else {
            close(outFds[0]); close(errFds[0])
            throw SpawnError.posixSpawn(rc)
        }
        pid = childPid

        startReader(fd: outFds[0], isStdout: true)
        startReader(fd: errFds[0], isStdout: false)
        startWaiter()

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            self.finished = true
            let out = String(data: self.stdoutData, encoding: .utf8) ?? ""
            let err = String(data: self.stderrData, encoding: .utf8) ?? ""
            self.onExit?(self.exitStatus, out, err)
        }
    }

    private func startReader(fd: Int32, isStdout: Bool) {
        group.enter()
        // Capture the group strongly: leave() must be unconditional. Reaching it
        // through weak self would skip the leave once the job is deallocated
        // (e.g. on cancel), leaking the group and its pending notify forever.
        let group = self.group
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buf = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = read(fd, &buf, buf.count)
                if n > 0 {
                    guard let self = self else { break }
                    self.lock.lock()
                    if isStdout { self.stdoutData.append(contentsOf: buf[0..<n]) }
                    else { self.stderrData.append(contentsOf: buf[0..<n]) }
                    self.lock.unlock()
                } else if n == 0 {
                    break
                } else if errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            close(fd)
            group.leave()
        }
    }

    private func startWaiter() {
        group.enter()
        let p = pid
        let group = self.group   // unconditional leave — see startReader
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var status: Int32 = 0
            while waitpid(p, &status, 0) == -1 && errno == EINTR {}
            // WIFEXITED/WEXITSTATUS are C macros unavailable in Swift — decode by hand.
            let sig = status & 0x7f
            self?.exitStatus = (sig == 0) ? (status >> 8) & 0xff : 128 + sig
            group.leave()
        }
    }

    /// SIGTERM the whole process group; SIGKILL any survivor after 3 s.
    /// kill(-pid, 0) succeeds while ANY member of the group is still alive,
    /// so grandchildren that outlive the script leader are still caught.
    func cancel() {
        guard !finished else { return }
        EngineJob.killGroup(pid)
    }

    static func killGroup(_ pgid: pid_t) {
        kill(-pgid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            if kill(-pgid, 0) == 0 { kill(-pgid, SIGKILL) }
        }
    }

    /// Synchronous variant for app termination: TERM, bounded wait, then KILL.
    static func killGroupAndWait(_ pgid: pid_t, timeout: TimeInterval = 3.0) {
        kill(-pgid, SIGTERM)
        let deadline = Date().addingTimeInterval(timeout)
        while kill(-pgid, 0) == 0 && Date() < deadline {
            usleep(100_000)
        }
        if kill(-pgid, 0) == 0 { kill(-pgid, SIGKILL) }
    }
}

// MARK: - Progress polling

/// Polls the engine's progress file (~0.3 s, per the tab-separated protocol)
/// and reports parsed lines on the main run loop.
final class ProgressPoller {
    private var timer: Timer?

    init(file: URL, onUpdate: @escaping (ProgressLine) -> Void) {
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
            guard let text = try? String(contentsOf: file, encoding: .utf8),
                  let line = parseProgressLine(text) else { return }
            onUpdate(line)
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    deinit { stop() }
}

// MARK: - Per-job scratch directory

/// Each job gets a private directory for its progress file (never shared — two
/// engines writing one progress file would interleave staging renames).
enum JobWorkspace {
    static var base: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("com.flisko.transcribe", isDirectory: true)
    }

    static func create() -> URL {
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func remove(_ dir: URL) {
        try? FileManager.default.removeItem(at: dir)
    }
}
