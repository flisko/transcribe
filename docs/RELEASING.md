# Releasing Transcribe

How versions, GitHub releases, and the in-app update banner work — and how to
turn the whole machine on. This is the reference for the future maintainer
(probably you, months from now).

## IMG_2827.mov — done, don't redo it

The personal test video is **not in this repository's history**. It was stripped
before the repo was pushed; it survives only as an untracked local fixture on the
dev machine (`.gitignore` keeps it out, and the integration suite self-skips when
it isn't there).

Re-check any time — this must print **nothing**:

```bash
git log --all --oneline -- IMG_2827.mov
```

If it ever prints something (a careless `git add -f`), fix it in the same commit
rather than rewriting history: the repo is published, so a `git filter-repo` pass
now would rewrite every already-pushed commit and force-push over it. Only reach
for that if a private file genuinely made it into a pushed commit — and then say
so loudly, because clones and forks keep the old objects.

## Public repo: what that changed

The repo is public, so anyone can read the source, fork it, and open pull
requests. Three things exist because of that:

- **`.github/workflows/ci.yml`** runs the unit tests (plus a `setup.ps1` parse
  check under both PowerShell editions) on every pull request and on every
  branch that isn't `main`. `release.yml` also runs them, but only *after* a
  push to main — by which point it is already packaging that code for release.
  ci.yml uses `pull_request`, never `pull_request_target`, and a read-only
  token, so a fork's PR gets no secrets and no write access.
- **Release notes carry SHA-256 checksums** of both zips. The builds are
  unsigned, so this is the only integrity signal a user has — and a fork could
  otherwise publish an identical-looking "Transcribe" release.
- **`.github/dependabot.yml`** raises weekly PRs for `desktop/`. Electron *is*
  Chromium, and the lockfile publicly states which one each release shipped.

Two things worth knowing when reading `npm audit` here: the number that matters
is **`npm audit --omit=dev`, which is 0** — the app has zero runtime
dependencies and nothing from npm reaches users (`app.asar` holds only the 25
first-party runtime files). The high-severity lines in a plain `npm audit` are
all inside `electron-builder`'s own tree and run only on a build machine.

## What happens on every push to main

Once the project lives on GitHub (see "Activating releases" below), the
workflow in `.github/workflows/release.yml` runs automatically on every push
to `main` (or manually via the Actions tab → "release" → Run workflow). Three
jobs:

**build-mac** (macOS runner):
1. Computes the release version: `$(cat VERSION).<run number>` —
   e.g. `VERSION` contains `1.0` and this is workflow run 42 → `1.0.42`.
2. `npm ci` + unit tests (`node --test`) in `desktop/`.
3. `electron-builder --mac --universal` builds `Transcribe.app` (Apple
   Silicon + Intel), with the version and the repo slug baked into the
   packaged `package.json` via `extraMetadata` — that slug is what the
   update banner polls.
4. Stages a `Transcribe/` folder containing `Transcribe.app`, `bin/`,
   `setup.command`, and `README.md` — **never `models/`** — and zips it with
   `ditto` (preserves the .app structure and permission bits that plain zip
   can mangle) as `Transcribe-macos-v1.0.42.zip`.

**build-win** (Windows runner):
1. Same version computation, `npm ci`, and unit tests.
2. **A real smoke test**: runs `setup.ps1 -ToolsOnly` — the same script users
   run — which downloads whisper.cpp, ffmpeg, yt-dlp, and deno into
   `tools/win/`, then runs the engine integration tests against those real
   binaries (yt-dlp metadata lookup hits a real URL). Models are never
   downloaded in CI; model-dependent tests self-skip.
3. `electron-builder --win` builds `Transcribe.exe` (same `extraMetadata`
   baking).
4. Stages a `Transcribe/` folder containing the unpacked app (Transcribe.exe
   + resources), `Transcribe Setup.bat`, `setup.ps1`, and `README.md` —
   **never `models/` or `tools/`** — and zips it with `Compress-Archive` as
   `Transcribe-windows-v1.0.42.zip`.

**release** (needs both): creates git tag `v1.0.42` plus a GitHub release
with auto-generated notes and **both** zips, `--target`-pinned to the exact
commit the zips were built from.

Those release assets are what users download, and what existing apps compare
themselves against. If either platform's build or smoke fails, nothing is
released for anyone — a half-release (one platform only) can't happen.

> **What build-win proves, and what it doesn't.** The Windows port has since
> been validated on real Windows 11 hardware — see `WINDOWS-TASKS.md` for the
> record of what is proven end-to-end and the short list that still needs a
> human at the machine. build-win is the ongoing regression net (it runs the
> real `setup.ps1` tool download and the engine integration tests against those
> binaries), not the only evidence. It still can't see the models, toasts, the
> shell integration, or SmartScreen, so treat a green build-win as "nothing
> obviously regressed", not "shipped and checked".

## Releases are live

The repo is on GitHub (`flisko/transcribe`) and `main` is the release branch —
every push to it runs the workflow above and publishes a new version. Nothing
to configure: it uses the automatic `github.token`, no secrets.

> **Private vs public:** the repo is currently **private**, which is fine for
> *building* releases, but the app's update check calls the GitHub API
> anonymously — against a private repo it gets a 404 and stays silent, and
> users couldn't download the zip anyway. So today no shipped app will ever
> show an update banner. When you want other people's machines to see them,
> make the repo public (github.com → repo Settings → Danger Zone → Change
> visibility, or `gh repo edit flisko/transcribe --visibility public`).

## Code signing and notarization (macOS)

**Optional by design.** Every push to `main` publishes, so a missing or expired
credential must not be able to block a release. The workflow checks for the
secrets first (`Detect signing credentials`) and, when they are absent, sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`, logs a warning, and publishes the same
unsigned build as before. Nothing to undo if a certificate lapses.

### Why it is worth having

Not mainly the Gatekeeper prompt. **TCC keys its permission grants to the app's
code identity**, and an ad-hoc `linker-signed` bundle (which is what
`identity: null` produced — `codesign -dv` reported `Identifier=Electron`,
`Info.plist=not bound`) is the unstable case. A user could allow Transcribe
access to their Downloads folder, have it work, and find the grant gone the next
morning — every sibling file then stats `EPERM` and the app reports
"can't find setup.command" about a file sitting in plain sight in Finder. That
was the original bug report. A Developer ID signature gives a stable designated
requirement, so the grant sticks.

Notarization is the second half: it turns the System Settings →
"Open Anyway" detour into one ordinary "Open" prompt.

**What it does NOT fix: App Translocation.** That keys off the quarantine
attribute and whether the user moved the app in Finder — not off the signature.
Notarized apps translocate too; it is why every DMG ships an `/Applications`
symlink, to make the user drag the app and clear translocation eligibility. A
DMG is not an option here (the models must live beside the app), so the guard in
`desktop/main/relocate.js` stays load-bearing. Signing and that guard cover
different failure modes; neither replaces the other.

### The five secrets

Settings → Secrets and variables → Actions → New repository secret.

| Secret | What it is |
| --- | --- |
| `MACOS_CERT_P12` | Developer ID Application certificate + private key, `.p12`, base64 |
| `MACOS_CERT_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_API_KEY_P8` | App Store Connect API key `.p8`, base64 |
| `APPLE_API_KEY_ID` | The key's ID (10 chars, in the filename `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | Issuer ID (a UUID, shown above the key list) |

Team ID for this account: `TV72VARN6H`.

### Getting the certificate

An "Apple Development" certificate is **not** enough — it only signs builds for
machines in your provisioning profile. Distribution outside the App Store needs
`Developer ID Application`.

1. Xcode → Settings → Accounts → select the team → Manage Certificates → `+` →
   **Developer ID Application**. (Or developer.apple.com → Certificates → `+` →
   Developer ID Application, with a CSR from Keychain Access.)
2. Confirm it landed: `security find-identity -v -p codesigning` must list a
   line containing `Developer ID Application`.
3. Keychain Access → My Certificates → right-click it → Export → `.p12`, set a
   password. **Export the certificate with its private key** — expanding the row
   and exporting only the key, or only the cert, produces a `.p12` that imports
   without erroring and then fails to sign.
4. `base64 -i cert.p12 | pbcopy` → paste into `MACOS_CERT_P12`.

### Getting the API key

appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect
API → `+`. Role **Developer** is sufficient for notarization. The `.p8`
downloads **once and only once** — save it before closing the page.

`base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` → `APPLE_API_KEY_P8`.

An API key is preferred over an Apple ID + app-specific password: it is
independent of the personal account, individually revocable, and unaffected by
password changes or 2FA.

### Verifying a signed release

The workflow already asserts this and fails the build if the signature is
broken (`codesign --verify --deep --strict`, then `spctl -a -t exec`). Stapling
is checked too but only warns: an unstapled-yet-notarized app still passes
Gatekeeper, it just has to ask Apple over the network on first launch instead of
offline. On a downloaded zip you can check the same three things by hand:

```sh
codesign -dv --verbose=4 Transcribe.app   # Authority=Developer ID Application: …
spctl -a -vvv -t exec Transcribe.app      # source=Notarized Developer ID
xcrun stapler validate Transcribe.app     # The validate action worked!
```

### Building signed locally

Local `npm run dist` picks up any Developer ID certificate in your login
keychain automatically. To force the unsigned build:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

## How users get the update warning

Apps built by CI carry two values in their packaged `package.json`, injected
by electron-builder's `extraMetadata`: their own version (e.g. `1.0.42`) and
the repo slug (`updateRepo`, e.g. `flisko/transcribe`).

On launch, the app quietly asks
`https://api.github.com/repos/<slug>/releases/latest` for the newest tag
(short timeout, silent on any failure — no network, no nagging). If that
tag's version is newer than its own, a small banner appears at the top of the
window: **"Version X.Y.Z is available." [Download]** — Download opens the
release page in the browser, where the user grabs the zip for their OS. No
auto-update, deliberately: users replace the folder the same way they
installed it, and their `models/` (and `tools/` on Windows) stays where it is.

**Why local builds never warn:** `npm start` and a local `npm run dist` bake
*no* `updateRepo` and version `0.0.0-dev`, which disables the check entirely.
Only CI-built apps know where to look. So you can rebuild and experiment
locally without ever seeing (or triggering) update banners.

## How versioning works

- `VERSION` in the repo root holds **major.minor** only (currently `1.0`).
- CI appends the workflow **run number** as the patch: `1.0.42`, `1.0.43`, …
  Every push to main gets a unique, increasing version with zero bookkeeping,
  and both platforms' zips in one release always share one version.
- Bump `VERSION` to `1.1` / `2.0` when it feels like a bigger step. The run
  number keeps counting upward regardless, so versions still sort correctly
  (`1.0.42` → `1.1.43`).
- Local builds are always `0.0.0-dev`, which sorts below every CI build and
  never triggers a banner.

## The models (4.6GB)

Never put `models/` (or Windows' `tools/`) in a release — the zips would
balloon from ~100MB to multiple GB, and GitHub caps release assets at 2GB
anyway. The models are public downloads from Hugging Face; `setup.command`
(macOS) and `Transcribe Setup.bat` (Windows) fetch them on each user's
machine — and skip them if they're already there, e.g. copied from another
machine. `.gitignore` keeps them out of the repo for the same reason.
