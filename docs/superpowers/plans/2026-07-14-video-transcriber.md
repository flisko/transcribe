# Video Transcriber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A drag-and-drop macOS app that transcribes videos (Croatian/Slovenian) to `.txt` using local whisper.cpp.

**Architecture:** A `bash` core script (`bin/transcribe`) does the real work (ffmpeg → whisper-cli → `.txt`). A one-time `setup.command` installs whisper-cpp and the model. A thin AppleScript `Transcribe.app` (built by `build_app.sh`) catches dropped files, asks the language, and delegates to the core script.

**Tech Stack:** bash, ffmpeg (installed), whisper-cpp (Homebrew), AppleScript (osacompile). No Python.

## Global Constraints

- **Platform:** macOS on Apple Silicon only.
- **No Python dependency** — Python 3.14 is too new for whisper/torch wheels.
- **Model:** `ggml-large-v3-turbo.bin` (~1.6GB) from Hugging Face; model filename is a single editable variable at the top of `setup.command` and `bin/transcribe`.
- **PATH:** every script must `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` so ffmpeg/whisper-cli resolve under the app's restricted environment.
- **Output:** for `<video>.<ext>`, write `<video>.txt` in the same folder. Text only, no SRT.
- **Whisper binary detection:** prefer `whisper-cli`, fall back to `whisper-cpp`, then `main`.
- **Test asset:** `IMG_2827.mov` in the project root (a real Croatian/Slovenian clip).

---

### Task 1: One-time setup installer

**Files:**
- Create: `setup.command`

**Interfaces:**
- Produces: `whisper-cli` (or `whisper-cpp`/`main`) on PATH; `models/ggml-large-v3-turbo.bin` present.

- [ ] **Step 1: Write `setup.command`**

```bash
#!/bin/bash
# One-time setup: installs whisper-cpp and downloads the speech model.
# Safe to re-run — skips anything already done.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

MODEL_NAME="ggml-large-v3-turbo.bin"   # edit to ggml-large-v3.bin for max accuracy
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"

echo "== Transcribe setup =="

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is not installed."
  echo "Install it from https://brew.sh then re-run this file."
  read -r -p "Press Return to close." _
  exit 1
fi

# 2. whisper.cpp
if command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1 || command -v main >/dev/null 2>&1; then
  echo "whisper.cpp already installed — skipping."
else
  echo "Installing whisper-cpp (this can take a few minutes)…"
  brew install whisper-cpp
fi

# 3. ffmpeg (should already exist, but be safe)
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing ffmpeg…"
  brew install ffmpeg
fi

# 4. Model
mkdir -p models
if [ -f "models/${MODEL_NAME}" ]; then
  echo "Model ${MODEL_NAME} already downloaded — skipping."
else
  echo "Downloading model ${MODEL_NAME} (~1.6GB)…"
  curl -L --fail -o "models/${MODEL_NAME}" "$MODEL_URL"
fi

echo ""
echo "Setup complete. Drag videos onto Transcribe.app to transcribe them."
read -r -p "Press Return to close." _
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x setup.command`

- [ ] **Step 3: Run setup (verify install + download)**

Run: `bash setup.command < /dev/null`
Expected: whisper-cpp installs (or "already installed"), model downloads to `models/ggml-large-v3-turbo.bin`, ends with "Setup complete."

- [ ] **Step 4: Verify artifacts exist**

Run: `command -v whisper-cli || command -v whisper-cpp || command -v main; ls -lh models/*.bin`
Expected: a whisper binary path prints; the `.bin` is ~1.6GB.

- [ ] **Step 5: Verify idempotency**

Run: `bash setup.command < /dev/null`
Expected: prints "already installed" and "already downloaded", no re-download.

- [ ] **Step 6: Commit**

```bash
git add setup.command
git commit -m "feat: add one-time setup installer for whisper-cpp + model"
```

---

### Task 2: Core transcription script

**Files:**
- Create: `bin/transcribe`

**Interfaces:**
- Consumes: whisper binary + `models/ggml-large-v3-turbo.bin` from Task 1.
- Produces: CLI `bin/transcribe LANG file1 [file2 …]` → writes `<file>.txt` next to each input; exits non-zero if any file fails. Called by the app in Task 3.

- [ ] **Step 1: Write `bin/transcribe`**

