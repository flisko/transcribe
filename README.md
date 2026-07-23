# Transcribe

Drop audio or video files — or paste a YouTube, Instagram, or TikTok link —
and get a transcript plus subtitles, running fully on your Mac with
whisper.cpp. No cloud, no cost, no data leaves your computer.

## Installing from a downloaded zip

Downloaded a release zip (from the in-app update banner or the GitHub
releases page)? Three steps:

1. **Unzip it.** You get a `Transcribe` folder — move it wherever you like
   (or just leave it in Downloads).
2. **Let macOS trust it.** Everything downloaded from the internet is
   quarantined, so macOS blocks the app and `setup.command` the first time
   ("from an unidentified developer"). Run this once in Terminal, pointing at
   wherever the folder from step 1 ended up:
   ```bash
   xattr -dr com.apple.quarantine ~/Downloads/Transcribe
   ```
   Prefer to skip Terminal? Double-click `setup.command`, let macOS refuse,
   then open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** (you may need to do the same for `Transcribe.app` later).
3. **Run `setup.command`** — the first-time setup below.

## First-time setup (once)

Double-click **`setup.command`**. It installs the free components the app
relies on (whisper.cpp for speech recognition, ffmpeg for audio, yt-dlp for
video links) and downloads the speech models (~4.6GB total). Takes a few
minutes. Re-running it is safe.

If anything is missing, the app notices on launch and shows a setup checklist
with a **Run Setup…** button — so you can also just open the app and follow
along.

## Everyday use

1. **Double-click `Transcribe.app`.**
2. Check the **language** and **model** shown at the top of the window —
   they're remembered between launches.
3. Add things to the queue, in any mix:
   - **Drop files** anywhere on the window (or click **Browse…**, or drop
     them on the Dock icon).
   - **Paste a video link** — YouTube, TikTok, Instagram, and most other
     video sites — and click **Add**.
4. Everything starts by itself and runs through a queue, each row showing a
   **live progress bar and time estimate**. You can keep adding while it
   works, cancel any item, or close the window — it keeps going and can
   notify you when the queue finishes.
5. When a row says **Done**, click **Open** to read the transcript. Each file
   gets a `.txt` transcript **and** a `.srt` subtitle file saved right next
   to it; link downloads land in your downloads folder.

### Video links

A link is downloaded first, then transcribed like any other file. Normally
only the **audio** is fetched — much faster and smaller, and the transcript
is identical. Want the video itself too? Turn on **"Keep the downloaded video
file"** in Settings, where you can also choose which folder downloads go to.

### Settings

The gear button (or Cmd+,) holds the handful of options: model, language,
the keep-video toggle, the download folder, and whether to notify you when
the queue finishes.

### Supported formats

Any audio or video file with an audio track works — it's decoded with `ffmpeg`.
That includes audio (`.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.ogg`, `.opus`,
`.wma`, `.aiff`) and video (`.mov`, `.mp4`, `.m4v`, `.mkv`, `.avi`, `.webm`,
`.wmv`, `.flv`, `.mpg`, `.3gp`). A file with no audio track fails with a
friendly note; the rest of the queue carries on.

### Languages

Whisper is multilingual (~99 languages), so this isn't limited to Croatian and
Slovenian. Pick any language from the searchable list (Croatian and Slovenian
are pinned at the top), or **Auto-detect** if you're not sure. For
high-resource languages like English the **Fast** model is nearly as accurate
as **Best**, so it's a fine choice there; for Croatian/Slovenian and other
Balkan languages, stick with **Best quality**.

## Updates

When a new version is released, a banner appears at the top of the window —
click **Download** to grab it. The check is quiet and never interrupts your
work; if it can't reach the internet, nothing happens. (It activates once the
project is published on GitHub — see `docs/RELEASING.md`. Apps rebuilt
locally with `build_app.sh` skip the check entirely.)

## From the Terminal (optional)

`bin/transcribe MODEL LANG file…` where MODEL is `best` or `fast`, and LANG is
a language code/name (`hr`, `sl`, `en`, …) or `auto`:

```bash
bin/transcribe best hr path/to/video.mov     # most accurate
bin/transcribe fast sl clip1.mov clip2.mov   # faster
bin/transcribe best en interview.mp3         # English
bin/transcribe best auto mystery.m4a         # auto-detect the language
```

`bin/download` fetches a video link into a folder (it's what the app uses
under the hood) — then transcribe the result like any file:

```bash
bin/download get audio "https://www.youtube.com/watch?v=…" ~/Downloads   # audio only — fastest
bin/download get video "https://www.youtube.com/watch?v=…" ~/Downloads   # keep the video (mp4)
bin/download info "https://www.youtube.com/watch?v=…"                    # peek at the title first
```

## The models

The two main models are downloaded by `setup.command` (~4.6GB total) so you can
switch per transcription with no extra wait:

| Model | Whisper model | Best for | Trade-off |
|-------|---------------|----------|-----------|
| **Best quality** | `large-v3` | Highest accuracy on Croatian/Slovenian (and other Balkan languages) | Slower, ~3GB |
| **Fast** | `large-v3-turbo` | Quick turnaround, English-heavy or easy audio | ~4× faster, slightly less accurate on low-resource languages, ~1.6GB |

For Croatian & Slovenian, **Best quality** is the recommended default — the
speed-optimized `turbo` model loses the most accuracy exactly on these kinds
of lower-resource languages.

Four smaller optional models are also available in the app's Model menu —
**Medium** (`medium`, ~1.5GB), **Small** (`small`, ~0.5GB), **Base** (`base`,
~150MB), and **Tiny** (`tiny`, ~80MB). Each step down is faster and less
accurate. They aren't downloaded by default: re-run `setup.command` and answer
**y** when it offers the extra models (or run `./setup.command --all-models`
from the Terminal). Picking a model that isn't downloaded simply marks that
item as failed with a note telling you how to get it.

## Moving the folder / using it on another Mac

The app finds its engine **relative to itself**, so you can move or rename the
whole `transcribe` folder freely — no rebuild needed. Just keep the folder
together: `Transcribe.app`, `bin/`, and `models/` must stay side by side.

To set it up on **another Mac**:

1. Copy the **whole `transcribe` folder** (not just the app). If you copy the
   `models/` folder too, you skip the ~4.6GB re-download.
2. On that Mac, macOS may block the copied app the first time ("unidentified
   developer"). Either **right-click the app → Open → Open**, or run this once
   in Terminal to clear the flag for the whole folder:
   ```bash
   xattr -dr com.apple.quarantine /path/to/transcribe
   ```
3. Double-click **`setup.command`** on that Mac once. It installs whisper.cpp,
   ffmpeg, and yt-dlp via Homebrew (and downloads the models if you didn't
   copy them).
   > Requires [Homebrew](https://brew.sh); `setup.command` tells you if it's
   > missing.
4. Use `Transcribe.app` as normal.

## Rebuilding the app

Only needed if you change the app's source in `app/`:

```bash
./build_app.sh
```

This compiles the Swift app into a universal `Transcribe.app` (Apple Silicon
+ Intel, macOS 13+). The **build** Mac needs the Xcode Command Line Tools
(`xcode-select --install`) — Macs that just *run* the app don't.
