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
    confirmDollyZoomButton: document.getElementById("confirmDollyZoomButton"),
    clearZoomButton:  document.getElementById("clearZoomButton"),
    warpStabilizerButton: document.getElementById("warpStabilizerButton"),
    autoColorButton: document.getElementById("autoColorButton"),
    resetColorButton: document.getElementById("resetColorButton"),
    status:           document.getElementById("status"),
    densityPanel:     document.getElementById("densityPanel"),
    densitySlider:    document.getElementById("densitySlider"),
    thresholdLabel:   document.getElementById("thresholdLabel"),
    filteredCount:    document.getElementById("filteredCount"),
    totalCount:       document.getElementById("totalCount"),
    markerTarget:     document.getElementById("markerTarget"),
    zoomSlider:       document.getElementById("zoomSlider"),
    zoomLabel:        document.getElementById("zoomLabel"),
    autoZoomRatio:    document.getElementById("autoZoomRatio"),
    targetCountInput: document.getElementById("targetCountInput"),
    targetStrategy:   document.getElementById("targetStrategy"),
    targetCountHint:  document.getElementById("targetCountHint"),
    clearLogsButton:  document.getElementById("clearLogsButton"),
    dollySubjectSlider: document.getElementById("dollySubjectSlider"),
    dollyBackgroundSlider: document.getElementById("dollyBackgroundSlider"),
    dollySensitivitySlider: document.getElementById("dollySensitivitySlider"),
    dollySubjectXSlider: document.getElementById("dollySubjectXSlider"),
    dollySubjectYSlider: document.getElementById("dollySubjectYSlider"),
    dollyBackgroundXSlider: document.getElementById("dollyBackgroundXSlider"),
    dollyBackgroundYSlider: document.getElementById("dollyBackgroundYSlider"),
    dollySubjectLabel: document.getElementById("dollySubjectLabel"),
    dollyBackgroundLabel: document.getElementById("dollyBackgroundLabel"),
    dollySensitivityLabel: document.getElementById("dollySensitivityLabel"),
    dollySubjectXLabel: document.getElementById("dollySubjectXLabel"),
    dollySubjectYLabel: document.getElementById("dollySubjectYLabel"),
    dollyBackgroundXLabel: document.getElementById("dollyBackgroundXLabel"),
    dollyBackgroundYLabel: document.getElementById("dollyBackgroundYLabel"),
    dollyStrengthLabel: document.getElementById("dollyStrengthLabel"),
    dollyFrameLabel: document.getElementById("dollyFrameLabel"),
    dollySubjectFrame: document.getElementById("dollySubjectFrame"),
    dollyBackgroundFrame: document.getElementById("dollyBackgroundFrame"),
    dollyScreen: document.getElementById("dollyScreen"),
    dollyMotionLine: document.getElementById("dollyMotionLine"),
    dollySubjectTarget: document.getElementById("dollySubjectTarget"),
    dollyBackgroundTarget: document.getElementById("dollyBackgroundTarget"),
    tabDensity:       document.getElementById("tabDensity"),
    tabLimit:         document.getElementById("tabLimit"),
    densityTabContent:document.getElementById("densityTabContent"),
    limitTabContent:  document.getElementById("limitTabContent"),
    offsetSlider:     document.getElementById("offsetSlider"),
    offsetLabel:      document.getElementById("offsetLabel"),
    mainTabMarkersButton: document.getElementById("mainTabMarkersButton"),
    mainTabColorButton: document.getElementById("mainTabColorButton"),
    mainTabToolsButton: document.getElementById("mainTabToolsButton"),
    mainTabDollyButton: document.getElementById("mainTabDollyButton"),
    mainTabDiagnosticsButton: document.getElementById("mainTabDiagnosticsButton"),
    mainTabMarkers: document.getElementById("mainTabMarkers"),
    mainTabColor: document.getElementById("mainTabColor"),
    mainTabTools: document.getElementById("mainTabTools"),
    mainTabDolly: document.getElementById("mainTabDolly"),
    mainTabDiagnostics: document.getElementById("mainTabDiagnostics")
  };

  function getBeatWorkflowLabel() {
    return "beat-grid";
  }

  function dispatchInputEvent(element) {
    if (!element) return;
    var event = new Event("input", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    dom.analyzeButton.disabled   = isBusy;
    dom.diagnosticsButton.disabled = isBusy;
    dom.removeButton.disabled    = isBusy;
    if (dom.randomizeButton) dom.randomizeButton.disabled = isBusy || state.allEvents.length === 0;
    if (dom.gimbalZoomButton) dom.gimbalZoomButton.disabled = isBusy;
    if (dom.confirmDollyZoomButton) dom.confirmDollyZoomButton.disabled = isBusy;
    if (dom.clearZoomButton) dom.clearZoomButton.disabled = isBusy;
    if (dom.warpStabilizerButton) dom.warpStabilizerButton.disabled = isBusy;
    if (dom.autoColorButton) dom.autoColorButton.disabled = isBusy;
    if (dom.resetColorButton) dom.resetColorButton.disabled = isBusy;
    if (dom.clearLogsButton) dom.clearLogsButton.disabled = isBusy;
    dom.applyButton.disabled = isBusy || state.filteredEvents.length === 0;
  }

  function setStatus(message, isError, isBusy, isSuccess) {
    dom.status.textContent = message;
    dom.status.classList.toggle("is-error", Boolean(isError));
    dom.status.classList.toggle("is-busy", Boolean(isBusy));
    dom.status.classList.toggle("is-success", Boolean(isSuccess));
    appendLog((isError ? "ERROR: " : "STATUS: ") + message);
  }

  var logQueue = [];
  var logProcessing = false;

  function appendLog(message) {
    logQueue.push(new Date().toISOString() + " " + message + "\n");
    processLogQueue();
  }

  function processLogQueue() {
    if (logProcessing || logQueue.length === 0) {
      return;
    }
    logProcessing = true;

    try {
      var req = getNodeRequire();
      if (!req) {
        logQueue = [];
        logProcessing = false;
        return;
      }
      var fs = req("fs");
      var path = req("path");
      var os = req("os");
      var appData = typeof process !== "undefined" && process.env ? process.env.APPDATA : "";
      var dir = path.join(appData || os.tmpdir(), "AutoCutStudio");

      fs.mkdir(dir, { recursive: true }, function (err) {
        if (err) {
          logQueue = [];
          logProcessing = false;
          return;
        }

        var logPath = path.join(dir, "panel.log");

        fs.stat(logPath, function (statErr, stats) {
          if (!statErr && stats && stats.size > 2 * 1024 * 1024) {
            fs.readFile(logPath, "utf8", function (readErr, content) {
              if (readErr) {
                writeNext();
                return;
              }
              var truncated = content.substring(content.length - 100 * 1024);
              fs.writeFile(logPath, "[LOG FILE TRUNCATED DUE TO SIZE LIMITS]\n" + truncated, "utf8", function (writeErr) {
                writeNext();
              });
            });
          } else {
            writeNext();
          }
        });

        function writeNext() {
          if (logQueue.length === 0) {
            logProcessing = false;
            return;
          }
          var batch = logQueue.join("");
          logQueue = [];

          fs.appendFile(logPath, batch, function (appendErr) {
            logProcessing = false;
            processLogQueue();
          });
        }
      });
    } catch (_) {
      logQueue = [];
      logProcessing = false;
    }
  }

  function parseBridgeResult(raw) {
    if (raw === null || raw === undefined) {
      throw new Error("Premiere returned an empty response.");
    }

    var text = String(raw).trim();
    if (!text) {
      throw new Error("Premiere returned an empty response.");
    }
    if (text.indexOf("EvalScript error") === 0) {
      throw new Error("Premiere bridge failed before returning data. Check the ExtendScript bridge and restart the panel.");
    }

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("Premiere returned invalid bridge data: " + text.slice(0, 240));
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Premiere returned an invalid bridge payload.");
    }
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
    if (cs && typeof cs.getSystemPath === "function" && typeof SystemPath !== "undefined" && SystemPath.EXTENSION) {
      var extensionPath = cs.getSystemPath(SystemPath.EXTENSION);
      if (extensionPath) {
        return extensionPath;
      }
    }
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

    throw new Error("Analyzer executable is missing. Reinstall AutoCut Studio or run scripts/build-setup-exe.ps1.");
  }

  function clipAnalysisRange(clip) {
    if (!clip) return null;
    var start = Number(clip.inPointSeconds);
    var out = Number(clip.outPointSeconds);
    var duration = Number(clip.durationSeconds);

    if ((!isFinite(duration) || duration <= 0) && isFinite(start) && isFinite(out)) {
      duration = out - start;
    }
    if (!isFinite(start) || start < 0 || !isFinite(duration) || duration <= 0) {
      return null;
    }

    return {
      start: Math.max(0, start),
      duration: duration,
      end: Math.max(0, start) + duration
    };
  }

  function addClipRangeArgs(args, clip) {
    var range = clipAnalysisRange(clip);
    if (range) {
      args.push("--start", range.start.toFixed(6), "--duration", range.duration.toFixed(6));
    }
    return args;
  }

  function formatSeconds(seconds) {
    seconds = Math.max(0, Number(seconds) || 0);
    var minutes = Math.floor(seconds / 60);
    var remaining = Math.round(seconds - minutes * 60);
    return minutes > 0 ? minutes + "m " + remaining + "s" : remaining + "s";
  }

  function cropEventsToSelectedClip(events, clip) {
    var range = clipAnalysisRange(clip);
    if (!range) return events;
    var start = range.start - 0.001;
    var end = range.end + 0.001;
    return events.filter(function(event) {
      return event.time >= start && event.time <= end;
    });
  }

  function runAnalyzer(mediaPath, clip) {
    if (mediaPath === "__autocut_studio_preview__" || isBrowserPreview()) {
      return Promise.resolve(makePreviewEvents());
    }
    if (!mediaPath || typeof mediaPath !== "string") {
      return Promise.reject(new Error("Analyzer did not receive a valid media path."));
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

      var args = addClipRangeArgs([], clip);
      args.push(mediaPath);

      childProcess.execFile(
        analyzerPath,
        args,
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

  function runHybridAnalyzer(mediaPath, clip) {
    return runAnalyzer(mediaPath, clip).then(function(primaryEvents) {
      return {
        events: sanitizeEvents(primaryEvents),
        primaryCount: primaryEvents.length
      };
    });
  }

  function makePreviewEvents() {
    var beatEvents = [];
    for (var beat = 0; beat < 42; beat++) {
      beatEvents.push({
        time: Number((0.52 + beat * 0.50).toFixed(3)),
        score: beat % 8 === 0 ? 0.88 : beat % 4 === 0 ? 0.76 : 0.64
      });
    }
    return beatEvents;
  }

  function getThreshold() {
    return dom.densitySlider ? Number(dom.densitySlider.value) / 100 : 0;
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

  function keepStrongestWithMinimumGap(events, minGapSeconds) {
    if (!events.length || !minGapSeconds || minGapSeconds <= 0) {
      return events;
    }

    var strongestFirst = events.slice().sort(function(a, b) {
      return Number(b.score) - Number(a.score);
    });
    var kept = [];

    for (var i = 0; i < strongestFirst.length; i++) {
      var candidate = strongestFirst[i];
      var tooClose = false;
      for (var j = 0; j < kept.length; j++) {
        if (Math.abs(candidate.time - kept[j].time) < minGapSeconds) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        kept.push(candidate);
      }
    }

    return kept.sort(function(a, b) {
      return a.time - b.time;
    });
  }

  function beatMinimumGapForThreshold(threshold) {
    if (threshold <= 0.40) return 0;
    var t = Math.max(0, Math.min(1, (threshold - 0.40) / 0.50));
    return 1.05 + t * 2.75;
  }

  // ── Target Count selection logic ──────────────────────────────
  //
  // Selects N events from state.allEvents whenever N real detected beats exist.
  //
  // Beat mode is section-based: divide the detected beat span into N sections,
  // choose one real beat from each non-empty section, then top up from real
  // unused beats if any section had no candidate. No synthetic markers.
  //
  // Beat strategies:
  //   balanced  = strong beat near the section center.
  //   strongest = highest-scored beat inside each section.
  //   spread    = beat closest to the section center.
  //
  function getTargetStrategy() {
    return dom.targetStrategy ? dom.targetStrategy.value : "balanced";
  }

  function getTargetStrategyLabel() {
    var strategy = getTargetStrategy();
    if (strategy === "strongest") return "section best";
    if (strategy === "spread") return "even spread";
    return "balanced";
  }

  function collapseBeatCandidatesBySecond(sortedEvents, target) {
    if (!sortedEvents || sortedEvents.length === 0 || target >= sortedEvents.length) {
      return sortedEvents || [];
    }

    var strongestBySecond = {};
    var secondCount = 0;
    for (var i = 0; i < sortedEvents.length; i++) {
      var event = sortedEvents[i];
      var bucket = String(Math.floor(Number(event.time) || 0));
      if (!strongestBySecond[bucket]) {
        strongestBySecond[bucket] = event;
        secondCount++;
      } else if ((Number(event.score) || 0) > (Number(strongestBySecond[bucket].score) || 0)) {
        strongestBySecond[bucket] = event;
      }
    }

    if (secondCount < target) {
      return sortedEvents;
    }

    var collapsed = [];
    for (var key in strongestBySecond) {
      if (Object.prototype.hasOwnProperty.call(strongestBySecond, key)) {
        collapsed.push(strongestBySecond[key]);
      }
    }
    return collapsed.sort(function(a, b) { return a.time - b.time; });
  }

  function selectByTargetCount(pool, n, strategy) {
    if (!pool || pool.length === 0 || !isFinite(n) || n <= 0) return [];
    n = Math.min(Math.floor(n), pool.length);
    if (n >= pool.length) {
      return pool.slice().sort(function(a, b) { return a.time - b.time; });
    }
    strategy = strategy || "balanced";

    return selectBeatGridByTargetCount(pool, n, strategy);
  }

  function selectBeatGridByTargetCount(pool, n, strategy) {
    if (!pool || pool.length === 0 || !isFinite(n) || n <= 0) return [];
    var sorted = pool.slice().sort(function(a, b) { return a.time - b.time; });
    var target = Math.min(Math.floor(n), sorted.length);
    sorted = collapseBeatCandidatesBySecond(sorted, target);
    target = Math.min(target, sorted.length);
    if (target >= sorted.length) return sorted.slice();

    var firstTime = sorted[0].time;
    var lastTime = sorted[sorted.length - 1].time;
    var duration = Math.max(0, lastTime - firstTime);
    if (duration <= 0) {
      return sorted.slice(0, target);
    }

    var segWidth = duration / target;
    var selected = [];
    var usedIndices = {};

    for (var seg = 0; seg < target; seg++) {
      var tLo = firstTime + seg * segWidth;
      var tHi = seg === target - 1 ? lastTime + 0.001 : tLo + segWidth;
      var center = tLo + segWidth * 0.5;
      var best = null;
      var bestIdx = -1;
      var bestRank = -Infinity;

      for (var k = 0; k < sorted.length; k++) {
        if (usedIndices[k]) continue;
        var event = sorted[k];
        if (event.time < tLo || event.time >= tHi) continue;

        var rank = Number(event.score) || 0;
        if (strategy === "spread") {
          var distance = Math.abs(event.time - center);
          var closeness = 1 - Math.min(1, distance / Math.max(segWidth * 0.5, 0.001));
          rank = closeness * 0.90 + rank * 0.10;
        } else if (strategy === "balanced") {
          var centerDistance = Math.abs(event.time - center);
          var centerCloseness = 1 - Math.min(1, centerDistance / Math.max(segWidth * 0.5, 0.001));
          rank = rank * 0.70 + centerCloseness * 0.30;
        }

        if (best === null || rank > bestRank) {
          best = event;
          bestIdx = k;
          bestRank = rank;
        }
      }

      if (best !== null) {
        selected.push(best);
        usedIndices[bestIdx] = true;
      }
    }

    if (strategy !== "spread") {
      fillSelectionToTarget(sorted, selected, usedIndices, target, strategy);
    }
    return selected.sort(function(a, b) { return a.time - b.time; });
  }

  function fillSelectionToTarget(sorted, selected, usedIndices, target, strategy) {
    if (!sorted || !selected || !usedIndices || selected.length >= target) return;

    while (selected.length < target) {
      var bestIdx = -1;
      var bestRank = -Infinity;

      for (var i = 0; i < sorted.length; i++) {
        if (usedIndices[i]) continue;
        var event = sorted[i];
        var score = Number(event.score) || 0;
        var spacing = nearestSelectedDistanceSeconds(event, selected);
        var rank = score;

        if (strategy === "spread") {
          rank = spacing;
        } else if (strategy === "balanced") {
          rank = score * 0.65 + Math.min(spacing / 6, 1) * 0.35;
        }

        if (bestIdx < 0 || rank > bestRank) {
          bestIdx = i;
          bestRank = rank;
        }
      }

      if (bestIdx < 0) break;
      selected.push(sorted[bestIdx]);
      usedIndices[bestIdx] = true;
    }
  }

  function nearestSelectedDistanceSeconds(event, selected) {
    if (!selected || selected.length === 0) return Number.MAX_VALUE;
    var best = Number.MAX_VALUE;
    var time = Number(event.time) || 0;
    for (var i = 0; i < selected.length; i++) {
      best = Math.min(best, Math.abs(time - (Number(selected[i].time) || 0)));
    }
    return best;
  }

  // Returns the user-entered target count (integer) or null if blank/invalid.
  function getTargetCount() {
    if (!dom.targetCountInput) return null;
    var raw = dom.targetCountInput.value.trim();
    if (raw === "") return null;
    var n = Number(raw);
    return (isFinite(n) && n >= 1) ? Math.round(n) : null;
  }

  // Calibrate min/max bounds of the target-count input after analysis.
  function calibrateTargetCountBounds(allEvents, clip) {
    if (!dom.targetCountInput) return;
    var total = allEvents.length;
    if (total < 1) {
      dom.targetCountInput.min = "1";
      dom.targetCountInput.max = "1";
      if (dom.targetCountHint) {
        dom.targetCountHint.textContent = "No usable events found for this analysis.";
      }
      return;
    }
    // Practical minimum: at least 1 but default to ~1 per 15 s of track
    var duration = 0;
    if (clip) {
      duration = Number(clip.durationSeconds) || Math.max(0, Number(clip.outPointSeconds) - Number(clip.inPointSeconds));
      if (!duration) {
        duration = Math.max(0, Number(clip.endSeconds) - Number(clip.startSeconds));
      }
    }
    var minEstimate = duration > 0 ? Math.max(1, Math.round(duration / 15)) : 1;
    var min = Math.min(minEstimate, Math.max(1, total));
    var max = total;
    dom.targetCountInput.min = String(min);
    dom.targetCountInput.max = String(max);
    // Update hint with range
    if (dom.targetCountHint) {
      dom.targetCountHint.textContent = "Range: " + min + "\u2013" + max + " beat markers. Even Spread skips empty sections; Balanced and Section Best fill from real beats when possible.";
    }
  }

  // Shuffle target-count selection. In beat mode this follows the same section
  // logic as Strategy, then tops up from remaining real beats to honor the
  // manually entered limit whenever enough detected beats exist.
  function randomizeSelection() {
    var n = getTargetCount();
    if (!isFinite(n) || n <= 0 || state.allEvents.length === 0) return;

    var pool = state.allEvents;
    n = Math.min(Math.floor(n), pool.length);
    if (n >= pool.length) {
      state.filteredEvents = pool.slice().sort(function(a,b){ return a.time - b.time; });
      updateCounterUI(n);
      return;
    }
    var sorted = pool.slice().sort(function(a,b){ return a.time - b.time; });
    sorted = collapseBeatCandidatesBySecond(sorted, n);
    n = Math.min(n, sorted.length);
    var firstTime = sorted[0].time;
    var lastTime = sorted[sorted.length - 1].time;
    var duration = Math.max(0, lastTime - firstTime);
    var segWidth = duration > 0 ? duration / n : 0;
    var selected = [];
    var usedIndices = {};

    for (var seg = 0; seg < n; seg++) {
      var tLo = firstTime + seg * segWidth;
      var tHi = seg === n - 1 ? lastTime + 0.001 : tLo + segWidth;
      var candidates = [];
      for (var k = 0; k < sorted.length; k++) {
        if (!usedIndices[k] && sorted[k].time >= tLo && sorted[k].time < tHi) {
          candidates.push(k);
        }
      }
      if (candidates.length > 0) {
        // Calculate cumulative score-weighted sum (using squared score to favor prominent events)
        var totalWeight = 0;
        var weights = [];
        for (var c = 0; c < candidates.length; c++) {
          var score = Number(sorted[candidates[c]].score) || 0.1;
          var weight = Math.max(0.001, score * score);
          totalWeight += weight;
          weights.push(weight);
        }

        // Weighted random selection
        var randomValue = Math.random() * totalWeight;
        var runningSum = 0;
        var pickIndex = candidates[0]; // fallback
        for (var c = 0; c < candidates.length; c++) {
          runningSum += weights[c];
          if (randomValue <= runningSum) {
            pickIndex = candidates[c];
            break;
          }
        }

        selected.push(sorted[pickIndex]);
        usedIndices[pickIndex] = true;
      }
    }

    if (getTargetStrategy() !== "spread") {
      while (selected.length < n) {
        var remaining = [];
        for (var r = 0; r < sorted.length; r++) {
          if (!usedIndices[r]) remaining.push(r);
        }
        if (remaining.length === 0) break;
        var extraPick = remaining[Math.floor(Math.random() * remaining.length)];
        selected.push(sorted[extraPick]);
        usedIndices[extraPick] = true;
      }
    }

    state.filteredEvents = selected.sort(function(a,b){ return a.time - b.time; });
    updateCounterUI(n);
  }

  function updateCounterUI(targetN) {
    var n = targetN !== undefined ? targetN : getTargetCount();
    var displayTarget = n !== null && state.allEvents.length > 0 ? Math.min(n, state.allEvents.length) : n;
    dom.filteredCount.textContent = String(state.filteredEvents.length);
    if (n !== null) {
      dom.totalCount.textContent = "of " + state.allEvents.length + " events (target: " + displayTarget + ", " + getTargetStrategyLabel() + ")";
      dom.thresholdLabel.textContent = "\u2022" + state.filteredEvents.length;
    } else {
      var threshold = getThreshold();
      dom.thresholdLabel.textContent = threshold.toFixed(2);
      dom.totalCount.textContent = "of " + state.allEvents.length + " events selected";
    }
    dom.applyButton.disabled = state.isBusy || state.filteredEvents.length === 0;
    if (dom.randomizeButton) dom.randomizeButton.disabled = state.isBusy || state.allEvents.length === 0;
    syncFilterTabUI();
  }

  function syncFilterTabUI() {
    var hasLimit = getTargetCount() !== null;
    if (hasLimit) {
      if (dom.tabDensity) dom.tabDensity.classList.remove("is-active");
      if (dom.tabLimit) dom.tabLimit.classList.add("is-active");
      if (dom.densityTabContent) dom.densityTabContent.classList.remove("is-active");
      if (dom.limitTabContent) dom.limitTabContent.classList.add("is-active");
    } else {
      if (dom.tabDensity) dom.tabDensity.classList.add("is-active");
      if (dom.tabLimit) dom.tabLimit.classList.remove("is-active");
      if (dom.densityTabContent) dom.densityTabContent.classList.add("is-active");
      if (dom.limitTabContent) dom.limitTabContent.classList.remove("is-active");
    }
  }

  function filterEvents() {
    var n = getTargetCount();
    if (n !== null) {
      // ── Target Count mode ──
      state.filteredEvents = selectByTargetCount(state.allEvents, n, getTargetStrategy());
      if (dom.targetCountInput) dom.targetCountInput.classList.add("is-active");
    } else {
      var beatThreshold = getThreshold();
      var beatEvents = state.allEvents.filter(function(event) {
        return Number(event.score) >= beatThreshold;
      });
      state.filteredEvents = beatThreshold <= 0.40
        ? beatEvents
        : keepStrongestWithMinimumGap(
            keepStrongestPerSecond(beatEvents),
            beatMinimumGapForThreshold(beatThreshold)
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

  function markerColorIndexForEvent(event) {
    return 3;
  }

  function getOffsetMs() {
    return dom.offsetSlider ? Number(dom.offsetSlider.value) || 0 : 0;
  }

  function updateOffsetLabel() {
    if (dom.offsetSlider && dom.offsetLabel) {
      var val = Number(dom.offsetSlider.value) || 0;
      var sign = val > 0 ? "+" : "";
      dom.offsetLabel.innerText = sign + val + " ms";
    }
  }

  function eventsForPremiere(events) {
    var offsetSec = getOffsetMs() / 1000.0;
    return events.map(function(event) {
      return {
        time: event.time + offsetSec,
        score: event.score,
        colorIndex: markerColorIndexForEvent(event)
      };
    });
  }

  function analyzeTrack() {
    if (state.isBusy) return;

    setBusy(true);
    state.allEvents    = [];
    state.filteredEvents = [];
    state.clip         = null;
    if (dom.offsetSlider) {
      dom.offsetSlider.value = 0;
      updateOffsetLabel();
    }
    dom.densityPanel.classList.add("is-hidden");
    setStatus("Reading the selected clip path from Premiere...", false, true);

    cepEval("AutoCutStudio.getSelectedClipInfo()")
      .then(function (result) {
        state.clip = result.clip;
        if (!state.clip.mediaPath) {
          throw new Error("Premiere returned an empty media path for the selected clip.");
        }
        var range = clipAnalysisRange(state.clip);
        if (!range) {
          throw new Error("Selected clip has an invalid source in/out range. Trim or reselect the timeline clip and try again.");
        }
        setStatus("Analyzing selected cut only (" + formatSeconds(range.duration) + ") from " + state.clip.name + " for " + getBeatWorkflowLabel() + " markers...", false, true);
        return runHybridAnalyzer(state.clip.mediaPath, state.clip);
      })
      .then(function (analysis) {
        state.allEvents = cropEventsToSelectedClip(sanitizeEvents(analysis.events || []), state.clip);
        // Calibrate target-count input bounds now we know the event pool size
        calibrateTargetCountBounds(state.allEvents, state.clip);
        filterEvents();
        dom.densityPanel.classList.remove("is-hidden");
        setStatus(
          (isBrowserPreview() ? "Preview analysis complete: " : "Analysis complete: ") +
          "found " + state.allEvents.length + " " + getBeatWorkflowLabel() + " markers in the selected cut using Rust analyzer.",
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

    var basePayload = {
      target: dom.markerTarget.value,
      mediaPath: state.clip ? state.clip.mediaPath : "",
      startSeconds: state.clip ? state.clip.startSeconds : null,
      endSeconds: state.clip ? state.clip.endSeconds : null,
      inPointSeconds: state.clip ? state.clip.inPointSeconds : null,
      outPointSeconds: state.clip ? state.clip.outPointSeconds : null
    };

    var allEvents = eventsForPremiere(state.filteredEvents);
    var chunkSize = 50;
    var totalApplied = 0;
    var totalSkipped = 0;
    var markersCleared = false;

    var removePayload = {
      target: basePayload.target,
      mediaPath: basePayload.mediaPath,
      startSeconds: basePayload.startSeconds,
      endSeconds: basePayload.endSeconds,
      inPointSeconds: basePayload.inPointSeconds,
      outPointSeconds: basePayload.outPointSeconds
    };

    cepEval("AutoCutStudio.removeMarkers(" + JSON.stringify(JSON.stringify(removePayload)) + ")")
      .then(function () {
        markersCleared = true;
        return new Promise(function (resolve, reject) {
          function processChunk(index) {
            if (index >= allEvents.length) {
              resolve();
              return;
            }

            var chunkEvents = allEvents.slice(index, index + chunkSize);
            var chunkPayload = {
              target: basePayload.target,
              mediaPath: basePayload.mediaPath,
              startSeconds: basePayload.startSeconds,
              endSeconds: basePayload.endSeconds,
              inPointSeconds: basePayload.inPointSeconds,
              outPointSeconds: basePayload.outPointSeconds,
              events: chunkEvents
            };

            setStatus("Applying markers: " + index + " to " + Math.min(index + chunkSize, allEvents.length) + " of " + allEvents.length + "...", false, true);

            cepEval("AutoCutStudio.applyMarkersChunk(" + JSON.stringify(JSON.stringify(chunkPayload)) + ")")
              .then(function (result) {
                totalApplied += (result.applied || 0);
                totalSkipped += (result.skipped || 0);
                setTimeout(function () {
                  processChunk(index + chunkSize);
                }, 15);
              })
              .catch(reject);
          }

          processChunk(0);
        });
      })
      .then(function () {
        setStatus("Replaced AutoCut Studio markers in range. Applied " + totalApplied + "; skipped " + totalSkipped + " outside the selected clip range.", false, false, true);
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        var message = error && error.message ? error.message : String(error);
        if (markersCleared) {
          var cleanupFailed = false;
          setStatus("Marker apply failed after " + totalApplied + " markers. Removing partial result...", true, true);
          return cepEval("AutoCutStudio.removeMarkers(" + JSON.stringify(JSON.stringify(removePayload)) + ")")
            .catch(function (cleanupError) {
              cleanupFailed = true;
              appendLog(cleanupError && cleanupError.stack ? cleanupError.stack : String(cleanupError));
            })
            .then(function () {
              if (cleanupFailed) {
                setStatus(message + " Partial marker cleanup also failed; remove markers manually before retrying.", true);
              } else {
                setStatus(message + " Partial markers were removed; run Apply Markers again.", true);
              }
            });
        }
        setStatus(message, true);
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
    setStatus("Removing AutoCut Studio markers from the selected " + (dom.markerTarget.value === "clip" ? "clip" : "timeline range") + "...", false, true);

    var payload = {
      target: dom.markerTarget.value
    };

    cepEval("AutoCutStudio.removeMarkers(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Removed " + result.removed + " AutoCut Studio markers.", false, false, true);
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
    var zoomModeEl = document.getElementById("zoomMode");
    var zoomStyle = zoomModeEl ? zoomModeEl.value : "smooth_in";
    var autoRatio = !dom.autoZoomRatio || dom.autoZoomRatio.checked;
    var styleLabel = zoomStyle.replace("_", " ");
    setStatus("Applying " + styleLabel + " gimbal zoom to selected clips (" + (autoRatio ? "auto ratio" : zoomValue + "%") + ")...");

    var payload = { zoom: zoomValue, style: zoomStyle, autoRatio: autoRatio };
    cepEval("AutoCutStudio.applyGimbalZoom(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        var skipped = Number(result.skipped) || 0;
        var details = result.errors && result.errors.length ? " Details: " + result.errors.join(" | ") : "";
        setStatus("Applied gimbal zoom keyframes to " + result.applied + " clips" + (skipped ? "; skipped " + skipped : "") + "." + details, false, false, true);
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function readSliderNumber(element, fallback) {
    var value = element ? Number(element.value) : fallback;
    return isFinite(value) ? value : fallback;
  }

  function getDollyPayload() {
    var subjectFrame = readSliderNumber(dom.dollySubjectSlider, 72);
    var backgroundFrame = readSliderNumber(dom.dollyBackgroundSlider, 112);
    var sensitivity = readSliderNumber(dom.dollySensitivitySlider, 65);
    var subjectX = readSliderNumber(dom.dollySubjectXSlider, 50);
    var subjectY = readSliderNumber(dom.dollySubjectYSlider, 50);
    var backgroundX = readSliderNumber(dom.dollyBackgroundXSlider, 50);
    var backgroundY = readSliderNumber(dom.dollyBackgroundYSlider, 50);
    return {
      zoom: backgroundFrame,
      style: "dolly_zoom",
      autoRatio: false,
      dolly: {
        subjectFrame: subjectFrame,
        backgroundFrame: backgroundFrame,
        sensitivity: sensitivity,
        subjectX: subjectX,
        subjectY: subjectY,
        backgroundX: backgroundX,
        backgroundY: backgroundY
      }
    };
  }

  function applyDollyFrameInfo(info, isFallback) {
    var width = Number(info && info.width) || 1920;
    var height = Number(info && info.height) || 1080;
    if (dom.dollyScreen) {
      dom.dollyScreen.style.aspectRatio = width + " / " + height;
      dom.dollyScreen.classList.toggle("is-auto-portrait", height > width);
      dom.dollyScreen.classList.toggle("is-frame-unknown", Boolean(isFallback));
    }
    if (dom.dollyFrameLabel) {
      dom.dollyFrameLabel.textContent = isFallback ? "Frame unknown" : Math.round(width) + "x" + Math.round(height);
    }
  }

  function detectDollyFrame() {
    if (isBrowserPreview()) {
      applyDollyFrameInfo({ width: 1920, height: 1080 });
      return Promise.resolve();
    }
    return cepEval("AutoCutStudio.getDollyFrameInfo()")
      .then(function(result) {
        applyDollyFrameInfo(result);
      })
      .catch(function(error) {
        appendLog("DOLLY FRAME DETECT FAILED: " + (error && error.message ? error.message : String(error)));
        applyDollyFrameInfo({ width: 1920, height: 1080 }, true);
        setStatus("Could not detect sequence frame for Dolly preview. Showing a neutral guide; applied motion still uses Premiere sequence data when available.", true);
      });
  }

  function applyDollyZoom() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    var payload = getDollyPayload();
    setStatus("Applying manual dolly zoom: subject " + payload.dolly.subjectFrame + "% at " + payload.dolly.subjectX + "," + payload.dolly.subjectY + "; background " + payload.dolly.backgroundFrame + "% at " + payload.dolly.backgroundX + "," + payload.dolly.backgroundY + "; sensitivity " + payload.dolly.sensitivity + "%...");

    cepEval("AutoCutStudio.applyGimbalZoom(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        var skipped = Number(result.skipped) || 0;
        var details = result.errors && result.errors.length ? " Details: " + result.errors.join(" | ") : "";
        setStatus("Applied manual dolly zoom to " + result.applied + " clips" + (skipped ? "; skipped " + skipped : "") + "." + details, false, false, true);
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function () {
        setBusy(false);
      });
  }

  function clearGimbalZoom() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Clearing zoom keyframes from selected video clips...", false, true);

    cepEval("AutoCutStudio.clearGimbalZoom()")
      .then(function(result) {
        var skipped = Number(result.skipped) || 0;
        var details = result.errors && result.errors.length ? " Details: " + result.errors.join(" | ") : "";
        setStatus("Cleared zoom keyframes on " + result.cleared + " clips" + (skipped ? "; skipped " + skipped : "") + "." + details, false, false, true);
      })
      .catch(function(error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function() {
        setBusy(false);
      });
  }

  function autoColorSelectedClips() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Capturing the playhead frame for AutoCut color correction...", false, true);

    cepEval("AutoCutStudio.autoColorAtPlayhead()")
      .then(function(result) {
        var engine = result.engine || "AutoCut custom correction";
        var skipped = Number(result.skipped) || 0;
        var details = result.errors && result.errors.length ? " Details: " + result.errors.join(" | ") : "";
        var csInfo = result.colorScience ? " [Color Science: " + result.colorScience + "]" : "";
        var capture = result.captureFrameSeconds !== undefined ? " from playhead frame " + formatSeconds(Number(result.captureFrameSeconds)) : "";
        setStatus("Auto color applied to " + result.applied + " selected clip" + (result.applied === 1 ? "" : "s") + capture + " using " + engine + (skipped ? "; skipped " + skipped : "") + "." + csInfo + details, false, false, true);
      })
      .catch(function(error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function() {
        setBusy(false);
      });
  }

  function resetColorGrade() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Resetting color correction controls on selected video clips...", false, true);

    cepEval("AutoCutStudio.resetColorGrade()")
      .then(function(result) {
        var skipped = Number(result.skipped) || 0;
        var details = result.errors && result.errors.length ? " Details: " + result.errors.join(" | ") : "";
        setStatus("Reset color controls on " + result.reset + " clips" + (skipped ? "; skipped " + skipped : "") + "." + details, false, false, true);
      })
      .catch(function(error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function() {
        setBusy(false);
      });
  }

  function sleep(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  function waitForVideoEffectAnalysis(label) {
    var started = Date.now();
    var timeoutMs = 20 * 60 * 1000;

    return sleep(1200).then(function poll() {
      return cepEval("AutoCutStudio.isVideoEffectAnalysisDone()")
        .then(function(result) {
          if (result.done) {
            return result;
          }
          if (Date.now() - started > timeoutMs) {
            throw new Error("Timed out waiting for Warp Stabilizer analysis on " + label + ".");
          }
          setStatus("Waiting for Warp Stabilizer analysis: " + label + "...", false, true);
          return sleep(2500).then(poll);
        })
        .catch(function(error) {
          var message = error && error.message ? error.message : String(error);
          if (message.indexOf("video-effect analysis status") >= 0) {
            setStatus("Warp Stabilizer applied to " + label + ". Premiere did not expose analysis status, continuing.", false, true);
            return { done: true, unsupportedStatus: true };
          }
          throw error;
        });
    });
  }

  function applyWarpStabilizerQueue() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Reading selected video clips for Warp Stabilizer...", false, true);

    cepEval("AutoCutStudio.getSelectedVideoClipCount()")
      .then(function(result) {
        var total = Number(result.count) || 0;
        if (total < 1) {
          throw new Error("Select at least one video clip in the active sequence.");
        }

        var applied = 0;
        var skipped = 0;

        function applyNext(index) {
          if (index >= total) {
            setStatus("Warp Stabilizer queue complete: applied " + applied + ", skipped " + skipped + ".", false, false, true);
            return Promise.resolve();
          }

          setStatus("Applying Warp Stabilizer to clip " + (index + 1) + " of " + total + "...", false, true);
          var payload = { index: index };
          return cepEval("AutoCutStudio.applyWarpStabilizerToSelectedClip(" + JSON.stringify(JSON.stringify(payload)) + ")")
            .then(function(applyResult) {
              var name = applyResult.name || ("clip " + (index + 1));
              if (applyResult.skipped) {
                skipped++;
                setStatus("Skipping " + name + ": " + applyResult.reason, false, true);
                return sleep(300).then(function() {
                  return applyNext(index + 1);
                });
              }

              applied++;
              setStatus("Warp Stabilizer applied to " + name + ". Waiting for analysis before next clip...", false, true);
              return waitForVideoEffectAnalysis(name).then(function() {
                return applyNext(index + 1);
              });
            });
        }

        return applyNext(0);
      })
      .catch(function(error) {
        appendLog(error && error.stack ? error.stack : String(error));
        setStatus(error.message, true);
      })
      .then(function() {
        setBusy(false);
      });
  }

  function runDiagnostics() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus("Running AutoCut Studio diagnostics for v" + APP_VERSION + "...");

    var checks = [];
    checks.push("AutoCut Studio: v" + APP_VERSION);
    var req = getNodeRequire();
    checks.push(req ? "CEP Node: OK" : (isBrowserPreview() ? "CEP Node: simulated in browser preview" : "CEP Node: FAIL"));

    if (req) {
      try {
        var analyzerPath = getAnalyzerPath();
        checks.push("Analyzer: OK at " + analyzerPath);
      } catch (error) {
        checks.push("Analyzer: FAIL - " + error.message);
      }
    } else if (isBrowserPreview()) {
      checks.push("Analyzer: simulated demo events");
    }

    cepEval("AutoCutStudio.runDiagnostics()")
      .then(function (result) {
        if (result.diagnostics && result.diagnostics.length) {
          checks = checks.concat(result.diagnostics);
        }
        var report = checks.join(" | ");
        var formatted = report.replace(/ \| /g, "\n");
        setStatus("Diagnostics complete.");

        // Show report in confirm modal and copy to clipboard only upon explicit user action.
        if (confirm("DIAGNOSTICS REPORT:\n\n" + formatted + "\n\nWould you like to copy this report to the clipboard?")) {
          copyToClipboard(formatted)
            .then(function () {
              setStatus("Diagnostics copied to clipboard.");
            })
            .catch(function () {
              setStatus("Failed to copy diagnostics to clipboard.", true);
            });
        }
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

  function clearLogs() {
    var req = getNodeRequire();
    if (!req) {
      setStatus("Cannot clear logs: Node.js unavailable.", true);
      return;
    }

    try {
      var fs = req("fs");
      var path = req("path");
      var os = req("os");
      var appData = typeof process !== "undefined" && process.env ? process.env.APPDATA : "";
      var dir = path.join(appData || os.tmpdir(), "AutoCutStudio");

      var panelLog = path.join(dir, "panel.log");

      if (fs.existsSync(panelLog)) {
        fs.writeFileSync(panelLog, "");
      }

      setStatus("Panel logs cleared successfully.", false, false, true);
    } catch (error) {
      setStatus("Failed to clear logs: " + error.message, true);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    var req = getNodeRequire();
    if (req) {
      return new Promise(function (resolve, reject) {
        try {
          var childProcess = req("child_process");
          var os = req("os");
          var command = os.platform() === "win32" ? "clip" : "pbcopy";
          var child = childProcess.spawn(command);
          child.on("error", reject);
          child.on("close", function (code) {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(command + " exited with code " + code));
            }
          });
          child.stdin.end(text);
        } catch (error) {
          reject(error);
        }
      });
    }
    return Promise.reject(new Error("Clipboard API is unavailable in this host."));
  }

  function activateMainTab(tabName) {
    var tabs = [
      { name: "markers", button: dom.mainTabMarkersButton, panel: dom.mainTabMarkers },
      { name: "color", button: dom.mainTabColorButton, panel: dom.mainTabColor },
      { name: "tools", button: dom.mainTabToolsButton, panel: dom.mainTabTools },
      { name: "dolly", button: dom.mainTabDollyButton, panel: dom.mainTabDolly },
      { name: "diagnostics", button: dom.mainTabDiagnosticsButton, panel: dom.mainTabDiagnostics }
    ];

    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var active = tab.name === tabName;
      if (tab.button) {
        tab.button.classList.toggle("is-active", active);
        tab.button.setAttribute("aria-selected", active ? "true" : "false");
      }
      if (tab.panel) {
        tab.panel.classList.toggle("is-active", active);
        if (active) {
          tab.panel.removeAttribute("hidden");
        } else {
          tab.panel.setAttribute("hidden", "hidden");
        }
      }
    }
  }

  dom.analyzeButton.addEventListener("click", analyzeTrack);
  dom.diagnosticsButton.addEventListener("click", runDiagnostics);
  if (dom.clearLogsButton) dom.clearLogsButton.addEventListener("click", clearLogs);
  dom.applyButton.addEventListener("click", applyMarkers);
  dom.removeButton.addEventListener("click", removeMarkers);
  if (dom.gimbalZoomButton) dom.gimbalZoomButton.addEventListener("click", applyGimbalZoom);
  if (dom.confirmDollyZoomButton) dom.confirmDollyZoomButton.addEventListener("click", applyDollyZoom);
  if (dom.clearZoomButton) dom.clearZoomButton.addEventListener("click", clearGimbalZoom);
  if (dom.warpStabilizerButton) dom.warpStabilizerButton.addEventListener("click", applyWarpStabilizerQueue);
  if (dom.autoColorButton) dom.autoColorButton.addEventListener("click", autoColorSelectedClips);
  if (dom.resetColorButton) dom.resetColorButton.addEventListener("click", resetColorGrade);
  if (dom.randomizeButton) {
    dom.randomizeButton.addEventListener("click", function() {
      // If no target count is set, default to current filtered count
      if (getTargetCount() === null && state.filteredEvents.length > 0) {
        dom.targetCountInput.value = String(state.filteredEvents.length);
      }
      randomizeSelection();
    });
  }
  if (dom.densitySlider) dom.densitySlider.addEventListener("input", filterEvents);
  if (dom.offsetSlider) {
    dom.offsetSlider.addEventListener("input", function() {
      updateOffsetLabel();
    });
  }
  if (dom.targetCountInput) {
    dom.targetCountInput.addEventListener("input", function() {
      if (state.allEvents.length > 0) filterEvents();
    });
  }
  if (dom.targetStrategy) {
    dom.targetStrategy.addEventListener("change", function() {
      if (state.allEvents.length > 0 && getTargetCount() !== null) filterEvents();
    });
  }
  if (dom.zoomSlider) {
    dom.zoomSlider.addEventListener("input", function() {
      if (dom.autoZoomRatio) dom.autoZoomRatio.checked = false;
      if (dom.zoomLabel) dom.zoomLabel.textContent = dom.zoomSlider.value + "%";
      refreshZoomPreview();
    });
  }

  // Interactive movement preview animations changer
  var previewSubject = document.getElementById("previewSubject");
  var zoomModeSelect = document.getElementById("zoomMode");
  var previewModeLabel = document.getElementById("previewModeLabel");
  var previewRatioLabel = document.getElementById("previewRatioLabel");
  var previewKeyframeTrack = document.getElementById("previewKeyframeTrack");
  var previewStartLabel = document.getElementById("previewStartLabel");
  var previewEndLabel = document.getElementById("previewEndLabel");
  var selectedMomentLabel = document.getElementById("selectedMomentLabel");
  var selectedMomentMeta = document.getElementById("selectedMomentMeta");
  var movementButtons = document.querySelectorAll(".movement-btn");
  var activeMovementLabel = "";
  var autoRatioByMode = {
    smooth_in: 108,
    smooth_out: 108,
    drift: 105,
    breath: 106,
    reveal: 112,
    settle_in: 114,
    swell: 110,
    crash_in: 126,
    crash_out: 124,
    punch_in: 118,
    punch_out: 116,
    pulse: 112,
    snap_back: 120,
    triple_hit: 116
  };
  var previewNames = {
    smooth_in: "Slow Advance",
    smooth_out: "Elegant Pullback",
    drift: "Subtle Drift",
    breath: "Soft Breathing",
    reveal: "Grace Reveal",
    settle_in: "Refined Settle",
    swell: "Closing Swell",
    crash_in: "Impact Advance",
    crash_out: "Impact Release",
    punch_in: "Dance Accent",
    punch_out: "Beat Release",
    pulse: "Rhythm Pulse",
    snap_back: "Percussion Snap",
    triple_hit: "Procession Beat"
  };
  var movementDescriptions = {
    smooth_in: "Gradual cinematic emphasis for portraits, vows, and emotional detail shots.",
    smooth_out: "Elegant release that opens the frame near the end of the shot.",
    drift: "Subtle motion for couple portraits and calm beauty shots.",
    breath: "Soft organic movement that gently returns to neutral.",
    reveal: "Held emphasis followed by a graceful reveal.",
    settle_in: "Refined push with a controlled settle for detail emphasis.",
    swell: "Quiet start with a closing lift for transitions and emotional exits.",
    punch_in: "Strong beat accent for dance entries and energetic cuts.",
    punch_out: "Fast release after a strong visual or music hit.",
    pulse: "Controlled rhythmic pulse for claps and dance beats.",
    snap_back: "Sharp percussion accent that quickly returns to neutral.",
    triple_hit: "Three rhythmic accents for procession, dhol, and dance sections."
  };

  function setZoomRatio(value, keepAuto) {
    if (!dom.zoomSlider || !value) return;
    dom.zoomSlider.value = value;
    if (dom.zoomLabel) dom.zoomLabel.textContent = dom.zoomSlider.value + "%";
    if (dom.autoZoomRatio) dom.autoZoomRatio.checked = keepAuto !== false;
    refreshZoomPreview();
  }

  function applyAutoRatioForMode() {
    if (!zoomModeSelect || !dom.autoZoomRatio || !dom.autoZoomRatio.checked) return;
    setZoomRatio(autoRatioByMode[zoomModeSelect.value] || 110, true);
  }

  function syncMovementButtons(mode) {
    for (var i = 0; i < movementButtons.length; i++) {
      var label = movementButtons[i].textContent || "";
      var isActive = movementButtons[i].getAttribute("data-mode") === mode && (!activeMovementLabel || label === activeMovementLabel);
      movementButtons[i].classList.toggle("is-active", isActive);
      movementButtons[i].setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  function selectZoomMode(mode, keepManualRatio, displayLabel) {
    if (!zoomModeSelect || !mode) return;
    zoomModeSelect.value = mode;
    activeMovementLabel = displayLabel || "";
    syncMovementButtons(mode);
    if (!keepManualRatio) {
      applyAutoRatioForMode();
    }
    refreshZoomPreview();
  }

  function refreshZoomPreview() {
    if (!zoomModeSelect) return;
    var mode = zoomModeSelect.value || "smooth_in";
    var val = String(mode).replace(/_/g, "-");
    var ratio = dom.zoomSlider ? Number(dom.zoomSlider.value) || 110 : 110;
    var autoText = dom.autoZoomRatio && dom.autoZoomRatio.checked ? "AUTO " : "MANUAL ";
    if (previewSubject) previewSubject.className = "preview-subject animate-" + val;
    syncMovementButtons(mode);
    var displayName = activeMovementLabel || previewNames[mode] || mode.replace(/_/g, " ");
    if (previewModeLabel) previewModeLabel.textContent = displayName;
    if (selectedMomentLabel) selectedMomentLabel.textContent = displayName;
    if (selectedMomentMeta) selectedMomentMeta.textContent = movementDescriptions[mode] || "Clean scale movement across the selected clip.";
    if (previewRatioLabel) previewRatioLabel.textContent = autoText + ratio + "%";
    renderKeyframePreview(mode, ratio);
  }

  function keyframePreviewPoints(mode, ratio) {
    var soft = Math.round(100 + (ratio - 100) * 0.45);
    var drift = Math.round(100 + (ratio - 100) * 0.3);
    var breath = Math.round(100 + (ratio - 100) * 0.22);
    var over = Math.min(150, Math.round(100 + (ratio - 100) * 1.18));
    var patterns = {
      smooth_in: [[0, 100], [100, ratio]],
      smooth_out: [[0, ratio], [100, 100]],
      drift: [[0, 100], [100, drift]],
      breath: [[0, 100], [50, breath], [100, 100]],
      reveal: [[0, ratio], [62, ratio], [100, 100]],
      settle_in: [[0, 100], [22, over], [55, soft], [100, ratio]],
      swell: [[0, 100], [45, 100], [100, ratio]],
      crash_in: [[0, 100], [72, 100], [100, ratio]],
      crash_out: [[0, ratio], [24, 100], [100, 100]],
      punch_in: [[0, 100], [8, ratio], [28, soft], [100, soft]],
      punch_out: [[0, ratio], [10, 100], [100, 100]],
      pulse: [[0, 100], [18, ratio], [38, 100], [62, soft], [100, 100]],
      snap_back: [[0, 100], [10, ratio], [30, 100], [100, 100]],
      triple_hit: [[0, 100], [15, ratio], [31, 100], [47, soft], [63, 100], [100, 100]]
    };
    return patterns[mode] || patterns.smooth_in;
  }

  function renderKeyframePreview(mode, ratio) {
    if (!previewKeyframeTrack) return;
    var points = keyframePreviewPoints(mode, ratio);
    previewKeyframeTrack.innerHTML = "";
    var minScale = 100;
    var maxScale = Math.max(150, ratio);

    function yFor(scale) {
      var normalized = (scale - minScale) / (maxScale - minScale);
      return 21 - Math.max(0, Math.min(1, normalized)) * 17;
    }

    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i];
      var b = points[i + 1];
      var x1 = a[0];
      var y1 = yFor(a[1]);
      var x2 = b[0];
      var y2 = yFor(b[1]);
      var dx = x2 - x1;
      var dy = y2 - y1;
      var line = document.createElement("span");
      line.className = "key-line";
      line.style.left = x1 + "%";
      line.style.top = y1 + "px";
      line.style.width = Math.sqrt(dx * dx + dy * dy) + "%";
      line.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
      previewKeyframeTrack.appendChild(line);
    }

    for (var k = 0; k < points.length; k++) {
      var point = points[k];
      var node = document.createElement("span");
      node.className = "key-node";
      node.style.left = point[0] + "%";
      node.style.top = yFor(point[1]) + "px";
      node.setAttribute("data-scale", Math.round(point[1]) + "%");
      previewKeyframeTrack.appendChild(node);
    }

    if (previewStartLabel) previewStartLabel.textContent = Math.round(points[0][1]) + "% start";
    if (previewEndLabel) previewEndLabel.textContent = Math.round(points[points.length - 1][1]) + "% end";
  }

  function updateDollyPanel() {
    var subjectFrame = readSliderNumber(dom.dollySubjectSlider, 72);
    var backgroundFrame = readSliderNumber(dom.dollyBackgroundSlider, 112);
    var sensitivity = readSliderNumber(dom.dollySensitivitySlider, 65);
    var subjectX = readSliderNumber(dom.dollySubjectXSlider, 50);
    var subjectY = readSliderNumber(dom.dollySubjectYSlider, 50);
    var backgroundX = readSliderNumber(dom.dollyBackgroundXSlider, 50);
    var backgroundY = readSliderNumber(dom.dollyBackgroundYSlider, 50);
    var subjectBox = Math.max(26, Math.min(82, subjectFrame * 0.62));
    var subjectWidth = subjectBox * 0.58;
    var subjectHeight = Math.min(92, subjectBox * 0.92);
    var backgroundBox = Math.max(subjectBox + 8, Math.min(96, backgroundFrame * 0.72));

    if (dom.dollySubjectLabel) dom.dollySubjectLabel.textContent = subjectFrame + "%";
    if (dom.dollyBackgroundLabel) dom.dollyBackgroundLabel.textContent = backgroundFrame + "%";
    if (dom.dollySensitivityLabel) dom.dollySensitivityLabel.textContent = sensitivity + "%";
    if (dom.dollySubjectXLabel) dom.dollySubjectXLabel.textContent = subjectX + "%";
    if (dom.dollySubjectYLabel) dom.dollySubjectYLabel.textContent = subjectY + "%";
    if (dom.dollyBackgroundXLabel) dom.dollyBackgroundXLabel.textContent = backgroundX + "%";
    if (dom.dollyBackgroundYLabel) dom.dollyBackgroundYLabel.textContent = backgroundY + "%";
    if (dom.dollyStrengthLabel) dom.dollyStrengthLabel.textContent = sensitivity + "% Sens";
    if (dom.dollySubjectFrame) {
      dom.dollySubjectFrame.style.width = subjectWidth + "%";
      dom.dollySubjectFrame.style.height = subjectHeight + "%";
      dom.dollySubjectFrame.style.left = subjectX + "%";
      dom.dollySubjectFrame.style.top = subjectY + "%";
    }
    if (dom.dollyBackgroundFrame) {
      dom.dollyBackgroundFrame.style.width = backgroundBox + "%";
      dom.dollyBackgroundFrame.style.height = backgroundBox * 0.56 + "%";
      dom.dollyBackgroundFrame.style.left = backgroundX + "%";
      dom.dollyBackgroundFrame.style.top = backgroundY + "%";
    }
    if (dom.dollySubjectTarget) {
      dom.dollySubjectTarget.style.left = subjectX + "%";
      dom.dollySubjectTarget.style.top = subjectY + "%";
    }
    if (dom.dollyBackgroundTarget) {
      dom.dollyBackgroundTarget.style.left = backgroundX + "%";
      dom.dollyBackgroundTarget.style.top = backgroundY + "%";
    }
    if (dom.dollyMotionLine) {
      var dx = subjectX - backgroundX;
      var dy = subjectY - backgroundY;
      var length = Math.sqrt(dx * dx + dy * dy);
      dom.dollyMotionLine.style.left = backgroundX + "%";
      dom.dollyMotionLine.style.top = backgroundY + "%";
      dom.dollyMotionLine.style.width = length + "%";
      dom.dollyMotionLine.style.transform = "rotate(" + Math.atan2(dy, dx) + "rad)";
    }
  }

  var dollySliders = [
    dom.dollySubjectSlider,
    dom.dollyBackgroundSlider,
    dom.dollySensitivitySlider,
    dom.dollySubjectXSlider,
    dom.dollySubjectYSlider,
    dom.dollyBackgroundXSlider,
    dom.dollyBackgroundYSlider
  ];
  for (var ds = 0; ds < dollySliders.length; ds++) {
    if (dollySliders[ds]) {
      dollySliders[ds].addEventListener("input", function() {
        updateDollyPanel();
      });
    }
  }
  detectDollyFrame();
  updateDollyPanel();

  if (zoomModeSelect && previewSubject) {
    zoomModeSelect.addEventListener("change", function() {
      selectZoomMode(zoomModeSelect.value);
    });
    applyAutoRatioForMode();
    refreshZoomPreview();
  }

  for (var mb = 0; mb < movementButtons.length; mb++) {
    movementButtons[mb].addEventListener("click", function() {
      var isWeddingPreset = this.classList && this.classList.contains("wedding-preset");
      selectZoomMode(this.getAttribute("data-mode"), false, isWeddingPreset ? this.textContent : "");
      var ratio = this.getAttribute("data-ratio");
      if (ratio) {
        setZoomRatio(ratio, true);
      }
    });
  }

  // Zoom preset shortcuts click handler
  var presetButtons = document.querySelectorAll(".btn-preset");
  for (var pb = 0; pb < presetButtons.length; pb++) {
    presetButtons[pb].addEventListener("click", function() {
      var ratio = this.getAttribute("data-ratio");
      var mode = this.getAttribute("data-mode");
      if (mode) {
        selectZoomMode(mode, false, this.textContent || "");
      }
      if (dom.zoomSlider && ratio) {
        setZoomRatio(ratio, Boolean(mode));
      }
    });
  }
  if (dom.autoZoomRatio) {
    dom.autoZoomRatio.addEventListener("change", function() {
      if (dom.autoZoomRatio.checked) {
        applyAutoRatioForMode();
      }
      refreshZoomPreview();
    });
  }
  if (dom.mainTabMarkersButton) {
    dom.mainTabMarkersButton.addEventListener("click", function() {
      activateMainTab("markers");
    });
  }
  if (dom.mainTabColorButton) {
    dom.mainTabColorButton.addEventListener("click", function() {
      activateMainTab("color");
    });
  }
  if (dom.mainTabToolsButton) {
    dom.mainTabToolsButton.addEventListener("click", function() {
      activateMainTab("tools");
    });
  }
  if (dom.mainTabDollyButton) {
    dom.mainTabDollyButton.addEventListener("click", function() {
      activateMainTab("dolly");
      detectDollyFrame();
    });
  }
  if (dom.mainTabDiagnosticsButton) {
    dom.mainTabDiagnosticsButton.addEventListener("click", function() {
      activateMainTab("diagnostics");
    });
  }
  // Initialize collapsible card headers for Adobe Spectrum smart folders
  var headers = document.querySelectorAll(".card-header");
  for (var h = 0; h < headers.length; h++) {
    headers[h].addEventListener("click", function() {
      var card = this.parentElement;
      if (card && card.classList.contains("panel-card")) {
        card.classList.toggle("is-collapsed");
      }
    });
  }
  if (dom.tabDensity) {
    dom.tabDensity.addEventListener("click", function() {
      if (state.isBusy) return;
      if (dom.targetCountInput) {
        dom.targetCountInput.value = "";
        dispatchInputEvent(dom.targetCountInput);
      }
      syncFilterTabUI();
    });
  }

  if (dom.tabLimit) {
    dom.tabLimit.addEventListener("click", function() {
      if (state.isBusy) return;
      if (dom.targetCountInput) {
        var val = dom.targetCountInput.value.trim();
        if (val === "") {
          var minVal = dom.targetCountInput.min || "10";
          dom.targetCountInput.value = minVal;
        }
        dispatchInputEvent(dom.targetCountInput);
      }
      syncFilterTabUI();
    });
  }

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
    setStatus("Browser preview mode. Analyze uses simulated event markers; Premiere actions are mocked.");
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