```bash
#!/bin/bash
# Core transcriber: bin/transcribe LANG file1 [file2 ...]
# For each video: extract audio (ffmpeg) -> transcribe (whisper) -> <video>.txt
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Resolve project root (this script lives in <root>/bin)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_NAME="ggml-large-v3-turbo.bin"   # keep in sync with setup.command
MODEL="$ROOT/models/$MODEL_NAME"

# Locate whisper binary
if command -v whisper-cli >/dev/null 2>&1; then WHISPER=whisper-cli
elif command -v whisper-cpp >/dev/null 2>&1; then WHISPER=whisper-cpp
elif command -v main >/dev/null 2>&1; then WHISPER=main
else
  echo "whisper.cpp not found. Please run setup.command first." >&2
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo "Model not found at $MODEL. Please run setup.command first." >&2
  exit 1
fi

if [ "$#" -lt 2 ]; then
  echo "Usage: transcribe LANG file1 [file2 ...]" >&2
  exit 2
fi

# Normalize language (hr/sl or common full names)
raw_lang="$(echo "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"; shift
case "$raw_lang" in
  hr|croatian|hrvatski) LANG_CODE=hr ;;
  sl|slovenian|slovene|slovenscina|slovenščina) LANG_CODE=sl ;;
  "" ) LANG_CODE=hr ;;
  * ) LANG_CODE="$raw_lang" ;;   # pass through any other whisper code
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

ok=0; fail=0
for f in "$@"; do
  if [ ! -f "$f" ]; then
    echo "SKIP (not a file): $f" >&2; fail=$((fail+1)); continue
  fi
  base="${f%.*}"                     # strip extension -> output prefix
  name="$(basename "$f")"
  wav="$tmpdir/audio.wav"

  echo "Transcribing: $name (language=$LANG_CODE)"
  if ! ffmpeg -y -loglevel error -i "$f" -vn -ar 16000 -ac 1 -c:a pcm_s16le "$wav"; then
    echo "SKIP (could not read audio): $name" >&2; fail=$((fail+1)); continue
  fi

  if "$WHISPER" -m "$MODEL" -f "$wav" -l "$LANG_CODE" -otxt -of "$base" >/dev/null 2>&1; then
    echo "  -> ${base}.txt"; ok=$((ok+1))
  else
    echo "SKIP (transcription failed): $name" >&2; fail=$((fail+1))
  fi
  rm -f "$wav"
done

echo "Done. $ok succeeded, $fail failed."
[ "$fail" -eq 0 ]
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x bin/transcribe`

- [ ] **Step 3: Run against the sample video (the end-to-end test)**

Run: `bin/transcribe hr IMG_2827.mov`
Expected: prints "Transcribing: IMG_2827.mov", then "-> IMG_2827.txt", then "Done. 1 succeeded, 0 failed."

- [ ] **Step 4: Verify the transcript**

