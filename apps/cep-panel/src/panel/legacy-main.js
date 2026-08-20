(function () {
  "use strict";

  var cs = new CSInterface();
  var APP_VERSION = "1.2.0";
  var state = {
    allEvents: [],
    markerEvents: [],
    clip: null,
    isBusy: false,
  };

  var dom = {
    analyzeButton: document.getElementById("analyzeButton"),
    diagnosticsButton: document.getElementById("diagnosticsButton"),
    applyButton: document.getElementById("applyButton"),
    removeButton: document.getElementById("removeButton"),
    gimbalZoomButton: document.getElementById("gimbalZoomButton"),
    clearZoomButton: document.getElementById("clearZoomButton"),
    autoColorButton: document.getElementById("autoColorButton"),
    resetColorButton: document.getElementById("resetColorButton"),
    status: document.getElementById("status"),
    beatResultsPanel: document.getElementById("beatResultsPanel"),
    filteredCount: document.getElementById("filteredCount"),
    totalCount: document.getElementById("totalCount"),
    markerTarget: document.getElementById("markerTarget"),
    markerTimingOffsetSlider: document.getElementById(
      "markerTimingOffsetSlider",
    ),
    markerTimingOffsetLabel: document.getElementById(
      "markerTimingOffsetLabel",
    ),
    beatSelectionSlider: document.getElementById("beatSelectionSlider"),
    beatSelectionLabel: document.getElementById("beatSelectionLabel"),
    beatSelectionSummary: document.getElementById("beatSelectionSummary"),
    zoomSlider: document.getElementById("zoomSlider"),
    zoomLabel: document.getElementById("zoomLabel"),
    autoZoomRatio: document.getElementById("autoZoomRatio"),
    clearLogsButton: document.getElementById("clearLogsButton"),
    mainTabMarkersButton: document.getElementById("mainTabMarkersButton"),
    mainTabColorButton: document.getElementById("mainTabColorButton"),
    mainTabToolsButton: document.getElementById("mainTabToolsButton"),
    mainTabDiagnosticsButton: document.getElementById(
      "mainTabDiagnosticsButton",
    ),
    mainTabMarkers: document.getElementById("mainTabMarkers"),
    mainTabColor: document.getElementById("mainTabColor"),
    mainTabTools: document.getElementById("mainTabTools"),
    mainTabDiagnostics: document.getElementById("mainTabDiagnostics"),
  };

  function getBeatWorkflowLabel() {
    return "beat-grid";
  }

  function setBusy(isBusy) {
    state.isBusy = isBusy;
    dom.analyzeButton.disabled = isBusy;
    dom.diagnosticsButton.disabled = isBusy;
    dom.removeButton.disabled = isBusy;
    if (dom.gimbalZoomButton) dom.gimbalZoomButton.disabled = isBusy;
    if (dom.clearZoomButton) dom.clearZoomButton.disabled = isBusy;
    if (dom.autoColorButton) dom.autoColorButton.disabled = isBusy;
    if (dom.resetColorButton) dom.resetColorButton.disabled = isBusy;
    if (dom.clearLogsButton) dom.clearLogsButton.disabled = isBusy;
    if (dom.markerTimingOffsetSlider)
      dom.markerTimingOffsetSlider.disabled = isBusy;
    if (dom.beatSelectionSlider)
      dom.beatSelectionSlider.disabled = isBusy;
    dom.applyButton.disabled = isBusy || state.markerEvents.length === 0;
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
      var appData =
        typeof process !== "undefined" && process.env
          ? process.env.APPDATA
          : "";
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
              fs.writeFile(
                logPath,
                "[LOG FILE TRUNCATED DUE TO SIZE LIMITS]\n" + truncated,
                "utf8",
                function (writeErr) {
                  writeNext();
                },
              );
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
      throw new Error(
        "Premiere bridge failed before returning data. Check the ExtendScript bridge and restart the panel.",
      );
    }

    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(
        "Premiere returned invalid bridge data: " + text.slice(0, 240),
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Premiere returned an invalid bridge payload.");
    }
    if (!parsed.ok) {
      throw new Error(parsed.error || "Premiere operation failed.");
    }

    return parsed;
  }

  var hostReadyPromise = null;

  function evalScriptOnce(script, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timeout = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Premiere bridge timed out."));
      }, timeoutMs);
      cs.evalScript(script, function (result) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        try {
          resolve(parseBridgeResult(result));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function bridgeDelay(milliseconds) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function ensureHostReady() {
    if (isBrowserPreview()) {
      return Promise.resolve({ ok: true });
    }
    if (hostReadyPromise) {
      return hostReadyPromise;
    }

    var retryDelays = [0, 100, 250, 500, 1000];
    var attempt = 0;
    function probe() {
      var delay = retryDelays[attempt];
      attempt += 1;
      return bridgeDelay(delay)
        .then(function () {
          return evalScriptOnce("AutoCutStudio.hostInfo()", 2500);
        })
        .catch(function (error) {
          if (attempt >= retryDelays.length) {
            throw new Error(
              "Premiere host bridge did not become ready. Restart Premiere Pro and reopen AutoCut Studio. " +
                error.message,
            );
          }
          return probe();
        });
    }

    hostReadyPromise = probe().catch(function (error) {
      hostReadyPromise = null;
      throw error;
    });
    return hostReadyPromise;
  }

  function isBridgeTransportError(error) {
    var message = String(error && error.message ? error.message : error);
    message = message.toLowerCase();
    return (
      message.indexOf("bridge timed out") >= 0 ||
      message.indexOf("bridge failed before") >= 0 ||
      message.indexOf("empty response") >= 0 ||
      message.indexOf("invalid bridge data") >= 0
    );
  }

  function cepEval(script) {
    return ensureHostReady().then(function () {
      return evalScriptOnce(script, 30000).catch(function (error) {
        if (isBridgeTransportError(error)) {
          hostReadyPromise = null;
        }
        throw error;
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
    return !(
      window.__adobe_cep__ &&
      typeof window.__adobe_cep__.evalScript === "function"
    );
  }

  function getExtensionRoot() {
    if (
      cs &&
      typeof cs.getSystemPath === "function" &&
      typeof SystemPath !== "undefined" &&
      SystemPath.EXTENSION
    ) {
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

    throw new Error(
      "Analyzer executable is missing. Reinstall AutoCut Studio or run scripts/build-setup-exe.ps1.",
    );
  }

  function clipAnalysisRange(clip) {
    if (!clip) return null;
    var start = Number(clip.inPointSeconds);
    var out = Number(clip.outPointSeconds);
    var duration = Number(clip.durationSeconds);

    if (
      (!isFinite(duration) || duration <= 0) &&
      isFinite(start) &&
      isFinite(out)
    ) {
      duration = out - start;
    }
    if (!isFinite(start) || start < 0 || !isFinite(duration) || duration <= 0) {
      return null;
    }

    return {
      start: Math.max(0, start),
      duration: duration,
      end: Math.max(0, start) + duration,
    };
  }

  function addClipRangeArgs(args, clip) {
    var range = clipAnalysisRange(clip);
    if (range) {
      args.push(
        "--start",
        range.start.toFixed(6),
        "--duration",
        range.duration.toFixed(6),
      );
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
    return events.filter(function (event) {
      return event.time >= start && event.time <= end;
    });
  }

  function runAnalyzer(mediaPath, clip) {
    if (mediaPath === "__autocut_studio_preview__" || isBrowserPreview()) {
      return Promise.resolve(makePreviewEvents());
    }
    if (!mediaPath || typeof mediaPath !== "string") {
      return Promise.reject(
        new Error("Analyzer did not receive a valid media path."),
      );
    }

    var req = getNodeRequire();
    if (!req) {
      return Promise.reject(
        new Error("Node.js is not enabled in this CEP panel."),
      );
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
        {
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 15 * 60 * 1000,
        },
        function (error, stdout, stderr) {
          if (error) {
            if (error.killed) {
              reject(
                new Error(
                  "Analyzer timed out. Try a shorter clip or transcode the media to WAV/MP3 first.",
                ),
              );
              return;
            }
            reject(
              new Error((stderr || error.message || "Analyzer failed.").trim()),
            );
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
            reject(
              new Error(
                "Analyzer returned invalid JSON: " +
                  parseError.message +
                  (stderr ? " stderr: " + stderr.trim() : ""),
              ),
            );
          }
        },
      );
    });
  }

  function runHybridAnalyzer(mediaPath, clip) {
    return runAnalyzer(mediaPath, clip).then(function (primaryEvents) {
      return {
        events: sanitizeEvents(primaryEvents),
        primaryCount: primaryEvents.length,
      };
    });
  }

  function makePreviewEvents() {
    var beatEvents = [];
    for (var beat = 0; beat < 42; beat++) {
      beatEvents.push({
        time: Number((0.52 + beat * 0.5).toFixed(3)),
        score: beat % 8 === 0 ? 0.88 : beat % 4 === 0 ? 0.76 : 0.64,
      });
    }
    return beatEvents;
  }

  function updateCounterUI() {
    dom.filteredCount.textContent = String(state.markerEvents.length);
    dom.totalCount.textContent =
      "of " + state.allEvents.length + " detected beat markers";
    dom.applyButton.disabled = state.isBusy || state.markerEvents.length === 0;
  }

  function beatSelectionPercentage() {
    if (!dom.beatSelectionSlider) return 100;
    var percentage = Number(dom.beatSelectionSlider.value);
    if (!isFinite(percentage)) return 100;
    return Math.max(5, Math.min(100, Math.round(percentage)));
  }

  function updateBeatSelectionUI() {
    var percentage = beatSelectionPercentage();
    if (dom.beatSelectionLabel) {
      dom.beatSelectionLabel.textContent = percentage + "%";
    }
    if (dom.beatSelectionSummary) {
      dom.beatSelectionSummary.textContent = state.allEvents.length
        ? "Keeps " +
          state.markerEvents.length +
          " of " +
          state.allEvents.length +
          " detected beats. "
        : percentage === 100
          ? "Uses every detected beat. "
          : "Will keep " + percentage + "% of detected beats. ";
    }
  }

  function filterEvents() {
    var ordered = state.allEvents.slice().sort(function (a, b) {
      return a.time - b.time;
    });
    var core = window.AutoCutBeatDistribution;
    if (!core || typeof core.select !== "function") {
      state.markerEvents = ordered;
    } else {
      state.markerEvents = core.select(ordered, beatSelectionPercentage());
    }
    updateCounterUI();
    updateBeatSelectionUI();
  }

  function sanitizeEvents(events) {
    return events
      .map(function (event) {
        return {
          time: Number(event.time),
          score: Number(event.score),
        };
      })
      .filter(function (event) {
        return isFinite(event.time) && event.time >= 0 && isFinite(event.score);
      })
      .sort(function (a, b) {
        return a.time - b.time;
      });
  }

  function markerTimingOffsetMilliseconds() {
    if (!dom.markerTimingOffsetSlider) return 0;

    var offset = Number(dom.markerTimingOffsetSlider.value);
    if (!isFinite(offset)) return 0;

    var minimum = Number(dom.markerTimingOffsetSlider.min);
    var maximum = Number(dom.markerTimingOffsetSlider.max);
    if (!isFinite(minimum)) minimum = -500;
    if (!isFinite(maximum)) maximum = 500;
    return Math.max(minimum, Math.min(maximum, Math.round(offset)));
  }

  function updateMarkerTimingOffsetLabel() {
    if (!dom.markerTimingOffsetLabel) return;

    var offset = markerTimingOffsetMilliseconds();
    dom.markerTimingOffsetLabel.textContent =
      (offset > 0 ? "+" : "") + offset + " ms";
  }

  function markerTimingDescription(offsetMilliseconds) {
    if (!offsetMilliseconds) return "";

    return (
      " (" +
      Math.abs(offsetMilliseconds) +
      " ms " +
      (offsetMilliseconds < 0 ? "earlier" : "later") +
      ")"
    );
  }

  function eventsForPremiere(events, offsetMilliseconds) {
    var offsetSeconds = offsetMilliseconds / 1000;
    return events.map(function (event) {
      return {
        time: Number((event.time + offsetSeconds).toFixed(6)),
        score: event.score,
      };
    });
  }

  function analyzeTrack() {
    if (state.isBusy) return;

    setBusy(true);
    state.allEvents = [];
    state.markerEvents = [];
    state.clip = null;
    dom.beatResultsPanel.classList.add("is-hidden");
    setStatus("Reading the selected clip path from Premiere...", false, true);

    cepEval("AutoCutStudio.getSelectedClipInfo()")
      .then(function (result) {
        state.clip = result.clip;
        if (!state.clip.mediaPath) {
          throw new Error(
            "Premiere returned an empty media path for the selected clip.",
          );
        }
        var range = clipAnalysisRange(state.clip);
        if (!range) {
          throw new Error(
            "Selected clip has an invalid source in/out range. Trim or reselect the timeline clip and try again.",
          );
        }
        setStatus(
          "Analyzing selected cut only (" +
            formatSeconds(range.duration) +
            ") from " +
            state.clip.name +
            " for " +
            getBeatWorkflowLabel() +
            " markers...",
          false,
          true,
        );
        return runHybridAnalyzer(state.clip.mediaPath, state.clip);
      })
      .then(function (analysis) {
        var analyzerEvents = sanitizeEvents(analysis.events || []);
        state.allEvents = cropEventsToSelectedClip(analyzerEvents, state.clip);
        filterEvents();
        dom.beatResultsPanel.classList.remove("is-hidden");
        if (state.allEvents.length !== analyzerEvents.length) {
          appendLog(
            "BEAT RANGE: analyzer returned " +
              analyzerEvents.length +
              "; kept " +
              state.allEvents.length +
              " within the selected clip range.",
          );
        }
        setStatus(
          (isBrowserPreview()
            ? "Preview analysis complete: "
            : "Analysis complete: ") +
            "received " +
            analyzerEvents.length +
            "; keeping " +
            state.markerEvents.length +
            " evenly distributed " +
            getBeatWorkflowLabel() +
            " markers at " +
            beatSelectionPercentage() +
            "% selection in the selected cut using Rust analyzer.",
          false,
          false,
          true,
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
    if (state.isBusy || state.markerEvents.length === 0) {
      return;
    }

    var markerOffsetMilliseconds = markerTimingOffsetMilliseconds();
    setBusy(true);
    setStatus(
      "Applying " +
        state.markerEvents.length +
        " markers in Premiere" +
        markerTimingDescription(markerOffsetMilliseconds) +
        "...",
      false,
      true,
    );

    var basePayload = {
      target: dom.markerTarget.value,
      mediaPath: state.clip ? state.clip.mediaPath : "",
      identity: state.clip ? state.clip.identity : "",
      startSeconds: state.clip ? state.clip.startSeconds : null,
      endSeconds: state.clip ? state.clip.endSeconds : null,
      inPointSeconds: state.clip ? state.clip.inPointSeconds : null,
      outPointSeconds: state.clip ? state.clip.outPointSeconds : null,
    };

    var allEvents = eventsForPremiere(
      state.markerEvents,
      markerOffsetMilliseconds,
    );
    var chunkSize = 50;
    var totalApplied = 0;
    var totalSkipped = 0;
    var createdTimes = [];
    var markersCleared = false;

    var removePayload = {
      target: basePayload.target,
      identity: basePayload.identity,
      mediaPath: basePayload.mediaPath,
      startSeconds: basePayload.startSeconds,
      endSeconds: basePayload.endSeconds,
      inPointSeconds: basePayload.inPointSeconds,
      outPointSeconds: basePayload.outPointSeconds,
    };

    cepEval(
      "AutoCutStudio.scanMarkers(" +
        JSON.stringify(JSON.stringify(removePayload)) +
        ")",
    )
      .then(function (scan) {
        setStatus(
          "Found " +
            (scan.count || 0) +
            " owned marker candidates in the selected range.",
          false,
          true,
        );
        if (
          !confirm("Replace existing AutoCut Studio markers in this range?")
        ) {
          throw new Error("Marker apply cancelled.");
        }
        return cepEval(
          "AutoCutStudio.removeMarkers(" +
            JSON.stringify(JSON.stringify(removePayload)) +
            ")",
        );
      })
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
              events: chunkEvents,
            };

            setStatus(
              "Applying markers: " +
                index +
                " to " +
                Math.min(index + chunkSize, allEvents.length) +
                " of " +
                allEvents.length +
                "...",
              false,
              true,
            );

            cepEval(
              "AutoCutStudio.applyMarkersChunk(" +
                JSON.stringify(JSON.stringify(chunkPayload)) +
                ")",
            )
              .then(function (result) {
                totalApplied += result.applied || 0;
                totalSkipped += result.skipped || 0;
                if (result.createdTimes)
                  createdTimes = createdTimes.concat(result.createdTimes);
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
        setStatus(
          "Replaced AutoCut Studio markers in range. Applied " +
            totalApplied +
            "; skipped " +
            totalSkipped +
            " outside the selected clip range" +
            markerTimingDescription(markerOffsetMilliseconds) +
            ".",
          false,
          false,
          true,
        );
      })
      .catch(function (error) {
        appendLog(error && error.stack ? error.stack : String(error));
        var message = error && error.message ? error.message : String(error);
        if (markersCleared) {
          var cleanupFailed = false;
          setStatus(
            "Marker apply failed after " +
              totalApplied +
              " markers. Removing partial result...",
            true,
            true,
          );
          var exactPayload = {
            target: basePayload.target,
            identity: basePayload.identity,
            mediaPath: basePayload.mediaPath,
            startSeconds: basePayload.startSeconds,
            endSeconds: basePayload.endSeconds,
            inPointSeconds: basePayload.inPointSeconds,
            outPointSeconds: basePayload.outPointSeconds,
            times: createdTimes,
          };
          return cepEval(
            "AutoCutStudio.removeMarkersExactTimes(" +
              JSON.stringify(JSON.stringify(exactPayload)) +
              ")",
          )
            .catch(function (cleanupError) {
              cleanupFailed = true;
              appendLog(
                cleanupError && cleanupError.stack
                  ? cleanupError.stack
                  : String(cleanupError),
              );
            })
            .then(function () {
              if (cleanupFailed) {
                setStatus(
                  message +
                    " Partial marker cleanup also failed; remove markers manually before retrying.",
                  true,
                );
              } else {
                setStatus(
                  message +
                    " Partial markers were removed; run Apply Markers again.",
                  true,
                );
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

    if (!confirm("Clear AutoCut Studio markers in the selected range?")) {
      return;
    }

    setBusy(true);
    setStatus(
      "Removing AutoCut Studio markers from the selected " +
        (dom.markerTarget.value === "clip" ? "clip" : "timeline range") +
        "...",
      false,
      true,
    );

    var payload = {
      target: dom.markerTarget.value,
      identity: state.clip ? state.clip.identity : "",
      mediaPath: state.clip ? state.clip.mediaPath : "",
    };

    cepEval(
      "AutoCutStudio.removeMarkers(" +
        JSON.stringify(JSON.stringify(payload)) +
        ")",
    )
      .then(function (result) {
        setStatus(
          "Removed " + result.removed + " AutoCut Studio markers.",
          false,
          false,
          true,
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

  function applyGimbalZoom() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    var zoomValue = dom.zoomSlider ? Number(dom.zoomSlider.value) : 110.0;
    var zoomModeEl = document.getElementById("zoomMode");
    var zoomStyle = zoomModeEl
      ? zoomModeEl.value
      : window.__autocutActiveMovementMode || "smooth_in";
    var autoRatio = !dom.autoZoomRatio || dom.autoZoomRatio.checked;
    var styleLabel = zoomStyle.replace("_", " ");
    setStatus(
      "Applying " +
        styleLabel +
        " gimbal zoom to selected clips (" +
        (autoRatio ? "auto ratio" : zoomValue + "%") +
        ")...",
    );

    var payload = { zoom: zoomValue, style: zoomStyle, autoRatio: autoRatio };
    cepEval(
      "AutoCutStudio.applyGimbalZoom(" +
        JSON.stringify(JSON.stringify(payload)) +
        ")",
    )
      .then(function (result) {
        var skipped = Number(result.skipped) || 0;
        var details =
          result.errors && result.errors.length
            ? " Details: " + result.errors.join(" | ")
            : "";
        setStatus(
          "Applied gimbal zoom keyframes to " +
            result.applied +
            " clips" +
            (skipped ? "; skipped " + skipped : "") +
            "." +
            details,
          false,
          false,
          true,
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

  function clearGimbalZoom() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus(
      "Clearing zoom keyframes from selected video clips...",
      false,
      true,
    );

    cepEval("AutoCutStudio.clearGimbalZoom()")
      .then(function (result) {
        var skipped = Number(result.skipped) || 0;
        var details =
          result.errors && result.errors.length
            ? " Details: " + result.errors.join(" | ")
            : "";
        setStatus(
          "Cleared zoom keyframes on " +
            result.cleared +
            " clips" +
            (skipped ? "; skipped " + skipped : "") +
            "." +
            details,
          false,
          false,
          true,
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

  function autoColorSelectedClips() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus(
      "Capturing the playhead frame for AutoCut color correction...",
      false,
      true,
    );

    var autoColorStarted = Date.now();
    function waitForAutoColorEffect() {
      return cepEval("AutoCutStudio.prepareAutoColorAtPlayhead()").then(
        function (result) {
          if (result.ready) return result;
          if (Date.now() - autoColorStarted >= 5000) {
            throw new Error(
              "AutoCutStudio Color Engine did not become ready. Verify the native plugin installation.",
            );
          }
          return sleep(150).then(waitForAutoColorEffect);
        },
      );
    }

    cepEval("AutoCutStudio.prepareAutoColorAtPlayhead()")
      .then(function (result) {
        return result.ready ? result : waitForAutoColorEffect();
      })
      .then(function () {
        return cepEval("AutoCutStudio.autoColorSelectedClips()");
      })
      .then(function (result) {
        var engine = result.engine || "AutoCut custom correction";
        var skipped = Number(result.skipped) || 0;
        var details =
          result.errors && result.errors.length
            ? " Details: " + result.errors.join(" | ")
            : "";
        var csInfo = result.colorScience
          ? " [Color Science: " + result.colorScience + "]"
          : "";
        var capture =
          result.captureFrameSeconds !== undefined
            ? " from playhead frame " +
              formatSeconds(Number(result.captureFrameSeconds))
            : "";
        var autoAmount = Number(result.autoAmount) || 80;
        setStatus(
          "Editable starting grade applied to " +
            result.applied +
            " selected clip" +
            (result.applied === 1 ? "" : "s") +
            capture +
            " using " +
            engine +
            " at " +
            autoAmount +
            "% Auto Amount. Refine it in Effect Controls" +
            (skipped ? "; skipped " + skipped : "") +
            "." +
            csInfo +
            details,
          false,
          false,
          true,
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

  function resetColorGrade() {
    if (state.isBusy) {
      return;
    }

    setBusy(true);
    setStatus(
      "Resetting color correction controls on selected video clips...",
      false,
      true,
    );

    cepEval("AutoCutStudio.resetColorGrade()")
      .then(function (result) {
        var skipped = Number(result.skipped) || 0;
        var details =
          result.errors && result.errors.length
            ? " Details: " + result.errors.join(" | ")
            : "";
        setStatus(
          "Reset color controls on " +
            result.reset +
            " clips" +
            (skipped ? "; skipped " + skipped : "") +
            "." +
            details,
          false,
          false,
          true,
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

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
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
    checks.push(
      req
        ? "CEP Node: OK"
        : isBrowserPreview()
          ? "CEP Node: simulated in browser preview"
          : "CEP Node: FAIL",
    );

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
        if (
          confirm(
            "DIAGNOSTICS REPORT:\n\n" +
              formatted +
              "\n\nWould you like to copy this report to the clipboard?",
          )
        ) {
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
      var appData =
        typeof process !== "undefined" && process.env
          ? process.env.APPDATA
          : "";
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
    return Promise.reject(
      new Error("Clipboard API is unavailable in this host."),
    );
  }

  function activateMainTab(tabName) {
    var tabs = [
      {
        name: "markers",
        button: dom.mainTabMarkersButton,
        panel: dom.mainTabMarkers,
      },
      {
        name: "color",
        button: dom.mainTabColorButton,
        panel: dom.mainTabColor,
      },
      {
        name: "tools",
        button: dom.mainTabToolsButton,
        panel: dom.mainTabTools,
      },
      {
        name: "diagnostics",
        button: dom.mainTabDiagnosticsButton,
        panel: dom.mainTabDiagnostics,
      },
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
  if (dom.clearLogsButton)
    dom.clearLogsButton.addEventListener("click", clearLogs);
  dom.applyButton.addEventListener("click", applyMarkers);
  dom.removeButton.addEventListener("click", removeMarkers);
  if (dom.gimbalZoomButton)
    dom.gimbalZoomButton.addEventListener("click", applyGimbalZoom);
  if (dom.clearZoomButton)
    dom.clearZoomButton.addEventListener("click", clearGimbalZoom);
  if (dom.autoColorButton)
    dom.autoColorButton.addEventListener("click", autoColorSelectedClips);
  if (dom.resetColorButton)
    dom.resetColorButton.addEventListener("click", resetColorGrade);
  if (dom.markerTimingOffsetSlider) {
    dom.markerTimingOffsetSlider.addEventListener(
      "input",
      updateMarkerTimingOffsetLabel,
    );
    updateMarkerTimingOffsetLabel();
  }
  if (dom.beatSelectionSlider) {
    dom.beatSelectionSlider.addEventListener("input", function () {
      filterEvents();
    });
    updateBeatSelectionUI();
  }
  if (dom.zoomSlider) {
    dom.zoomSlider.addEventListener("input", function () {
      if (dom.autoZoomRatio) dom.autoZoomRatio.checked = false;
      if (dom.zoomLabel) dom.zoomLabel.textContent = dom.zoomSlider.value + "%";
      refreshZoomPreview();
    });
  }

  // Interactive movement preview animations changer
  var previewSubject = document.getElementById("previewSubject");
  var zoomModeSelect = document.getElementById("zoomMode");
  var activeZoomMode = "smooth_in";
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
    punch_in: 118,
    punch_out: 116,
    pulse: 112,
    snap_back: 120,
  };
  var previewNames = {
    smooth_in: "Slow Push-In",
    smooth_out: "Slow Pull-Out",
    drift: "Micro Drift",
    breath: "Breathing Hold",
    reveal: "Hold Then Reveal",
    settle_in: "Overshoot Settle",
    punch_in: "Beat Punch-In",
    punch_out: "Beat Punch-Out",
    pulse: "Double Pulse",
    snap_back: "Snap Back",
  };
  var movementDescriptions = {
    smooth_in:
      "Gradual cinematic emphasis for portraits, vows, and emotional detail shots.",
    smooth_out:
      "Elegant release that opens the frame near the end of the shot.",
    drift: "Subtle motion for couple portraits and calm beauty shots.",
    breath: "Soft organic movement that gently returns to neutral.",
    reveal: "Held emphasis followed by a graceful reveal.",
    settle_in: "Refined push with a controlled settle for detail emphasis.",
    punch_in: "Strong beat accent for dance entries and energetic cuts.",
    punch_out: "Fast release after a strong visual or music hit.",
    pulse: "Controlled rhythmic pulse for claps and dance beats.",
    snap_back: "Sharp percussion accent that quickly returns to neutral.",
  };

  function setZoomRatio(value, keepAuto) {
    if (!dom.zoomSlider || !value) return;
    dom.zoomSlider.value = value;
    if (dom.zoomLabel) dom.zoomLabel.textContent = dom.zoomSlider.value + "%";
    if (dom.autoZoomRatio) dom.autoZoomRatio.checked = keepAuto !== false;
    refreshZoomPreview();
  }

  function applyAutoRatioForMode() {
    if (!dom.autoZoomRatio || !dom.autoZoomRatio.checked) return;
    setZoomRatio(autoRatioByMode[activeZoomMode] || 110, true);
  }

  function syncMovementButtons(mode) {
    for (var i = 0; i < movementButtons.length; i++) {
      var label = movementButtons[i].textContent || "";
      var isActive =
        movementButtons[i].getAttribute("data-mode") === mode &&
        (!activeMovementLabel || label === activeMovementLabel);
      movementButtons[i].classList.toggle("is-active", isActive);
      movementButtons[i].setAttribute(
        "aria-pressed",
        isActive ? "true" : "false",
      );
    }
  }

  function selectZoomMode(mode, keepManualRatio, displayLabel) {
    if (!mode) return;
    activeZoomMode = mode;
    window.__autocutActiveMovementMode = mode;
    if (zoomModeSelect) zoomModeSelect.value = mode;
    activeMovementLabel = displayLabel || "";
    syncMovementButtons(mode);
    if (!keepManualRatio) {
      applyAutoRatioForMode();
    }
    refreshZoomPreview();
  }

  function refreshZoomPreview() {
    var mode = activeZoomMode || "smooth_in";
    var val = String(mode).replace(/_/g, "-");
    var ratio = dom.zoomSlider ? Number(dom.zoomSlider.value) || 110 : 110;
    var autoText =
      dom.autoZoomRatio && dom.autoZoomRatio.checked ? "AUTO " : "MANUAL ";
    if (previewSubject)
      previewSubject.className = "preview-subject animate-" + val;
    syncMovementButtons(mode);
    var displayName =
      activeMovementLabel || previewNames[mode] || mode.replace(/_/g, " ");
    if (previewModeLabel) previewModeLabel.textContent = displayName;
    if (selectedMomentLabel) selectedMomentLabel.textContent = displayName;
    if (selectedMomentMeta)
      selectedMomentMeta.textContent =
        movementDescriptions[mode] ||
        "Clean scale movement across the selected clip.";
    if (previewRatioLabel)
      previewRatioLabel.textContent = autoText + ratio + "%";
    renderKeyframePreview(mode, ratio);
  }

  function keyframePreviewPoints(mode, ratio) {
    var soft = Math.round(100 + (ratio - 100) * 0.45);
    var drift = Math.round(100 + (ratio - 100) * 0.3);
    var breath = Math.round(100 + (ratio - 100) * 0.22);
    var over = Math.min(150, Math.round(100 + (ratio - 100) * 1.18));
    var patterns = {
      smooth_in: [
        [0, 100],
        [100, ratio],
      ],
      smooth_out: [
        [0, ratio],
        [100, 100],
      ],
      drift: [
        [0, 100],
        [100, drift],
      ],
      breath: [
        [0, 100],
        [50, breath],
        [100, 100],
      ],
      reveal: [
        [0, ratio],
        [62, ratio],
        [100, 100],
      ],
      settle_in: [
        [0, 100],
        [22, over],
        [55, soft],
        [100, ratio],
      ],
      punch_in: [
        [0, 100],
        [8, ratio],
        [28, soft],
        [100, soft],
      ],
      punch_out: [
        [0, ratio],
        [10, 100],
        [100, 100],
      ],
      pulse: [
        [0, 100],
        [18, ratio],
        [38, 100],
        [62, soft],
        [100, 100],
      ],
      snap_back: [
        [0, 100],
        [10, ratio],
        [30, 100],
        [100, 100],
      ],
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

    if (previewStartLabel)
      previewStartLabel.textContent = Math.round(points[0][1]) + "% start";
    if (previewEndLabel)
      previewEndLabel.textContent =
        Math.round(points[points.length - 1][1]) + "% end";
  }

  if (zoomModeSelect && previewSubject) {
    zoomModeSelect.addEventListener("change", function () {
      selectZoomMode(zoomModeSelect.value);
    });
    applyAutoRatioForMode();
    refreshZoomPreview();
  }
  refreshZoomPreview();

  for (var mb = 0; mb < movementButtons.length; mb++) {
    movementButtons[mb].addEventListener("click", function () {
      selectZoomMode(
        this.getAttribute("data-mode"),
        false,
        String(this.textContent || "").trim(),
      );
      var ratio = this.getAttribute("data-ratio");
      if (ratio) {
        setZoomRatio(ratio, true);
      }
    });
  }

  // Zoom preset shortcuts click handler
  var presetButtons = document.querySelectorAll(".btn-preset");
  for (var pb = 0; pb < presetButtons.length; pb++) {
    presetButtons[pb].addEventListener("click", function () {
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
    dom.autoZoomRatio.addEventListener("change", function () {
      if (dom.autoZoomRatio.checked) {
        applyAutoRatioForMode();
      }
      refreshZoomPreview();
    });
  }
  if (dom.mainTabMarkersButton) {
    dom.mainTabMarkersButton.addEventListener("click", function () {
      activateMainTab("markers");
    });
  }
  if (dom.mainTabColorButton) {
    dom.mainTabColorButton.addEventListener("click", function () {
      activateMainTab("color");
    });
  }
  if (dom.mainTabToolsButton) {
    dom.mainTabToolsButton.addEventListener("click", function () {
      activateMainTab("tools");
    });
  }
  if (dom.mainTabDiagnosticsButton) {
    dom.mainTabDiagnosticsButton.addEventListener("click", function () {
      activateMainTab("diagnostics");
    });
  }
  var githubLink = document.getElementById("githubLink");
  if (githubLink) {
    githubLink.addEventListener("click", function (e) {
      e.preventDefault();
      try {
        var req = getNodeRequire();
        if (req) {
          var cp = req("child_process");
          var isWin = req("os").platform() === "win32";
          var cmd = isWin
            ? "start https://github.com/Hamza-op"
            : "open https://github.com/Hamza-op";
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
    setStatus(
      "Browser preview mode. Analyze uses simulated event markers; Premiere actions are mocked.",
    );
  } else {
    ensureHostReady().then(
      function (info) {
        appendLog(
          "Premiere host bridge ready: " +
            (info.hostVersion || "unknown version"),
        );
      },
      function (error) {
        setStatus(error.message || String(error), "error");
        appendLog("HOST BRIDGE STARTUP ERROR: " + (error.message || error));
      },
    );
  }

  window.onerror = function (message, source, line, column, error) {
    appendLog(
      "WINDOW ERROR: " + message + " at " + source + ":" + line + ":" + column,
    );
    if (error && error.stack) {
      appendLog(error.stack);
    }
  };

  window.onunhandledrejection = function (event) {
    appendLog(
      "UNHANDLED PROMISE: " +
        (event.reason && event.reason.stack
          ? event.reason.stack
          : String(event.reason)),
    );
  };
})();
