(function () {
  "use strict";

  var cs = new CSInterface();
  var APP_VERSION = "1.0.0";
  var state = {
    allEvents: [],
    filteredEvents: [],
    clip: null,
    isBusy: false
  };

  var dom = {
    analyzeButton:    document.getElementById("analyzeButton"),
    randomizeButton:  document.getElementById("randomizeButton"),
    diagnosticsButton:document.getElementById("diagnosticsButton"),
    applyButton:      document.getElementById("applyButton"),
    removeButton:     document.getElementById("removeButton"),
    gimbalZoomButton: document.getElementById("gimbalZoomButton"),
    status:           document.getElementById("status"),
    densityPanel:     document.getElementById("densityPanel"),
    densitySlider:    document.getElementById("densitySlider"),
    thresholdLabel:   document.getElementById("thresholdLabel"),
    filteredCount:    document.getElementById("filteredCount"),
    totalCount:       document.getElementById("totalCount"),
    markerTarget:     document.getElementById("markerTarget"),
    zoomSlider:       document.getElementById("zoomSlider"),
    zoomLabel:        document.getElementById("zoomLabel"),
    targetCountInput: document.getElementById("targetCountInput"),
    targetCountHint:  document.getElementById("targetCountHint")
  };

  function getDetectionFocus() {
    var selected = document.querySelector("input[name='detectionFocus']:checked");
    return selected ? selected.value : "spikes";
  }

  function syncModeSelection() {
    var options = document.querySelectorAll(".mode-option");
    for (var i = 0; i < options.length; i++) {
      var input = options[i].querySelector("input");
      options[i].classList.toggle("is-selected", Boolean(input && input.checked));
    }
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    dom.analyzeButton.disabled   = isBusy;
    dom.diagnosticsButton.disabled = isBusy;
    dom.removeButton.disabled    = isBusy;
    if (dom.randomizeButton) dom.randomizeButton.disabled = isBusy || state.allEvents.length === 0;
    if (dom.gimbalZoomButton) dom.gimbalZoomButton.disabled = isBusy;
    dom.applyButton.disabled = isBusy || state.filteredEvents.length === 0;
  }

  function setStatus(message, isError, isBusy, isSuccess) {
    dom.status.textContent = message;
    dom.status.classList.toggle("is-error", Boolean(isError));
    dom.status.classList.toggle("is-busy", Boolean(isBusy));
    dom.status.classList.toggle("is-success", Boolean(isSuccess));
    appendLog((isError ? "ERROR: " : "STATUS: ") + message);
  }

  function appendLog(message) {
    try {
      var req = getNodeRequire();
      if (!req) {
        return;
      }
      var fs = req("fs");
      var path = req("path");
      var os = req("os");
      var appData = typeof process !== "undefined" && process.env ? process.env.APPDATA : "";
      var dir = path.join(appData || os.tmpdir(), "BeatDetect");
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(path.join(dir, "panel.log"), new Date().toISOString() + " " + message + "\n");
    } catch (_) {
      // Logging must never break panel behavior.
    }
  }

  function parseBridgeResult(raw) {
    if (!raw) {
      throw new Error("Premiere returned an empty response.");
    }

    var parsed = JSON.parse(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error || "Premiere operation failed.");
    }

    return parsed;
  }

  function cepEval(script) {
    return new Promise(function (resolve, reject) {
      cs.evalScript(script, function (result) {
        try {
          resolve(parseBridgeResult(result));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function getNodeRequire() {
    if (typeof window.cep_node !== "undefined" && window.cep_node.require) {
      return window.cep_node.require;
    }
    if (typeof require === "function") {
      return require;
    }
    return null;
  }

  function isBrowserPreview() {
    return !(window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function");
  }

  function getExtensionRoot() {
    var locationPath = decodeURIComponent(window.location.pathname);
    if (/^\/[A-Za-z]:\//.test(locationPath)) {
      locationPath = locationPath.slice(1);
    }
    return locationPath.replace(/[\\/][^\\/]*$/, "");
  }

  function getAnalyzerPath() {
    var req = getNodeRequire();
    if (!req) {
      throw new Error("Node.js is unavailable inside CEP.");
    }
    var path = req("path");
    var fs = req("fs");
    var root = getExtensionRoot();
    var isWindows = req("os").platform() === "win32";
    var exeName = isWindows ? "beat_analyzer.exe" : "beat_analyzer";
    var bundled = path.join(root, "bin", exeName);
    var devBuild = path.join(root, "analyzer", "target", "release", exeName);

    if (fs.existsSync(bundled)) {
      return bundled;
    }
    if (fs.existsSync(devBuild)) {
      return devBuild;
    }

    throw new Error("Analyzer executable is missing. Reinstall Beat Detect or run scripts/build-setup-exe.ps1.");
  }

  function runAnalyzer(mediaPath, focus) {
    if (mediaPath === "__beat_detect_preview__" || isBrowserPreview()) {
      return Promise.resolve(makePreviewEvents(focus));
    }

    var req = getNodeRequire();
    if (!req) {
      return Promise.reject(new Error("Node.js is not enabled in this CEP panel."));
    }

    return new Promise(function (resolve, reject) {
      var childProcess = req("child_process");
      var analyzerPath;

      try {
        analyzerPath = getAnalyzerPath();
      } catch (error) {
        reject(error);
        return;
      }

      childProcess.execFile(
        analyzerPath,
        ["--mode", focus || "music", mediaPath],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 },
        function (error, stdout, stderr) {
          if (error) {
            if (error.killed) {
              reject(new Error("Analyzer timed out. Try a shorter clip or transcode the media to WAV/MP3 first."));
              return;
            }
            reject(new Error((stderr || error.message || "Analyzer failed.").trim()));
            return;
          }

          try {
            var cleanStdout = String(stdout || "").trim();
            if (!cleanStdout) {
              throw new Error("Analyzer produced no stdout.");
            }
            var events = JSON.parse(cleanStdout);
            if (!Array.isArray(events)) {
              throw new Error("Analyzer output was not a JSON event array.");
            }
            resolve(events);
          } catch (parseError) {
            reject(new Error("Analyzer returned invalid JSON: " + parseError.message + (stderr ? " stderr: " + stderr.trim() : "")));
          }
        }
      );
    });
  }

  function getEssentiaExePath() {
    var req = getNodeRequire();
    if (!req) {
      return "";
    }
    var path = req("path");
    var fs = req("fs");
    var root = getExtensionRoot();
    var isWindows = req("os").platform() === "win32";
    var exeName = isWindows ? "essentia_beats.exe" : "essentia_beats";
    var exePath = path.join(root, "bin", exeName);
    return fs.existsSync(exePath) ? exePath : "";
  }

  function describeEssentiaAvailability() {
    if (isBrowserPreview()) {
      return "Essentia: skipped in browser preview";
    }
    if (!getNodeRequire()) {
      return "Essentia: optional, CEP Node unavailable";
    }
    if (getEssentiaExePath()) {
      return "Essentia: bundled runner available";
    }
    return "Essentia: not bundled";
  }

  function runEssentiaAnalyzer(mediaPath, focus) {
    if (mediaPath === "__beat_detect_preview__" || isBrowserPreview()) {
      return Promise.resolve({ events: [], used: false, reason: "preview" });
    }

    var req = getNodeRequire();
    if (!req) {
      return Promise.resolve({ events: [], used: false, reason: "node unavailable" });
    }

    var childProcess = req("child_process");
    var exePath = getEssentiaExePath();
    if (exePath) {
      return execEssentiaCommand(childProcess, exePath, ["--mode", focus || "music", mediaPath], "native runner", focus);
    }

    return Promise.resolve({ events: [], used: false, reason: "not bundled" });
  }

  function execEssentiaCommand(childProcess, command, args, label, focus) {
    return new Promise(function (resolve) {
      childProcess.execFile(
        command,
        args,
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 },
        function (error, stdout, stderr) {
          if (error) {
            appendLog("Essentia optional analyzer skipped (" + label + "): " + (stderr || error.message || "unknown error").trim());
            resolve({ events: [], used: false, reason: label + " failed" });
            return;
          }
          resolve(parseEssentiaOutput(stdout, stderr, label, focus));
        }
      );
    });
  }

  function parseEssentiaOutput(stdout, stderr, label, focus) {
    try {
      var cleanStdout = String(stdout || "").trim();
      if (!cleanStdout) {
        throw new Error("no stdout" + (stderr ? ": " + stderr.trim() : ""));
      }
      var parsed = JSON.parse(cleanStdout);
      var events = normalizeEssentiaEvents(parsed, focus);
      return {
        events: events,
        used: events.length > 0,
        reason: label,
        bpm: parsed && parsed.bpm
      };
    } catch (error) {
      appendLog("Essentia optional analyzer returned invalid output (" + label + "): " + error.message);
      return { events: [], used: false, reason: "invalid output" };
    }
  }

  function normalizeEssentiaEvents(parsed, focus) {
    var confidence = parsed && isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.45;
    var rawEvents = [];
    if (Array.isArray(parsed)) {
      rawEvents = parsed;
    } else if (parsed && Array.isArray(parsed.events)) {
      rawEvents = parsed.events;
    } else if (parsed && Array.isArray(parsed.beats)) {
      rawEvents = parsed.beats;
    }

    return rawEvents
      .map(function (event) {
        if (typeof event === "number") {
          return { time: event, score: essentiaScore(confidence, focus) };
        }
        return {
          time: Number(event.time !== undefined ? event.time : event.beat),
          score: isFinite(Number(event.score)) ? Number(event.score) : essentiaScore(confidence, focus)
        };
      })
      .filter(function (event) {
        return isFinite(event.time) && event.time >= 0 && isFinite(event.score);
      })
      .sort(function (a, b) {
        return a.time - b.time;
      });
  }

  function essentiaScore(confidence, focus) {
    var c = Math.max(0, Math.min(1, Number(confidence) || 0));
    if (focus === "vocal") {
      return 0.34 + c * 0.22;
    }
    if (focus === "music") {
      return 0.52 + c * 0.26;
    }
    return 0.48 + c * 0.24;
  }

  function mergeAnalyzerEvents(primaryEvents, essentiaEvents, focus) {
    var merged = sanitizeEvents(primaryEvents).map(function (event) {
      return { time: event.time, score: event.score };
    });
    var supportWindow = focus === "vocal" ? 0.24 : focus === "music" ? 0.15 : 0.11;
    var addThreshold = focus === "vocal" ? 0.54 : focus === "music" ? 0.50 : 0.48;

    for (var i = 0; i < essentiaEvents.length; i++) {
      var event = essentiaEvents[i];
      var nearest = null;
      var nearestDistance = Infinity;
      for (var j = 0; j < merged.length; j++) {
        var distance = Math.abs(merged[j].time - event.time);
        if (distance < nearestDistance) {
          nearest = merged[j];
          nearestDistance = distance;
        }
      }

      if (nearest && nearestDistance <= supportWindow) {
        nearest.score = Math.min(0.995, Math.max(nearest.score, nearest.score * 0.88 + event.score * 0.18));
      } else if (event.score >= addThreshold && focus !== "vocal") {
        merged.push({
          time: event.time,
          score: Math.min(0.82, event.score)
        });
      }
    }

    return merged.sort(function (a, b) {
      return a.time - b.time;
    });
  }

  function runHybridAnalyzer(mediaPath, focus) {
    return Promise.all([
      runAnalyzer(mediaPath, focus),
      runEssentiaAnalyzer(mediaPath, focus)
    ]).then(function (results) {
      var primaryEvents = results[0];
      var essentia = results[1] || { events: [], used: false };
      return {
        events: mergeAnalyzerEvents(primaryEvents, essentia.events || [], focus),
        primaryCount: primaryEvents.length,
        essentiaCount: essentia.events ? essentia.events.length : 0,
        essentiaUsed: Boolean(essentia.used)
      };
    });
  }

  function makePreviewEvents(focus) {
    var times = [
      0.42, 0.78, 1.11, 1.62, 2.05, 2.48, 3.02, 3.44, 4.01, 4.39,
      5.12, 5.54, 6.03, 6.46, 7.25, 8.04, 8.41, 9.18, 10.02, 10.42,
      11.07, 11.51, 12.16, 12.64, 13.33, 14.05, 14.48, 15.21, 16.01,
      16.52, 17.04, 17.44, 18.22, 19.03, 19.47, 20.18, 21.0
    ];

    return times.map(function (time, index) {
      var dropBoost = index === 4 || index === 14 || index === 27 ? 0.32 : 0;
      var phraseBoost = index === 0 || index === 10 || index === 20 || index === 30 ? 0.28 : 0;
      var base = 0.22 + ((index * 37) % 55) / 100;
      var score = focus === "vocal"
        ? base * 0.56 + phraseBoost
        : focus === "music"
          ? base * 0.78 + dropBoost * 0.7 + phraseBoost * 0.55
          : base + dropBoost;
      return { time: time, score: Math.min(1, Number(score.toFixed(3))) };
    });
  }

  function getThreshold() {
    return Number(dom.densitySlider.value) / 100;
  }

  function spacingForFilter(threshold, focus) {
    var density = Math.max(0, Math.min(1, (threshold - 0.2) / 0.45));
    var minGap = focus === "vocal" ? 0.42 : focus === "music" ? 0.16 : 0.12;
    var maxGap = focus === "vocal" ? 1.3 : focus === "music" ? 0.62 : 0.44;
    return minGap + density * (maxGap - minGap);
  }

  function adaptiveGapSeconds(anchorScore, candidateScore, baseGapSeconds, focus) {
    var anchor = Number(anchorScore) || 0;
    var candidate = Number(candidateScore) || 0;
    var bothMajor = anchor >= 0.9 && candidate >= 0.86;
    var candidateMuchStronger = candidate >= anchor + 0.18 && candidate >= 0.78;
    var candidateWeak = candidate < 0.62;

    if (bothMajor) {
      return focus === "vocal" ? baseGapSeconds * 0.58 : baseGapSeconds * 0.45;
    }
    if (candidateMuchStronger) {
      return baseGapSeconds * 0.55;
    }
    if (candidateWeak) {
      return baseGapSeconds * 1.28;
    }
    return baseGapSeconds;
  }

  function suppressCloseEvents(events, minGapSeconds, focus) {
    var byStrength = events.slice().sort(function (a, b) {
      return b.score - a.score;
    });
    var kept = [];

    for (var i = 0; i < byStrength.length; i++) {
      var candidate = byStrength[i];
      var tooClose = false;
      for (var j = 0; j < kept.length; j++) {
        var requiredGap = adaptiveGapSeconds(kept[j].score, candidate.score, minGapSeconds, focus);
        if (Math.abs(candidate.time - kept[j].time) < requiredGap) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        kept.push(candidate);
      }
    }

    return kept.sort(function (a, b) {
      return a.time - b.time;
    });
  }

  function keepStrongestPerWindow(events, windowSeconds) {
    if (!events.length || !windowSeconds || windowSeconds <= 0) {
      return events;
    }

    var byWindow = {};
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      var bucket = Math.floor(event.time / windowSeconds);
      if (!byWindow[bucket] || event.score > byWindow[bucket].score) {
        byWindow[bucket] = event;
      }
    }

    var kept = [];
    Object.keys(byWindow).forEach(function (bucket) {
      kept.push(byWindow[bucket]);
    });
    return kept.sort(function (a, b) {
      return a.time - b.time;
    });
  }

  function keepStrongestPerSecond(events) {
    return keepStrongestPerWindow(events, 1.0);
  }

  function finalDensityPass(events, threshold, focus) {
    var filtered = keepStrongestPerSecond(events);
    if (threshold < 0.68) {
      return filtered;
    }

    var pressure = Math.max(0, Math.min(1, (threshold - 0.68) / 0.12));
    var windowSeconds = focus === "vocal"
      ? 0.75 + pressure * 0.35
      : focus === "music"
        ? 0.34 + pressure * 0.18
        : 0.24 + pressure * 0.14;

    return keepStrongestPerWindow(filtered, windowSeconds);
  }

  // ── Target Count selection logic ──────────────────────────────
  //
  // Selects exactly N events from state.allEvents with two goals:
  //   1. Distribute picks across the full duration (no clustering).
  //   2. Within each segment pick the highest-scoring event so the
  //      output still follows the actual musical content.
  //
  // Strategy:
  //   a. If N >= pool size  → return the whole pool (already filtered).
  //   b. Divide the timeline into N equal segments.
  //   c. In each segment pick the strongest event. If a segment is
  //      empty (gap in the audio), skip it and "carry" its slot to a
  //      neighbouring non-empty segment by widening the search window.
  //   d. After the first pass, if fewer than N events were picked
  //      (due to gaps), fill the remainder with the globally strongest
  //      un-selected events to reach exactly N.
  //
  function selectByTargetCount(pool, n) {
    if (!pool || pool.length === 0 || n <= 0) return [];
    if (n >= pool.length) return pool.slice(); // Pool is already sorted by time

    var sorted = pool.slice();
    var duration = sorted[sorted.length - 1].time;
    if (duration <= 0) {
      // No time axis — fall back to top-N by score
      return pool.slice().sort(function(a,b){ return b.score - a.score; }).slice(0, n)
        .sort(function(a,b){ return a.time - b.time; });
    }

    var segWidth = duration / n;
    var selected = [];
    var usedIndices = {};

    for (var seg = 0; seg < n; seg++) {
      var tLo = seg * segWidth;
      var tHi = tLo + segWidth;

      // Widen by 50 % on each side if segment is empty
      var attempts = 0;
      var expand = 0;
      var best = null;
      var bestIdx = -1;

      while (best === null && attempts < 6) {
        var lo = tLo - expand * segWidth;
        var hi = tHi + expand * segWidth;
        for (var k = 0; k < sorted.length; k++) {
          if (usedIndices[k]) continue;
          var t = sorted[k].time;
          if (t >= lo && t < hi) {
            if (best === null || sorted[k].score > best.score) {
              best = sorted[k];
              bestIdx = k;
            }
          }
        }
        expand += 0.5;
        attempts++;
      }

      if (best !== null) {
        selected.push(best);
        usedIndices[bestIdx] = true;
      }
    }

    // Gap fill: if we still need more events, top up with globally strongest unused
    if (selected.length < n) {
      var remaining = sorted
        .filter(function(_, i) { return !usedIndices[i]; })
        .sort(function(a, b) { return b.score - a.score; });
      for (var r = 0; r < remaining.length && selected.length < n; r++) {
        selected.push(remaining[r]);
      }
    }

    return selected.sort(function(a,b){ return a.time - b.time; });
  }

  // Returns the user-entered target count (integer) or null if blank/invalid.
  function getTargetCount() {
    if (!dom.targetCountInput) return null;
    var raw = dom.targetCountInput.value.trim();
    if (raw === "") return null;
    var n = parseInt(raw, 10);
    return (isFinite(n) && n >= 1) ? n : null;
  }

  // Calibrate min/max bounds of the target-count input after analysis.
  function calibrateTargetCountBounds(allEvents, clip) {
    if (!dom.targetCountInput) return;
    var total = allEvents.length;
    // Practical minimum: at least 1 but default to ~1 per 15 s of track
    var duration = (clip && clip.duration) ? Number(clip.duration) : 0;
    var minEstimate = duration > 0 ? Math.max(1, Math.round(duration / 15)) : 1;
    var min = Math.min(minEstimate, Math.max(1, total));
    var max = total;
    dom.targetCountInput.min = String(min);
    dom.targetCountInput.max = String(max);
    // Update hint with range
    if (dom.targetCountHint) {
      dom.targetCountHint.textContent = "Range: " + min + "\u2013" + max + " markers. Leave blank for density slider.";
    }
  }

  // Perform a random shuffle of the target-count selection.
  // Picks N events from the pool at random but still distributes them
  // across segments (each segment contributes one random event).
  function randomizeSelection() {
    var n = getTargetCount();
    if (!n || state.allEvents.length === 0) return;

    var pool = state.allEvents;
    var sorted = pool.slice().sort(function(a,b){ return a.time - b.time; });
    var duration = sorted[sorted.length - 1].time;
    var segWidth = duration > 0 ? duration / n : 0;
    var selected = [];
    var usedIndices = {};

    for (var seg = 0; seg < n; seg++) {
      var tLo = seg * segWidth;
      var tHi = tLo + segWidth;
      var candidates = [];
      for (var k = 0; k < sorted.length; k++) {
        if (!usedIndices[k] && sorted[k].time >= tLo && sorted[k].time < tHi) {
          candidates.push(k);
        }
      }
      if (candidates.length > 0) {
        var pick = candidates[Math.floor(Math.random() * candidates.length)];
        selected.push(sorted[pick]);
        usedIndices[pick] = true;
      }
    }
    // Top-up with random unselected events if needed
    if (selected.length < n) {
      var unused = sorted.filter(function(_, i){ return !usedIndices[i]; });
      // Shuffle unused
      for (var i = unused.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = unused[i]; unused[i] = unused[j]; unused[j] = tmp;
      }
      for (var u = 0; u < unused.length && selected.length < n; u++) {
        selected.push(unused[u]);
      }
    }

    state.filteredEvents = selected.sort(function(a,b){ return a.time - b.time; });
    updateCounterUI(n);
  }

  function updateCounterUI(targetN) {
    var n = targetN !== undefined ? targetN : getTargetCount();
    dom.filteredCount.textContent = String(state.filteredEvents.length);
    if (n !== null) {
      dom.totalCount.textContent = "of " + state.allEvents.length + " events (target: " + n + ")";
      dom.thresholdLabel.textContent = "\u2022" + state.filteredEvents.length;
    } else {
      var threshold = getThreshold();
      dom.thresholdLabel.textContent = threshold.toFixed(2);
      dom.totalCount.textContent = "of " + state.allEvents.length + " events selected";
    }
    dom.applyButton.disabled = state.isBusy || state.filteredEvents.length === 0;
    if (dom.randomizeButton) dom.randomizeButton.disabled = state.isBusy || state.allEvents.length === 0;
  }

  function filterEvents() {
    var n = getTargetCount();
    if (n !== null) {
      // ── Target Count mode ──
      state.filteredEvents = selectByTargetCount(state.allEvents, n);
      if (dom.targetCountInput) dom.targetCountInput.classList.add("is-active");
    } else {
      // ── Density slider mode ──
      var threshold = getThreshold();
      var focus = getDetectionFocus();
      var thresholded = state.allEvents.filter(function(event) {
        return Number(event.score) >= threshold;
      });
      state.filteredEvents = finalDensityPass(
        suppressCloseEvents(thresholded, spacingForFilter(threshold, focus), focus),
        threshold,
        focus
      );
      if (dom.targetCountInput) dom.targetCountInput.classList.remove("is-active");
    }
    updateCounterUI();
  }

  function sanitizeEvents(events) {
    return events
      .map(function (event) {
        return {
          time: Number(event.time),
          score: Number(event.score)
        };
      })
      .filter(function (event) {
        return isFinite(event.time) && event.time >= 0 && isFinite(event.score);
      })
      .sort(function (a, b) {
        return a.time - b.time;
      });
  }

  function analyzeTrack() {
    if (state.isBusy) return;

    setBusy(true);
    state.allEvents    = [];
    state.filteredEvents = [];
    state.clip         = null;
    dom.densityPanel.classList.add("is-hidden");
    setStatus("Reading the selected clip path from Premiere...", false, true);

    cepEval("BeatDetect.getSelectedClipInfo()")
      .then(function (result) {
        state.clip = result.clip;
        if (!state.clip.mediaPath) {
          throw new Error("Premiere returned an empty media path for the selected clip.");
        }
        var focus = getDetectionFocus();
        var label = focus === "vocal"
          ? "vocal phrase starts and melodic entries"
          : focus === "music"
            ? "music spikes and vocal phrase starts"
            : "sharp percussion hits, drops, and accents";
        setStatus("Analyzing " + state.clip.name + " for " + label + "...", false, true);
        return runHybridAnalyzer(state.clip.mediaPath, focus);
      })
      .then(function (analysis) {
        state.allEvents = sanitizeEvents(analysis.events || []);
        // Calibrate target-count input bounds now we know the event pool size
        calibrateTargetCountBounds(state.allEvents, state.clip);
        filterEvents();
        dom.densityPanel.classList.remove("is-hidden");
        setStatus(
          (isBrowserPreview() ? "Preview analysis complete: " : "Analysis complete: ") +
          "found " + state.allEvents.length + " total rhythmic events" +
          (analysis.essentiaUsed ? " using Rust + Essentia support." : " using Rust analyzer."),
          false, false, true
        );
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function applyMarkers() {
    if (state.isBusy || state.filteredEvents.length === 0) {
      return;
    }

    setBusy(true);
    setStatus("Applying " + state.filteredEvents.length + " markers in Premiere...", false, true);

    var payload = {
      target: dom.markerTarget.value,
      mediaPath: state.clip ? state.clip.mediaPath : "",
      focus: getDetectionFocus(),
      events: state.filteredEvents
    };

    cepEval("BeatDetect.applyMarkers(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Applied " + result.applied + " markers. Skipped " + result.skipped + " outside the selected clip range.", false, false, true);
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function removeMarkers() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Removing Beat Detect markers from the selected " + (dom.markerTarget.value === "clip" ? "clip" : "timeline range") + "...", false, true);

    var payload = {
      target: dom.markerTarget.value
    };

    cepEval("BeatDetect.removeMarkers(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Removed " + result.removed + " Beat Detect markers.", false, false, true);
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function applyGimbalZoom() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    var zoomValue = dom.zoomSlider ? Number(dom.zoomSlider.value) : 110.0;
    setStatus("Applying smooth gimbal zoom to selected clips (" + zoomValue + "%)...");

    var payload = { zoom: zoomValue };
    cepEval("BeatDetect.applyGimbalZoom(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Applied gimbal zoom to " + result.applied + " clips.");
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function runDiagnostics() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Running Beat Detect diagnostics for v" + APP_VERSION + "...");

    var checks = [];
    checks.push("Beat Detect: v" + APP_VERSION);
    var req = getNodeRequire();
    checks.push(req ? "CEP Node: OK" : (isBrowserPreview() ? "CEP Node: simulated in browser preview" : "CEP Node: FAIL"));

    if (req) {
      try {
        var analyzerPath = getAnalyzerPath();
        checks.push("Analyzer: OK at " + analyzerPath);
      } catch (error) {
        checks.push("Analyzer: FAIL - " + error.message);
      }
      checks.push(describeEssentiaAvailability());
    } else if (isBrowserPreview()) {
      checks.push("Analyzer: simulated demo events");
      checks.push(describeEssentiaAvailability());
    }

    cepEval("BeatDetect.runDiagnostics()")
      .then(function (result) {
        if (result.diagnostics && result.diagnostics.length) {
          checks = checks.concat(result.diagnostics);
        }
        setStatus(checks.join(" | "));
      })
      .catch(function (error) {
        checks.push("Premiere bridge: FAIL - " + error.message);
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(checks.join(" | "), true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  dom.analyzeButton.addEventListener("click", analyzeTrack);
  dom.diagnosticsButton.addEventListener("click", runDiagnostics);
  dom.applyButton.addEventListener("click", applyMarkers);
  dom.removeButton.addEventListener("click", removeMarkers);
  if (dom.gimbalZoomButton) dom.gimbalZoomButton.addEventListener("click", applyGimbalZoom);
  if (dom.randomizeButton) {
    dom.randomizeButton.addEventListener("click", function() {
      // If no target count is set, default to current filtered count
      if (getTargetCount() === null && state.filteredEvents.length > 0) {
        dom.targetCountInput.value = String(state.filteredEvents.length);
      }
      randomizeSelection();
    });
  }
  dom.densitySlider.addEventListener("input", filterEvents);
  if (dom.targetCountInput) {
    dom.targetCountInput.addEventListener("input", function() {
      if (state.allEvents.length > 0) filterEvents();
    });
  }
  if (dom.zoomSlider) {
    dom.zoomSlider.addEventListener("input", function() {
      if (dom.zoomLabel) dom.zoomLabel.textContent = dom.zoomSlider.value + "%";
    });
  }

  var modeInputs = document.querySelectorAll("input[name='detectionFocus']");
  for (var modeIndex = 0; modeIndex < modeInputs.length; modeIndex++) {
    modeInputs[modeIndex].addEventListener("change", function () {
      syncModeSelection();
      if (state.allEvents.length > 0) {
        filterEvents();
      }
    });
  }
  syncModeSelection();

  var githubLink = document.getElementById("githubLink");
  if (githubLink) {
    githubLink.addEventListener("click", function (e) {
      e.preventDefault();
      try {
        var req = getNodeRequire();
        if (req) {
          var cp = req('child_process');
          var isWin = req('os').platform() === 'win32';
          var cmd = isWin ? 'start https://github.com/Hamza-op' : 'open https://github.com/Hamza-op';
          cp.exec(cmd);
        } else {
          window.open("https://github.com/Hamza-op");
        }
      } catch (err) {
        // Ignore fallback errors
      }
    });
  }

  if (isBrowserPreview()) {
    setStatus("Browser preview mode. Analyze uses simulated music spikes; Premiere actions are mocked.");
  }

  window.onerror = function (message, source, line, column, error) {
    appendLog("WINDOW ERROR: " + message + " at " + source + ":" + line + ":" + column);
    if (error && error.stack) {
      appendLog(error.stack);
    }
  };

  window.onunhandledrejection = function (event) {
    appendLog("UNHANDLED PROMISE: " + (event.reason && event.reason.stack ? event.reason.stack : String(event.reason)));
  };
})();
