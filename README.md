# Transcribe

Drop audio or video files — or paste a YouTube, Instagram, or TikTok link —
and get a transcript plus subtitles, running fully on your own computer with
whisper.cpp. No cloud, no cost, no data leaves your machine. One app, for
both **macOS** and **Windows**.

The speech models (~4.6GB) are **never inside the app or its updates** —
they're downloaded separately to your machine by the one-time setup below,
and they stay put across updates.

## Installing on macOS

Downloaded `Transcribe-macos-v….zip` (from the in-app update banner or the
GitHub releases page)? Three steps:

1. **Unzip it.** You get a `Transcribe` folder — move it wherever you like
   (or just leave it in Downloads).
2. **Let macOS trust it — don't skip this.** Everything downloaded from the
   internet is quarantined, so macOS blocks the app and `setup.command` the
   first time ("from an unidentified developer"). Worse, a quarantined app
   opened straight from the zip is run from a hidden read-only copy, where it
   can't see `setup.command` sitting next to it — that's why **Run Setup…** can
   look like it does nothing. Move the folder from step 1 where you want it,
   then run this once in Terminal, pointing at it:
   ```bash
   xattr -dr com.apple.quarantine ~/Downloads/Transcribe
   ```
   Then open `Transcribe.app` **from inside that folder**.

   Prefer to skip Terminal? Double-click `setup.command`, let macOS refuse,
   then open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** (you may need to do the same for `Transcribe.app` later).
