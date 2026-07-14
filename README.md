# Transcribe

Drag-and-drop video transcription for Croatian & Slovenian, running fully on
your Mac with whisper.cpp. No cloud, no cost, no data leaves your computer.

## First-time setup (once)

Double-click **`setup.command`**. It installs whisper.cpp and downloads the
speech model (~1.6GB). Takes a few minutes. Re-running it is safe.

## Everyday use

1. **Double-click `Transcribe.app`.** A file picker opens.
2. Choose one or more videos (Cmd-click to select several), click **Open**.
3. Pick the **model** — the dialog explains the trade-off:
   - **Best quality** (recommended) — most accurate for Croatian & Slovenian.
   - **Fast** — ~4× faster, slightly less accurate.
4. Type the language when asked: `hr` (Croatian) or `sl` (Slovenian).
5. Wait — a dialog reports when it's finished. Each `Video.mov` gets a
   `Video.txt` transcript **and** a `Video.srt` subtitle file saved right next
   to it.

(You can also drag videos straight onto the app icon if you prefer — same result.)

## From the Terminal (optional)

`bin/transcribe MODEL LANG file…` where MODEL is `best` or `fast`:

```bash
bin/transcribe best hr path/to/video.mov     # most accurate
bin/transcribe fast sl clip1.mov clip2.mov   # faster
```

## The two models

Both are downloaded once by `setup.command` (~4.6GB total) so you can switch
per transcription with no extra wait:

| Model | Whisper model | Best for | Trade-off |
|-------|---------------|----------|-----------|
| **Best quality** | `large-v3` | Highest accuracy on Croatian/Slovenian (and other Balkan languages) | Slower, ~3GB |
| **Fast** | `large-v3-turbo` | Quick turnaround, English-heavy or easy audio | ~4× faster, slightly less accurate on low-resource languages, ~1.6GB |

For Croatian & Slovenian, **Best quality** is the recommended default — the
speed-optimized `turbo` model loses the most accuracy exactly on these kinds of
lower-resource languages.

## Rebuilding the app

If you move the project folder, rebuild the app so it points at the new path:

```bash
./build_app.sh
```
