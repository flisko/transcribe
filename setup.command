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
read -r -p "Press Return to close." _ || true
