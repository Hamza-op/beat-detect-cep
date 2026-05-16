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
    analyzeButton: document.getElementById("analyzeButton"),
    diagnosticsButton: document.getElementById("diagnosticsButton"),
    applyButton: document.getElementById("applyButton"),
    removeButton: document.getElementById("removeButton"),
    status: document.getElementById("status"),
    densityPanel: document.getElementById("densityPanel"),
    densitySlider: document.getElementById("densitySlider"),
    thresholdLabel: document.getElementById("thresholdLabel"),
    filteredCount: document.getElementById("filteredCount"),
    totalCount: document.getElementById("totalCount"),
    markerTarget: document.getElementById("markerTarget")
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
    dom.analyzeButton.disabled = isBusy;
    dom.diagnosticsButton.disabled = isBusy;
    dom.removeButton.disabled = isBusy;
    dom.applyButton.disabled = isBusy || state.filteredEvents.length === 0;
  }

  function setStatus(message, isError) {
    dom.status.textContent = message;
    dom.status.classList.toggle("is-error", Boolean(isError));
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
    var minGap = focus === "vocal" ? 0.65 : 0.22;
    var maxGap = focus === "vocal" ? 2.0 : 1.5;
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

  function keepStrongestPerSecond(events) {
    var bySecond = {};
    for (var i = 0; i < events.length; i++) {
      var event = events[i];
      var second = Math.floor(event.time);
      if (!bySecond[second] || event.score > bySecond[second].score) {
        bySecond[second] = event;
      }
    }

    var kept = [];
    Object.keys(bySecond).forEach(function (second) {
      kept.push(bySecond[second]);
    });
    return kept.sort(function (a, b) {
      return a.time - b.time;
    });
  }

  function filterEvents() {
    var threshold = getThreshold();
    var focus = getDetectionFocus();
    var thresholded = state.allEvents.filter(function (event) {
      return Number(event.score) >= threshold;
    });
    state.filteredEvents = keepStrongestPerSecond(
      suppressCloseEvents(thresholded, spacingForFilter(threshold, focus), focus)
    );

    dom.thresholdLabel.textContent = threshold.toFixed(2);
    dom.filteredCount.textContent = String(state.filteredEvents.length);
    dom.totalCount.textContent = "of " + state.allEvents.length + " events selected";
    dom.applyButton.disabled = state.isBusy || state.filteredEvents.length === 0;
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
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    state.allEvents = [];
    state.filteredEvents = [];
    state.clip = null;
    dom.densityPanel.classList.add("is-hidden");
    setStatus("Reading the selected clip path from Premiere...");

    cepEval("BeatDetect.getSelectedClipInfo()")
      .then(function (result) {
        state.clip = result.clip;
        if (!state.clip.mediaPath) {
          throw new Error("Premiere returned an empty media path for the selected clip.");
        }
        var focus = getDetectionFocus();
        var label = focus === "vocal" ? "vocal phrase starts and melodic entries" : focus === "music" ? "music spikes and vocal phrase starts" : "sharp percussion hits, drops, and accents";
        setStatus("Analyzing " + state.clip.name + " for " + label + "...");
        return runAnalyzer(state.clip.mediaPath, focus);
      })
      .then(function (events) {
        state.allEvents = sanitizeEvents(events);
        filterEvents();
        dom.densityPanel.classList.remove("is-hidden");
        setStatus((isBrowserPreview() ? "Preview analysis complete: " : "Analysis complete: ") + "found " + state.allEvents.length + " total rhythmic events.");
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
    setStatus("Applying " + state.filteredEvents.length + " markers in Premiere...");

    var payload = {
      target: dom.markerTarget.value,
      mediaPath: state.clip ? state.clip.mediaPath : "",
      focus: getDetectionFocus(),
      events: state.filteredEvents
    };

    cepEval("BeatDetect.applyMarkers(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Applied " + result.applied + " markers. Skipped " + result.skipped + " outside the selected clip range.");
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
    setStatus("Removing Beat Detect markers from the selected " + (dom.markerTarget.value === "clip" ? "clip" : "timeline range") + "...");

    var payload = {
      target: dom.markerTarget.value
    };

    cepEval("BeatDetect.removeMarkers(" + JSON.stringify(JSON.stringify(payload)) + ")")
      .then(function (result) {
        setStatus("Removed " + result.removed + " Beat Detect markers.");
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
    } else if (isBrowserPreview()) {
      checks.push("Analyzer: simulated demo events");
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
  dom.densitySlider.addEventListener("input", filterEvents);

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
