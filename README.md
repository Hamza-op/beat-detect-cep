# AutoCut Studio

Version: `1.1.0`

AutoCut Studio is a Windows-first Adobe Premiere Pro tool for beat-grid edit markers, automated timeline helpers, and native color-correction work. The beat analyzer is tuned for Hindi, Urdu, and Punjabi wedding edits where useful cut points often come from dhol/tabla hits, claps, drops, and strong rhythmic sections.

The extension is a vanilla CEP panel backed by a bundled Rust analyzer. The editor machine only needs Premiere Pro and `AutoCutStudioSetup.exe`; Python, Cargo, Rust, FFmpeg, and manual library installs are not user requirements.

## Features

- Premiere Pro CEP panel: `Window -> Extensions -> AutoCut Studio`
- One-click analysis of the selected timeline clip's source media
- Resolve-style beat detection for a consistent clip beat grid
- Marker target:
  - `Sequence Markers`
  - `Clip Markers`
- Automatic beat marker selection without manual density tuning
- Adaptive spacing so weak nearby events are suppressed but strong nearby dhol/tabla hits can survive
- Final marker selection keeps only the strongest event per whole second
- Beat-score marker color while marker name/comment fields remain blank
- Exact marker count mode with Balanced, Strongest, and Spread selection strategies
- Native AutoCutStudio color correction that samples the current playhead frame and applies one fixed 8/16/32-bpc grade across the selected clip
- One-by-one Warp Stabilizer queue for selected video clips
- Remove blank AutoCut Studio markers from the selected target/range
- Diagnostics button for CEP, Premiere selection, marker API, and analyzer checks
- Browser preview mode by opening `index.html` without Premiere
- Single Windows setup executable

## Repository Layout

```text
config/product.json    Product and artifact source of truth
apps/cep-panel/        TypeScript panel, ES3 host sources, styles, tests
crates/analyzer/       Rust analyzer library and thin CLI
crates/installer/      Transactional Windows installer library and CLI
native/color-core/     Production color algorithm and native tests
native/premiere-plugin/ Premiere `.aex` effect
vendor/adobe-sdk/      Adobe SDK headers and utilities
tools/                 Build, package, verify, and preview scripts
```

Generated files are ignored by Git:

```text
bin/beat_analyzer.exe
dist/
AutoCutStudioSetup.exe
AutoCutStudio-CEP-Windows.zip
target/
crates/*/target/
```

## User Install

Download `AutoCutStudioSetup.exe` from a GitHub release and run it.

The installer:

- installs the extension to:

```text
%APPDATA%\Adobe\CEP\extensions\com.autocutstudio.panel
```

- enables unsigned CEP loading only for Adobe `CSXS.11` through `CSXS.13` registry keys
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
- Visual Studio Build Tools 2022 or newer with MSBuild and the Windows 10 SDK

These prerequisites are only for building the installer and native color plugin. Editing machines do not need them.

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

The package script builds the Rust analyzer and the native `AutoCutColorEngine.aex` before embedding runtime files. If MSBuild is unavailable, it refuses to package a missing or stale native plugin instead of silently shipping an old color engine.

Release artifacts are explicitly labeled unsigned unless signing is configured. See [docs/release/README.md](docs/release/README.md) for the out-of-scope signing integration.

## GitHub Release Build

This repository includes a Windows CI and release workflow:

```text
.github/workflows/ci.yml
```

CI runs on:

- every push to the repository
- pull requests
- every push
- explicit `v*` tags

GitHub releases are published only for explicit `v*` tags. Other pushes run
validation jobs without publishing artifacts.

The workflow builds and publishes:

```text
AutoCutStudioSetup.exe
AutoCutStudio-CEP-Windows.zip
```

`AutoCutStudioSetup.exe` is the recommended download for editors. The ZIP is included for manual CEP installation/debugging.

## Analyzer CLI

After building:

```powershell
.\bin\beat_analyzer.exe "C:\path\to\song-or-video.mp4"
```

The analyzer has one detection workflow: beat detection.

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
$json = & .\bin\beat_analyzer.exe $media
$events = $json | ConvertFrom-Json
$selected = $events |
  Where-Object { [double]$_.score -ge $threshold } |
  Group-Object { [math]::Floor([double]$_.time) } |
  ForEach-Object { $_.Group | Sort-Object score -Descending | Select-Object -First 1 } |
  Sort-Object time
$lines = @(
  "AutoCut Studio Beat Analysis Report",
  "Media: $media",
  "Threshold: $threshold",
  "Raw beat count: $($events.Count)",
  "Selected beat count: $($selected.Count)",
  "",
  "time_seconds`tscore"
)
$lines += $selected | ForEach-Object { "{0:N3}`t{1:N3}" -f [double]$_.time, [double]$_.score }
Set-Content -LiteralPath "$outDir\o-rangrez-beats-threshold-050.txt" -Value $lines -Encoding UTF8
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
