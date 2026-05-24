# AutoCut Studio

Version: `1.0.0`

AutoCut Studio is a Windows-first Adobe Premiere Pro tool for music-aware edit markers, automated timeline helpers, and native color-correction work. It is tuned for Hindi, Urdu, and Punjabi wedding edits where useful cut points often come from dhol/tabla hits, drops, and strong musical section changes.

The extension is a vanilla CEP panel backed by a bundled Rust analyzer. The editor machine only needs Premiere Pro and `AutoCutStudioSetup.exe`; Python, Cargo, Rust, FFmpeg, and manual library installs are not user requirements.

## Features

- Premiere Pro CEP panel: `Window -> Extensions -> AutoCut Studio`
- One-click analysis of the selected timeline clip's source media
- Resolve-style `Beats` mode for a consistent music beat grid
- Marker target:
  - `Sequence Markers`
  - `Clip Markers`
- Automatic beat marker selection without manual density tuning
- Adaptive spacing so weak nearby events are suppressed but strong nearby dhol/tabla hits can survive
- Final marker selection keeps only the strongest event per whole second
- Score/mode-based marker colors while marker name/comment fields remain blank
- Exact marker count mode with Balanced, Strongest, and Spread selection strategies
- One-by-one Warp Stabilizer queue for selected video clips
- Remove blank AutoCut Studio markers from the selected target/range
- Diagnostics button for CEP, Premiere selection, marker API, and analyzer checks
- Browser preview mode by opening `index.html` without Premiere
- Single Windows setup executable

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
dist/
AutoCutStudioSetup.exe
AutoCutStudio-CEP-Windows.zip
analyzer/target/
installer/target/
```

## User Install

Download `AutoCutStudioSetup.exe` from a GitHub release and run it.

The installer:

- installs the extension to:

```text
%APPDATA%\Adobe\CEP\extensions\com.autocutstudio.panel
```

- enables unsigned CEP loading for common Adobe `CSXS.7` through `CSXS.15` registry keys
- writes install logs to:

```text
%APPDATA%\AutoCutStudio\install.log
```

Restart Premiere Pro after installing, then open:

```text
Window -> Extensions -> AutoCut Studio
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
dist\com.autocutstudio.panel
```

Build the single setup executable:

```powershell
.\scripts\build-setup-exe.ps1
```

Output:

```text
AutoCutStudioSetup.exe
```

The setup builder embeds only the whitelisted runtime files needed by the beats-only workflow, so stale optional binaries cannot enter a release accidentally.

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
AutoCutStudioSetup.exe
AutoCutStudio-CEP-Windows.zip
```

`AutoCutStudioSetup.exe` is the recommended download for editors. The ZIP is included for manual CEP installation/debugging.

## Analyzer CLI

After building:

```powershell
.\bin\beat_analyzer.exe --mode beats "C:\path\to\song-or-video.mp4"
```

Modes:

```text
beats
```

Expected stdout is JSON only:

```json
[{"time":25.739,"score":0.963}]
```

Errors are written to stderr with a non-zero exit code.

## Local Song Test Reports

To test the bundled analyzer against a real song, build first:

```powershell
.\scripts\build-setup-exe.ps1
```

Then run the beats analyzer at the marker threshold used for review reports:

```powershell
$media = "C:\Users\User\Downloads\Video\O Rangrez Full Video - Bhaag Milkha Bhaag_Farhan, Sonam_Shreya Ghoshal, Javed Bashir_3.mp4"
$outDir = ".\analysis-reports"
$threshold = 0.50
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($mode in "beats") {
  $json = & .\bin\beat_analyzer.exe --mode $mode $media
  $events = $json | ConvertFrom-Json
  $selected = $events |
    Where-Object { [double]$_.score -ge $threshold } |
    Group-Object { [math]::Floor([double]$_.time) } |
    ForEach-Object { $_.Group | Sort-Object score -Descending | Select-Object -First 1 } |
    Sort-Object time
  $lines = @(
    "AutoCut Studio Analysis Report",
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
analysis-reports\o-rangrez-beats-threshold-050.txt
```

## Premiere Workflow

1. Open a Premiere sequence.
2. Select one timeline clip with linked source media.
3. Choose `Sequence Markers` or `Clip Markers`.
4. Click `Analyze Track`.
5. Click `Apply Markers to Timeline`.

To clean generated markers, keep the same marker target selected and click:

```text
Remove AutoCut Studio Markers
```

AutoCut Studio applies blank markers: marker name and comments are intentionally empty. Marker color carries the event category signal. Because the markers are intentionally blank, avoid using the remove button on ranges that contain user-created blank markers you want to keep.

## Warp Stabilizer Queue

Select multiple video clips and click `Apply Warp Stabilizer`. AutoCut Studio applies the effect to one selected clip, waits for Premiere's video-effect analysis state to report complete, then moves to the next selected clip.

This uses Premiere's QE DOM to apply the named video effect and `Sequence.isDoneAnalyzingForVideoEffects()` to wait between clips. If a Premiere version does not expose either API, the panel reports the failure instead of continuing blindly.

## Detection Notes

The core Rust analyzer uses multiple onset methods and fuses them:

- spectral-band novelty:
  - `45-180 Hz` dhol/kick impact
  - `180-950 Hz` tabla/dholak body
  - `1.2-8 kHz` slap, clap, and stick attack
  - wideband section rise
- waveform-envelope onset:
  - RMS rise
  - peak rise
  - immediate frame-to-frame transient rise
- log-frequency SuperFlux-style onset scoring:
  - 40 log-spaced bands from `45 Hz-10 kHz`
  - dhol/tabla-focused weighting around bass impact, drum body, and slap/attack bands
- local robust normalization:
  - each section is judged against its own recent context, so late quiet hits are not buried by loud earlier drops
  - direct onset-evidence gating prevents steady hum/noise sections from producing fake markers

Scores use non-saturated calibrated confidence, but the panel now uses the `beats` grid output directly instead of asking the editor to tune density.

Panel filtering then applies:

- threshold filtering
- adaptive strongest-in-window spacing
- one strongest selected event per whole second
- optional extra thinning at the strict end of the slider

The panel uses one Rust `beats` grid path so marker output stays coherent instead of blending unrelated detector styles.

## Logs

Installer log:

```text
%APPDATA%\AutoCutStudio\install.log
```

Panel runtime log:

```text
%APPDATA%\AutoCutStudio\panel.log
```

## Current Scope

- Windows is the supported production target.
- Premiere Pro CEP is the extension platform.
- No FFmpeg, Python, Cargo, or Rust runtime is required on editor machines; runtime decoding is handled by bundled binaries.
- The setup executable installs an unsigned CEP extension. For wider public distribution, signing/ZXP packaging can be added later.
