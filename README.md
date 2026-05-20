# Beat Detect Spike Marker

Version: `1.0.0`

Beat Detect is a Windows-first Adobe Premiere Pro CEP extension for adding edit markers from music/audio events. It is tuned for Hindi, Urdu, and Punjabi wedding edits where useful cut points often come from dhol/tabla hits, drops, vocal phrase starts, and musical section changes.

The extension is a vanilla CEP panel backed by a bundled Rust analyzer. It can also merge in a bundled native Essentia runner when `bin/essentia_beats.exe` is included in the build. The editor machine only needs Premiere Pro and `BeatDetectSetup.exe`; Python, Cargo, Rust, FFmpeg, and manual library installs are not user requirements.

## Features

- Premiere Pro CEP panel: `Window -> Extensions -> Beat Detect`
- One-click analysis of the selected timeline clip's source media
- Three detection modes:
  - `Spikes`: percussion hits, dhol/kick impact, drops, sharp accents
  - `Music`: music spikes plus vocal/melodic phrase starts
  - `Vocal`: vocal and melodic phrase entries
- Marker target:
  - `Sequence Markers`
  - `Clip Markers`
- Density slider from `0.20` to `0.80`
- Adaptive spacing so weak nearby events are suppressed but strong nearby dhol/tabla hits can survive
- Final marker selection keeps only the strongest event per whole second
- Score/mode-based marker colors while marker name/comment fields remain blank
- Exact marker count mode with Balanced, Strongest, and Spread selection strategies
- One-by-one Warp Stabilizer queue for selected video clips
- Remove blank Beat Detect markers from the selected target/range
- Diagnostics button for CEP, Premiere selection, marker API, and analyzer checks
- Browser preview mode by opening `index.html` without Premiere
- Single Windows setup executable
- Optional bundled Essentia steady-beat support via `bin/essentia_beats.exe`

## Repository Layout

```text
CSXS/                  CEP manifest
css/                   Panel styles
js/                    CEP panel JavaScript
jsx/                   Premiere ExtendScript bridge
analyzer/              Rust audio analyzer
installer/             Rust single-file Windows setup builder
scripts/               Build/package scripts
bin/.gitkeep           Runtime binary folder placeholder
index.html             CEP panel entry point
```

Generated files are ignored by Git:

```text
bin/beat_analyzer.exe
bin/essentia_beats.exe
dist/
BeatDetectSetup.exe
BeatDetect-CEP-Windows.zip
analyzer/target/
installer/target/
```

## User Install

Download `BeatDetectSetup.exe` from a GitHub release and run it.

The installer:

- installs the extension to:

```text
%APPDATA%\Adobe\CEP\extensions\com.beatdetect.spikemarker
```

- enables unsigned CEP loading for common Adobe `CSXS.7` through `CSXS.15` registry keys
- writes install logs to:

```text
%APPDATA%\BeatDetect\install.log
```

Restart Premiere Pro after installing, then open:

```text
Window -> Extensions -> Beat Detect
```

## Local Build On Windows

Prerequisites:

- Windows
- PowerShell
- Rust stable toolchain

These prerequisites are only for building the installer. Editing machines do not need them.

Build the analyzer only:

```powershell
.\scripts\build-windows.ps1
```

Create a copy-paste CEP folder:

```powershell
.\scripts\package-extension.ps1
```

Output:

```text
dist\com.beatdetect.spikemarker
```

Build the single setup executable:

```powershell
.\scripts\build-setup-exe.ps1
```

Output:

```text
BeatDetectSetup.exe
```

Beat Detect can merge an optional native Essentia runner if one is bundled as `bin\essentia_beats.exe`. On Windows, Essentia's Python bindings are not currently a reliable build path, so the recommended shipping path remains the Rust analyzer unless a native Essentia runner is built separately.

If you already have a Python environment where `import essentia.standard` works, this helper can package it into a runner:

```powershell
.\scripts\build-essentia-runner.ps1 -PythonPath "C:\Path\To\python.exe"
```

That script requires Python packages `essentia` and `PyInstaller` on the build PC only. It creates:

```text
bin\essentia_beats.exe
```

Then build the full single-file installer:

```powershell
.\scripts\build-setup-exe.ps1 -WithEssentia -PythonPath "C:\Path\To\python.exe"
```

The setup builder embeds every packaged runtime file, so the final editor install still remains one file: `BeatDetectSetup.exe`.

If Python Essentia fails on Windows, do not install anything on editor machines. Either ship the Rust-only installer or build a native C++ Essentia runner that matches the JSON contract below.

## GitHub Release Build

This repository includes a Windows release workflow:

```text
.github/workflows/release-windows.yml
```

It runs on:

- every push to the repository
- manual `workflow_dispatch`

Releases are generated automatically for every push with the tag `build-<run_number>`.

The workflow builds and publishes:

```text
BeatDetectSetup.exe
BeatDetect-CEP-Windows.zip
```

`BeatDetectSetup.exe` is the recommended download for editors. The ZIP is included for manual CEP installation/debugging.

## Analyzer CLI

After building:

```powershell
.\bin\beat_analyzer.exe --mode music "C:\path\to\song-or-video.mp4"
```

Modes:

```text
spikes
music
vocal
```

