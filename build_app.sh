#!/bin/bash
# Builds Transcribe.app from app/*.swift as a universal binary (Apple Silicon
# + Intel). The app finds bin/transcribe RELATIVE TO ITSELF at run time, so the
# built app is portable: copy the whole folder to any Mac and it still works.
#
# Usage: ./build_app.sh [--version X.Y.Z] [--update-repo owner/name]
#   --version      Baked into Info.plist. Default: "$(cat VERSION).0".
#   --update-repo  GitHub repo the app polls for new releases. Default: empty,
#                  which turns the update check OFF — local builds never nag.
#                  CI passes the real repo slug; see .github/workflows/release.yml.
set -euo pipefail
cd "$(dirname "$0")"

fail() { echo "" >&2; echo "ERROR: $1" >&2; shift; for line in "$@"; do echo "       $line" >&2; done; exit 1; }

VERSION=""
UPDATE_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || fail "--version needs a value, e.g. --version 1.0.3"
      VERSION="$2"; shift 2 ;;
    --update-repo)
      [ $# -ge 2 ] || fail "--update-repo needs a value, e.g. --update-repo flisko/transcribe"
      UPDATE_REPO="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,10p' "$0"; exit 0 ;;
    *)
      fail "Unknown option: $1" "Usage: ./build_app.sh [--version X.Y.Z] [--update-repo owner/name]" ;;
  esac
done

# Local builds default to "<major.minor>.0"; CI overrides with a real patch
# number so released versions always sort above local ones.
if [ -z "$VERSION" ]; then
  [ -f VERSION ] || fail "VERSION file not found next to build_app.sh." \
    "It should contain the major.minor version (e.g. 1.0)."
  VERSION="$(tr -d '[:space:]' < VERSION).0"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Version must look like X.Y.Z (got: \"$VERSION\")."
[[ -z "$UPDATE_REPO" || "$UPDATE_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] \
  || fail "--update-repo must look like owner/name (got: \"$UPDATE_REPO\")."

# Everything the build needs must exist up front — better one clear message
# than a swiftc stack trace halfway through.
shopt -s nullglob
SOURCES=(app/*.swift)
shopt -u nullglob
[ ${#SOURCES[@]} -gt 0 ] || fail "No Swift sources found in app/." \
  "This script compiles the app from app/*.swift — make sure you're running it" \
  "inside the full transcribe folder (app/ must sit next to build_app.sh)."
[ -f assets/AppIcon.icns ] || fail "App icon not found at assets/AppIcon.icns." \
  "The icon ships with the project — restore the assets/ folder and try again."
xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1 \
  || fail "The Swift compiler isn't available on this Mac." \
    "Install the Xcode Command Line Tools first:  xcode-select --install" \
    "(Only the Mac that BUILDS the app needs this — Macs that just run it don't.)"

BUILD_DIR="$(mktemp -d -t transcribe_build)"
trap 'rm -rf "$BUILD_DIR"' EXIT

# One slice per architecture, then lipo. The flag set "-O -swift-version 5
# -parse-as-library" is a contract with app/main.swift (@main entry point) —
# don't change it without changing the app source too.
for ARCH in arm64 x86_64; do
  echo "Compiling ($ARCH)…"
  swiftc -O -swift-version 5 -parse-as-library \
    -target "$ARCH-apple-macos13.0" \
    "${SOURCES[@]}" -o "$BUILD_DIR/Transcribe-$ARCH"
done
lipo -create "$BUILD_DIR/Transcribe-arm64" "$BUILD_DIR/Transcribe-x86_64" \
  -output "$BUILD_DIR/Transcribe"

echo "Assembling Transcribe.app…"
rm -rf Transcribe.app
mkdir -p Transcribe.app/Contents/MacOS Transcribe.app/Contents/Resources
cp "$BUILD_DIR/Transcribe" Transcribe.app/Contents/MacOS/Transcribe
cp assets/AppIcon.icns Transcribe.app/Contents/Resources/AppIcon.icns
printf 'APPL????' > Transcribe.app/Contents/PkgInfo

# TranscribeUpdateRepo empty = the app skips the update check entirely.
# CFBundleDocumentTypes lets users drop audio/video files on the Dock icon.
cat > Transcribe.app/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Transcribe</string>
	<key>CFBundleIdentifier</key>
	<string>com.flisko.transcribe</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Transcribe</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>TranscribeUpdateRepo</key>
	<string>$UPDATE_REPO</string>
	<key>CFBundleDocumentTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeName</key>
			<string>Audio or Video</string>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>LSHandlerRank</key>
			<string>Alternate</string>
			<key>LSItemContentTypes</key>
			<array>
				<string>public.movie</string>
				<string>public.audio</string>
				<string>public.audio-visual-content</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST
plutil -lint -s Transcribe.app/Contents/Info.plist

# Ad-hoc signature: enough for local Macs; first launch on ANOTHER Mac still
# needs right-click -> Open (or the xattr command in the README) — expected
# for an unsigned-developer app. (--force: swiftc's linker already ad-hoc
# signs the binary; its stderr note about replacing that is noise, but real
# failures must still surface.)
codesign --force -s - Transcribe.app 2> "$BUILD_DIR/codesign.log" \
  || { cat "$BUILD_DIR/codesign.log" >&2; fail "Code signing failed (see message above)."; }

echo ""
echo "Built Transcribe.app"
echo "  version       : $VERSION"
echo "  runs on       : macOS 13+, Apple Silicon + Intel (universal)"
if [ -n "$UPDATE_REPO" ]; then
  echo "  update check  : github.com/$UPDATE_REPO releases"
else
  echo "  update check  : off (local build)"
fi
echo "The app locates bin/ and models/ relative to itself — keep the folder together."
