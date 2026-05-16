Role: Senior Audio DSP Engineer & Adobe Creative Cloud Extensibility Developer

Objective:
Build a lightweight, high-performance Adobe Premiere Pro CEP extension panel for intelligent, automated rhythm and audio event detection. The tool is engineered specifically for South Asian (Hindi, Urdu, Punjabi) wedding videos, naturally adapting to fluid tempos, massive percussion drops (dhol/tabla), and emotional vocal sections (alaaps, lyrics). It must require zero manual mode tweaking from the user, operating entirely via a single "Analyze Track" button and an interactive review slider.

---

### Technical Architecture & Data Pipeline
1. Frontend UI: Adobe Premiere Pro CEP Extension Panel (HTML5, CSS, vanilla JavaScript/Node.js environment).
2. Bridge: Node.js enabled inside the CEP context (`CSXS/manifest.xml`) executing a bundled, compiled native background binary via `child_process.execFile`.
3. Backend DSP Engine: Cross-compiled pure Rust binary (.exe for Windows, extensionless native binary for macOS) with no external runtime dependencies.
4. Output Cycle: 
   - Rust analyzes the source file path and prints a JSON array of structured objects to stdout containing timestamps and normalized significance scores: `[{"time": 0.42, "score": 0.95}, {"time": 0.85, "score": 0.41}]`.
   - The JS frontend captures this array, updates the UI live using an interactive slider filter, and triggers Premiere's ExtendScript API (`sequence.markers.createMarker` or `clip.markers.createMarker`) to instantly drop the frame-accurate markers.

---

### Critical Workflow Requirements

1. Native Video Container Handling (Container Agnostic)
Wedding editors frequently drag music videos (.mp4, .mov, .mkv) onto the timeline and strip/delete the video track. The Premiere API passes the path of the original underlying video file. The Rust backend MUST use the `symphonia` crate (with `all-formats`, `isomp4`, and `mkv` features enabled) to demux the video container on the fly, isolate the inner compressed audio track (AAC/MP3/PCM), and stream it into the DSP analysis engine without crashing or requiring manual transcoding.

2. Automated Dual-Stream Fusion DSP
The backend must run a parallel audio analysis loop that avoids a simple rigid 4/4 BPM grid, focusing instead on calculating a rolling "Event Significance Score" (0.0 to 1.0) based on two streams:
   - Stream A (Transient Spikes): Low-pass filter (40 Hz - 120 Hz) to catch deep dhol bass beats, combined with a band-pass filter (2 kHz - 5 kHz) to catch sharp tabla/dholak wooden hand slaps and rim shots.
   - Stream B (Vocal Onsets): Band-pass filter (200 Hz - 3 kHz) targeting vocal spectral novelty. This captures when a singer breaks a pause, transitions to a new verse, or triggers a melodic/instrumental crescendo (e.g., a sudden shehnai/violin swell during a Rukhsati or Entry).
   - Dynamic Weighting: In quiet, low-percussion zones, vocal/melodic shifts naturally dominate the score. In high-energy dance sequences, percussion transients naturally dominate.

3. Front-End Density Slider & Review Workflow
To prevent timeline marker clutter, the frontend must execute a two-step generation cycle:
   - Step 1 (Analyze): The user clicks "Analyze Track". The Rust binary analyzes the track in milliseconds and returns the full JSON map of all detected micro and macro beats to the JS memory. The panel updates to show text: "Analysis Complete: Found X total rhythmic events."
   - Step 2 (Filter Slider): Below the message, a native HTML range slider spans from "Major Beats Only" (threshold 0.8) to "Show All Micro-Beats" (threshold 0.2). Moving the slider dynamically filters the JS array data in real-time, live-updating the numeric event counter on the screen.
   - Step 3 (Apply): A final button labeled "Apply Markers to Timeline" takes the currently filtered list and pushes them directly into Premiere.

4. User UI Layout Controls
The CEP panel must feature:
   - An "Analyze Track" action button.
   - The real-time interactive "Marker Density Slider" (hidden until analysis finishes, then fades in).
   - A Dropdown Menu for "Marker Target": 
     - Option A: "Sequence Markers" (drops markers on the main timeline time ruler above the audio).
     - Option B: "Clip Markers" (drops markers directly onto the selected audio clip block so they move when the clip moves).
   - An "Apply Markers to Timeline" action button.

---

### System Implementation Steps
Please generate the complete project directory layout and provide the step-by-step implementation code, starting with Phase 1: The Rust backend configuration (`Cargo.toml` dependencies with full symphonia container/decoder feature flags) and the core multi-band processing loop.