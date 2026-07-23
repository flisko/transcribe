// Views.swift — the whole UI: main window (input header, queue, footer),
// setup state, queue rows for all 8 states, language popover, settings pane,
// update banner, and drop choreography. macOS 13-safe API only.
import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Transcribe DS accent violet (#6E45E2), used as the window tint.
let transcribeAccent = Color(red: 0.431, green: 0.271, blue: 0.886)

// MARK: - Main window

struct ContentView: View {
    @ObservedObject var model = AppModel.shared
    @AppStorage("model") private var modelSel = "best"
    @AppStorage("language") private var language = "hr"
    @State private var linkText = ""
    @State private var showLinkError = false
    @State private var dropTargeted = false
    @State private var bannerDismissed = false
    @State private var installClicked = false
    @State private var showLangPopover = false
    @FocusState private var linkFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                if let update = model.updateBanner, !bannerDismissed {
                    UpdateBanner(info: update,
                                 onDownload: { model.openUpdatePage() },
                                 onDismiss: { bannerDismissed = true })
                }
                inputHeader
                Divider()
                queueArea
                FooterBar(model: model)
            }
            if dropTargeted {
                DropOverlay(setupMode: model.phase == .setupNeeded)
                    .transition(reduceMotion
                                ? .opacity
                                : .opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(.easeOut(duration: 0.15), value: dropTargeted)
        .onDrop(of: [.fileURL, .url, .plainText], isTargeted: $dropTargeted) { providers in
            handleDrop(providers)
        }
        .frame(minWidth: 480, minHeight: 460)
        .tint(transcribeAccent)
        .toolbar { toolbarContent }
        .onChange(of: model.focusLinkToken) { _ in
            linkFocused = true
            // Re-select existing text so a fresh paste replaces it instantly.
            DispatchQueue.main.async {
                (NSApp.keyWindow?.firstResponder as? NSTextView)?.selectAll(nil)
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            // Spec: visible only when a finished row exists AND nothing
            // selected is in progress.
            if model.hasFinishedRows && !model.selectionIsInProgress {
                Button(Copy.clearDone) { model.clearDone() }
                    .help(Copy.clearDoneTooltip)
            }
            Button {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            } label: {
                Image(systemName: "gear")
            }
            .help(Copy.settingsTooltip)
        }
    }

    // MARK: Input header

    private var inputHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            dropZone
            if model.phase == .ready && model.deps.linksLimited {
                linksLimitedRow
            } else {
                linkRow
            }
            quickSettingsRow
        }
        .padding(16)
        .disabled(model.phase == .setupNeeded)
        .opacity(model.phase == .setupNeeded ? 0.5 : 1)
    }

    private var dropZone: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10)
                .fill(.quaternary.opacity(0.3))
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
            HStack(spacing: 12) {
                Image(systemName: "arrow.down.doc")
                    .font(.system(size: 24))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Copy.dropZoneTitle)
                        .font(.body)
                    Text(Copy.dropZoneSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(Copy.browse) { model.browseForFiles() }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 16)
        }
        .frame(height: 76)
        .contentShape(Rectangle())
        .onTapGesture { model.browseForFiles() }
    }

    private var linkRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField("", text: $linkText, prompt: Text(Copy.linkPrompt))
                    .textFieldStyle(.roundedBorder)
                    .focused($linkFocused)
                    .onSubmit(submitLink)
                Button(Copy.addLink, action: submitLink)
                    .buttonStyle(.bordered)
                    .disabled(linkText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if showLinkError {
                Text(Copy.invalidLink)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .onChange(of: linkText) { _ in showLinkError = false }
    }

    private var linksLimitedRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField("", text: .constant(""), prompt: Text(Copy.linksLimitedPrompt))
                    .textFieldStyle(.roundedBorder)
                    .disabled(true)
                Button(installClicked ? Copy.checkAgain : Copy.linksLimitedInstall) {
                    if installClicked {
                        model.probeDeps()
                    } else {
                        model.openSetupCommand()
                        installClicked = true
                    }
                }
                .buttonStyle(.bordered)
            }
            Text(Copy.linksLimitedCaption)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var quickSettingsRow: some View {
        HStack(spacing: 16) {
            Button {
                showLangPopover = true
            } label: {
                HStack(spacing: 3) {
                    Text("Language: \(Languages.name(for: language))")
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9))
                }
            }
            .buttonStyle(.borderless)
            .font(.callout)
            .foregroundStyle(.secondary)
            .popover(isPresented: $showLangPopover, arrowEdge: .bottom) {
                LanguagePopover(selection: $language, isPresented: $showLangPopover)
            }

            Menu {
                Button(Copy.modelMenuBest) { modelSel = "best" }
                Button(Copy.modelMenuFast) { modelSel = "fast" }
            } label: {
                // One concatenated Text keeps the chevron AFTER the label: with
                // separate Text+Image views the NSPopUpButton bridge moves the
                // image to the leading edge, breaking parity with the Language
                // control's label-then-chevron order.
                Text("Model: \(modelSel == "fast" ? Copy.modelDisplayFast : Copy.modelDisplayBest) ")
                    + Text(Image(systemName: "chevron.up.chevron.down"))
                        .font(.system(size: 9))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .font(.callout)
            // Menu labels ignore foregroundStyle and color themselves from the
            // tint — override it so both quick-settings controls read secondary.
            .tint(Color(nsColor: .secondaryLabelColor))

            Spacer()
        }
    }

    private func submitLink() {
        let text = linkText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if model.addLink(text) {
            linkText = ""
            showLinkError = false
        } else {
            showLinkError = true
        }
    }

    // MARK: Queue area

    @ViewBuilder
    private var queueArea: some View {
        if model.phase == .setupNeeded {
            SetupView(model: model)
        } else if model.items.isEmpty {
            EmptyStateView()
        } else {
            queueList
        }
    }

    private var queueList: some View {
        ScrollViewReader { proxy in
            List(selection: $model.selection) {
                ForEach(model.items) { item in
                    QueueRow(item: item, model: model)
                        .id(item.id)
                        .listRowBackground(
                            model.flashID == item.id
                                ? transcribeAccent.opacity(0.18)
                                : Color.clear
                        )
                }
            }
            .listStyle(.plain)
            .animation(reduceMotion ? .default : .spring(response: 0.35, dampingFraction: 0.8),
                       value: model.items.map(\.id))
            .onDeleteCommand { model.deleteSelected() }
            .onPasteCommand(of: [UTType.plainText]) { _ in model.pasteFromClipboard() }
            .onChange(of: model.scrollTarget) { target in
                guard let target = target else { return }
                withAnimation { proxy.scrollTo(target, anchor: .bottom) }
                model.scrollTarget = nil
            }
        }
    }

    // MARK: Drop handling

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        guard model.phase == .ready else { return false }
        var handled = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                handled = true
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { data, _ in
                    var url: URL?
                    if let d = data as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
                    else if let u = data as? URL { url = u }
                    if let u = url, u.isFileURL {
                        DispatchQueue.main.async { AppModel.shared.addFiles([u]) }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                handled = true
                provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { data, _ in
                    var link: String?
                    if let d = data as? Data { link = String(data: d, encoding: .utf8) }
                    else if let u = data as? URL { link = u.absoluteString }
                    if let l = link, looksLikeWebLink(l) {
                        DispatchQueue.main.async { AppModel.shared.addLink(l) }
                    }
                }
            } else if provider.canLoadObject(ofClass: NSString.self) {
                handled = true
                _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                    if let s = object as? String, looksLikeWebLink(s) {
                        DispatchQueue.main.async { AppModel.shared.addLink(s) }
                    }
                }
            }
        }
        return handled
    }
}

