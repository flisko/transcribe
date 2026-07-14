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

    -- 1. Choose the model (pros/cons shown right in the dialog).
    try
        set modelChoice to button returned of (display dialog "Choose the transcription model:

•  BEST QUALITY  (recommended)
   Most accurate for Croatian & Slovenian.
   Slower, and a larger model.

•  FAST
   About 4× faster.
   Slightly less accurate on these languages.

Not sure? Choose Best quality." buttons {"Cancel", "Fast", "Best quality"} default button "Best quality" with title "Transcribe — model")
    on error number -128
        return -- user pressed Cancel
    end try
    if modelChoice is "Fast" then
        set modelSel to "fast"
    else
        set modelSel to "best"
    end if

    -- 2. Choose the language.
    try
        set langAnswer to text returned of (display dialog "Language? Type hr (Croatian) or sl (Slovenian):" default answer "hr" with title "Transcribe — language")
    on error number -128
        return -- user pressed Cancel
    end try

    set filesArg to ""
    repeat with f in theFiles
        set filesArg to filesArg & " " & quoted form of (POSIX path of f)
    end repeat
    display notification "Transcribing with the " & modelSel & " model… this can take a few minutes." with title "Transcribe"
    -- 2>&1 + true: capture all output and never throw, so we can always show a clear summary.
    set theResult to do shell script quoted form of coreScript & " " & quoted form of modelSel & " " & quoted form of langAnswer & filesArg & " 2>&1; true"
    display dialog "Transcription finished." & return & return & theResult & return & return & "Transcripts (.txt) are saved next to each video." buttons {"OK"} default button "OK" with title "Transcribe"
end processFiles
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (core: $CORE)"
