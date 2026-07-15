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

-- Format a seconds count as a friendly ETA string.
on formatETA(secs)
    set s to secs as integer
    if s < 0 then set s to 0
    if s < 60 then return ("~" & s & "s left")
    set m to s div 60
    set r to s mod 60
    return ("~" & m & "m " & r & "s left")
end formatETA

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
        set langAnswer to text returned of (display dialog "Language of the audio?

Type a code or name, for example:
    hr = Croatian      sl = Slovenian
    en = English       de = German

… or type  auto  to detect it automatically." default answer "hr" with title "Transcribe — language")
    on error number -128
        return -- user pressed Cancel
    end try

    set filesArg to ""
    repeat with f in theFiles
        set filesArg to filesArg & " " & quoted form of (POSIX path of f)
    end repeat

    -- 3. Launch the engine in the background; it writes progress to progFile,
    --    all its output to resFile, and touches doneFile when finished.
    set progFile to do shell script "mktemp -t transcribe_prog"
    set resFile to do shell script "mktemp -t transcribe_res"
    set doneFile to resFile & ".done"
    set launchCmd to "( TRANSCRIBE_PROGRESS_FILE=" & quoted form of progFile & " " & quoted form of coreScript & " " & quoted form of modelSel & " " & quoted form of langAnswer & filesArg & " > " & quoted form of resFile & " 2>&1 ; touch " & quoted form of doneFile & " ) >/dev/null 2>&1 &"
    do shell script launchCmd

    -- 4. Show a native progress bar and poll the progress file until done.
    set progress total steps to 100
    set progress completed steps to 0
    set progress description to "Transcribing with the " & modelSel & " model…"
    set progress additional description to "Preparing…"
    set startTime to current date

    repeat
        set isDone to (do shell script "test -f " & quoted form of doneFile & " && echo 1 || echo 0")
        set ln to ""
        try
            set ln to do shell script "tail -1 " & quoted form of progFile & " 2>/dev/null"
        end try
        if ln is not "" then
            set AppleScript's text item delimiters to tab
            set parts to text items of ln
            set AppleScript's text item delimiters to ""
            if (count of parts) > 2 then
                set pct to 0
                try
                    set pct to (item 1 of parts) as integer
                end try
                if pct < 0 then set pct to 0
                if pct > 100 then set pct to 100
                set idx to item 2 of parts
                set tot to item 3 of parts
                set fname to ""
                if (count of parts) > 3 then set fname to item 4 of parts
                set progress completed steps to pct
                set etaText to "estimating…"
                if pct > 0 and pct < 100 then
                    set elapsed to (current date) - startTime
                    set etaText to formatETA((elapsed * (100 - pct)) / pct)
                else if pct is 100 then
                    set etaText to "finishing…"
                end if
                set progress additional description to ("File " & idx & " of " & tot & " — " & fname & "   ·   " & etaText)
            end if
        end if
        if isDone is "1" then exit repeat
        delay 0.3
    end repeat
    set progress completed steps to 100

    -- 5. Summarise and clean up.
    set summary to ""
    try
        set summary to do shell script "grep -E '^Done|SKIP|not found' " & quoted form of resFile & " 2>/dev/null"
    end try
    if summary is "" then
        try
            set summary to do shell script "tail -3 " & quoted form of resFile
        end try
    end if
    do shell script "rm -f " & quoted form of progFile & " " & quoted form of (progFile & ".tmp") & " " & quoted form of resFile & " " & quoted form of doneFile
    display dialog "Transcription finished." & return & return & summary & return & return & "Transcript (.txt) and subtitles (.srt) are saved next to each video." buttons {"OK"} default button "OK" with title "Transcribe"
end processFiles
APPLESCRIPT

rm -rf Transcribe.app
osacompile -o Transcribe.app "$SRC"
rm -f "$SRC"
echo "Built Transcribe.app (locates bin/transcribe relative to itself at run time)"
