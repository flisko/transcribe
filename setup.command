#!/bin/bash
# One-time setup: installs the tools Transcribe needs (whisper-cpp, ffmpeg,
# yt-dlp) and downloads the speech models.
# Safe to re-run — it skips what's done, resumes interrupted model downloads,
# and keeps the video downloader up to date.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# The two main models are always downloaded (~4.6GB total):
#   ggml-large-v3.bin        -> "Best quality" (most accurate, ~3GB)
#   ggml-large-v3-turbo.bin  -> "Fast"         (~4x faster, ~1.6GB)
# Smaller optional models (chosen in the app's Model menu) can be added on
# request — run with --all-models, or answer "y" when asked below.
MODELS=("ggml-large-v3.bin" "ggml-large-v3-turbo.bin")
OPTIONAL_MODELS=("ggml-medium.bin" "ggml-small.bin" "ggml-base.bin" "ggml-tiny.bin")
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Smallest believable size per model — anything under this is a truncated
# download left by an interrupted run, not a usable model.
# Keep in sync with the app's model catalog (app/Logic.swift).
min_size_for() {
  case "$1" in
    ggml-large-v3.bin)       echo 2500000000 ;;   # real file ~3.1GB
    ggml-large-v3-turbo.bin) echo 1200000000 ;;   # real file ~1.6GB
    ggml-medium.bin)         echo 1300000000 ;;   # real file ~1.5GB
    ggml-small.bin)          echo 400000000  ;;   # real file ~0.5GB
    ggml-base.bin)           echo 120000000  ;;   # real file ~148MB
    ggml-tiny.bin)           echo 60000000   ;;   # real file ~78MB
    *)                       echo 1000000000 ;;
  esac
}
file_size() { stat -f%z "$1" 2>/dev/null || echo 0; }

echo "== Transcribe setup =="
echo "This prepares your Mac for Transcribe. Each step below says what it's"
echo "doing. Everything is safe to run again later."
echo ""

# 1. Homebrew (the free installer that fetches everything else)
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is not installed."
  echo "Install it from https://brew.sh then re-run this file."
  read -r -p "Press Return to close." _ || true
  exit 1
fi

# A transient brew failure (network hiccup, brew mid-update) must not abort
# the whole run under set -e — note it, keep going, and say so at the end.
install_failed=0

# 2. whisper.cpp (the speech-recognition engine)
if command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1 || command -v main >/dev/null 2>&1; then
  echo "Speech engine (whisper.cpp) already installed — skipping."
else
  echo "Installing the speech engine (whisper-cpp) — this can take a few minutes…"
  if ! brew install whisper-cpp; then
    echo ""
    echo "NOTE: Couldn't install the speech engine just now (no internet, or a"
    echo "Homebrew hiccup). Transcription needs it — run this file again later"
    echo "to retry. The rest of setup continues below."
    echo ""
    install_failed=1
  fi
fi

# 3. ffmpeg (reads the sound out of video files)
if command -v ffmpeg >/dev/null 2>&1; then
  echo "Sound reader (ffmpeg) already installed — skipping."
else
  echo "Installing the sound reader (ffmpeg)…"
  if ! brew install ffmpeg; then
    echo ""
    echo "NOTE: Couldn't install the sound reader just now (no internet, or a"
    echo "Homebrew hiccup). Transcription needs it — run this file again later"
    echo "to retry. The rest of setup continues below."
    echo ""
    install_failed=1
  fi
fi

# 4. yt-dlp (downloads videos from YouTube / Instagram / TikTok links).
#    Video sites change constantly — an out-of-date downloader silently breaks
#    or quietly drops to low quality, so try to update it on EVERY run.
if command -v yt-dlp >/dev/null 2>&1; then
  echo "Updating the video downloader (yt-dlp) — sites change often, this keeps links working…"
  if ! brew upgrade yt-dlp; then
    echo ""
    echo "NOTE: Couldn't update the video downloader just now (no internet?)."
    echo "Everything else still works. If video links stop downloading later,"
    echo "run this file again while online."
    echo ""
  fi
else
  echo "Installing the video downloader (yt-dlp)…"
  if ! brew install yt-dlp; then
    echo ""
    echo "NOTE: Couldn't install the video downloader (no internet?). You can"
    echo "still transcribe files that are already on this Mac — run this file"
    echo "again later to add support for video links."
    echo ""
  fi
fi

# 5. Speech models. Downloads go to a .download file first and are only moved
#    into place once complete — so an interrupted download can never
#    masquerade as a working model, and re-running resumes (curl -C -) instead
#    of restarting a multi-GB fetch. When the server is reachable we ask it
#    for each model's exact byte size and require an exact match before
#    trusting any file; offline, we fall back to resuming anything that isn't
#    plausibly sized (and never promote a leftover partial by size alone).

