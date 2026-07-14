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
