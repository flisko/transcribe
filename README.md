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

(You can also drag files straight onto the app icon if you prefer — same result.)

### Supported formats

Any audio or video file with an audio track works — it's decoded with `ffmpeg`.
That includes audio (`.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.opus`,
`.wma`, `.aiff`) and video (`.mov`, `.mp4`, `.m4v`, `.mkv`, `.avi`, `.webm`,
`.wmv`, `.flv`, `.mpg`, `.3gp`). A file with no audio track is skipped with a note.

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

## Moving the folder / using it on another Mac

The app finds its engine **relative to itself**, so you can move or rename the
whole `transcribe` folder freely — no rebuild needed. Just keep the folder
together: `Transcribe.app`, `bin/`, and `models/` must stay side by side.

To set it up on **another Mac**:

1. Copy the **whole `transcribe` folder** (not just the app). If you copy the
   `models/` folder too, you skip the ~4.6GB re-download.
2. On that Mac, macOS may block the copied app the first time ("unidentified
   developer"). Either **right-click the app → Open → Open**, or run this once in
   Terminal to clear the flag for the whole folder:
   ```bash
   xattr -dr com.apple.quarantine /path/to/transcribe
   ```
3. Double-click **`setup.command`** on that Mac once. It installs whisper.cpp +
   ffmpeg via Homebrew (and downloads the models if you didn't copy them).
   > Requires [Homebrew](https://brew.sh); `setup.command` tells you if it's missing.
4. Use `Transcribe.app` as normal.

## Rebuilding the app

Only needed if you change `build_app.sh`:

```bash
./build_app.sh
```
