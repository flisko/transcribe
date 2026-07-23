> **Status: Implemented** — 2026-07-23. This spec was executed by six parallel
> lanes (engine, queue/main, renderer, setup, tests, build/release); the pinned
> contracts C1-C11 below are the interfaces they built against.

# Transcribe 3.0 — Cross-Platform (macOS + Windows) Spec

Date: 2026-07-23. Supersedes the SwiftUI app (Transcribe 2.0). ALL 2.0 functionality must be
preserved. One codebase: **Electron 43, plain JavaScript (CommonJS in main, no bundler, no
framework), Node >= 22**. The design system in `design/` is the literal UI source. Models are NEVER
packed with installs/updates — per-platform setup downloads them to the user's machine (unchanged
philosophy). The bash engine (`bin/transcribe`, `bin/download`) and `setup.command` remain as
macOS Terminal tools — the app itself uses its own JS engine on BOTH platforms.

The authoritative references for porting:
- app/AppModel.swift, app/Logic.swift, app/Copy.swift, app/Engine.swift, app/Views.swift (the
  behavior being ported — read them; they encode two review cycles of fixes)
- research_ux.json (binding UX), research_errors.json (failure copy), research_ytdlp.json
  (verified yt-dlp flags) — in this scratchpad dir
- design/tokens.css + design/cards/*.html (visual truth)

## Repo layout (target)

```
desktop/
  package.json            # electron, electron-builder, @playwright/test devDeps; scripts
  electron-builder.yml
  main.js                 # entry: app lifecycle, single-instance, open-file, window
  preload.js              # contextBridge API + webUtils.getPathForFile for drops
  main/
    queue.js              # AppModel port: state machine, lanes, footer/status text
    engine.js             # JS engine: probe, transcribe, dlInfo, dlGet, killTree
    paths.js              # folderRoot(), per-platform tool/model paths, PATH env
    settings.js           # JSON persistence in userData/settings.json
    update.js             # GitHub releases/latest banner check
    menus.js              # app menu, row context menus (Menu.popup), accelerators
    ipc.js                # channel wiring (schema below)
  shared/
    copy.js               # every user-facing string (port of Copy.swift, verbatim)
    catalog.js            # 6-model catalog (port of Models)
    languages.js          # 100 languages (port of Languages)
    logic.js              # classifier, ETA smoother, version compare, progress parse
  renderer/
    index.html  app.css  view.js  popover.js
    settings.html  settings.js
    tokens.css            # tracked COPY of design/tokens.css (npm run sync-tokens refreshes)
  build/                  # icon.icns (copy of assets/AppIcon.icns), icon.ico, icon.png
  test/
    unit/*.test.js        # node --test
    e2e/*.spec.js         # Playwright _electron
setup.ps1 + setup.bat     # Windows setup (repo root)
```
Removed at migration: app/*.swift, build_app.sh (release.yml rewritten).

## PINNED CONTRACTS

### C1. Folder root (portable-folder philosophy on both platforms)
- Packaged mac: exe is `<folder>/Transcribe.app/Contents/MacOS/Transcribe` → folderRoot =
  `path.resolve(dirname(exe), '..', '..', '..')`.
- Packaged win: folderRoot = `dirname(exe)` (release zip = folder with Transcribe.exe at top).
- Dev (`!app.isPackaged`): folderRoot = repo root (`path.resolve(__dirname, '..')` from desktop/).
- Override for tests: env `TRANSCRIBE_ROOT` wins when set. Models at `<folderRoot>/models/`.

### C2. Dependency discovery (main/paths.js)
- mac: whisper-cli|whisper-cpp|main, ffmpeg, yt-dlp found on PATH + /opt/homebrew/bin +
  /usr/local/bin (same as today). Child processes get PATH with those dirs prepended.
- win: tools under `<folderRoot>/tools/win/`: `whisper/whisper-cli.exe`, `ffmpeg/ffmpeg.exe`,
  `yt-dlp/yt-dlp.exe`, `deno/deno.exe` (deno = yt-dlp's JS challenge solver). Child PATH gets all
  four dirs prepended. Missing tool → same setupNeeded/linksLimited semantics as 2.0
  (whisper/ffmpeg/best-model = setup needed; yt-dlp = links limited only).
- Model presence: file size > minBytes from catalog (port exactly).

### C3. Engine module API (main/engine.js) — used by queue.js
- `probeDeps() -> {whisperOK, ffmpegOK, ytDlpOK, bestModelOK, fastModelOK, folderOK, setupNeeded, linksLimited}`
- `transcribe({input, modelSel, lang, workDir, onProgress(pct)}) -> Promise<{txt, srt}>`
  ffmpeg extract (16kHz mono s16le wav in workDir) → whisper `-m <model> -f wav -l <lang> -otxt
  -osrt -of <inputBaseNoExt> -pp`; parse `progress = NN%` lines; call onProgress(1) right after
  extraction (short-clip fix); delete pre-existing txt/srt first (stale-output fix); success =
  txt exists with fresh mtime; whisper stderr kept, on failure thrown as {message, details}
  classified via shared/logic.js `classifyTranscribeFailure` (port of exit-3/oom/disk/etc.
  mapping incl. failModelMissing preflight).
- `dlInfo(url) -> Promise<{title, durationSec|null, isLive, playlistCount|null}>` — yt-dlp
  `--no-update --no-playlist --skip-download --print "%(title)s\t%(duration)s\t%(is_live)s\t%(playlist_count)s"`,
  30 s watchdog kill.
- `dlGet({url, mode: 'video'|'audio', destDir, onProgress(pct)}) -> Promise<{file}>` — verified
  flag sets from research_ytdlp.json; args passed as ARRAY (never shell) so the \t progress
  template needs no quoting: template `download:PROGRESS\t%(progress._percent_str)s\t%(progress.eta)s\t%(progress.filename)s`;
  `--print after_move:filepath --no-simulate --newline --progress -I 1 --no-playlist --no-update`;
  video: `-f "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" -S res:1080
  --merge-output-format mp4`; audio: `-f "ba[ext=m4a]/ba/b" -x --audio-format m4a --audio-quality 0`;
  `-P <staging> -o "%(title).120B [%(id)s].%(ext)s"`; staging dir `<destDir>/.transcribe-dl.<pid>`
  cleaned on every exit path; final move into destDir with "(2)" numbering only when bytes differ
  (identical file → reuse, resolve to existing path); 2-stage progress mapping (filename-change
  stage detection, hold ≤99 until final path known).
- `killTree(child)`: mac/linux — child spawned with `detached: true`, kill via
  `process.kill(-pid, 'SIGTERM')`, SIGKILL escalation after 3 s; win — `taskkill /pid <pid> /T /F`.
  Zero orphans is a verified requirement on mac (pgrep test).
- SECURITY: every spawn `shell: false`; URLs validated `^https?://` BEFORE any spawn and passed as
  a single argv element (arg-injection immunity); user paths never string-interpolated into shells.

### C4. State snapshot + IPC (main computes ALL text; renderer is dumb)
Renderer receives full snapshots on channel `state` (send on every mutation):
```js
{ phase: 'checking'|'setup'|'ready',
  deps: {whisperOK, ffmpegOK, ytDlpOK, modelsOK, bestModelOK, linksLimited, setupNeeded, folderOK},
  items: [{ id, title, kind: 'file'|'link'|'audio', state: 'waiting'|'lookingUp'|'downloading'|
            'preparing'|'transcribing'|'done'|'failed'|'canceled',
            statusText,            // fully composed (status line incl. ETA / error / notes)
            statusTitle,           // tooltip = full text
            progressPct,           // 0-100 or null
            indeterminate,         // bar style
            showProgressBar, flash, // dup-add flash (0.4 s)
            canRetry, canOpen }],  // which trailing controls the row shows
  footer: {text, showCancelAll},
  banner: null | {version, url},
  settings: {model, language, keepVideo, downloadFolder, downloadFolderDisplay, notifyOnFinish},
  catalog: [{sel, display, technical, menuTitle, caption, present}],   // 6 models
  languages: [{code, name}],                                          // for popover
  selectionHint: {clearDoneVisible} }
```
Renderer→main via `invoke('cmd', payload)`: addFiles([paths]), addLink(text), browse, cancel(id),
cancelAll, retry(id), remove(id), startAgain(id), transcribeAgain(id), openTranscript(id),
openSubtitles(id), showInFinder(id), copyTranscript(id), copyErrorDetails(id), clearDone,
setSetting({key, value}), chooseDownloadFolder, runSetup, recheckDeps, openReleasePage,
dismissBanner, rowMenu({id, x, y}), openSettingsWindow, linkFieldValidate(text) -> bool.
Main→renderer events: `state`, `focus-link` (Cmd/Ctrl+L + menu item).
File drops: preload exposes `getPathForFile(File)` via `webUtils.getPathForFile` (Electron ≥32 —
`file.path` no longer exists). Dropped TEXT/URLs that match `^https?://` become link items.

### C5. Queue semantics (port AppModel.swift EXACTLY — read it)
One transcription lane + one download lane, queue order; items capture model+language at START;
model-missing preflight (failModelMissing with display name); cancelAll marks waiting first then
active, single pump; lookup watchdog (60 s) tied to the specific job instance; duplicate active
adds flash existing row 0.4 s, finished duplicates re-add; retry to FRONT of waiting; done rows:
Open + menu (Open Transcript/Subtitles(.srt)/Show in Finder/Copy Transcript Text/Transcribe
Again/Remove); failed rows: Retry + menu (Copy Error Details/Remove); canceled: Start Again;
missing-file actions show Copy.fileGoneNote transient note (4 s) + Show in Finder falls back to
containing folder; copiedFlash "Transcript copied." 2 s; ETA: exponentially smoothed, coarse
phrases, monotone (port EtaSmoother from Logic.swift); no-speech doneNote; notifications
(Electron Notification) only when window not focused, respecting notifyOnFinish, fired on queue
completion with the 4 message variants; progress: `win.setProgressBar(overall)` during work
(both OSes) + `app.dock.setBadge(String(remaining))` mac-only; `powerSaveBlocker
.start('prevent-app-suspension')` while working, stopped when idle; quit guard dialog when work
active (Copy strings), kills all trees + cleans temp on quit; open-file event (mac) and
second-instance argv files/URLs (win, `app.requestSingleInstanceLock`) enqueue.

### C6. Renderer (build from design/cards/*.html — they ARE the UI)
Window 560x640 min 480x460, `tokens.css` variables everywhere, light+dark via
`nativeTheme`/`prefers-color-scheme`. Sections: toolbar (Clear Done per 2.0 visibility rule incl.
selection-in-progress condition, gear), drop zone (click = browse), link row (validate on Add:
inline red caption Copy.invalidLink), quick settings (Language popover with search + arrow-key
highlight + Return select + pinned hr/sl after Auto-detect; Model menu = 6 catalog entries with
"— not downloaded" suffix when !present), queue list (row anatomy per cards/queue-rows.html:
icon film/waveform/link, title middle-truncate, status caption up to 4 lines for failed/notes,
4 px capsule progress bar), empty state, footer status bar, full-window drop overlay (+ setup
variant text), setup screen (checklist with per-dep Installed/Not installed, Run Setup…, Check
Again, folder-split special case), update banner (Copy strings + Download → openReleasePage + ✕
dismiss), settings window (small BrowserWindow, cards/settings.html layout: 6 model radios with
captions + warning icon when missing, language button+popover, keepVideo toggle + caption,
download folder chooser, notifyOnFinish toggle). Context menu on rows via rowMenu IPC.
Keyboard: CmdOrCtrl+O add files, CmdOrCtrl+L focus link, CmdOrCtrl+, settings, CmdOrCtrl+.
cancel selected, Delete remove selected finished, CmdOrCtrl+V with list focused = paste URL,
CmdOrCtrl+0 show window. Menu bar: File > Add Files…/Add Video Link…; standard Edit/Window.
Reduce Motion: `matchMedia('(prefers-reduced-motion)')` → crossfade instead of scale/spring.

### C7. Copy (shared/copy.js)
Port app/Copy.swift verbatim. Strings mentioning "setup.command" become platform-aware via
`SETUP_NAME` = mac ? "setup.command" : "Transcribe Setup" (the win batch file is
`Transcribe Setup.bat` at folder root, shipped by CI; setup.ps1 beside it). Everything else
identical, including all failure sentences, notifications, footer formats, durations.

### C8. Windows setup (setup.ps1 + `Transcribe Setup.bat`)
.bat = `@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*` + pause.
setup.ps1 (PowerShell 5.1-compatible syntax, also runs on pwsh): friendly, idempotent, resumable:
1. Tools into `<root>/tools/win/`, downloaded with **curl.exe** (ships with Win10+; `-L --fail
   -C -` resume) then Expand-Archive:
   - whisper: https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip
     → tools/win/whisper/ (contains whisper-cli.exe; verify presence after extract)
   - ffmpeg: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip → flatten so
     ffmpeg.exe lands at tools/win/ffmpeg/ffmpeg.exe
   - yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe →
     tools/win/yt-dlp/ (on re-run: `yt-dlp.exe -U` self-update — the exe build self-updates,
     unlike brew)
   - deno: https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip
     → tools/win/deno/ (yt-dlp needs a JS runtime for YouTube)
2. Models into `<root>/models/`: same HF URLs, `.download` staging, curl -C - resume, exact
   Content-Length verification when online (mirror setup.command's logic including
   never-promote-partials), min-size floors from the catalog; two main models always,
   optional four via `-AllModels` switch or interactive Y/N prompt.
3. Same closing messages/voice as setup.command. Exit codes 0/1.
App's Run Setup on win: `spawn('cmd.exe', ['/c', 'start', '', batPath])`.

### C9. Packaging + release (electron-builder + release.yml)
- electron-builder.yml: appId com.flisko.transcribe, productName Transcribe, directories.app =
  desktop, mac: target zip, identity null, icon build/icon.icns, extendInfo file associations
  (public.movie/public.audio viewer, same as 2.0); win: target zip, icon build/icon.ico.
  asarUnpack nothing special; renderer/shared/main files included; models/tools NEVER included.
- Release zips (assembled in CI, top-level folder `Transcribe/`):
  mac: Transcribe.app + setup.command + bin/ + README.md → Transcribe-macos-v{V}.zip (ditto)
  win: contents of win-unpacked (Transcribe.exe + resources) + `Transcribe Setup.bat` +
  setup.ps1 + README.md → Transcribe-windows-v{V}.zip (Compress-Archive)
- .github/workflows/release.yml: on push main + workflow_dispatch; concurrency group release;
  jobs: build-mac (macos-latest), build-win (windows-latest) — both: setup-node 22, npm ci in
  desktop/, `node --test` unit tests, npx electron-builder, assemble zip, upload-artifact;
  job release (needs both): download artifacts, RELEASE_VERSION="$(cat VERSION).${run_number}",
  gh release create v$V --target $GITHUB_SHA with BOTH zips. Windows job also runs a REAL
  smoke: setup.ps1 tool download (not models), then `node --test` engine tests that exercise
  yt-dlp dlInfo against a real URL. (First real Windows validation happens in CI — no local
  Windows exists; be explicit about this in RELEASING.md.)
- App update banner: unchanged logic; repo slug from `TRANSCRIBE_UPDATE_REPO` baked at build:
  electron-builder `extraMetadata.updateRepo` set from env in CI; empty locally → check off.
  Version from package.json version = VERSION.runNumber (CI sets via extraMetadata too).

### C10. Tests (must pass before migration commit)
- `node --test desktop/test/unit/` — ports of ALL prior logic tests: classifier (incl. nsig-vs-
  network ordering, took-too-long, no-video-formats→photo post), ETA smoothing/monotonicity,
  version compare (10 cases), language search, model catalog, collision naming, progress-line
  parsing, folderRoot per-platform (with TRANSCRIBE_ROOT), win taskkill arg construction.
- Engine integration (mac, real binaries): transcribe sample copy (fast/hr, diacritic name) →
  txt+srt; dlInfo + dlGet audio zoo video; cancel mid-run → pgrep zero whisper/ffmpeg/yt-dlp,
  staging cleaned.
- Playwright e2e (mac, real app, TRANSCRIBE_ROOT=repo): empty state renders (screenshot);
  add real zoo link via the link field → row progresses to done → click Open (test hook env
  TRANSCRIBE_TEST_LOG records shell.openPath/showItemInFolder/clipboard calls to a JSONL file
  instead of performing them) → assert logged path = produced .txt; click every done-row menu
  action via rowMenu test shim; missing-file note appears after deleting the txt; cancel-all
  path; setup screen renders under a barren TRANSCRIBE_ROOT fixture (screenshot); settings
  window opens, model list shows 6 entries with (technical) names; light+dark screenshots.
- pwsh (on this mac): `pwsh -NoProfile -File setup.ps1 -SyntaxCheckOnly`-style validation: script
  must parse; download/resume/verify functions exercised against a local HTTP server with
  range support (same harness idea as the setup.command test), path logic under a temp root.

### C11. Migration + docs
Delete app/ and build_app.sh. README: rewritten for both platforms (install from release zip per
OS, SmartScreen note for win "More info → Run anyway", quarantine xattr for mac, setup flows,
models-are-separate-downloads statement, Terminal tools still documented as macOS-only, dev
build: Node 22 + npm start in desktop/). docs/RELEASING.md: matrix pipeline, both assets, the
CI-is-first-Windows-validation caveat. docs/superpowers/specs/2026-07-23-transcribe-3-crossplatform.md
records this spec. design/README.md: tokens now consumed directly by the Electron renderer
(sync-tokens script). Memory files updated. Old Transcribe.app build artifact removed from disk.
