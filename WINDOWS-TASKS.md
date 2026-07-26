# Windows validation — status

This file used to be a work list handed to an agent running on a Windows PC,
written when the app had only ever been built and reasoned about on macOS. That
work is done: the port has since been exercised on real Windows 11 hardware
(ACP cp1250) and the defects it turned up are fixed and committed. What follows
is the record — what is actually proven, and what still isn't — so the next
person doesn't re-derive it.

Read alongside `docs/superpowers/specs/2026-07-23-transcribe-3-crossplatform.md`
(the binding spec, contracts C1–C11) and `docs/RELEASING.md` (CI/release).

## Verified on real Windows hardware

| Area | Status |
|---|---|
| whisper starts (MSVC runtime) | `setup.ps1` smoke-runs `whisper-cli.exe`, installs `vc_redist.x64.exe` if it can't load, then copies MSVCP140/VCRUNTIME140/VCRUNTIME140_1/VCOMP140 next to the exe so a **copied folder** runs with no redist and no elevation. |
| Unicode filenames | A source named `Čćžšđ – proba škola (v šoli).mov` produces correctly-named, non-empty `.txt` + `.srt`. whisper gets an ASCII `-of` inside the job workDir; Node's Unicode-safe `fs` does the rename. |
| Non-ASCII Windows username (`C:\Users\Žiga\…`) | Crashed whisper outright (`0xC0000409`) even for codepage-representable diacritics. Fixed: job scratch is rooted at an ASCII, per-user-hashed, ACL-locked `%ProgramData%` base, and a non-ASCII model is hardlinked into it for `-m`. Verified end-to-end, including the DACL excluding `BUILTIN\Users` and a standard (non-admin) user being able to create the base. |
| Links with non-ASCII / emoji titles | `--encoding UTF-8` on every yt-dlp call; `findStagedFile` recovers the download if the printed path is ever still unusable. Verified across live TikTok and YouTube videos. |
| Cancel / quit cleanup | `killTree` leaves zero `whisper-cli`/`ffmpeg`/`yt-dlp` survivors, partial outputs are removed, and no `transcribe-*` job dir or download staging dir is left behind. Covered by the integration suite, which runs on Windows. |
| Crash-orphaned scratch | Startup sweep reclaims job dirs **and** `.transcribe-dl.*` download staging left by a force-kill or power loss. |
| Locked output file | A transcript the user still has open no longer aborts the run before whisper starts, and no longer surfaces a raw `EPERM: … rename …` — it fails with a sentence naming the file to close. |
| Packaged layout | `paths.folderRoot()` for a packaged win build is the exe's own directory; `tools/win` + `models` resolve relative to the unzipped folder. |
| Test suites | `npm test` and `npm run test:integration` both green on Windows, with no platform-skipped assertions beyond the two documented mac-only `whichSync` cases. |

## Not verified — needs a human at the machine

- **Queue-finished toast.** `main.js` sets `app.setAppUserModelId('com.flisko.transcribe')`, which is the documented prerequisite. Whether Windows actually shows the toast for a **portable** app (no installer, so no Start Menu shortcut carrying that AUMID) has not been observed. If nothing appears with "Notify me when the queue finishes" on and the app unfocused, the minimal fix is registering a shortcut with a matching AUMID — deliberately not done blind, because it writes to the user's Start Menu.
- **Taskbar progress + "Open with" / drag-onto-exe.** The code paths exist and are unit-tested (`startup-args.js`), but the visual/shell behavior hasn't been eyeballed.
- **SmartScreen wording** on a freshly downloaded release zip.
- **Instagram login.** The cookie mechanism is implemented and audited, but only a real login can prove the end-to-end fetch.

## House rules for Windows changes

- Platform-guard everything (`process.platform`); macOS output must stay byte-identical.
- `setup.ps1` must keep its **UTF-8 BOM + CRLF** — Windows PowerShell 5.1 mojibakes the em-dashes otherwise. Verify after editing, and re-run `-SyntaxCheckOnly` under both `powershell` and `pwsh`.
- User-facing strings live in `desktop/shared/copy.js` and are platform-aware there; don't hardcode "Mac"/"Finder"/"Terminal" anywhere else.
- Add or fix tests for anything you touch. Every push to `main` builds and publishes a release.
