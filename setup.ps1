# One-time setup: downloads the tools Transcribe needs (whisper.cpp, ffmpeg,
# yt-dlp, deno) and the speech models.
# Safe to re-run — it skips what's done, resumes interrupted model downloads,
# and keeps the video downloader up to date.
# Switches: -AllModels also fetches the four optional smaller models;
# -ToolsOnly (CI smoke) fetches just the tools and skips the multi-GB models;
# -SyntaxCheckOnly parses and exits.
#
# Windows PowerShell 5.1 compatible (also runs on pwsh 7): no ternary, no
# null-coalescing, no pipeline-chain operators.
param(
  [switch]$AllModels,
  [switch]$ToolsOnly,
  [switch]$SyntaxCheckOnly
)

# Reaching this line means the file parsed — that is all -SyntaxCheckOnly asks.
if ($SyntaxCheckOnly) {
  Write-Host "setup.ps1 parsed OK."
  exit 0
}

$Root = $PSScriptRoot
$ToolsDir  = Join-Path $Root (Join-Path 'tools' 'win')
$StageDir  = Join-Path $ToolsDir '.dl'
$ModelsDir = Join-Path $Root 'models'

# The two main models are always downloaded (~4.6GB total):
#   ggml-large-v3.bin        -> "Best quality" (most accurate, ~3GB)
#   ggml-large-v3-turbo.bin  -> "Fast"         (~4x faster, ~1.6GB)
# Smaller optional models (chosen in the app's Model menu) can be added on
# request — run with -AllModels, or answer "y" when asked below.
$Models = @('ggml-large-v3.bin', 'ggml-large-v3-turbo.bin')
$OptionalModels = @('ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin')
$BaseUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

$WhisperUrl = 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip'
$FfmpegUrl  = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$YtDlpUrl   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
$DenoUrl    = 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip'

# whisper-cli.exe dynamically links the Microsoft Visual C++ 2015-2022
# runtime (MSVCP140.dll, VCRUNTIME140*.dll, VCOMP140.dll) — DLLs that ship
# with neither Windows nor the whisper zip. Without them the exe can't even
# start. Permalink to the official x64 redistributable installer:
$VCRedistUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'

# Smallest believable size per model — anything under this is a truncated
# download left by an interrupted run, not a usable model.
# Keep in sync with the app's model catalog (desktop/shared/catalog.js).
function Get-MinSize([string]$name) {
  switch ($name) {
    'ggml-large-v3.bin'       { return 2500000000 }   # real file ~3.1GB
    'ggml-large-v3-turbo.bin' { return 1200000000 }   # real file ~1.6GB
    'ggml-medium.bin'         { return 1300000000 }   # real file ~1.5GB
    'ggml-small.bin'          { return 400000000 }    # real file ~0.5GB
    'ggml-base.bin'           { return 120000000 }    # real file ~148MB
    'ggml-tiny.bin'           { return 60000000 }     # real file ~78MB
    default                   { return 1000000000 }
  }
}

function Get-FileSize([string]$path) {
  if (Test-Path -LiteralPath $path) { return (Get-Item -LiteralPath $path).Length }
  return [long]0
}

# All downloads honor TRANSCRIBE_SETUP_MIRROR: when set, every file is fetched
# as <mirror>/<original file name> instead of from the real hosts — this is
# how the validation harness points the script at a local HTTP server.
function Resolve-Url([string]$url) {
  if ($env:TRANSCRIBE_SETUP_MIRROR) {
    return ($env:TRANSCRIBE_SETUP_MIRROR.TrimEnd('/') + '/' + $url.Split('/')[-1])
  }
  return $url
}

# Windows 10+ ships a real curl at System32\curl.exe. The bare name "curl" is
# NEVER used on Windows — in Windows PowerShell it is an alias for
# Invoke-WebRequest, which understands none of curl's flags. On other OSes
# (validation runs on a Mac) plain "curl" is the real thing.
# Override: TRANSCRIBE_SETUP_CURL = path of the curl binary to use.
function Resolve-Curl {
  if ($env:TRANSCRIBE_SETUP_CURL) { return $env:TRANSCRIBE_SETUP_CURL }
  if ($env:SystemRoot) {
    $sys = Join-Path $env:SystemRoot (Join-Path 'System32' 'curl.exe')
    if (Test-Path -LiteralPath $sys) { return $sys }
  }
  $cmd = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if (-not $env:SystemRoot) { return 'curl' }
  return ''
}

