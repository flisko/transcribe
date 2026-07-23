# Transcribe 2.0 — Design Spec

**Date:** 2026-07-23
**Status:** Implemented

Supersedes the AppleScript wrapper described in
`2026-07-14-video-transcriber-design.md` (engine philosophy unchanged: portable
folder, terminal-testable bash engine, no Python). This document was the binding
spec for the implementation; research artifacts referenced as `research_*.json`
were point-in-time studies (UX design, 57-entry failure catalog, empirically
verified yt-dlp behavior) whose conclusions are baked into the code and the
error-message copy.

## Product summary

Native macOS SwiftUI app ("Transcribe.app") for local whisper.cpp transcription of:
1. Local audio/video files (drag-drop, browse, dock drop)
2. Video links (YouTube / Instagram / TikTok / anything yt-dlp supports): download → transcribe

Outputs `.txt` + `.srt` next to the source file (link downloads go to a chosen folder, default ~/Downloads).
Non-technical users; primary languages Croatian/Slovenian; everything runs locally.

## Repo layout (target)

```
transcribe/
├── Transcribe.app          # built artifact (gitignored)
├── app/
│   └── main.swift          # entire SwiftUI app (single file, ~1500-2000 lines)
├── bin/
│   ├── transcribe          # existing engine (small fixes only — see below)
│   └── download            # NEW: yt-dlp wrapper with progress protocol
├── assets/
│   └── AppIcon.icns        # DONE (already in repo)
├── design/                 # NEW: Claude Design design-system source (HTML cards + tokens)
├── models/                 # gitignored (4.6GB)
├── setup.command           # + yt-dlp install
├── build_app.sh            # REWRITTEN: swiftc universal build
├── VERSION                 # "1.0" (major.minor; CI appends patch = run number)
├── .github/workflows/release.yml   # NEW (dormant until repo pushed)
├── docs/RELEASING.md       # NEW: how GitHub releases + update warnings work
└── README.md               # rewritten for the new app
```

## Engine layer (bash, terminal-testable)

### bin/transcribe (existing — keep protocol, small hardening only)
- Keep: `transcribe MODEL LANG file…`, progress file protocol `PCT\tINDEX\tTOTAL\tNAME` (atomic tmp+mv).
- The app invokes it ONE FILE PER INVOCATION (index/total always 1/1); app computes queue-level aggregates.
- Hardening (from error-catalog research; see ERROR CATALOG section): apply only clear wins, keep diff small.

### bin/download URL DESTDIR MODE (NEW)
- MODE: `video` (keep mp4) or `audio` (audio-only, fastest).
- Uses yt-dlp with --no-playlist; exact flags per YT-DLP RESEARCH section below.
- Progress protocol (mirrors transcribe): if TRANSCRIBE_PROGRESS_FILE set, writes `PCT\t1\t1\tNAME` atomically.
- On success prints exactly one final line to stdout: `FILE\t<absolute path of downloaded media file>`.
  Everything else goes to stderr. Exit 0 only if the file exists and is non-empty.
