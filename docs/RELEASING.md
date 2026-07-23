# Releasing Transcribe

How versions, GitHub releases, and the in-app update banner work — and how to
turn the whole machine on. This is the reference for the future maintainer
(probably you, months from now).

## Step 0 — REQUIRED before the repo is ever pushed: strip IMG_2827.mov

**Do this before the first `git push`, and absolutely before making the repo
public.** The personal test video `IMG_2827.mov` was removed from the index
(it's no longer tracked), but it still sits inside the 12 historical commits —
anyone who clones the repo gets the private recording, forever. This is a
privacy requirement, not housekeeping: it's trivial to fix now and impossible
to fully undo once the repo has been published (clones, forks, and caches keep
the file).

```bash
brew install git-filter-repo
git filter-repo --path IMG_2827.mov --invert-paths --force
```

(`--force` is needed because this working copy isn't a fresh clone; the file
itself stays on disk as a local test fixture. `git filter-repo` also drops any
configured remotes — re-add `origin` afterwards if you had one.)

Then prove the video is gone from every commit — this must print **nothing**:

```bash
git log --all --oneline -- IMG_2827.mov
```

## What happens on every push to main

Once the project lives on GitHub (see "Activating releases" below), the
workflow in `.github/workflows/release.yml` runs automatically on every push
to `main` (or manually via the Actions tab → "release" → Run workflow):

1. A macOS runner checks out the repo.
2. It computes the release version: `$(cat VERSION).<run number>` —
   e.g. `VERSION` contains `1.0` and this is workflow run 42 → `1.0.42`.
3. It runs `./build_app.sh --version 1.0.42 --update-repo <owner>/<repo>`,
   which compiles `app/*.swift` into a universal (Apple Silicon + Intel)
   `Transcribe.app` with that version and repo slug baked into its Info.plist.
4. It stages a `Transcribe/` folder containing `Transcribe.app`, `bin/`,
   `setup.command`, and `README.md` — **never `models/`** — and zips it with
   `ditto` (preserves the .app structure and permission bits that plain zip
   can mangle).
5. It creates git tag `v1.0.42` plus a GitHub release with auto-generated
   notes and the asset `Transcribe-macos-v1.0.42.zip`.

That release is what users download, and what existing apps compare
themselves against.

## Activating releases (one-time)

First complete **Step 0** above — these commands publish the repo's history.

The workflow is dormant until the project is on GitHub. The local branch is
currently `master`, but the workflow triggers on `main`, so push it *as*
`main` (or rename first). Two equivalent paths:

```bash
# Option A — gh CLI (creates the repo and the remote in one go):
gh repo create flisko/transcribe --private --source=. --remote=origin
git push -u origin master:main

# Option B — plain git (create the empty repo on github.com first):
git remote add origin git@github.com:flisko/transcribe.git
git push -u origin master:main
```

Or rename the branch once and forget about it: `git branch -m master main`
then `git push -u origin main`.

The first push to `main` triggers the first release. Nothing else to
configure — the workflow uses the automatic `github.token`, no secrets needed.

> **Private vs public:** a private repo is fine for *building* releases, but
> the app's update check calls the GitHub API anonymously — against a private
> repo it gets a 404 and stays silent, and users couldn't download the zip
> anyway. When you want other people's Macs to see update banners, make the
> repo public (github.com → repo Settings → Danger Zone → Change visibility,
> or `gh repo edit flisko/transcribe --visibility public`).

## How users get the update warning

Apps built by CI carry two Info.plist values: their own version
(`CFBundleShortVersionString`, e.g. `1.0.42`) and the repo slug
(`TranscribeUpdateRepo`, e.g. `flisko/transcribe`).

On launch, the app quietly asks
`https://api.github.com/repos/<slug>/releases/latest` for the newest tag
(5-second timeout, silent on any failure — no network, no nagging). If that
tag's version is newer than its own, a small banner appears at the top of the
window: **"Version X.Y.Z is available." [Download]** — Download opens the
release page in the browser, where the user grabs the new zip. No
auto-update, deliberately: users replace the folder the same way they
installed it, and their `models/` stays where it is.

**Why local builds never warn:** running `./build_app.sh` by hand bakes an
*empty* `TranscribeUpdateRepo`, which disables the check entirely. Only
CI-built apps know where to look. So you can rebuild and experiment locally
without ever seeing (or triggering) update banners.

## How versioning works

- `VERSION` in the repo root holds **major.minor** only (currently `1.0`).
- CI appends the workflow **run number** as the patch: `1.0.42`, `1.0.43`, …
  Every push to main gets a unique, increasing version with zero bookkeeping.
- Bump `VERSION` to `1.1` / `2.0` when it feels like a bigger step. The run
  number keeps counting upward regardless, so versions still sort correctly
  (`1.0.42` → `1.1.43`).
- Local builds are always `<major.minor>.0` (e.g. `1.0.0`), which sorts below
  every CI build of the same major.minor.

## Adding a Windows build later

`release.yml` ends with a commented-out template for a `windows` job — the
shape is: build on `windows-latest`, zip as
`Transcribe-windows-v<version>.zip`, and `gh release upload` it to the same
release the macos job created (`needs: macos`).

Keep the per-platform asset naming. The app-side update check needs **no
changes** for this: each platform ships its own binary, so a Mac app and a
Windows app each compare against the same latest release and point their
users at the same release page, where both zips sit side by side.

## The models (4.6GB)

Never put `models/` in a release — the zips would balloon from ~5MB to
~4.6GB, and GitHub caps release assets at 2GB anyway. The models are public
downloads from Hugging Face; `setup.command` fetches them on each user's Mac
(and skips them if they're already there, e.g. copied from another Mac).
`.gitignore` keeps them out of the repo for the same reason.