# Ask the server how big a file really is (follows redirects; empty if
# offline or the server won't say). No answer just means "can't check".
function Get-ExpectedSize([string]$url) {
  $lines = & $Curl '-sIL' '--max-time' '20' $url 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  $n = ''
  foreach ($line in @($lines)) {
    if ("$line" -match '^[Cc]ontent-[Ll]ength:\s*(\d+)') { $n = $Matches[1] }
  }
  return $n
}

# curl -C - resumes a partial download instead of restarting it; a file that
# is already complete fetches zero extra bytes. Returns $true on success.
function Invoke-CurlDownload([string]$url, [string]$dest) {
  & $Curl '-C' '-' '-L' '--fail' '-o' $dest $url
  return ($LASTEXITCODE -eq 0)
}

# Downloads a tool zip (resumable), extracts it, and lands the directory that
# holds $ExeName at $DestDir — release zips differ in nesting (ffmpeg buries
# its binaries two levels deep), so the exe is found by search, not by a
# hard-coded path. With -ExeOnly only the exe itself is kept (ffmpeg's zip
# also carries ffplay/ffprobe — dead weight here). Returns $true only when
# $DestDir\$ExeName exists afterwards.
function Install-ZipTool {
  param([string]$Url, [string]$DestDir, [string]$ExeName, [switch]$ExeOnly)
  New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
  $zip = Join-Path $StageDir ($Url.Split('/')[-1])
  if (-not (Invoke-CurlDownload (Resolve-Url $Url) $zip)) {
    Write-Host "The download didn't finish (connection dropped?) — it resumes on the next run."
    return $false
  }
  $extract = "$zip.extract"
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  } catch {
    # A zip that won't open is damaged beyond what resume can repair.
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "The downloaded archive couldn't be opened (interrupted download?) — it's been cleared for a fresh retry."
    return $false
  }
  $exe = Get-ChildItem -LiteralPath $extract -Recurse -Filter $ExeName -File | Select-Object -First 1
  if (-not $exe) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "The archive didn't contain $ExeName — the release may have changed shape."
    return $false
  }
  # Only installed when the exe is absent, so wiping $DestDir loses nothing.
  if (Test-Path -LiteralPath $DestDir) { Remove-Item -LiteralPath $DestDir -Recurse -Force }
  if ($ExeOnly) {
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    Move-Item -LiteralPath $exe.FullName -Destination (Join-Path $DestDir $ExeName) -Force
  } else {
    # The exe's whole directory comes along — whisper-cli.exe needs its DLLs.
    Move-Item -LiteralPath $exe.DirectoryName -Destination $DestDir
  }
  Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  return (Test-Path -LiteralPath (Join-Path $DestDir $ExeName))
}

# whisper-cli.exe links the Microsoft Visual C++ runtime, which is not part
# of Windows. Smoke-run it (with --help) to see whether its DLLs load: a
# clean PC without the runtime exits immediately with STATUS_DLL_NOT_FOUND
# (0xC0000135), and a process that can't start at all throws. Any other exit
# (even a non-zero "usage" code) means the binary loaded — that is what we
# test. Returns $true when whisper loaded, $false when the runtime is missing.
# Overrides (validation runs on a Mac, where whisper-cli.exe can't execute):
#   TRANSCRIBE_SETUP_WHISPER_SMOKE = program to run instead of whisper-cli.exe
#   TRANSCRIBE_SETUP_DLL_FAIL_CODE = extra exit code to treat as the DLL
#     failure (a Unix exit code can't be the real 0xC0000135, so the stub
#     uses a small sentinel instead).
function Test-WhisperDllLoad([string]$exe) {
  $probe = $exe
  if ($env:TRANSCRIBE_SETUP_WHISPER_SMOKE) { $probe = $env:TRANSCRIBE_SETUP_WHISPER_SMOKE }
  try {
    & $probe '--help' *> $null
  } catch {
    return $false
  }
  $code = $LASTEXITCODE
  if ($code -eq -1073741515) { return $false }   # 0xC0000135, signed int32
  if ($code -eq 3221225781)  { return $false }   # 0xC0000135, unsigned
  if ($env:TRANSCRIBE_SETUP_DLL_FAIL_CODE -and
      "$code" -eq "$env:TRANSCRIBE_SETUP_DLL_FAIL_CODE") { return $false }
  return $true
}