Expected stdout is JSON only:

```json
[{"time":25.739,"score":0.963}]
```

Errors are written to stderr with a non-zero exit code.

## Optional Essentia Runner Contract

The panel automatically runs `bin\essentia_beats.exe` when it is bundled. It must accept:

```powershell
.\bin\essentia_beats.exe --mode music "C:\path\to\song-or-video.mp4"
```

Expected stdout is JSON only. Supported shapes:

```json
{"bpm":96.0,"confidence":0.74,"events":[{"time":25.739,"score":0.68}]}
```

or:

```json
{"bpm":96.0,"confidence":0.74,"beats":[25.739,26.364]}
```

Beat Detect uses Essentia events as steady beat-grid support. The custom Rust analyzer still owns dhol/tabla hits, vocal phrase entries, drops, and edit accents.

## Local Song Test Reports

To test the bundled analyzer against a real song, build first:

```powershell
.\scripts\build-setup-exe.ps1
```

Then run all three modes at the same `0.50` marker threshold used for review reports:

```powershell
$media = "C:\Users\User\Downloads\Video\O Rangrez Full Video - Bhaag Milkha Bhaag_Farhan, Sonam_Shreya Ghoshal, Javed Bashir_3.mp4"
$outDir = ".\analysis-reports"
$threshold = 0.50
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($mode in "spikes", "music", "vocal") {
  $json = & .\bin\beat_analyzer.exe --mode $mode $media
  $events = $json | ConvertFrom-Json
  $selected = $events |
    Where-Object { [double]$_.score -ge $threshold } |
    Group-Object { [math]::Floor([double]$_.time) } |
    ForEach-Object { $_.Group | Sort-Object score -Descending | Select-Object -First 1 } |
    Sort-Object time
  $lines = @(
    "Beat Detect Analysis Report",
    "Mode: $mode",
    "Media: $media",
    "Threshold: $threshold",
    "Raw event count: $($events.Count)",
    "Selected event count: $($selected.Count)",
    "",
    "time_seconds`tscore"
  )
  $lines += $selected | ForEach-Object { "{0:N3}`t{1:N3}" -f [double]$_.time, [double]$_.score }
  Set-Content -LiteralPath "$outDir\o-rangrez-$mode-threshold-050.txt" -Value $lines -Encoding UTF8
}
```

Current generated threshold reports in this repo:

```text
analysis-reports\o-rangrez-spikes-threshold-050.txt
analysis-reports\o-rangrez-music-threshold-050.txt
analysis-reports\o-rangrez-vocal-threshold-050.txt
```

## Premiere Workflow

1. Open a Premiere sequence.
2. Select one timeline clip with linked source media.
3. Choose `Sequence Markers` or `Clip Markers`.
4. Choose detection focus: `Spikes`, `Music`, or `Vocal`.
5. Click `Analyze Track`.
6. Adjust marker density, or enter an exact target marker count.
7. Click `Apply Markers to Timeline`.

To clean generated markers, keep the same marker target selected and click:

```text
Remove Beat Detect Markers
```

Beat Detect applies blank markers: marker name and comments are intentionally empty. Marker color carries the event category signal. Because the markers are intentionally blank, avoid using the remove button on ranges that contain user-created blank markers you want to keep.

## Warp Stabilizer Queue

Select multiple video clips and click `Apply Warp Stabilizer`. Beat Detect applies the effect to one selected clip, waits for Premiere's video-effect analysis state to report complete, then moves to the next selected clip.

This uses Premiere's QE DOM to apply the named video effect and `Sequence.isDoneAnalyzingForVideoEffects()` to wait between clips. If a Premiere version does not expose either API, the panel reports the failure instead of continuing blindly.

## Detection Notes

The core Rust analyzer uses two independent methods and fuses them:

- spectral-band novelty:
  - `45-180 Hz` dhol/kick impact
  - `180-950 Hz` tabla/dholak body
  - `1.2-8 kHz` slap, clap, and stick attack
  - `250 Hz-4 kHz` vocal/melodic movement
  - wideband section rise
- waveform-envelope onset:
  - RMS rise
  - peak rise
  - immediate frame-to-frame transient rise

Scores use non-saturated calibrated confidence. This keeps the density slider useful instead of flattening many events to `1.000`.

Panel filtering then applies:

- threshold filtering
- adaptive strongest-in-window spacing
- one strongest selected event per whole second
- optional extra thinning at the strict end of the slider

When the bundled Essentia runner is present, the panel also merges its steady beat positions. Nearby Essentia beats raise confidence on Rust events; strong Essentia-only beats can be added in `spikes` and `music` modes. `vocal` mode does not add Essentia-only beats because vocal phrase entries are not the same thing as a beat grid.

## Logs

Installer log:

```text
%APPDATA%\BeatDetect\install.log
```

Panel runtime log:

```text
%APPDATA%\BeatDetect\panel.log
```

## Current Scope

- Windows is the supported production target.
- Premiere Pro CEP is the extension platform.
- No FFmpeg, Python, Cargo, or Rust runtime is required on editor machines; runtime decoding is handled by bundled binaries.
- The setup executable installs an unsigned CEP extension. For wider public distribution, signing/ZXP packaging can be added later.