Run: `test -s IMG_2827.txt && wc -w IMG_2827.txt && head -c 400 IMG_2827.txt`
Expected: file is non-empty; the text reads as plausible Croatian. (Manually eyeball that it's real words, not garbage.)

- [ ] **Step 5: Verify error path (missing file)**

Run: `bin/transcribe hr does_not_exist.mov; echo "exit=$?"`
Expected: "SKIP (not a file)" and non-zero exit.

- [ ] **Step 6: Commit**

```bash
git add bin/transcribe
git commit -m "feat: add core transcription script"
```

---

### Task 3: Drag-and-drop app

**Files:**
- Create: `build_app.sh`
- Generates: `Transcribe.app` (gitignored)

**Interfaces:**
- Consumes: `bin/transcribe` from Task 2 (absolute path baked in at build time).

- [ ] **Step 1: Write `build_app.sh`**

```bash
#!/bin/bash
# Builds Transcribe.app — a drag-drop wrapper around bin/transcribe.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
CORE="$ROOT/bin/transcribe"

SRC="$(mktemp -t transcribe_app).applescript"
cat > "$SRC" <<APPLESCRIPT
property coreScript : "$CORE"

on run
    display dialog "Drag one or more video files onto this app's icon to transcribe them." buttons {"OK"} default button "OK" with title "Transcribe"
end run

on open theFiles
    set langAnswer to text returned of (display dialog "Language for these videos? Type hr (Croatian) or sl (Slovenian):" default answer "hr" with title "Transcribe")
    set filesArg to ""
    repeat with f in theFiles
        set filesArg to filesArg & " " & quoted form of (POSIX path of f)
    end repeat
    display notification "Transcribing… this can take a few minutes." with title "Transcribe"
    try
        do shell script quoted form of coreScript & " " & quoted form of langAnswer & filesArg
        display notification "Done. Transcripts saved next to your videos." with title "Transcribe"
    on error errMsg
        display dialog "Transcription problem:" & return & errMsg buttons {"OK"} default button "OK" with title "Transcribe"
    end try
end open
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (core: $CORE)"
```

- [ ] **Step 2: Make it executable and build**

Run: `chmod +x build_app.sh && ./build_app.sh`
Expected: "Built Transcribe.app"; a `Transcribe.app` directory now exists.

- [ ] **Step 3: Verify the app bundle**

Run: `test -d Transcribe.app && osascript -e 'id of app "'"$PWD"'/Transcribe.app"' 2>/dev/null; ls Transcribe.app/Contents/MacOS`
Expected: `Transcribe.app` exists and contains an executable under `Contents/MacOS` (an `applet`).

- [ ] **Step 4: Verify the baked-in core path**

Run: `grep -a "$PWD/bin/transcribe" Transcribe.app/Contents/Resources/Scripts/main.scpt >/dev/null && echo "path baked ok" || echo "MISSING PATH"`
Expected: "path baked ok" (the compiled script references the absolute core path).

- [ ] **Step 5: Manual drop test (user-driven)**

Instruct the user: drag `IMG_2827.mov` onto `Transcribe.app` in Finder, type `hr`, wait for the "Done" notification, confirm `IMG_2827.txt` was (re)written. (This step is a human check — note it in the handoff.)

- [ ] **Step 6: Commit**

```bash
git add build_app.sh
git commit -m "feat: add build script for drag-drop Transcribe.app"
```

---

### Task 4: README and final polish

**Files:**
- Create: `README.md`
- Verify: `.gitignore` already ignores `models/*.bin`, `Transcribe.app/`, `*.txt`.

- [ ] **Step 1: Write `README.md`**

````markdown
# Transcribe

Drag-and-drop video transcription for Croatian & Slovenian, running fully on
your Mac with whisper.cpp. No cloud, no cost, no data leaves your computer.

## First-time setup (once)

Double-click **`setup.command`**. It installs whisper.cpp and downloads the
speech model (~1.6GB). Takes a few minutes. Re-running it is safe.

## Everyday use

1. Drag one or more video files onto **`Transcribe.app`**.
2. Type the language when asked: `hr` (Croatian) or `sl` (Slovenian).
3. Wait for the "Done" notification. Each `Video.mov` gets a `Video.txt`
   transcript saved right next to it.

## From the Terminal (optional)

```bash
bin/transcribe hr path/to/video.mov
bin/transcribe sl clip1.mov clip2.mov
```

## Changing accuracy vs speed

Default model is `ggml-large-v3-turbo` (fast, good quality). For maximum
accuracy, edit the `MODEL_NAME` line at the top of `setup.command` and
`bin/transcribe` to `ggml-large-v3.bin`, then re-run `setup.command`.

## Rebuilding the app

If you move the project folder, rebuild the app so it points at the new path:

```bash
./build_app.sh
```
````

- [ ] **Step 2: Verify README renders and paths are correct**

Run: `grep -c "setup.command" README.md`
Expected: at least 2.

- [ ] **Step 3: Final end-to-end sanity**

Run: `bin/transcribe hr IMG_2827.mov && test -s IMG_2827.txt && echo "E2E OK"`
Expected: "E2E OK".

- [ ] **Step 4: Commit**

```bash
git add README.md .gitignore
git commit -m "docs: add README"
```

---

## Self-Review

**Spec coverage:**
- Setup installer → Task 1. ✓
- Core ffmpeg→whisper→.txt with per-file independence + summary → Task 2. ✓
- Drag-drop app with language popup + notifications → Task 3. ✓
- Model default `large-v3-turbo`, editable → Global Constraints + Tasks 1/2. ✓
- Error messages ("run setup first", skip non-videos) → Task 2. ✓
- Output `.txt` next to video, text only → Task 2. ✓
- Testing against `IMG_2827.mov` → Tasks 2 & 4. ✓
- README → Task 4. ✓

**Placeholder scan:** No TBD/TODO; all scripts are complete and literal.

**Type/name consistency:** `MODEL_NAME="ggml-large-v3-turbo.bin"` and `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` identical across `setup.command` and `bin/transcribe`. Whisper binary detection order (`whisper-cli` → `whisper-cpp` → `main`) identical in both. Core invocation `bin/transcribe LANG file...` matches the app's `do shell script` call.