# Downloads (resumable) and silently installs the Microsoft Visual C++
# 2015-2022 x64 redistributable. Installer exit codes: 0 = installed,
# 3010 = installed but a reboot is needed, 1638 = a same-or-newer version is
# already present — all three mean the runtime is now available, so all three
# are success. Returns $true on any of them. Override for validation:
#   TRANSCRIBE_SETUP_VCREDIST_RUN = program to invoke with the install
#     switches instead of the downloaded exe.
function Install-VCRedist {
  New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
  $exe = Join-Path $StageDir 'vc_redist.x64.exe'
  if (-not (Invoke-CurlDownload (Resolve-Url $VCRedistUrl) $exe)) {
    return $false
  }
  $runner = $exe
  if ($env:TRANSCRIBE_SETUP_VCREDIST_RUN) { $runner = $env:TRANSCRIBE_SETUP_VCREDIST_RUN }
  try {
    & $runner '/install' '/quiet' '/norestart'
  } catch {
    Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    return $false
  }
  $code = $LASTEXITCODE
  Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
  return ($code -eq 0 -or $code -eq 3010 -or $code -eq 1638)
}

Write-Host "== Transcribe setup =="
Write-Host "This prepares your PC for Transcribe. Each step below says what it's"
Write-Host "doing. Everything is safe to run again later."
Write-Host ""

# 1. curl (the downloader that fetches everything else; ships with Windows 10+)
$Curl = Resolve-Curl
if ($Curl -eq '') {
  Write-Host "ERROR: curl.exe was not found. It ships with Windows 10 and newer —"
  Write-Host "update Windows, or install curl from https://curl.se, then re-run this file."
  if (-not [Console]::IsInputRedirected) { Read-Host "Press Enter to close" | Out-Null }
  exit 1
}

# A transient download failure (network hiccup, server blip) must not abort
# the whole run — note it, keep going, and say so at the end.
$installFailed = $false

# 2. whisper.cpp (the speech-recognition engine)
$WhisperDir = Join-Path $ToolsDir 'whisper'
$WhisperExe = Join-Path $WhisperDir 'whisper-cli.exe'
if (Test-Path -LiteralPath $WhisperExe) {
  Write-Host "Speech engine (whisper.cpp) already installed — skipping."
} else {
  Write-Host "Downloading the speech engine (whisper.cpp) — this can take a few minutes…"
  if (Install-ZipTool -Url $WhisperUrl -DestDir $WhisperDir -ExeName 'whisper-cli.exe') {
    Write-Host "Speech engine (whisper.cpp) installed."
  } else {
    Write-Host ""
    Write-Host "NOTE: Couldn't install the speech engine just now (no internet, or a"
    Write-Host "server hiccup — see above). Transcription needs it — run this file"
    Write-Host "again later to retry. The rest of setup continues below."
    Write-Host ""
    $installFailed = $true
  }
}

# 2b. whisper needs the Microsoft Visual C++ runtime (see $VCRedistUrl). It is
#     NOT part of Windows and NOT in the whisper zip, so on a clean PC the exe
#     can't even start — every later transcription would then fail with a
#     misleading error. Smoke-run whisper; if it can't load its DLLs, install
#     the redistributable and try once more. This runs on every setup and is
#     idempotent: a PC that already has the runtime passes the smoke test and
#     does nothing.
if (Test-Path -LiteralPath $WhisperExe) {
  if (-not (Test-WhisperDllLoad $WhisperExe)) {
    Write-Host "The speech engine needs the Microsoft Visual C++ runtime — installing it…"
    if (Install-VCRedist) {
      if (Test-WhisperDllLoad $WhisperExe) {
        Write-Host "Microsoft Visual C++ runtime installed — the speech engine is ready."
      } else {
        Write-Host ""
        Write-Host "NOTE: The speech engine still can't start after installing the Microsoft"
        Write-Host "Visual C++ runtime. Restart your PC and run this file again; if it keeps"
        Write-Host "failing, install ""Visual C++ Redistributable (x64)"" from Microsoft, then retry."
        Write-Host ""
        $installFailed = $true
      }
    } else {
      Write-Host ""
      Write-Host "NOTE: Couldn't install the Microsoft Visual C++ runtime just now (no"
      Write-Host "internet, or a server hiccup). The speech engine needs it — run this file"
      Write-Host "again later to retry."
      Write-Host ""
      $installFailed = $true
    }
  }
}

