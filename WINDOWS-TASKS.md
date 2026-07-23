# Windows validation & fix tasks — for Claude Code running on the Windows PC

You are Claude Code running on a **real Windows machine**. This repo (Transcribe)
is a cross-platform Electron app. Everything was built and tested on a **macOS**
dev machine that has **no Windows hardware**, so the Windows-specific behavior
below was reasoned about and unit-tested but **never run on real Windows**. Your
job is to validate it on actual hardware and fix anything that's broken.

Work methodically: reproduce → confirm the defect → fix → verify the fix → commit.
Prefer small, surgical diffs. When you change behavior, keep macOS working too
(guard with `process.platform`). Don't invent scope — this list is the work.

---

## 0. Orient yourself first

- Read `docs/superpowers/specs/2026-07-23-transcribe-3-crossplatform.md` — the
  binding spec (pinned contracts C1–C11: folder-root discovery, engine API, IPC
  snapshot, Windows setup, packaging).
- Read `README.md` (user-facing) and `docs/RELEASING.md` (CI/release pipeline).
- The app is `desktop/`. Engine + platform logic: `desktop/main/engine.js`,
  `desktop/main/paths.js`. Main process: `desktop/main.js`. Windows setup:
  `setup.ps1` + `Transcribe Setup.bat` (repo root).
- Speech **models are never committed or packaged** — they're downloaded by
  setup into `models/`. Windows tools (whisper/ffmpeg/yt-dlp/deno) download into
  `tools/win/`. Both are gitignored.

## 1. Environment setup on this machine

```powershell
# Node 22+ is REQUIRED (Node 20 breaks Electron). Check:
node --version          # want v22.x  (install from nodejs.org if older)

# Install JS deps
cd desktop
npm ci

# Get the native tools + models into the portable folder (this is the real
# end-user setup path — exercise it, don't shortcut it):
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
#   • add  -AllModels     to also fetch the small optional models
#   • add  -ToolsOnly     to skip the ~4.6GB model download (tools only)

# Run the app in dev mode:
cd desktop
npm start
```

If PowerShell blocks the script: `Set-ExecutionPolicy -Scope Process Bypass`.

## 2. Run the automated tests (baseline — should already pass)

```powershell
cd desktop
npm test                 # unit tests — must be green on Windows
npm run test:integration # real whisper/ffmpeg/yt-dlp; needs tools (+models for the
                         # transcribe cases). Bot-walled YouTube on some networks
                         # is tolerated (classified failures pass).
```
If any unit test fails **on Windows specifically**, that's a real finding — fix
the code or the test's platform assumption (tests must be platform-correct, not
skipped to hide a bug).

## 3. PRIORITY validation on real hardware

These are the Windows-specific risks that could not be verified on macOS. For
each: reproduce, confirm the current behavior, and fix if broken.

1. **whisper actually runs (VC++ runtime).** `whisper-cli.exe` dynamically links
   the MSVC runtime (MSVCP140.dll, VCRUNTIME140.dll, VCRUNTIME140_1.dll), which
   are NOT part of Windows. `setup.ps1` was changed to smoke-run whisper after
   install and, if it fails to start (exit `-1073741515` / `0xC0000135`),
   download+install `vc_redist.x64.exe` silently. **Verify on a machine that
   does NOT already have the VC++ redist** (or temporarily rename the DLLs):
   does setup detect it, install the redist, and does transcription then work?
   Confirm a real transcription produces a correct `.txt`+`.srt`. If the redist
   approach is flaky (UAC, offline), consider **bundling the 3 DLLs** next to
   `whisper-cli.exe` in `tools/win/whisper/` instead (they're redistributable).

2. **Unicode filenames (the primary use case — Croatian + emoji).** On Windows,
   `whisper-cli.exe` reads argv through the ANSI codepage, so non-codepage
   characters corrupt. `engine.js` was changed to run whisper with an ASCII `-of`
   inside the job workDir on win32, then rename to the real Unicode path.
   **Verify:** transcribe a local file named `Čćžšđ proba 🎬.mp4`; download a
   TikTok whose title has emoji/quotes. Confirm the `.txt`/`.srt` land with the
   correct Unicode names and non-empty content. Also test a Windows **username
   with non-ASCII** if you can (`C:\Users\Žiga\…`) — the model path (`-m`) and
   app-folder path go through whisper too; note/fix if that path breaks.

3. **Queue-finished notifications.** `main.js` now sets
   `app.setAppUserModelId('com.flisko.transcribe')`. **Verify a Windows toast
   actually appears** when the queue finishes with the app unfocused (enable
   "Notify me when the queue finishes"). Portable (no-installer) apps often need
   the AUMID registered in the registry with a matching shortcut for toasts to
   show — if nothing appears, investigate whether a shortcut/registration is
   needed and implement the minimal fix.

4. **Files opened before launch / drag-onto-exe / "Open with".** `main.js` now
   parses `process.argv` at first launch on win32 and resolves second-instance
   relative paths against the launching cwd. **Verify:** right-click a media
   file → Open with → Transcribe.exe (app not running) enqueues it; same while
   running (second instance); drag a file onto the .exe.

5. **Quit-time cleanup.** No leftover `transcribe-*` job dirs in `%TEMP%` after
   quitting mid-transcription (the fix awaits taskkill before deleting). Verify.

6. **Taskbar progress + tray behavior.** The taskbar button should show progress
   while working (`win.setProgressBar`). Confirm it appears and clears.

7. **Full happy path through the real UI.** Paste a YouTube, a TikTok, and an
   Instagram link; drop a local file. All reach Done; **click Open** on a done
   row and confirm it opens the transcript in the default editor; "Show in
   Finder" opens Explorer with the file selected; Copy works.

8. **SmartScreen / packaged build.** Build the real package and run it like an
   end user:
   ```powershell
   cd desktop
   npm run dist        # electron-builder → dist/  (win zip + unpacked)
   ```
   Unzip the produced `Transcribe-windows-*.zip` somewhere fresh, run
   `Transcribe.exe`, note the SmartScreen prompt wording, and confirm the
   packaged (asar) app finds `tools/win` + `models` relative to the folder
   (`paths.js` folderRoot for packaged win = the exe's own dir).

## 4. How to report / hand back

- Put fixes on a branch and open a PR, **or** commit to `main` directly if you're
  confident — every push to `main` triggers a CI build that publishes a new
  release (macOS + Windows zips) and bumps the version.
- Keep macOS working: platform-guard Windows-only changes.
- If you change `setup.ps1`, **preserve its UTF-8-BOM + CRLF encoding** (Windows
  PowerShell 5.1 mis-reads BOM-less files and mojibakes the em-dashes). After
  editing, re-apply CRLF line endings and a leading BOM.
- Update `README.md` / `docs/RELEASING.md` if user-facing Windows behavior
  changes.
- Add or fix tests for anything you touch (`desktop/test/unit/*.test.js`); the CI
  Windows job runs `npm test` + `npm run test:integration -ToolsOnly`.

## 5. Known context (already handled — don't redo)

- Update banner: the app checks GitHub releases anonymously; it only works when
  the repo is **public**. `updateRepo` is baked into the packaged
  `package.json` by CI.
- macOS ships bash Terminal tools (`bin/transcribe`, `bin/download`) — those are
  mac-only by design; Windows uses the app + `setup.ps1`.
- The Swift app (`app/`) was retired in git history — the Electron app in
  `desktop/` is the whole product now.

Good luck. Reproduce before you fix; verify before you commit.