# Ask the server how big a model really is (follows redirects; empty if
# offline or the server won't say). The || true keeps a failed curl from
# aborting the whole run under set -e — no answer just means "can't check".
expected_size_for() {
  curl -sIL --max-time 20 "$BASE_URL/$1" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="content-length:" {n=$2} END {print n}' \
    || true
}

mkdir -p models
download_failed=0

# Which models to fetch this run: the two main ones always; the optional small
# ones with --all-models, on request, or when a (possibly partial) copy is
# already here — a leftover .download is always finished, never abandoned.
fetch_list=("${MODELS[@]}")
want_optional=0
for arg in "$@"; do
  [ "$arg" = "--all-models" ] && want_optional=1
done
if [ "$want_optional" -eq 0 ] && [ -t 0 ]; then
  echo ""
  echo "The app can also use smaller, faster (less accurate) models:"
  echo "  Medium ~1.5GB · Small ~0.5GB · Base ~150MB · Tiny ~80MB"
  read -r -p "Download the extra models too? [y/N] " extra_ans || extra_ans=""
  case "$extra_ans" in y|Y|yes|YES) want_optional=1 ;; esac
  echo ""
fi
for m in "${OPTIONAL_MODELS[@]}"; do
  if [ "$want_optional" -eq 1 ] || [ -f "models/$m" ] || [ -f "models/$m.download" ]; then
    fetch_list=("${fetch_list[@]}" "$m")
  fi
done

for m in "${fetch_list[@]}"; do
  min="$(min_size_for "$m")"
  expected="$(expected_size_for "$m")"
  case "$expected" in *[!0-9]*|"") expected="" ;; esac

  if [ -f "models/$m" ]; then
    size="$(file_size "models/$m")"
    if [ -n "$expected" ]; then
      if [ "$size" -eq "$expected" ]; then
        echo "Model $m already downloaded — skipping."
        continue
      fi
      # The real size disagrees with the server — an earlier run left a
      # partial (or damaged) file here. Keep the bytes and finish the job.
      echo "Model $m is incomplete — resuming its download…"
      mv -f "models/$m" "models/$m.download"
    elif [ "$size" -ge "$min" ]; then
      # Offline, so the exact size can't be checked — keep a plausibly sized
      # model rather than re-downloading gigabytes.
      echo "Model $m already downloaded — skipping."
      continue
    else
      echo "Model $m looks incomplete — resuming its download…"
      mv -f "models/$m" "models/$m.download"
    fi
  fi

  # A leftover .download is NEVER promoted as-is, whatever its size: curl
  # always gets a chance to top it off first (a file that is already complete
  # fetches zero extra bytes), and only an exact size match makes it a model.
  if [ -f "models/$m.download" ]; then
    echo "Resuming the download of model $m (this can take a while)…"
  else
    echo "Downloading model $m (this can take a while)…"
  fi
  if curl -C - -L --fail -o "models/$m.download" "$BASE_URL/$m"; then
    size="$(file_size "models/$m.download")"
    if [ -n "$expected" ] && [ "$size" -ne "$expected" ]; then
      rm -f "models/$m.download"
      echo "Model $m came through the wrong size — something went wrong at the source."
      echo "Run this file again to retry."
      download_failed=1
    elif [ -z "$expected" ] && [ "$size" -lt "$min" ]; then
      rm -f "models/$m.download"
      echo "Model $m came through too small — something went wrong at the source."
      echo "Run this file again to retry."
      download_failed=1
    else
      mv -f "models/$m.download" "models/$m"
      echo "Model $m downloaded."
    fi
  else
    echo "Model $m didn't finish downloading (connection dropped?)."
    echo "Run this file again — it continues from where it stopped."
    download_failed=1
  fi
done

# 6. Repair what copying the folder between Macs can break: stripped execute
#    bits on the engine scripts and macOS quarantine flags on the app.
chmod +x bin/* 2>/dev/null || true
xattr -dr com.apple.quarantine . 2>/dev/null || true

echo ""
if [ "$install_failed" -ne 0 ]; then
  echo "Setup is almost done — one of the tools couldn't be installed (see the"
  echo "notes above). Double-click setup.command again to retry."
elif [ "$download_failed" -ne 0 ]; then
  echo "Setup is almost done — one of the model downloads didn't finish."
  echo "Double-click setup.command again to resume it."
else
  echo "Setup complete. Double-click Transcribe.app to transcribe videos."
  echo ""
  echo "If macOS says the app can't be opened (unidentified developer):"
  echo "right-click Transcribe.app, choose Open, then click Open. Once only."
fi
read -r -p "Press Return to close." _ || true