# 3. ffmpeg (reads the sound out of video files)
$FfmpegDir = Join-Path $ToolsDir 'ffmpeg'
if (Test-Path -LiteralPath (Join-Path $FfmpegDir 'ffmpeg.exe')) {
  Write-Host "Sound reader (ffmpeg) already installed — skipping."
} else {
  Write-Host "Downloading the sound reader (ffmpeg)…"
  if (Install-ZipTool -Url $FfmpegUrl -DestDir $FfmpegDir -ExeName 'ffmpeg.exe' -ExeOnly) {
    Write-Host "Sound reader (ffmpeg) installed."
  } else {
    Write-Host ""
    Write-Host "NOTE: Couldn't install the sound reader just now (no internet, or a"
    Write-Host "server hiccup — see above). Transcription needs it — run this file"
    Write-Host "again later to retry. The rest of setup continues below."
    Write-Host ""
    $installFailed = $true
  }
}

# 4. yt-dlp (downloads videos from YouTube / Instagram / TikTok links).
#    Video sites change constantly — an out-of-date downloader silently breaks
#    or quietly drops to low quality, so try to update it on EVERY run. The
#    exe build self-updates in place with -U (there is no package manager
#    to re-run). Override for validation: TRANSCRIBE_SETUP_YTDLP_UPDATE =
#    program to invoke with -U instead of the real exe.
$YtDlpDir = Join-Path $ToolsDir 'yt-dlp'
$YtDlpExe = Join-Path $YtDlpDir 'yt-dlp.exe'
if (Test-Path -LiteralPath $YtDlpExe) {
  Write-Host "Updating the video downloader (yt-dlp) — sites change often, this keeps links working…"
  $updater = $YtDlpExe
  if ($env:TRANSCRIBE_SETUP_YTDLP_UPDATE) { $updater = $env:TRANSCRIBE_SETUP_YTDLP_UPDATE }
  $updOK = $false
  try {
    & $updater '-U'
    if ($LASTEXITCODE -eq 0) { $updOK = $true }
  } catch { }
  if (-not $updOK) {
    Write-Host ""
    Write-Host "NOTE: Couldn't update the video downloader just now (no internet?)."
    Write-Host "Everything else still works. If video links stop downloading later,"
    Write-Host "run this file again while online."
    Write-Host ""
  }
} else {
  Write-Host "Installing the video downloader (yt-dlp)…"
  New-Item -ItemType Directory -Force -Path $StageDir | Out-Null
  $ytStage = Join-Path $StageDir 'yt-dlp.exe'
  if (Invoke-CurlDownload (Resolve-Url $YtDlpUrl) $ytStage) {
    New-Item -ItemType Directory -Force -Path $YtDlpDir | Out-Null
    Move-Item -LiteralPath $ytStage -Destination $YtDlpExe -Force
    Write-Host "Video downloader (yt-dlp) installed."
  } else {
    Write-Host ""
    Write-Host "NOTE: Couldn't download the video downloader (no internet?). You can"
    Write-Host "still transcribe files that are already on this PC — run this file"
    Write-Host "again later to add support for video links."
    Write-Host ""
  }
}

# 5. deno (yt-dlp needs a JavaScript runtime to keep YouTube links working)
$DenoDir = Join-Path $ToolsDir 'deno'
if (Test-Path -LiteralPath (Join-Path $DenoDir 'deno.exe')) {
  Write-Host "Link helper (deno) already installed — skipping."
} else {
  Write-Host "Installing the link helper (deno) — YouTube links need it…"
  if (Install-ZipTool -Url $DenoUrl -DestDir $DenoDir -ExeName 'deno.exe') {
    Write-Host "Link helper (deno) installed."
  } else {
    Write-Host ""
    Write-Host "NOTE: Couldn't download the link helper (no internet?). Video links"
    Write-Host "may stop working until it's installed — run this file again later"
    Write-Host "to retry."
    Write-Host ""
  }
}

# 6. Speech models. Downloads go to a .download file first and are only moved
#    into place once complete — so an interrupted download can never
#    masquerade as a working model, and re-running resumes (curl -C -) instead
#    of restarting a multi-GB fetch. When the server is reachable we ask it
#    for each model's exact byte size and require an exact match before
#    trusting any file; offline, we fall back to resuming anything that isn't
#    plausibly sized (and never promote a leftover partial by size alone).

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$downloadFailed = $false

# Which models to fetch this run: the two main ones always; the optional small
# ones with -AllModels, on request, or when a (possibly partial) copy is
# already here — a leftover .download is always finished, never abandoned.
# -ToolsOnly (CI smoke) skips models entirely.
$fetchList = @()
if (-not $ToolsOnly) {
  $fetchList = @() + $Models
  $wantOptional = [bool]$AllModels
  if (-not $wantOptional -and -not [Console]::IsInputRedirected) {
    Write-Host ""
    Write-Host "The app can also use smaller, faster (less accurate) models:"
    Write-Host "  Medium ~1.5GB · Small ~0.5GB · Base ~150MB · Tiny ~80MB"
    $extraAns = Read-Host "Download the extra models too? [y/N]"
    if ("$extraAns" -match '^(y|Y|yes|YES)$') { $wantOptional = $true }
    Write-Host ""
  }
  foreach ($m in $OptionalModels) {
    $have = (Test-Path -LiteralPath (Join-Path $ModelsDir $m)) -or
            (Test-Path -LiteralPath (Join-Path $ModelsDir "$m.download"))
    if ($wantOptional -or $have) { $fetchList += $m }
  }
}

