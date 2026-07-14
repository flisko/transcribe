#!/bin/bash
# One-time setup: installs whisper-cpp and downloads the speech models.
# Safe to re-run — skips anything already done.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Both models are downloaded so you can pick per transcription (~4.6GB total):
#   ggml-large-v3.bin        -> "Best quality" (most accurate, ~3GB)
#   ggml-large-v3-turbo.bin  -> "Fast"         (~4x faster, ~1.6GB)
MODELS=("ggml-large-v3.bin" "ggml-large-v3-turbo.bin")
BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

echo "== Transcribe setup =="

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is not installed."
  echo "Install it from https://brew.sh then re-run this file."
  read -r -p "Press Return to close." _ || true
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

# 4. Models
mkdir -p models
for m in "${MODELS[@]}"; do
  if [ -f "models/$m" ]; then
    echo "Model $m already downloaded — skipping."
  else
    echo "Downloading model $m …"
    curl -L --fail -o "models/$m" "$BASE_URL/$m"
  fi
done

echo ""
echo "Setup complete. Double-click Transcribe.app to transcribe videos."
read -r -p "Press Return to close." _ || true
