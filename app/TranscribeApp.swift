// TranscribeApp.swift — app entry point: scenes, menu commands, and the
// AppDelegate that owns dock drops, guarded quit, and window-reopen behavior.
import SwiftUI
import AppKit

@main
struct TranscribeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // Window (not WindowGroup): Cmd+N must not spawn duplicate queues.
        // Cmd+0 (on the Window menu item) reopens/focuses the hidden window.
        Window(Copy.windowTitle, id: "main") {
            ContentView()
        }
        .keyboardShortcut("0", modifiers: .command)
        .defaultSize(width: 560, height: 640)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button(Copy.addFilesMenu) { AppModel.shared.browseForFiles() }
                    .keyboardShortcut("o", modifiers: .command)
                Button(Copy.addLinkMenu) { AppModel.shared.focusLinkToken += 1 }
                    .keyboardShortcut("l", modifiers: .command)
            }
            CommandGroup(after: .pasteboard) {
                Divider()
                Button(Copy.cancelItemMenu) { AppModel.shared.cancelSelected() }
                    .keyboardShortcut(".", modifiers: .command)
            }
        }

        Settings {
            SettingsView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppModel.shared.onLaunch()
    }

    // Dock-icon drops and "Open With" arrive here (document types are declared
    // in Info.plist by build_app.sh). Handles web URLs too, for completeness.
    func application(_ application: NSApplication, open urls: [URL]) {
        let files = urls.filter { $0.isFileURL }
        if !files.isEmpty { AppModel.shared.addFiles(files) }
        for url in urls where !url.isFileURL {
            if looksLikeWebLink(url.absoluteString) {
                AppModel.shared.addLink(url.absoluteString)
            }
        }
    }

    // Closing the window hides it; the app keeps working in the background.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // Dock click / Cmd+Tab back: bring the (possibly closed) window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for window in sender.windows {
                window.makeKeyAndOrderFront(nil)
            }
        }
        return true
    }

    // Guarded quit: work in progress deserves one honest question. On confirmed
    // quit every child process GROUP is killed and temp files are removed — no
    // orphan whisper/ffmpeg/yt-dlp may survive.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let model = AppModel.shared
        guard model.hasUnfinishedWork else {
            model.prepareForTermination()
            return .terminateNow
        }
        let alert = NSAlert()
        alert.messageText = Copy.quitTitle
        alert.informativeText = Copy.quitMessage
        alert.alertStyle = .warning
        alert.addButton(withTitle: Copy.quitKeepWorking)   // first button = default
        alert.addButton(withTitle: Copy.quitAnyway)
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn {
            return .terminateCancel
        }
        model.prepareForTermination()
        return .terminateNow
    }
}
