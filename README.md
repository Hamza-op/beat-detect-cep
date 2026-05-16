# Beat Detect Spike Marker

Version: `1.0.0`

Beat Detect is a Windows-first Adobe Premiere Pro CEP extension for adding edit markers from music/audio events. It is tuned for Hindi, Urdu, and Punjabi wedding edits where useful cut points often come from dhol/tabla hits, drops, vocal phrase starts, and musical section changes.

The extension is a vanilla CEP panel backed by a Rust analyzer. The analyzer decodes audio from common audio/video containers and prints clean JSON for the panel to filter and apply as Premiere markers.

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
- Hard rule: only the strongest event per second is applied
- Adaptive spacing so weak nearby events are suppressed but strong nearby hits can survive
- Mode-specific marker naming and colors
- Remove only Beat Detect markers from the selected target/range
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

## Premiere Workflow

1. Open a Premiere sequence.
2. Select one timeline clip with linked source media.
3. Choose `Sequence Markers` or `Clip Markers`.
4. Choose detection focus: `Spikes`, `Music`, or `Vocal`.
5. Click `Analyze Track`.
6. Adjust marker density.
7. Click `Apply Markers to Timeline`.

To clean generated markers, keep the same marker target selected and click:

```text
Remove Beat Detect Markers
```

Removal only targets markers created by this extension:

```text
BD Spike
BD Music
BD Vocal
BD Event
```

Normal editor-created Premiere markers are not intentionally removed.

## Detection Notes

The analyzer uses two independent methods and fuses them:

- spectral-band novelty:
  - `40-140 Hz` low impact
  - `140-900 Hz` body
  - `2-6 kHz` attack
  - `200 Hz-3 kHz` vocal/melodic movement
  - wideband section rise
- waveform-envelope onset:
  - RMS rise
  - peak rise

Scores use non-saturated calibrated confidence. This keeps the density slider useful instead of flattening many events to `1.000`.

Panel filtering then applies:

- threshold filtering
- adaptive strongest-in-window spacing
- hard one-marker-per-second suppression

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
- No FFmpeg runtime is required; decoding is handled by Rust/Symphonia.
- The setup executable installs an unsigned CEP extension. For wider public distribution, signing/ZXP packaging can be added later.
