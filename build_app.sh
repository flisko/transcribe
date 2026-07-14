#!/bin/bash
# Builds Transcribe.app — a wrapper around bin/transcribe.
# The app finds bin/transcribe RELATIVE TO ITSELF at run time, so the built app
# is portable: copy the whole folder to any Mac and it still works.
set -euo pipefail
cd "$(dirname "$0")"

SRC="$(mktemp -t transcribe_app).applescript"
cat > "$SRC" <<'APPLESCRIPT'
-- Resolve bin/transcribe relative to THIS app's own location (not a baked path).
on coreScriptPath()
    set appPosix to POSIX path of (path to me)
    return (do shell script "dirname " & quoted form of appPosix) & "/bin/transcribe"
end coreScriptPath

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

    -- 0. Locate the engine relative to this app; guard if it's missing.
    set coreScript to coreScriptPath()
    try
        do shell script "test -f " & quoted form of coreScript
    on error
        display dialog "Couldn't find the transcriber engine at:" & return & return & coreScript & return & return & "Make sure the whole Transcribe folder was copied to this Mac (not just the app), then run setup.command once on this Mac." buttons {"OK"} default button "OK" with title "Transcribe"
        return
    end try

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
    display dialog "Transcription finished." & return & return & theResult & return & return & "Transcript (.txt) and subtitles (.srt) are saved next to each video." buttons {"OK"} default button "OK" with title "Transcribe"
end processFiles
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (locates bin/transcribe relative to itself at run time)"