3. **Run `setup.command`** — the first-time setup. It installs the free
   components the app relies on (whisper.cpp for speech recognition, ffmpeg
   for audio, yt-dlp for video links — via [Homebrew](https://brew.sh)) and
   downloads the speech models (~4.6GB total). Takes a few minutes.
   Re-running it is safe.

## Installing on Windows

Downloaded `Transcribe-windows-v….zip`? Three steps:

1. **Unzip it.** You get a `Transcribe` folder — move it wherever you like.
2. **Know what Windows will say.** The first time you run something new and
   unsigned, SmartScreen shows a blue "Windows protected your PC" screen —
   that's Windows being cautious about any new app, not a problem with this
   one. Click **More info → Run anyway**. Expect it once for the setup and
   once for the app; after that it won't ask again.
3. **Run `Transcribe Setup.bat`** (double-click). It downloads the free
   components the app relies on (whisper.cpp, ffmpeg, yt-dlp) into the
   folder's own `tools` directory, plus the speech models (~4.6GB total).
   Takes a few minutes. Re-running it is safe.

If anything is missing, the app notices on launch and shows a setup checklist
with a **Run Setup…** button — so on either system you can also just open the
app and follow along.

### Make sure you got the real thing

These builds aren't code-signed, which is why macOS and Windows warn on first
run — and it also means the OS can't tell you where a download came from. The
**only** official source is
[github.com/flisko/transcribe/releases](https://github.com/flisko/transcribe/releases).
Every release lists the SHA-256 of both zips in its notes; if you want to be
sure, check yours against it:

```bash
shasum -a 256 Transcribe-macos-v1.0.12.zip      # macOS
```
```powershell
Get-FileHash Transcribe-windows-v1.0.12.zip     # Windows
```

## Everyday use

1. **Open the app** — `Transcribe.app` on macOS, `Transcribe.exe` on Windows.
2. Check the **language** and **model** shown at the top of the window —
   they're remembered between launches.
3. Add things to the queue, in any mix:
   - **Drop files** anywhere on the window (or click **Browse…** — on macOS
     you can also drop them on the Dock icon).
   - **Paste a video link** — YouTube, TikTok, Instagram, and most other
     video sites — and click **Add**.
4. Everything starts by itself and runs through a queue, each row showing a
   **live progress bar and time estimate**. You can keep adding while it
   works, cancel any item, or switch to other apps — it keeps going and can
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

The gear button (or Cmd+, on macOS, Ctrl+, on Windows) holds the handful of
options: model, language, the keep-video toggle, the download folder, whether
to notify you when the queue finishes, and — at the bottom — which version
you're running plus the update controls.

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

**Transcribe never installs anything by itself.** It checks whether a newer
version exists and tells you; downloading and replacing the folder stays your
decision. That's deliberate — you always know exactly what's on your machine.

- **Which version am I on?** Settings → **Updates** shows it, and macOS also
  shows it under  → About Transcribe.
- **A new version exists** → a banner appears at the top of the window. Click
  **Download** to open the release page and grab the zip for your system.
- **Check whenever you like** → Settings → Updates → **Check Now**, or the
  **Check for Updates…** menu item. It tells you what it found, including when
  it couldn't reach the internet.
- **Don't want the automatic check?** Turn off **Check for updates
  automatically** in the same place. Nothing phones home after that; Check Now
  still works when you ask for it.

Updating never touches the models: replace the app, keep your `models` folder
(and `tools` on Windows), and nothing re-downloads. The automatic check runs
once at launch, is silent when it fails, and never interrupts your work. Apps
built locally have no release to compare against and skip it entirely — see
`docs/RELEASING.md`.

## From the Terminal (macOS only)

The `bin/` scripts wrap the same engine for shell use. They're Bash and ship
only in the macOS zip — on Windows, use the app.

`bin/transcribe MODEL LANG file…` where MODEL is `best` or `fast`, and LANG is
a language code/name (`hr`, `sl`, `en`, …) or `auto`:

```bash
bin/transcribe best hr path/to/video.mov     # most accurate
bin/transcribe fast sl clip1.mov clip2.mov   # faster
bin/transcribe best en interview.mp3         # English
bin/transcribe best auto mystery.m4a         # auto-detect the language
```

`bin/download` fetches a video link into a folder — then transcribe the
result like any file:

```bash
bin/download get audio "https://www.youtube.com/watch?v=…" ~/Downloads   # audio only — fastest
bin/download get video "https://www.youtube.com/watch?v=…" ~/Downloads   # keep the video (mp4)
bin/download info "https://www.youtube.com/watch?v=…"                    # peek at the title first
```

## The models

The two main models are downloaded by the setup (~4.6GB total) so you can
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
accurate. They aren't downloaded by default: re-run the setup and answer
**y** when it offers the extra models (macOS Terminal:
`./setup.command --all-models`; Windows PowerShell:
`.\setup.ps1 -AllModels`). Picking a model that isn't downloaded simply marks
that item as failed with a note telling you how to get it.

## Moving the folder / using it on another computer

The app finds everything **relative to itself**, so you can move or rename
the whole `Transcribe` folder freely — no reinstall needed. Just keep the
folder together: the app, `models/`, and (on Windows) `tools/` must stay
side by side.

To set it up on **another machine**:

1. Copy the **whole folder** (not just the app). If you copy `models/` too,
   you skip the ~4.6GB re-download; copying `tools/` on Windows skips the
   tool downloads as well.
2. Get past the one-time security prompt on that machine — the `xattr`
   command (macOS) or SmartScreen's **More info → Run anyway** (Windows),
   exactly as in the install sections above.
3. Run the setup once on that machine — `setup.command` (macOS, needs
   [Homebrew](https://brew.sh)) or `Transcribe Setup.bat` (Windows). It
   installs whatever wasn't copied and skips whatever was.
4. Use the app as normal.

## Building the app yourself

Only needed if you change the source in `desktop/`. Requires **Node 22**:

```bash
cd desktop
npm ci          # once
npm start       # run the app from source
```

`npm test` runs the unit tests, `npm run dist` packages the app for the
platform you're on (into `desktop/dist/` — never committed). Locally built
apps carry version `0.0.0-dev` and skip the update check; real versioning
and both release zips come from CI — see `docs/RELEASING.md`.