foreach ($m in $fetchList) {
  $final = Join-Path $ModelsDir $m
  $stage = "$final.download"
  $min = Get-MinSize $m
  $expected = Get-ExpectedSize (Resolve-Url "$BaseUrl/$m")
  if ($expected -notmatch '^\d+$') { $expected = '' }

  if (Test-Path -LiteralPath $final) {
    $size = Get-FileSize $final
    if ($expected -ne '') {
      if ($size -eq [long]$expected) {
        Write-Host "Model $m already downloaded — skipping."
        continue
      }
      # The real size disagrees with the server — an earlier run left a
      # partial (or damaged) file here. Keep the bytes and finish the job.
      Write-Host "Model $m is incomplete — resuming its download…"
      Move-Item -LiteralPath $final -Destination $stage -Force
    } elseif ($size -ge $min) {
      # Offline, so the exact size can't be checked — keep a plausibly sized
      # model rather than re-downloading gigabytes.
      Write-Host "Model $m already downloaded — skipping."
      continue
    } else {
      Write-Host "Model $m looks incomplete — resuming its download…"
      Move-Item -LiteralPath $final -Destination $stage -Force
    }
  }

  # A leftover .download is NEVER promoted as-is, whatever its size: curl
  # always gets a chance to top it off first (a file that is already complete
  # fetches zero extra bytes), and only an exact size match makes it a model.
  if (Test-Path -LiteralPath $stage) {
    Write-Host "Resuming the download of model $m (this can take a while)…"
  } else {
    Write-Host "Downloading model $m (this can take a while)…"
  }
  if (Invoke-CurlDownload (Resolve-Url "$BaseUrl/$m") $stage) {
    $size = Get-FileSize $stage
    if ($expected -ne '' -and $size -ne [long]$expected) {
      Remove-Item -LiteralPath $stage -Force
      Write-Host "Model $m came through the wrong size — something went wrong at the source."
      Write-Host "Run this file again to retry."
      $downloadFailed = $true
    } elseif ($expected -eq '' -and $size -lt $min) {
      Remove-Item -LiteralPath $stage -Force
      Write-Host "Model $m came through too small — something went wrong at the source."
      Write-Host "Run this file again to retry."
      $downloadFailed = $true
    } else {
      Move-Item -LiteralPath $stage -Destination $final -Force
      Write-Host "Model $m downloaded."
    }
  } else {
    Write-Host "Model $m didn't finish downloading (connection dropped?)."
    Write-Host "Run this file again — it continues from where it stopped."
    $downloadFailed = $true
  }
}

# 7. Repair what copying this folder between PCs can break: the mark-of-the-web
#    that makes SmartScreen warn on every launch (the Windows sibling of
#    setup.command's quarantine fix). Top-level files (Transcribe.exe lives
#    there) plus the tools — models are plain data and carry no mark.
try {
  Get-ChildItem -LiteralPath $Root -File -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $ToolsDir) {
    Get-ChildItem -LiteralPath $ToolsDir -Recurse -File -ErrorAction SilentlyContinue |
      Unblock-File -ErrorAction SilentlyContinue
  }
} catch { }

Write-Host ""
if ($installFailed) {
  Write-Host "Setup is almost done — one of the tools couldn't be installed (see the"
  Write-Host "notes above). Double-click ""Transcribe Setup"" again to retry."
} elseif ($downloadFailed) {
  Write-Host "Setup is almost done — one of the model downloads didn't finish."
  Write-Host "Double-click ""Transcribe Setup"" again to resume it."
} else {
  Write-Host "Setup complete. Double-click Transcribe.exe to transcribe videos."
  Write-Host ""
  Write-Host "If Windows says it protected your PC (SmartScreen): click ""More info"","
  Write-Host "then ""Run anyway"". Once only."
}
if (-not [Console]::IsInputRedirected) { Read-Host "Press Enter to close" | Out-Null }
if ($installFailed -or $downloadFailed) { exit 1 }
exit 0
