#!/bin/bash
# Builds Transcribe.app — a drag-drop wrapper around bin/transcribe.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
CORE="$ROOT/bin/transcribe"

SRC="$(mktemp -t transcribe_app).applescript"
cat > "$SRC" <<APPLESCRIPT
property coreScript : "$CORE"

on run
    display dialog "Drag one or more video files onto this app's icon to transcribe them." buttons {"OK"} default button "OK" with title "Transcribe"
end run

on open theFiles
    set langAnswer to text returned of (display dialog "Language for these videos? Type hr (Croatian) or sl (Slovenian):" default answer "hr" with title "Transcribe")
    set filesArg to ""
    repeat with f in theFiles
        set filesArg to filesArg & " " & quoted form of (POSIX path of f)
    end repeat
    display notification "Transcribing… this can take a few minutes." with title "Transcribe"
    try
        do shell script quoted form of coreScript & " " & quoted form of langAnswer & filesArg
        display notification "Done. Transcripts saved next to your videos." with title "Transcribe"
    on error errMsg
        display dialog "Transcription problem:" & return & errMsg buttons {"OK"} default button "OK" with title "Transcribe"
    end try
end open
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (core: $CORE)"