// MARK: - Queue row

struct QueueRow: View {
    let item: QueueItem
    @ObservedObject var model: AppModel
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            leadingIcon
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Failure/no-speech copy carries the fix instructions in its
                    // second half — give it room, and a tooltip with the full text.
                    .lineLimit(item.state == .failed || item.doneNote != nil ? 4 : 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .help(statusText)
                if showsProgressBar {
                    progressBar
                }
            }
            Spacer(minLength: 8)
            trailingControls
        }
        .padding(.vertical, 6)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { contextItems }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    // MARK: Icon

    @ViewBuilder
    private var leadingIcon: some View {
        ZStack {
            switch item.state {
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.green)
                    .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.red)
                    .transition(.opacity)
            case .canceled:
                Image(systemName: "minus.circle")
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
                    .transition(.opacity)
            default:
                Image(systemName: typeIconName)
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.3)
                                : .spring(response: 0.3, dampingFraction: 0.7),
                   value: item.state)
    }

    private var typeIconName: String {
        switch item.source {
        case .link:
            return "link"
        case .file(let url):
            let audioExts: Set<String> = ["mp3", "m4a", "aac", "wav", "flac", "ogg",
                                          "opus", "wma", "aiff", "aif", "caf"]
            return audioExts.contains(url.pathExtension.lowercased()) ? "waveform" : "film"
        }
    }

    // MARK: Status line

    private var statusText: String {
        switch item.state {
        case .waiting: return Copy.waiting
        case .lookingUp: return Copy.lookingUp
        case .downloading:
            if let pct = item.progressPct { return Copy.downloading(pct) }
            return Copy.downloadingUnknown
        case .preparing: return Copy.preparing
        case .transcribing:
            if item.afterSleep && item.etaText == nil { return Copy.continuingAfterSleep }
            return Copy.transcribing(item.progressPct ?? 0, eta: item.etaText)
        case .done:
            if item.copiedFlash { return Copy.transcriptCopied }
            if let note = item.doneNote { return note }
            let secs = item.finishedAt.flatMap { end in
                item.startedAt.map { end.timeIntervalSince($0) }
            } ?? 0
            let duration = Copy.durationPhrase(secs)
            if item.isLink {
                let folderName = item.destFolder.map {
                    FileManager.default.displayName(atPath: $0.path)
                } ?? "Downloads"
                return Copy.doneLink(duration, folder: folderName)
            }
            return Copy.doneFile(duration)
        case .failed:
            return item.errorMessage ?? Copy.failTranscription
        case .canceled:
            return Copy.canceled
        }
    }

    // MARK: Progress bar

    private var showsProgressBar: Bool {
        switch item.state {
        case .downloading, .preparing, .transcribing, .lookingUp: return true
        default: return false
        }
    }

    @ViewBuilder
    private var progressBar: some View {
        Group {
            switch item.state {
            case .downloading where item.progressPct != nil,
                 .transcribing:
                ProgressView(value: Double(item.progressPct ?? 0), total: 100)
            default:
                ProgressView()   // indeterminate (looking up / preparing / pct unknown)
            }
        }
        .progressViewStyle(.linear)
        .controlSize(.small)
        .tint(transcribeAccent)
        .accessibilityValue("\(item.progressPct ?? 0) percent")
    }

    // MARK: Trailing controls

    @ViewBuilder
    private var trailingControls: some View {
        switch item.state {
        case .waiting:
            if hovering { removeButton }
        case .lookingUp:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                if hovering { cancelButton }
            }
        case .downloading, .preparing, .transcribing:
            cancelButton
        case .done:
            HStack(spacing: 8) {
                Button(Copy.open) { model.openTranscript(item.id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Menu {
                    doneMenuItems
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        case .failed:
            HStack(spacing: 8) {
                Button(Copy.retry) { model.retry(item.id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                Menu {
                    failedMenuItems
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
        case .canceled:
            HStack(spacing: 8) {
                Button(Copy.startAgain) { model.startAgain(item.id) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                if hovering { removeButton }
            }
        }
    }

    private var cancelButton: some View {
        Button { model.cancel(item.id) } label: {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .help(Copy.cancelTooltip)
    }

    private var removeButton: some View {
        Button { model.remove(item.id) } label: {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .help(Copy.removeTooltip)
    }

    @ViewBuilder
    private var doneMenuItems: some View {
        Button(Copy.openTranscript) { model.openTranscript(item.id) }
        Button(Copy.openSubtitles) { model.openSubtitles(item.id) }
        Button(Copy.showInFinder) { model.showInFinder(item.id) }
        Button(Copy.copyTranscript) { model.copyTranscript(item.id) }
        Button(Copy.transcribeAgain) { model.transcribeAgain(item.id) }
        Divider()
        Button(Copy.removeFromList) { model.remove(item.id) }
    }

    @ViewBuilder
    private var failedMenuItems: some View {
        Button(Copy.copyErrorDetails) { model.copyErrorDetails(item.id) }
        Button(Copy.removeFromList) { model.remove(item.id) }
    }

    // Context menu mirrors each state's action set (two paths to every action).
    @ViewBuilder
    private var contextItems: some View {
        switch item.state {
        case .waiting:
            Button(Copy.removeFromList) { model.remove(item.id) }
        case .lookingUp, .downloading, .preparing, .transcribing:
            Button(Copy.cancelTooltip) { model.cancel(item.id) }
        case .done:
            doneMenuItems
        case .failed:
            Button(Copy.retry) { model.retry(item.id) }
            failedMenuItems
        case .canceled:
            Button(Copy.startAgain) { model.startAgain(item.id) }
            Button(Copy.removeFromList) { model.remove(item.id) }
        }
    }

    private var accessibilityText: String {
        "\(item.title), \(statusText)"
    }
}

// MARK: - Empty state

struct EmptyStateView: View {
    var body: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "text.quote")
                .font(.system(size: 44))
                .foregroundStyle(.quaternary)
            Text(Copy.emptyTitle)
                .font(.title3)
                .fontWeight(.semibold)
            Text(Copy.emptySubtitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Setup needed

struct SetupView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "shippingbox")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text(Copy.setupTitle)
                .font(.title2)
                .fontWeight(.semibold)
            Text(Copy.setupIntro)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)

            if model.deps.engineScriptPresent {
                VStack(alignment: .leading, spacing: 8) {
                    checklistRow(Copy.setupWhisper, ok: model.deps.whisperOK)
                    checklistRow(Copy.setupFfmpeg, ok: model.deps.ffmpegOK)
                    checklistRow(Copy.setupModels, ok: model.deps.modelsOK)
                    checklistRow(Copy.setupYtDlp, ok: model.deps.ytDlpOK)
                }
                .padding(.vertical, 8)
            } else {
                // The app was copied out of its folder — the checklist can't help.
                Text(Copy.engineMissing)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 400)
                    .padding(.vertical, 8)
            }

            HStack(spacing: 12) {
                Button(Copy.runSetup) { model.openSetupCommand() }
                    .buttonStyle(.borderedProminent)
                Button(Copy.checkAgain) { model.probeDeps() }
                    .buttonStyle(.bordered)
            }
            Text(Copy.setupFootnote)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private func checklistRow(_ label: String, ok: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(ok ? Color.green : Color.secondary)
            Text(label)
                .font(.callout)
            Spacer()
            Text(ok ? Copy.installed : Copy.notInstalled)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 380)
    }
}

// MARK: - Drop overlay

struct DropOverlay: View {
    let setupMode: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12)
                .fill(transcribeAccent.opacity(0.1))
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(transcribeAccent, style: StrokeStyle(lineWidth: 2, dash: [8, 5]))
            Label(setupMode ? Copy.dropOverlaySetup : Copy.dropOverlay,
                  systemImage: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(transcribeAccent)
                .padding(12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        }
        .padding(8)
        .allowsHitTesting(false)
    }
}

// MARK: - Footer

struct FooterBar: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack {
                if let text = model.footerText {
                    Text(text)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                if model.hasUnfinishedWork {
                    Button(Copy.cancelAll) { model.cancelAll() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 40)
        }
    }
}

// MARK: - Update banner

struct UpdateBanner: View {
    let info: UpdateInfo
    let onDownload: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.down.circle")
                .foregroundStyle(transcribeAccent)
            Text(Copy.updateAvailable(info.version))
                .font(.callout)
            Spacer()
            Button(Copy.updateDownload, action: onDownload)
                .buttonStyle(.bordered)
                .controlSize(.small)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(transcribeAccent.opacity(0.1))
    }
}

// MARK: - Language popover

struct LanguagePopover: View {
    @Binding var selection: String
    @Binding var isPresented: Bool
    @State private var query = ""
    @State private var highlighted = 0    // index into the filtered results

    var body: some View {
        let results = Languages.filtered(query)
        VStack(spacing: 0) {
            // The search field keeps focus the whole time (type-to-search);
            // arrow keys move the highlight, Return picks the highlighted row.
            TextField("", text: $query, prompt: Text(Copy.searchLanguages))
                .textFieldStyle(.roundedBorder)
                .padding(10)
                .onSubmit { commitHighlighted(results) }
                .onMoveCommand { direction in
                    switch direction {
                    case .down: highlighted = min(highlighted + 1, max(0, results.count - 1))
                    case .up: highlighted = max(highlighted - 1, 0)
                    default: break
                    }
                }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(results.enumerated()), id: \.element.id) { index, lang in
                            languageRow(lang, isHighlighted: index == highlighted)
                            // Separators after Auto-detect and after the pinned pair —
                            // only in the unfiltered browse view.
                            if query.isEmpty && (index == 0 || index == 2) {
                                Divider().padding(.vertical, 2)
                            }
                        }
                    }
                    .padding(6)
                }
                .onChange(of: highlighted) { h in
                    if h >= 0 && h < results.count {
                        proxy.scrollTo(results[h].id)
                    }
                }
            }
        }
        .frame(width: 260, height: 360)
        .onChange(of: query) { _ in highlighted = 0 }
    }

    private func commitHighlighted(_ results: [WhisperLanguage]) {
        guard !results.isEmpty else { return }
        pick(results[min(max(highlighted, 0), results.count - 1)])
    }

    private func pick(_ lang: WhisperLanguage) {
        selection = lang.code
        isPresented = false
    }

    private func languageRow(_ lang: WhisperLanguage, isHighlighted: Bool) -> some View {
        Button {
            pick(lang)
        } label: {
            HStack {
                Image(systemName: "checkmark")
                    .font(.caption)
                    .opacity(selection == lang.code ? 1 : 0)
                Text(lang.name)
                Spacer()
                if lang.code != Languages.auto.code {
                    Text(lang.code)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .background(isHighlighted ? transcribeAccent.opacity(0.15) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .id(lang.id)
    }
}

// MARK: - Settings

struct SettingsView: View {
    @ObservedObject var model = AppModel.shared
    @AppStorage("model") private var modelSel = "best"
    @AppStorage("language") private var language = "hr"
    @AppStorage("keepVideo") private var keepVideo = false
    @AppStorage("downloadFolder") private var downloadFolderPath =
        ("~/Downloads" as NSString).expandingTildeInPath
    @AppStorage("notifyOnFinish") private var notifyOnFinish = true
    @State private var showLangPopover = false

    var body: some View {
        Form {
            Section(Copy.settingsSectionTranscription) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(Copy.settingsModel)
                    modelOption(title: Copy.modelDisplayBest,
                                caption: Copy.settingsBestCaption,
                                value: "best",
                                missing: !model.deps.bestModelOK)
                    modelOption(title: Copy.modelDisplayFast,
                                caption: Copy.settingsFastCaption,
                                value: "fast",
                                missing: !model.deps.fastModelOK)
                }
                .padding(.vertical, 4)

                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(Copy.settingsLanguage)
                        Spacer()
                        Button(Languages.name(for: language)) { showLangPopover = true }
                            .popover(isPresented: $showLangPopover, arrowEdge: .bottom) {
                                LanguagePopover(selection: $language, isPresented: $showLangPopover)
                            }
                    }
                    Text(Copy.settingsLanguageHelp)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section(Copy.settingsSectionLinks) {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle(Copy.settingsKeepVideo, isOn: $keepVideo)
                    Text(Copy.settingsKeepVideoCaption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text(Copy.settingsDownloadFolder)
                    Spacer()
                    Image(systemName: "folder")
                        .foregroundStyle(.secondary)
                    Text(FileManager.default.displayName(atPath: downloadFolderPath))
                        .help(downloadFolderPath)
                    Button(Copy.settingsChooseFolder) { chooseFolder() }
                }
            }

            Section(Copy.settingsSectionNotifications) {
                Toggle(Copy.settingsNotify, isOn: $notifyOnFinish)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .fixedSize(horizontal: false, vertical: true)
        .tint(transcribeAccent)
    }

    private func modelOption(title: String, caption: String, value: String, missing: Bool) -> some View {
        Button {
            modelSel = value
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: modelSel == value ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(modelSel == value ? transcribeAccent : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(title)
                        if missing {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.yellow)
                                .help(Copy.settingsModelMissingTooltip)
                        }
                    }
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            downloadFolderPath = url.path
        }
    }
}
