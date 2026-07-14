#!/bin/bash
# Builds Transcribe.app — a drag-drop wrapper around bin/transcribe.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
CORE="$ROOT/bin/transcribe"

SRC="$(mktemp -t transcribe_app).applescript"
cat > "$SRC" <<APPLESCRIPT
property coreScript : "$CORE"

-- Double-clicking the app opens a file picker.
on run
    try
        set chosenFiles to (choose file with prompt "Choose video file(s) to transcribe:" with multiple selections allowed)
    on error number -128
        return -- user pressed Cancel
    end try
    processFiles(chosenFiles)
end run

-- Dragging file(s) onto the app icon also works.
on open theFiles
    processFiles(theFiles)
end open

on processFiles(theFiles)
    if (count of theFiles) is 0 then return
    try
        set langAnswer to text returned of (display dialog "Language? Type hr (Croatian) or sl (Slovenian):" default answer "hr" with title "Transcribe")
    on error number -128
        return -- user pressed Cancel
    end try
    set filesArg to ""
    repeat with f in theFiles
        set filesArg to filesArg & " " & quoted form of (POSIX path of f)
    end repeat
    display notification "Transcribing… this can take a few minutes." with title "Transcribe"
    -- 2>&1 + true: capture all output and never throw, so we can always show a clear summary.
    set theResult to do shell script quoted form of coreScript & " " & quoted form of langAnswer & filesArg & " 2>&1; true"
    display dialog "Transcription finished." & return & return & theResult & return & return & "Transcripts (.txt) are saved next to each video." buttons {"OK"} default button "OK" with title "Transcribe"
end processFiles
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (core: $CORE)"