- Metadata subcommand: `bin/download --info URL` prints `TITLE\t<title>` (used by the app's "Looking up video…" state) — single fast yt-dlp --print call, timeout-guarded.
- Errors: exit non-zero with a final stderr line the app can classify. Classification happens in the APP
  by pattern-matching yt-dlp stderr (patterns per research section).

## App (app/main.swift, SwiftUI, macOS 13+, universal binary)

Implement EXACTLY the UX in research_ux.json (same directory as this spec) — layout, states,
queue row states, settings, copy (verbatim strings), edge_ux, polish items 1-10.
Key structural facts (from that spec):
- Window scene (not WindowGroup) 560x640 min 480x460; Settings scene; document types for dock drop.
- App states: CHECKING → SETUP NEEDED | READY; LINKS LIMITED sub-flag (yt-dlp missing); WORKING; ALL DONE.
- Queue: one transcription lane + one download lane in parallel, queue order, auto-start.
- Row states: waiting / looking-up / downloading / preparing / transcribing / done / failed / canceled.
- Item captures language+model at START time. Duplicate active adds flash existing row; finished dups re-add.
- Cancel = SIGTERM process group, SIGKILL after 3s, cleanup temps/.part files. Cancel All. Guarded quit.
- ProcessInfo.beginActivity idle-sleep suppression while working; dock badge; notification on finish
  (permission requested in-context at first completion; only when not frontmost).
- ETA: exponentially smoothed, coarse rounding, monotone.
- Whisper language list: embed the 100 entries from whisper_languages.tsv (same dir); pinned Croatian/Slovenian
  after Auto-detect; search by name or code.
- Engine discovery: Bundle.main.bundleURL.deletingLastPathComponent() → ../bin/transcribe etc. PATH probe for
  whisper-cli/ffmpeg/yt-dlp must include /opt/homebrew/bin and /usr/local/bin.
- Launch engine via Process with its own process group (posix_spawn attrs not exposed in Process — use
  `/bin/bash -c 'exec setsid …'`? NO: simplest reliable method: Process runs the script directly; store
  process.processIdentifier and kill(-pid) after setpgid via a tiny wrapper: run through
  `/usr/bin/env bash -c 'set -m; exec "$@"' _ <script> args…` so the child gets its own pgid, then
  kill(-pid, SIGTERM). Implementer: verify pgid behavior empirically; fallback: kill the direct pid AND
  pkill -P descendants. MUST leave no orphan whisper/ffmpeg/yt-dlp after cancel (verification will test this).

### Update check (NEW requirement)
- Config: Info.plist keys `TranscribeUpdateRepo` (e.g. "flisko/transcribe", EMPTY in local builds → feature off)
  and CFBundleShortVersionString (from VERSION file + CI run number).
- On launch (async, 5s timeout, silent on any failure): GET
  https://api.github.com/repos/<slug>/releases/latest, parse tag_name "vX.Y.Z", numeric-compare vs own version.
- If newer: non-modal banner at top of window: "Version X.Y.Z is available." [Download] [x].
  Download opens the release's html_url in browser. Banner once per launch; "x" dismisses for this launch.
- No auto-download, no Sparkle — deliberate (unsigned app, simple flow, user copies folder).

## Versioning & releases (dormant until GitHub repo exists)

- VERSION file holds "1.0" (major.minor). Local build version: "<major.minor>.0", update repo slug empty.
- .github/workflows/release.yml: on push to main → macos runner → RELEASE_VERSION="$(cat VERSION).${{ github.run_number }}"
  → ./build_app.sh --version "$RELEASE_VERSION" --update-repo "$GITHUB_REPOSITORY"
  → zip (ditto -c -k --keepParent style) Transcribe-macos-v$RELEASE_VERSION.zip containing:
  Transcribe.app, bin/, setup.command, README.md (NOT models/) → create tag v$RELEASE_VERSION + GitHub release
  (gh release create, generate notes). Job name "macos"; structured so a "windows" job can be added later.
- docs/RELEASING.md documents: how to activate (create repo, push), how clients get update warnings,
  how to add Windows later. THIS FILE is the "keep it written somewhere" the user asked for.

## build_app.sh (rewritten)

- Args: [--version X.Y.Z] [--update-repo owner/name] (defaults: "$(cat VERSION).0", empty).
- swiftc -O -parse-as-library app/main.swift → arm64 + x86_64 (-target {arch}-apple-macos13.0), lipo,
  bundle Transcribe.app (Contents/MacOS/Transcribe, Info.plist, Resources/AppIcon.icns, PkgInfo),
  Info.plist: LSMinimumSystemVersion 13.0, CFBundleIdentifier com.flisko.transcribe, NSHighResolutionCapable,
  CFBundleDocumentTypes (public.movie, public.audio, public.audio-visual-content), CFBundleIconFile,
  TranscribeUpdateRepo, versions. codesign --force --deep -s - Transcribe.app.
- Gitignore Transcribe.app (it's a build artifact; releases carry it).

## Design system (Claude Design — user-requested)

- design/ directory: tokens.css + preview cards (HTML, first line `<!-- @dsCard group="…" -->`), self-contained.
- Visual language "Transcribe DS": accent violet family from the app icon
  (#5C33C7 → #8C57F2 gradient, primary accent #6E45E2), light+dark, SF Pro system stack,
  4pt spacing grid, 10pt radii (cards/drop zone), capsule progress bars.
- Cards: Brand (icon + palette), Colors (light/dark semantic tokens), Typography scale, Buttons,
  Drop zone (idle/targeted), Link input row, Queue rows (all 8 states), Progress + ETA, Empty state,
  Setup checklist, Update banner, Settings pane.
- Pushed to NEW claude.ai/design project "Transcribe" via DesignSync (create_project → finalize_plan → write_files).
- The SwiftUI app implements the same language natively (accent color, spacing, radii, SF Symbols per UX spec).

## Verification gates (all must pass before done)

1. bash -n on all scripts; shellcheck-clean-ish (no obvious quoting bugs).
2. bin/transcribe fast hr IMG_2827.mov → .txt+.srt (real run).
3. bin/download both modes on a tiny real video → FILE line correct, file plays (ffprobe).
4. bin/download --info returns a title fast. Bad URL → non-zero + classifiable stderr.
5. build_app.sh → universal, signed, launches (open + pgrep), icon correct.
6. Full in-app e2e: add a real URL via UI-driven test or direct AppModel invocation — at minimum engine-level
   e2e: download → transcribe chain on a real link.
7. Cancel leaves no orphan processes (pgrep whisper-cli/ffmpeg/yt-dlp after cancel).
8. Adversarial multi-lens code review; confirmed findings fixed.
9. actionlint or careful review of release.yml (can't run Actions locally).

## PINNED CONTRACTS (all agents must honor these exactly)

### bin/transcribe (interface UNCHANGED, internals hardened)
- `bin/transcribe MODEL LANG FILE…`; progress protocol unchanged: atomic write of
  `PCT\tINDEX\tTOTAL\tNAME` to $TRANSCRIBE_PROGRESS_FILE (NAME sanitized: tabs/newlines stripped).
- Exit codes: 0 = all succeeded · 1 = ran, but ≥1 file failed · 2 = usage · 3 = dependency missing
  (whisper/model/ffmpeg — check ffmpeg too). Human-readable detail on stderr.
- The app invokes ONE file per invocation.

### bin/download (NEW)
- `bin/download info URL` → single stdout line `TITLE\t<title>\t<duration_s>\t<is_live>\t<playlist_count>`
  (NA where unknown), exit 0; failure exit 1 with yt-dlp "ERROR:" lines on stderr; exit 3 if yt-dlp missing.
- `bin/download get video|audio URL DESTDIR` → progress `PCT\t1\t1\t<name>` to $TRANSCRIBE_PROGRESS_FILE;
  on success the LAST stdout line is `FILE\t<absolute final path>`; exit 0 only if that file exists non-empty.
  exit 1 = download failed; exit 3 = yt-dlp missing. All yt-dlp stderr passes through to stderr (the app
  captures it for error classification and staleness detection).

### App → engine process management
- App launches engine scripts via: /bin/bash <script> args (Process), with a leader that gives the child its
  own process group; cancel = SIGTERM to the process GROUP, SIGKILL escalation after 3s. Zero orphans.

### Update check + versioning
- Info.plist: TranscribeUpdateRepo (empty = disabled), CFBundleShortVersionString.
- build_app.sh args: --version X.Y.Z (default "$(cat VERSION).0"), --update-repo owner/name (default empty).

## ERROR CATALOG (research, 2026-07-23)
A 57-entry failure-mode catalog (detection / handling / user-facing copy) drove the error handling,
including 12 latent bugs found and fixed in the pre-2.0 engine (stale-output false success,
extension-strip on extensionless files, missing ffmpeg pre-check, fragile -pp percent parsing,
unsanitized progress NAME, no child-kill on TERM, discarded whisper stderr, resumable-model-download
gaps, exit-code ambiguity, basename dash handling). The user-facing failure sentences in
`app/Copy.swift` are the catalog's surviving artifact.

## YT-DLP FACTS (empirically verified 2026-07-23)
Empirically verified on this machine. Key pins: --no-update --no-playlist -I 1 always; video format
"bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" -S "res:1080" --merge-output-format mp4;
audio "ba[ext=m4a]/ba/b" -x --audio-format m4a --audio-quality 0; -P DEST -o "%(title).120B [%(id)s].%(ext)s"
(NO --restrict-filenames); progress via --newline --progress --progress-template (ANSI-C $'…' quoting, no
trailing \n); final path via --print after_move:filepath --no-simulate (last stdout line); metadata via
--skip-download --print with title/duration/is_live/playlist_count; two-stage merge progress mapping;
staleness stderr patterns ("Some formats may be missing", "challenge solving failed", "nsig") → suggest
re-running setup; setup.command must brew upgrade yt-dlp on re-run.
