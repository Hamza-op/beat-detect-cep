import { MOVEMENT_PRESETS, getPreset } from "./movements.ts";
import { PRODUCT_VERSION } from "./version.ts";

(function () {
  "use strict";

  function initialize() {
    if (window.__autocutPanelInitialized) return;
    window.__autocutPanelInitialized = true;

    var APP_VERSION = PRODUCT_VERSION;
    var MAX_LOG_BYTES = 2 * 1024 * 1024;
    var MAX_LOG_QUEUE = 200;
    var MAX_ANALYZER_BUFFER = 32 * 1024 * 1024;
    var MAX_ANALYZER_EVENTS = 250000;
    var ANALYZER_TIMEOUT = 15 * 60 * 1000;
    var BRIDGE_READ_TIMEOUT = 15000;
    var BRIDGE_WRITE_TIMEOUT = 120000;
    var MARKER_CHUNK_SIZE = 50;
    var GITHUB_URL = "https://github.com/Hamza-op";

    var previewMode = !(
      window.__adobe_cep__ &&
      typeof window.__adobe_cep__.evalScript === "function"
    );

    var cs = null;
    var csInitializationError = null;

    try {
      if (typeof CSInterface !== "undefined") {
        cs = new CSInterface();
      }
    } catch (error) {
      csInitializationError = error;
    }

    var state = {
      allEvents: [],
      markerEvents: [],
      clip: null,
      isBusy: false,
      disposed: false,
      bridgeUncertain: false,
      selectedColorLook: "skin_tone",
      activeZoomMode: "smooth_in",
      activeMovementLabel: "",
      analyzerProcess: null,
      previewAnimationClass: "",
      disabledSnapshot: [],
      operationId: 0
    };

    var elementIds = [
      "analyzeButton",
      "diagnosticsButton",
      "applyButton",
      "removeButton",
      "gimbalZoomButton",
      "clearZoomButton",
      "autoColorButton",
      "resetColorButton",
      "colorIntensitySlider",
      "colorIntensityLabel",
      "colorStatusValue",
      "colorStatusLabel",
      "status",
      "beatResultsPanel",
      "filteredCount",
      "totalCount",
      "markerTarget",
      "markerTimingOffsetSlider",
      "markerTimingOffsetLabel",
      "beatSelectionSlider",
      "beatSelectionLabel",
      "beatSelectionSummary",
      "zoomSlider",
      "zoomLabel",
      "zoomMode",
      "autoZoomRatio",
      "clearLogsButton",
      "mainTabMarkersButton",
      "mainTabColorButton",
      "mainTabToolsButton",
      "mainTabDiagnosticsButton",
      "mainTabMarkers",
      "mainTabColor",
      "mainTabTools",
      "mainTabDiagnostics",
      "previewSubject",
      "previewModeLabel",
      "previewRatioLabel",
      "previewKeyframeTrack",
      "previewStartLabel",
      "previewEndLabel",
      "selectedMomentLabel",
      "selectedMomentMeta",
      "githubLink"
    ];

    var dom = {};

    elementIds.forEach(function (id) {
      dom[id] = document.getElementById(id);
    });

    var colorLookButtons = Array.prototype.slice.call(
      document.querySelectorAll(".color-look-btn")
    );

    var movementButtons = Array.prototype.slice.call(
      document.querySelectorAll(".movement-btn")
    );

    var presetButtons = Array.prototype.slice.call(
      document.querySelectorAll(".btn-preset")
    );

    var actionIds = [
      "analyzeButton",
      "diagnosticsButton",
      "applyButton",
      "removeButton",
      "gimbalZoomButton",
      "clearZoomButton",
      "autoColorButton",
      "resetColorButton",
      "clearLogsButton"
    ];

    var inputIds = [
      "colorIntensitySlider",
      "markerTarget",
      "markerTimingOffsetSlider",
      "beatSelectionSlider",
      "zoomSlider",
      "zoomMode",
      "autoZoomRatio"
    ];

    var lockedControls = [];

    actionIds.concat(inputIds).forEach(function (id) {
      if (dom[id]) lockedControls.push(dom[id]);
    });

    lockedControls = lockedControls.concat(
      colorLookButtons,
      movementButtons,
      presetButtons
    );

    var presetById = {};

    MOVEMENT_PRESETS.forEach(function (preset) {
      if (preset && typeof preset.id === "string") {
        presetById[preset.id] = preset;
      }
    });

    function owns(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    function messageOf(error) {
      return error && error.message ? String(error.message) : String(error);
    }

    function makeError(message, code) {
      var error = new Error(message);
      error.code = code || "OPERATION_FAILED";
      return error;
    }

    function finiteNumber(value, label) {
      if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !value.trim())
      ) {
        throw new Error(label + " must be a finite number.");
      }

      var number = Number(value);

      if (!isFinite(number)) {
        throw new Error(label + " must be a finite number.");
      }

      return number;
    }

    function numberOr(value, fallback) {
      if (
        value === undefined ||
        value === null ||
        value === "" ||
        typeof value === "boolean"
      ) {
        return fallback;
      }

      var number = Number(value);
      return isFinite(number) ? number : fallback;
    }

    function clamp(value, minimum, maximum) {
      return Math.max(minimum, Math.min(maximum, value));
    }

    function setText(element, value) {
      if (element) element.textContent = String(value);
    }

    function listen(element, eventName, handler) {
      if (element) element.addEventListener(eventName, handler);
    }

    function sleep(milliseconds) {
      return new Promise(function (resolve) {
        window.setTimeout(resolve, milliseconds);
      });
    }

    function assertActive() {
      if (state.disposed) {
        throw makeError("The panel is closing.", "PANEL_CLOSED");
      }
    }

    function getNodeRequire() {
      try {
        if (
          window.cep_node &&
          typeof window.cep_node.require === "function"
        ) {
          return function (name) {
            return window.cep_node.require(name);
          };
        }

        if (typeof require === "function") {
          return require;
        }
      } catch (_) { }

      return null;
    }

    /*
     * Serialized, bounded logging.
     * Clear and rotation use the same queue as writes.
     */

    var nodeServices;
    var logQueue = [];
    var logTimer = null;
    var logTail = Promise.resolve();

    function getNodeServices() {
      if (nodeServices !== undefined) return nodeServices;

      var req = getNodeRequire();

      if (!req) {
        nodeServices = null;
        return null;
      }

      try {
        nodeServices = {
          fs: req("fs"),
          path: req("path"),
          os: req("os"),
          process: req("process"),
          childProcess: req("child_process")
        };
      } catch (_) {
        nodeServices = null;
      }

      return nodeServices;
    }

    function nodeCall(object, method, args) {
      return new Promise(function (resolve, reject) {
        var parameters = args.slice();

        parameters.push(function (error, result) {
          if (error) reject(error);
          else resolve(result);
        });

        try {
          object[method].apply(object, parameters);
        } catch (error) {
          reject(error);
        }
      });
    }

    function ensureDirectory(services, directory) {
      return nodeCall(services.fs, "stat", [directory]).then(
        function (stats) {
          if (!stats.isDirectory()) {
            throw new Error("State path is not a directory: " + directory);
          }
        },
        function (error) {
          if (error.code !== "ENOENT") throw error;

          var parent = services.path.dirname(directory);

          if (parent === directory) throw error;

          return ensureDirectory(services, parent).then(function () {
            return nodeCall(services.fs, "mkdir", [directory]).catch(
              function (mkdirError) {
                if (mkdirError.code !== "EEXIST") throw mkdirError;
              }
            );
          });
        }
      );
    }

    function getLogLocation() {
      var services = getNodeServices();

      if (!services) {
        throw new Error("Node.js is unavailable inside this panel.");
      }

      var environment = services.process.env || {};
      var platform = services.os.platform();
      var home = services.os.homedir();
      var root;

      if (platform === "win32") {
        root = environment.APPDATA ||
          services.path.join(home, "AppData", "Roaming");
      } else if (platform === "darwin") {
        root = services.path.join(home, "Library", "Logs");
      } else {
        root = environment.XDG_STATE_HOME ||
          services.path.join(home, ".local", "state");
      }

      var directory = services.path.join(root, "AutoCutStudio");

      return {
        services: services,
        directory: directory,
        file: services.path.join(directory, "panel.log"),
        backup: services.path.join(directory, "panel.log.1")
      };
    }

    function removeFileIfPresent(fs, filename) {
      return nodeCall(fs, "unlink", [filename]).catch(function (error) {
        if (error.code !== "ENOENT") throw error;
      });
    }

    function enqueueLogOperation(operation) {
      var task = logTail.then(operation);

      logTail = task.catch(function (error) {
        if (window.console && console.warn) {
          console.warn("AutoCutStudio logging:", messageOf(error));
        }
      });

      return task;
    }

    function writeLogBatch(batch) {
      if (!batch || previewMode) return Promise.resolve();

      var location = getLogLocation();
      var fs = location.services.fs;

      return ensureDirectory(location.services, location.directory)
        .then(function () {
          return nodeCall(fs, "stat", [location.file]).catch(function (error) {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        })
        .then(function (stats) {
          if (
            !stats ||
            stats.size + batch.length * 4 <= MAX_LOG_BYTES
          ) {
            return;
          }

          return removeFileIfPresent(fs, location.backup).then(function () {
            return nodeCall(fs, "rename", [
              location.file,
              location.backup
            ]);
          });
        })
        .then(function () {
          return nodeCall(fs, "appendFile", [
            location.file,
            batch,
            "utf8"
          ]);
        });
    }

    function flushLogs() {
      if (logTimer !== null) {
        window.clearTimeout(logTimer);
        logTimer = null;
      }

      if (!logQueue.length) return logTail;

      var batch = logQueue.join("");
      logQueue = [];

      return enqueueLogOperation(function () {
        return writeLogBatch(batch);
      });
    }

    function appendLog(message) {
      var text = String(message).slice(0, 12000);

      if (previewMode) {
        if (window.console && console.log) {
          console.log("[AutoCutStudio preview] " + text);
        }
        return;
      }

      if (logQueue.length >= MAX_LOG_QUEUE) {
        logQueue.shift();
      }

      logQueue.push(new Date().toISOString() + " " + text + "\n");

      if (logTimer === null && !state.disposed) {
        logTimer = window.setTimeout(function () {
          flushLogs().catch(function () { });
        }, 200);
      }
    }

    function logError(error) {
      appendLog(error && error.stack ? error.stack : messageOf(error));
    }

    function setStatus(message, isError, isBusy, isSuccess) {
      if (state.disposed) return;

      var text = (previewMode ? "[PREVIEW] " : "") + String(message);

      if (dom.status) {
        dom.status.textContent = text;
        dom.status.classList.toggle("is-error", !!isError);
        dom.status.classList.toggle("is-busy", !!isBusy);
        dom.status.classList.toggle("is-success", !!isSuccess);
        dom.status.setAttribute("aria-busy", isBusy ? "true" : "false");
      }

      appendLog((isError ? "ERROR: " : "STATUS: ") + text);
    }

    function syncControls() {
      if (state.disposed) return;

      var locked = state.isBusy || state.bridgeUncertain;

      if (locked && !state.disabledSnapshot.length) {
        lockedControls.forEach(function (element) {
          if ("disabled" in element) {
            state.disabledSnapshot.push({
              element: element,
              disabled: !!element.disabled
            });
          }
        });
      }

      if (locked) {
        lockedControls.forEach(function (element) {
          if ("disabled" in element) element.disabled = true;
          element.setAttribute("aria-disabled", "true");
        });
      } else {
        state.disabledSnapshot.forEach(function (entry) {
          entry.element.disabled = entry.disabled;
        });

        state.disabledSnapshot = [];

        lockedControls.forEach(function (element) {
          element.setAttribute(
            "aria-disabled",
            "disabled" in element && element.disabled ? "true" : "false"
          );
        });
      }

      if (dom.applyButton) {
        dom.applyButton.disabled =
          locked ||
          !state.clip ||
          state.markerEvents.length === 0;

        dom.applyButton.setAttribute(
          "aria-disabled",
          dom.applyButton.disabled ? "true" : "false"
        );
      }
    }

    function setBusy(value) {
      state.isBusy = !!value;
      syncControls();
    }

    function runOperation(label, operation) {
      if (
        state.disposed ||
        state.isBusy ||
        state.bridgeUncertain
      ) {
        return Promise.resolve();
      }

      var operationId = ++state.operationId;
      setBusy(true);

      if (label) setStatus(label, false, true);

      return Promise.resolve()
        .then(function () {
          assertActive();
          return operation();
        })
        .catch(function (error) {
          if (state.disposed) return;

          if (error && error.code === "CANCELLED") {
            setStatus(messageOf(error));
            return;
          }

          logError(error);
          setStatus(messageOf(error), true);
        })
        .then(function () {
          if (operationId === state.operationId && !state.disposed) {
            setBusy(false);
          }
        });
    }

    /*
     * Typed-by-name bridge calls with serialized transport.
     *
     * Mutating requests are never automatically retried.
     * A timeout does not cancel ExtendScript. Further calls are blocked until
     * its callback arrives, preventing overlapping unknown mutations.
     */

    var hostReadyPromise = null;
    var bridgeTail = Promise.resolve();

    var hostMethods = {
      hostInfo: false,
      getSelectedClipInfo: false,
      getSelectedVideoClipCount: false,
      scanMarkers: false,
      runDiagnostics: false,
      applyMarkersChunk: true,
      removeMarkers: true,
      removeMarkersExactTimes: true,
      applyGimbalZoom: true,
      clearGimbalZoom: true,
      prepareAutoColorAtPlayhead: true,
      autoColorSelectedClips: true,
      resetColorGrade: true,
      cleanMotionLedger: true
    };

    function parseBridgeResult(raw) {
      if (raw === null || raw === undefined || !String(raw).trim()) {
        throw makeError(
          "Premiere returned an empty response.",
          "BRIDGE_RESPONSE"
        );
      }

      var text = String(raw).trim();

      if (/^EvalScript error/i.test(text)) {
        throw makeError(
          "Premiere could not execute the bridge request. Verify the host " +
          "script installation and reopen the panel.",
          "BRIDGE_RESPONSE"
        );
      }

      var parsed;

      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw makeError(
          "Premiere returned invalid bridge data: " + text.slice(0, 240),
          "BRIDGE_RESPONSE"
        );
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw makeError(
          "Premiere returned an invalid bridge payload.",
          "BRIDGE_RESPONSE"
        );
      }

      if (parsed.ok !== true) {
        throw makeError(
          parsed.error || "Premiere operation failed.",
          "HOST_OPERATION"
        );
      }

      return parsed;
    }

    function scriptLiteral(value) {
      return JSON.stringify(value)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    }

    function buildHostScript(method, payload) {
      if (!owns(hostMethods, method)) {
        throw new Error("Unsupported host method: " + method);
      }

      return "AutoCutStudio." + method + "(" +
        (payload === undefined
          ? ""
          : scriptLiteral(JSON.stringify(payload))) +
        ")";
    }

    function evalScriptOnce(method, payload, timeoutMs) {
      return new Promise(function (resolve, reject) {
        assertActive();

        if (!cs || typeof cs.evalScript !== "function") {
          reject(
            csInitializationError ||
            new Error("CSInterface is unavailable. Verify CSInterface.js.")
          );
          return;
        }

        if (state.bridgeUncertain) {
          reject(makeError(
            "A previous Premiere request is still unresolved. Wait for " +
            "Premiere to finish before retrying.",
            "BRIDGE_UNCERTAIN"
          ));
          return;
        }

        var settled = false;
        var timedOut = false;
        var mutating = hostMethods[method] === true;

        var timer = window.setTimeout(function () {
          if (settled) return;

          settled = true;
          timedOut = true;
          state.bridgeUncertain = true;
          hostReadyPromise = null;
          syncControls();

          reject(makeError(
            "Premiere bridge timed out during " + method + ". " +
            (mutating
              ? "The edit may still be running; its outcome is unknown. "
              : "The host request may still be running. ") +
            "Do not repeat the action. Wait for Premiere to respond and " +
            "inspect the timeline.",
            "BRIDGE_TIMEOUT"
          ));
        }, timeoutMs);

        try {
          cs.evalScript(buildHostScript(method, payload), function (raw) {
            if (timedOut) {
              timedOut = false;
              state.bridgeUncertain = false;
              hostReadyPromise = null;
              syncControls();

              try {
                var lateResult = parseBridgeResult(raw);
                appendLog(
                  "LATE BRIDGE RESPONSE: " + method + " " +
                  JSON.stringify(lateResult).slice(0, 4000)
                );

                setStatus(
                  "Premiere finished the previously timed-out " + method +
                  " request. Inspect its result before running another action.",
                  true
                );
              } catch (lateError) {
                logError(lateError);
                setStatus(
                  "The timed-out Premiere request returned: " +
                  messageOf(lateError) +
                  " Inspect the timeline before retrying.",
                  true
                );
              }

              return;
            }

            if (settled) return;

            settled = true;
            window.clearTimeout(timer);

            try {
              resolve(parseBridgeResult(raw));
            } catch (error) {
              if (error.code === "BRIDGE_RESPONSE") {
                hostReadyPromise = null;

                if (mutating) {
                  error.message +=
                    " The edit outcome is unknown; inspect Premiere before retrying.";
                }
              }

              reject(error);
            }
          });
        } catch (error) {
          if (settled) return;

          settled = true;
          window.clearTimeout(timer);
          hostReadyPromise = null;
          reject(error);
        }
      });
    }

    function enqueueHostRequest(method, payload, timeoutMs) {
      var task = bridgeTail.then(function () {
        assertActive();

        if (state.bridgeUncertain) {
          throw makeError(
            "The previous Premiere request has not completed.",
            "BRIDGE_UNCERTAIN"
          );
        }

        return evalScriptOnce(method, payload, timeoutMs);
      });

      bridgeTail = task.catch(function () { });
      return task;
    }

    function ensureHostReady() {
      if (previewMode) {
        return Promise.resolve({
          ok: true,
          hostVersion: "browser-preview"
        });
      }

      if (hostReadyPromise) return hostReadyPromise;

      hostReadyPromise = enqueueHostRequest(
        "hostInfo",
        undefined,
        BRIDGE_READ_TIMEOUT
      ).catch(function (error) {
        hostReadyPromise = null;
        throw error;
      });

      return hostReadyPromise;
    }

    function callHost(method, payload) {
      if (!owns(hostMethods, method)) {
        return Promise.reject(new Error("Unsupported host method: " + method));
      }

      // Snapshot payload before it enters the queue.
      var snapshot;

      try {
        snapshot = payload === undefined
          ? undefined
          : JSON.parse(JSON.stringify(payload));
      } catch (error) {
        return Promise.reject(error);
      }

      if (previewMode) {
        return Promise.resolve().then(function () {
          assertActive();
          return previewHostCall(method, snapshot);
        });
      }

      return ensureHostReady().then(function () {
        return enqueueHostRequest(
          method,
          snapshot,
          hostMethods[method]
            ? BRIDGE_WRITE_TIMEOUT
            : BRIDGE_READ_TIMEOUT
        );
      });
    }

    /*
     * Explicit browser preview simulation.
     * Never launches a process or writes Premiere data.
     */

    var previewClip = {
      identity: "autocut-preview-clip",
      name: "Preview audio",
      mediaPath: "__autocut_studio_preview__",
      projectKey: "preview-project",
      projectItemNodeId: "preview-media",
      trackItemNodeId: "preview-track-item",
      sequenceId: "preview-sequence",
      startSeconds: 0,
      endSeconds: 24,
      inPointSeconds: 0,
      outPointSeconds: 24,
      sourceDurationSeconds: 24,
      timelineDurationSeconds: 24,
      durationSeconds: 24,
      playbackRate: 1,
      reversed: false,
      variableTimeRemap: false
    };

    var previewMarkers = {
      sequence: [],
      clip: []
    };

    function previewHostCall(method, payload) {
      payload = payload || {};

      if (method === "hostInfo") {
        return {
          ok: true,
          hostVersion: "browser-preview",
          extensionVersion: APP_VERSION
        };
      }

      if (method === "getSelectedClipInfo") {
        return { ok: true, clip: JSON.parse(JSON.stringify(previewClip)) };
      }

      if (method === "getSelectedVideoClipCount") {
        return { ok: true, count: 1 };
      }

      if (method === "runDiagnostics") {
        return {
          ok: true,
          diagnostics: [
            "Browser preview: no Premiere connection",
            "Analyzer: simulated events",
            "Marker edits: in-memory simulation",
            "Zoom and Color: simulated acknowledgements"
          ]
        };
      }

      if (method === "cleanMotionLedger") {
        return { ok: true, removed: 0, remaining: 0 };
      }

      var target = payload.target === "clip" ? "clip" : "sequence";
      var markers = previewMarkers[target];

      if (method === "scanMarkers") {
        return { ok: true, count: markers.length, times: markers.slice() };
      }

      if (method === "removeMarkers") {
        var removed = markers.length;
        previewMarkers[target] = [];

        return { ok: true, removed: removed, errors: [] };
      }

      if (method === "removeMarkersExactTimes") {
        var wanted = payload.times || [];
        var kept = markers.filter(function (time) {
          return !wanted.some(function (candidate) {
            return Math.abs(candidate - time) < 0.0005;
          });
        });

        previewMarkers[target] = kept;

        return {
          ok: true,
          removed: markers.length - kept.length,
          errors: []
        };
      }

      if (method === "applyMarkersChunk") {
        var created = [];
        var skipped = 0;
        var duplicates = 0;

        (payload.events || []).forEach(function (event) {
          var time = Number(event.time);

          if (
            !isFinite(time) ||
            time < previewClip.inPointSeconds ||
            time >= previewClip.outPointSeconds
          ) {
            skipped++;
            return;
          }

          if (target === "sequence") {
            time = clamp(Math.round(time * 30) / 30, 0, 24 - 1 / 30);
          }

          if (markers.some(function (existing) {
            return Math.abs(existing - time) < 0.000001;
          })) {
            skipped++;
            duplicates++;
            return;
          }

          markers.push(time);
          created.push(time);
        });

        markers.sort(function (a, b) { return a - b; });

        return {
          ok: true,
          applied: created.length,
          skipped: skipped,
          duplicates: duplicates,
          createdTimes: created,
          errors: [],
          warnings: []
        };
      }

      if (method === "prepareAutoColorAtPlayhead") {
        return { ok: true, ready: true };
      }

      if (method === "autoColorSelectedClips") {
        return {
          ok: true,
          applied: 1,
          skipped: 0,
          engine: "simulated native engine",
          look: payload.look || "skin_tone",
          autoAmount: 80,
          captureFrameSeconds: 2,
          captureRequested: true,
          colorScience: "Preview only",
          errors: [],
          warnings: []
        };
      }

      if (method === "applyGimbalZoom") {
        return { ok: true, applied: 1, skipped: 0, errors: [], warnings: [] };
      }

      if (method === "clearGimbalZoom") {
        return { ok: true, cleared: 1, skipped: 0, errors: [], warnings: [] };
      }

      if (method === "resetColorGrade") {
        return { ok: true, reset: 1, skipped: 0, errors: [], warnings: [] };
      }

      throw new Error("No preview implementation for " + method + ".");
    }

    /*
     * Analyzer.
     */

    function getExtensionRoot() {
      if (
        cs &&
        typeof cs.getSystemPath === "function" &&
        typeof SystemPath !== "undefined"
      ) {
        var root = cs.getSystemPath(SystemPath.EXTENSION);

        if (root) return root;
      }

      if (window.location.protocol !== "file:") {
        throw new Error("The extension root could not be determined.");
      }

      var pathname = decodeURIComponent(window.location.pathname);

      if (/^\/[A-Za-z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }

      if (window.location.hostname) {
        pathname = "//" + window.location.hostname + pathname;
      }

      return pathname.replace(/[\\/][^\\/]*$/, "");
    }

    function getAnalyzerPath() {
      var services = getNodeServices();

      if (!services) {
        throw new Error("Node.js is not enabled in this CEP panel.");
      }

      var executable = services.os.platform() === "win32"
        ? "beat_analyzer.exe"
        : "beat_analyzer";

      var root = getExtensionRoot();
      var candidates = [
        services.path.join(root, "bin", executable),
        services.path.join(root, "analyzer", "target", "release", executable)
      ];

      for (var i = 0; i < candidates.length; i++) {
        try {
          if (services.fs.statSync(candidates[i]).isFile()) {
            return candidates[i];
          }
        } catch (_) { }
      }

      throw new Error(
        "The beat analyzer executable is missing. Reinstall AutoCut Studio " +
        "or build the analyzer for this operating system."
      );
    }

    function clipAnalysisRange(clip) {
      if (!clip || typeof clip !== "object") {
        throw new Error("Premiere did not return valid clip information.");
      }

      var start = finiteNumber(clip.inPointSeconds, "Source in point");
      var end = finiteNumber(clip.outPointSeconds, "Source out point");

      if (start < 0 || end <= start) {
        throw new Error("The selected clip has an invalid source in/out range.");
      }

      return {
        start: start,
        end: end,
        duration: end - start
      };
    }

    function validateClip(clip) {
      clipAnalysisRange(clip);

      if (
        typeof clip.mediaPath !== "string" ||
        !clip.mediaPath ||
        typeof clip.identity !== "string" ||
        !clip.identity
      ) {
        throw new Error(
          "Premiere returned incomplete clip identity or media path information."
        );
      }

      var start = finiteNumber(clip.startSeconds, "Timeline start");
      var end = finiteNumber(clip.endSeconds, "Timeline end");

      if (end <= start) {
        throw new Error("The selected clip has an invalid timeline range.");
      }

      return clip;
    }

    function formatSeconds(seconds) {
      var total = Math.max(0, Math.round(numberOr(seconds, 0)));
      var hours = Math.floor(total / 3600);
      var minutes = Math.floor((total % 3600) / 60);
      var remaining = total % 60;

      if (hours) return hours + "h " + minutes + "m " + remaining + "s";
      if (minutes) return minutes + "m " + remaining + "s";
      return remaining + "s";
    }

    function sanitizeEvents(events) {
      if (!Array.isArray(events)) {
        throw new Error("Analyzer output must be a JSON event array.");
      }

      if (events.length > MAX_ANALYZER_EVENTS) {
        throw new Error("Analyzer returned too many events.");
      }

      var valid = [];

      events.forEach(function (event) {
        if (!event || typeof event !== "object") return;

        if (
          (typeof event.time !== "number" && typeof event.time !== "string") ||
          (typeof event.score !== "number" && typeof event.score !== "string") ||
          event.time === "" ||
          event.score === ""
        ) {
          return;
        }

        var time = Number(event.time);
        var score = Number(event.score);

        if (isFinite(time) && time >= 0 && isFinite(score)) {
          valid.push({ time: time, score: score });
        }
      });

      valid.sort(function (a, b) {
        return a.time - b.time || b.score - a.score;
      });

      var unique = [];

      valid.forEach(function (event) {
        var previous = unique.length ? unique[unique.length - 1] : null;

        if (previous && Math.abs(previous.time - event.time) < 0.000001) {
          if (event.score > previous.score) previous.score = event.score;
        } else {
          unique.push(event);
        }
      });

      return unique;
    }

    function makePreviewEvents(clip) {
      var range = clipAnalysisRange(clip);
      var events = [];

      for (var beat = 0; beat < 42; beat++) {
        var time = range.start + 0.52 + beat * 0.5;

        if (time >= range.end) break;

        events.push({
          time: Number(time.toFixed(6)),
          score: beat % 8 === 0 ? 0.88 : beat % 4 === 0 ? 0.76 : 0.64
        });
      }

      return events;
    }

    function runAnalyzer(mediaPath, clip) {
      if (previewMode) {
        return sleep(250).then(function () {
          return makePreviewEvents(clip);
        });
      }

      return new Promise(function (resolve, reject) {
        var services;
        var analyzerPath;
        var range;

        try {
          assertActive();
          services = getNodeServices();

          if (!services) {
            throw new Error("Node.js is unavailable inside CEP.");
          }

          if (
            typeof mediaPath !== "string" ||
            !mediaPath ||
            mediaPath.indexOf("\0") >= 0 ||
            !services.path.isAbsolute(mediaPath)
          ) {
            throw new Error("Analyzer requires an absolute media file path.");
          }

          if (!services.fs.statSync(mediaPath).isFile()) {
            throw new Error("The selected media path is not a readable file.");
          }

          analyzerPath = getAnalyzerPath();
          range = clipAnalysisRange(clip);
        } catch (error) {
          reject(error);
          return;
        }

        var args = [
          "--start",
          range.start.toFixed(6),
          "--duration",
          range.duration.toFixed(6),
          mediaPath
        ];

        var child;

        try {
          child = services.childProcess.execFile(
            analyzerPath,
            args,
            {
              windowsHide: true,
              shell: false,
              encoding: "utf8",
              maxBuffer: MAX_ANALYZER_BUFFER,
              timeout: ANALYZER_TIMEOUT
            },
            function (error, stdout, stderr) {
              if (state.analyzerProcess === child) {
                state.analyzerProcess = null;
              }

              if (state.disposed) {
                reject(makeError("The panel is closing.", "PANEL_CLOSED"));
                return;
              }

              if (error) {
                if (
                  error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
                  /maxBuffer/i.test(messageOf(error))
                ) {
                  reject(new Error(
                    "Analyzer output exceeded the size limit. Analyze a shorter cut."
                  ));
                  return;
                }

                if (error.killed) {
                  reject(new Error(
                    "The analyzer timed out or was terminated. Try a shorter " +
                    "clip or transcode the audio first."
                  ));
                  return;
                }

                reject(new Error(
                  String(stderr || error.message || "Analyzer failed.")
                    .trim()
                    .slice(0, 4000)
                ));
                return;
              }

              try {
                var output = String(stdout || "")
                  .replace(/^\uFEFF/, "")
                  .trim();

                if (!output) {
                  throw new Error("Analyzer produced no output.");
                }

                var parsed = JSON.parse(output);
                var events = sanitizeEvents(parsed);

                if (parsed.length && !events.length) {
                  throw new Error("Analyzer returned no valid event records.");
                }

                if (parsed.length !== events.length) {
                  appendLog(
                    "Analyzer validation: " + parsed.length +
                    " records received; " + events.length +
                    " valid unique records retained."
                  );
                }

                if (String(stderr || "").trim()) {
                  appendLog("Analyzer stderr: " + String(stderr).slice(0, 4000));
                }

                resolve(events);
              } catch (parseError) {
                reject(new Error(
                  "Invalid analyzer output: " + messageOf(parseError)
                ));
              }
            }
          );

          state.analyzerProcess = child;
        } catch (spawnError) {
          reject(spawnError);
        }
      });
    }

    /*
     * Beat filtering and analysis.
     */

    function beatSelectionPercentage() {
      return clamp(
        Math.round(numberOr(
          dom.beatSelectionSlider ? dom.beatSelectionSlider.value : 100,
          100
        )),
        5,
        100
      );
    }

    function evenlySelect(events, percentage) {
      if (!events.length) return [];

      var count = clamp(
        Math.round(events.length * percentage / 100),
        1,
        events.length
      );

      if (count === events.length) return events.slice();
      if (count === 1) return [events[Math.floor(events.length / 2)]];

      var result = [];

      for (var i = 0; i < count; i++) {
        var index = Math.round(i * (events.length - 1) / (count - 1));
        result.push(events[index]);
      }

      return result;
    }

    function updateBeatSelectionUI() {
      var percentage = beatSelectionPercentage();

      setText(dom.beatSelectionLabel, percentage + "%");
      setText(dom.filteredCount, state.markerEvents.length);
      setText(
        dom.totalCount,
        "of " + state.allEvents.length + " detected beat markers"
      );

      setText(
        dom.beatSelectionSummary,
        state.allEvents.length
          ? "Keeps " + state.markerEvents.length + " of " +
          state.allEvents.length + " detected beats."
          : percentage === 100
            ? "Uses every detected beat."
            : "Will keep approximately " + percentage + "% of detected beats."
      );

      syncControls();
    }

    function filterEvents() {
      var percentage = beatSelectionPercentage();
      var selected = null;
      var distribution = window.AutoCutBeatDistribution;

      if (distribution && typeof distribution.select === "function") {
        try {
          var input = state.allEvents.map(function (event) {
            return { time: event.time, score: event.score };
          });

          var proposed = distribution.select(input, percentage);

          if (!Array.isArray(proposed)) {
            throw new Error("Beat selector returned an invalid result.");
          }

          var available = {};

          state.allEvents.forEach(function (event) {
            available["$" + event.time.toFixed(9)] = event;
          });

          selected = sanitizeEvents(proposed).map(function (event) {
            var original = available["$" + event.time.toFixed(9)];

            if (!original) {
              throw new Error("Beat selector returned an unknown event.");
            }

            return original;
          });

          if (state.allEvents.length && !selected.length) {
            throw new Error("Beat selector returned an empty selection.");
          }
        } catch (error) {
          appendLog(
            "Beat selector fallback: " + messageOf(error)
          );
          selected = null;
        }
      }

      state.markerEvents = selected ||
        evenlySelect(state.allEvents, percentage);

      updateBeatSelectionUI();
    }

    function markerTimingOffsetMilliseconds() {
      var slider = dom.markerTimingOffsetSlider;

      if (!slider) return 0;

      var minimum = numberOr(slider.min, -500);
      var maximum = numberOr(slider.max, 500);

      if (maximum < minimum) {
        minimum = -500;
        maximum = 500;
      }

      return clamp(
        Math.round(numberOr(slider.value, 0)),
        minimum,
        maximum
      );
    }

    function updateMarkerTimingOffsetLabel() {
      var offset = markerTimingOffsetMilliseconds();

      setText(
        dom.markerTimingOffsetLabel,
        (offset > 0 ? "+" : "") + offset + " ms"
      );
    }

    function markerTimingDescription(offset) {
      return offset
        ? " (" + Math.abs(offset) + " ms " +
        (offset < 0 ? "earlier" : "later") + ")"
        : "";
    }

    function analyzeTrack() {
      return runOperation(
        "Reading the selected clip from Premiere...",
        async function () {
          state.clip = null;
          state.allEvents = [];
          state.markerEvents = [];

          if (dom.beatResultsPanel) {
            dom.beatResultsPanel.classList.add("is-hidden");
          }

          updateBeatSelectionUI();

          var result = await callHost("getSelectedClipInfo");
          var clip = validateClip(result.clip);
          var range = clipAnalysisRange(clip);

          setStatus(
            "Analyzing the selected cut (" + formatSeconds(range.duration) +
            ") from " + clip.name + "...",
            false,
            true
          );

          var analyzed = await runAnalyzer(clip.mediaPath, clip);
          assertActive();

          var cropped = analyzed.filter(function (event) {
            return event.time >= range.start && event.time < range.end;
          });

          state.clip = clip;
          state.allEvents = cropped;
          filterEvents();

          if (dom.beatResultsPanel) {
            dom.beatResultsPanel.classList.remove("is-hidden");
          }

          appendLog(
            "Beat range: " + analyzed.length + " analyzer events; " +
            cropped.length + " inside the selected source range."
          );

          setStatus(
            "Analysis complete: " + cropped.length +
            " beats detected; keeping " + state.markerEvents.length +
            " at " + beatSelectionPercentage() + "% selection" +
            (previewMode ? " using simulated events." : " using the Rust analyzer."),
            false,
            false,
            true
          );
        }
      );
    }

    /*
     * Marker operations.
     *
     * Replacement is not transactional in Premiere. Existing markers are
     * removed only after confirmation, and partial failures are reported
     * without pretending that the previous marker set was restored.
     */

    function markerTarget() {
      var target = dom.markerTarget ? dom.markerTarget.value : "sequence";

      if (target !== "clip" && target !== "sequence") {
        throw new Error("Marker target must be clip or sequence.");
      }

      return target;
    }

    function clipPayload(clip, target) {
      validateClip(clip);

      var payload = { target: target };
      var fields = [
        "identity",
        "mediaPath",
        "projectKey",
        "projectItemNodeId",
        "trackItemNodeId",
        "sequenceId",
        "startSeconds",
        "endSeconds",
        "inPointSeconds",
        "outPointSeconds"
      ];

      fields.forEach(function (field) {
        if (clip[field] !== undefined && clip[field] !== null) {
          payload[field] = clip[field];
        }
      });

      return payload;
    }

    function resultIssues(result) {
      var issues = [];

      ["errors", "warnings"].forEach(function (field) {
        if (Array.isArray(result[field])) {
          result[field].forEach(function (message) {
            if (message !== undefined && message !== null) {
              issues.push(String(message));
            }
          });
        }
      });

      return issues;
    }

    function assertCompleteMutation(result, label) {
      var errors = Array.isArray(result.errors) ? result.errors : [];

      if (
        result.partial === true ||
        numberOr(result.failed, 0) > 0 ||
        errors.length
      ) {
        throw new Error(
          label + " was incomplete." +
          (errors.length ? " " + errors.join(" | ") : "")
        );
      }
    }

    function countValue(result, field) {
      var value = finiteNumber(result[field], "Host " + field + " count");

      if (value < 0 || Math.floor(value) !== value) {
        throw new Error("Premiere returned an invalid " + field + " count.");
      }

      return value;
    }

    function copyObject(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function applyMarkers() {
      if (!state.clip || !state.markerEvents.length) {
        return Promise.resolve();
      }

      return runOperation("Preparing marker replacement...", async function () {
        var target = markerTarget();
        var clip = copyObject(state.clip);
        var range = clipAnalysisRange(clip);
        var base = clipPayload(clip, target);
        var offset = markerTimingOffsetMilliseconds();
        var events = state.markerEvents.map(function (event) {
          return {
            time: Number((event.time + offset / 1000).toFixed(6)),
            score: event.score
          };
        });

        var applicable = events.filter(function (event) {
          return event.time >= range.start && event.time < range.end;
        });

        var offsetSkipped = events.length - applicable.length;

        if (!applicable.length) {
          throw new Error(
            "The timing offset moves every selected beat outside the clip. " +
            "No markers were changed."
          );
        }

        var removed = 0;
        var totalApplied = 0;
        var totalSkipped = offsetSkipped;
        var duplicates = 0;
        var mutationAttempted = false;
        var acknowledgedTimes = [];
        var warnings = [];

        try {
          var scan = await callHost("scanMarkers", base);
          var existingCount = countValue(scan, "count");

          if (existingCount > 0) {
            var question =
              "Replace " + existingCount +
              " AutoCut Studio markers in the selected range?\n\n" +
              "Premiere cannot make this replacement atomic. If applying " +
              "new markers fails, removed markers are not automatically restored.";

            if (target === "clip") {
              question +=
                "\n\nSource markers are shared by all timeline instances " +
                "of this project media.";
            }

            if (!window.confirm(question)) {
              throw makeError("Marker apply cancelled.", "CANCELLED");
            }

            mutationAttempted = true;

            var removal = await callHost("removeMarkers", base);
            removed = countValue(removal, "removed");
            assertCompleteMutation(removal, "Marker removal");
          } else if (
            target === "clip" &&
            !window.confirm(
              "Add source markers to this media?\n\nSource markers are " +
              "shared by all timeline instances of the project item."
            )
          ) {
            throw makeError("Marker apply cancelled.", "CANCELLED");
          }

          for (
            var index = 0;
            index < applicable.length;
            index += MARKER_CHUNK_SIZE
          ) {
            assertActive();

            var payload = copyObject(base);
            payload.events = applicable.slice(
              index,
              index + MARKER_CHUNK_SIZE
            );

            setStatus(
              "Applying markers " + (index + 1) + "–" +
              Math.min(index + MARKER_CHUNK_SIZE, applicable.length) +
              " of " + applicable.length + "...",
              false,
              true
            );

            mutationAttempted = true;

            var result = await callHost("applyMarkersChunk", payload);

            totalApplied += countValue(result, "applied");
            totalSkipped += countValue(result, "skipped");
            duplicates += numberOr(result.duplicates, 0);

            if (Array.isArray(result.createdTimes)) {
              acknowledgedTimes = acknowledgedTimes.concat(
                result.createdTimes
              );
            }

            if (Array.isArray(result.warnings)) {
              warnings = warnings.concat(result.warnings);
            }

            assertCompleteMutation(result, "Marker creation");
            await sleep(15);
          }

          warnings.forEach(function (warning) {
            appendLog("MARKER WARNING: " + warning);
          });

          setStatus(
            (removed ? "Removed " + removed + " previous markers. " : "") +
            "Applied " + totalApplied +
            "; skipped " + totalSkipped +
            (duplicates ? " (" + duplicates + " duplicates)" : "") +
            markerTimingDescription(offset) + "." +
            (warnings.length ? " Warnings: " + warnings.join(" | ") : ""),
            false,
            false,
            warnings.length === 0
          );
        } catch (error) {
          if (error.code === "CANCELLED") throw error;

          if (!mutationAttempted) throw error;

          appendLog(
            "MARKER PARTIAL STATE: removed=" + removed +
            ", acknowledgedApplied=" + totalApplied +
            ", acknowledgedTimes=" +
            JSON.stringify(acknowledgedTimes).slice(0, 8000)
          );

          var partialError = makeError(
            messageOf(error) +
            "\nConfirmed changes: removed " + removed +
            " previous markers; created " + totalApplied +
            " new markers. No automatic rollback was attempted. " +
            "Existing removals cannot be restored by this panel. " +
            "Inspect Premiere before retrying; an unacknowledged request " +
            "may have made additional changes.",
            error.code || "MARKER_PARTIAL"
          );

          throw partialError;
        }
      });
    }

    function removeMarkers() {
      return runOperation(
        "Reading the selected marker range...",
        async function () {
          var target = markerTarget();

          // Use the current selection, not stale analysis metadata.
          var selected = await callHost("getSelectedClipInfo");
          var base = clipPayload(validateClip(selected.clip), target);
          var scan = await callHost("scanMarkers", base);
          var count = countValue(scan, "count");

          if (!count) {
            setStatus("No owned AutoCut Studio markers were found.");
            return;
          }

          var question =
            "Remove " + count +
            " AutoCut Studio markers from the selected range?";

          if (target === "clip") {
            question +=
              "\n\nThese are source markers shared by all uses of this media.";
          }

          if (!window.confirm(question)) {
            throw makeError("Marker removal cancelled.", "CANCELLED");
          }

          setStatus("Removing owned markers...", false, true);

          var result = await callHost("removeMarkers", base);
          var removed = countValue(result, "removed");

          assertCompleteMutation(result, "Marker removal");

          setStatus(
            "Removed " + removed + " AutoCut Studio markers.",
            false,
            false,
            true
          );
        }
      );
    }

    /*
     * Zoom controls and preview.
     */

    function zoomRatio() {
      return clamp(
        numberOr(dom.zoomSlider ? dom.zoomSlider.value : 110, 110),
        101,
        150
      );
    }

    function autoZoomEnabled() {
      return !dom.autoZoomRatio || dom.autoZoomRatio.checked;
    }

    function setZoomRatio(value, keepAuto) {
      var ratio = clamp(finiteNumber(value, "Zoom ratio"), 101, 150);

      if (dom.zoomSlider) dom.zoomSlider.value = String(ratio);
      if (dom.autoZoomRatio) dom.autoZoomRatio.checked = keepAuto !== false;

      setText(dom.zoomLabel, ratio + "%");
      refreshZoomPreview();
    }

    function applyAutoRatioForMode() {
      if (!autoZoomEnabled()) return;

      var preset = presetById[state.activeZoomMode];
      setZoomRatio(
        preset ? numberOr(preset.autoRatio, 110) : 110,
        true
      );
    }

    function syncMovementButtons() {
      movementButtons.forEach(function (button) {
        var label = String(button.textContent || "").trim();
        var active =
          button.getAttribute("data-mode") === state.activeZoomMode &&
          (!state.activeMovementLabel || label === state.activeMovementLabel);

        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    function selectZoomMode(mode, keepManualRatio, displayLabel) {
      if (!owns(presetById, mode)) {
        throw new Error("Unsupported movement preset: " + mode);
      }

      state.activeZoomMode = mode;
      state.activeMovementLabel = displayLabel || "";

      // Retained for other panel scripts that read the active movement.
      window.__autocutActiveMovementMode = mode;

      if (dom.zoomMode) dom.zoomMode.value = mode;

      if (!keepManualRatio) applyAutoRatioForMode();
      refreshZoomPreview();
    }

    function keyframePreviewPoints(mode, ratio) {
      var preset = getPreset(mode) || getPreset("smooth_in");
      var points = preset && typeof preset.keyframePattern === "function"
        ? preset.keyframePattern(ratio)
        : [[0, 100], [100, ratio]];

      if (!Array.isArray(points) || !points.length) {
        return [[0, 100], [100, ratio]];
      }

      return points.map(function (point) {
        return [
          clamp(finiteNumber(point[0], "Preview keyframe time"), 0, 100),
          finiteNumber(point[1], "Preview keyframe scale")
        ];
      }).sort(function (a, b) {
        return a[0] - b[0];
      });
    }

    function renderKeyframePreview(mode, ratio) {
      if (!dom.previewKeyframeTrack) return;

      var points = keyframePreviewPoints(mode, ratio);
      var minScale = Math.min.apply(
        Math,
        [100].concat(points.map(function (point) { return point[1]; }))
      );
      var maxScale = Math.max.apply(
        Math,
        [150].concat(points.map(function (point) { return point[1]; }))
      );

      var ns = "http://www.w3.org/2000/svg";
      var width = 100;
      var height = 24;
      var pad = 3;
      var svg = document.createElementNS(ns, "svg");

      function xFor(time) {
        return pad + time / 100 * (width - pad * 2);
      }

      function yFor(scale) {
        var normalized = (scale - minScale) / (maxScale - minScale || 1);
        return height - pad -
          clamp(normalized, 0, 1) * (height - pad * 2);
      }

      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("class", "keyframe-svg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Illustrative Scale keyframe preview");
      svg.style.width = "100%";
      svg.style.height = height + "px";
      svg.style.display = "block";

      for (var i = 0; i < points.length - 1; i++) {
        var line = document.createElementNS(ns, "line");

        line.setAttribute("x1", String(xFor(points[i][0])));
        line.setAttribute("y1", String(yFor(points[i][1])));
        line.setAttribute("x2", String(xFor(points[i + 1][0])));
        line.setAttribute("y2", String(yFor(points[i + 1][1])));
        line.setAttribute("stroke", "var(--acs-accent, #ffaa3c)");
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("stroke-linecap", "round");
        svg.appendChild(line);
      }

      points.forEach(function (point) {
        var circle = document.createElementNS(ns, "circle");

        circle.setAttribute("cx", String(xFor(point[0])));
        circle.setAttribute("cy", String(yFor(point[1])));
        circle.setAttribute("r", "2.2");
        circle.setAttribute("fill", "var(--acs-accent, #ffaa3c)");
        svg.appendChild(circle);
      });

      while (dom.previewKeyframeTrack.firstChild) {
        dom.previewKeyframeTrack.removeChild(
          dom.previewKeyframeTrack.firstChild
        );
      }

      dom.previewKeyframeTrack.appendChild(svg);

      setText(
        dom.previewStartLabel,
        Math.round(points[0][1]) + "% start"
      );

      setText(
        dom.previewEndLabel,
        Math.round(points[points.length - 1][1]) + "% end"
      );
    }

    function refreshZoomPreview() {
      var mode = state.activeZoomMode;
      var preset = presetById[mode];
      var ratio = zoomRatio();
      var auto = autoZoomEnabled();
      var displayName = state.activeMovementLabel ||
        (preset ? preset.name : mode.replace(/_/g, " "));

      if (dom.previewSubject) {
        if (state.previewAnimationClass) {
          dom.previewSubject.classList.remove(state.previewAnimationClass);
        }

        state.previewAnimationClass = "animate-" + mode.replace(/_/g, "-");
        dom.previewSubject.classList.add("preview-subject");

        var reduceMotion = window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        if (!reduceMotion) {
          dom.previewSubject.classList.add(state.previewAnimationClass);
        }

        dom.previewSubject.style.setProperty(
          "--autocut-preview-scale",
          String(ratio / 100)
        );
      }

      syncMovementButtons();
      setText(dom.zoomLabel, ratio + "%");
      setText(dom.previewModeLabel, displayName);
      setText(dom.selectedMomentLabel, displayName);
      setText(
        dom.selectedMomentMeta,
        (preset ? preset.description : "Scale movement across the selected clip.") +
        (auto ? " Auto strength also depends on clip duration." : "")
      );
      setText(
        dom.previewRatioLabel,
        (auto ? "AUTO BASE " : "MANUAL ") + ratio + "%"
      );

      renderKeyframePreview(mode, ratio);
    }

    function showBatchResult(result, field, label) {
      var count = countValue(result, field);
      var skipped = numberOr(result.skipped, 0);
      var issues = resultIssues(result);
      var clean = skipped === 0 && issues.length === 0 && !result.partial;

      issues.forEach(function (issue) {
        appendLog("HOST DETAIL: " + issue);
      });

      setStatus(
        label + " " + count + " clip" + (count === 1 ? "" : "s") +
        (skipped ? "; skipped " + skipped : "") + "." +
        (issues.length ? " Details: " + issues.join(" | ") : ""),
        count === 0 && issues.length > 0,
        false,
        clean
      );
    }

    function applyGimbalZoom() {
      return runOperation(
        "Applying Scale animation to the selected clips...",
        async function () {
          var payload = {
            zoom: zoomRatio(),
            style: state.activeZoomMode,
            autoRatio: autoZoomEnabled()
          };

          var result = await callHost("applyGimbalZoom", payload);
          showBatchResult(result, "applied", "Applied zoom keyframes to");
        }
      );
    }

    function clearGimbalZoom() {
      return runOperation(
        "Clearing owned zoom keyframes from selected clips...",
        async function () {
          var result = await callHost("clearGimbalZoom");
          showBatchResult(result, "cleared", "Cleared owned zoom keyframes on");
        }
      );
    }

    /*
     * Auto Color.
     */

    function colorIntensity() {
      return clamp(
        numberOr(
          dom.colorIntensitySlider ? dom.colorIntensitySlider.value : 100,
          100
        ),
        0,
        200
      );
    }

    function colorLookName(look) {
      var names = {
        skin_tone: "Skin Tone & Balance",
        wedding_cinema: "Wedding Cinema",
        cinematic_warm: "Cinematic Warm"
      };

      return owns(names, look) ? names[look] : look.replace(/_/g, " ");
    }

    function syncColorLookButtons() {
      colorLookButtons.forEach(function (button) {
        var active =
          button.getAttribute("data-look") === state.selectedColorLook;

        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }

    function autoColorSelectedClips() {
      return runOperation(
        "Preparing native playhead-frame color capture...",
        async function () {
          var look = state.selectedColorLook;
          var intensity = colorIntensity();
          var started = Date.now();
          var ready = false;

          while (!ready) {
            var preparation = await callHost("prepareAutoColorAtPlayhead");

            if (preparation.ready === true) {
              ready = true;
              break;
            }

            if (Date.now() - started >= 10000) {
              throw new Error(
                "Color Engine insertion is still pending. Check Effect " +
                "Controls and the native plugin installation before retrying."
              );
            }

            await sleep(200);
            assertActive();
          }

          var result = await callHost("autoColorSelectedClips", {
            look: look,
            intensity: intensity / 100
          });

          var applied = countValue(result, "applied");
          var issues = resultIssues(result);
          var resultLook = result.look || look;
          var label = colorLookName(resultLook);
          var requested = result.captureRequested === true;

          setText(dom.colorStatusValue, label.toUpperCase());
          setText(
            dom.colorStatusLabel,
            (requested ? "capture requested at " : "applied at ") +
            intensity + "% intensity"
          );

          setStatus(
            (requested ? "Requested " : "Applied ") +
            label + " color correction for " + applied +
            " clip" + (applied === 1 ? "" : "s") +
            (result.captureFrameSeconds !== undefined
              ? " at playhead " + formatSeconds(result.captureFrameSeconds)
              : "") +
            "." +
            (requested
              ? " Native analysis may finish asynchronously; inspect the rendered frame."
              : "") +
            (result.colorScience
              ? " Color science: " + result.colorScience + "."
              : "") +
            (issues.length ? " Details: " + issues.join(" | ") : ""),
            false,
            false,
            !requested && issues.length === 0
          );
        }
      );
    }

    function resetColorGrade() {
      return runOperation(
        "Resetting AutoCutStudio color controls...",
        async function () {
          var result = await callHost("resetColorGrade");
          var issues = resultIssues(result);

          if (
            numberOr(result.reset, 0) > 0 &&
            numberOr(result.skipped, 0) === 0 &&
            !issues.length
          ) {
            setText(dom.colorStatusValue, "RESET");
            setText(dom.colorStatusLabel, "AutoCut color controls reset");
          }

          showBatchResult(result, "reset", "Reset color controls on");
        }
      );
    }

    /*
     * Diagnostics, clipboard and log maintenance.
     */

    function legacyClipboardCopy(text) {
      return new Promise(function (resolve, reject) {
        var textarea = document.createElement("textarea");
        var previousFocus = document.activeElement;
        var copied = false;

        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-10000px";
        textarea.style.top = "0";

        document.body.appendChild(textarea);

        try {
          textarea.focus();
          textarea.select();
          copied = document.execCommand("copy");
        } catch (_) {
          copied = false;
        } finally {
          document.body.removeChild(textarea);

          if (previousFocus && typeof previousFocus.focus === "function") {
            previousFocus.focus();
          }
        }

        if (copied) resolve();
        else reject(new Error("Browser clipboard copy was denied."));
      });
    }

    function nativeClipboardCopy(text) {
      var services = getNodeServices();

      if (!services || previewMode) {
        return Promise.reject(
          new Error("Native clipboard access is unavailable.")
        );
      }

      var platform = services.os.platform();
      var command;

      if (platform === "win32") command = "clip.exe";
      else if (platform === "darwin") command = "/usr/bin/pbcopy";
      else {
        return Promise.reject(
          new Error("Native clipboard fallback is unsupported on this platform.")
        );
      }

      return new Promise(function (resolve, reject) {
        var settled = false;
        var child;
        var timer;

        function finish(error) {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);

          if (error) reject(error);
          else resolve();
        }

        try {
          child = services.childProcess.spawn(command, [], {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "ignore", "ignore"]
          });

          timer = window.setTimeout(function () {
            try { child.kill(); } catch (_) { }
            finish(new Error("Clipboard helper timed out."));
          }, 5000);

          child.on("error", finish);

          child.on("close", function (code) {
            finish(
              code === 0
                ? null
                : new Error("Clipboard helper exited with code " + code + ".")
            );
          });

          child.stdin.on("error", finish);

          if (platform === "win32") {
            // clip.exe recognizes UTF-16LE input with a BOM.
            child.stdin.end("\uFEFF" + text, "utf16le");
          } else {
            child.stdin.end(text, "utf8");
          }
        } catch (error) {
          finish(error);
        }
      });
    }

    function copyToClipboard(text) {
      var browserCopy = navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
        ? Promise.resolve().then(function () {
          return navigator.clipboard.writeText(text);
        })
        : Promise.reject(new Error("Clipboard API unavailable."));

      return browserCopy
        .catch(function () {
          return legacyClipboardCopy(text);
        })
        .catch(function () {
          return nativeClipboardCopy(text);
        });
    }

    function runDiagnostics() {
      return runOperation(
        "Running AutoCut Studio diagnostics for v" + APP_VERSION + "...",
        async function () {
          var checks = [
            "AutoCut Studio: v" + APP_VERSION,
            "Mode: " + (previewMode ? "browser preview" : "Premiere CEP"),
            "CEP Node: " + (getNodeServices() ? "available" : "unavailable")
          ];

          if (!previewMode) {
            try {
              checks.push("Analyzer: " + getAnalyzerPath());
            } catch (error) {
              checks.push("Analyzer: FAIL - " + messageOf(error));
            }

            try {
              checks.push("Panel log: " + getLogLocation().file);
            } catch (error) {
              checks.push("Panel log: unavailable - " + messageOf(error));
            }
          }

          var bridgeFailed = false;

          try {
            var result = await callHost("runDiagnostics");

            if (Array.isArray(result.diagnostics)) {
              checks = checks.concat(result.diagnostics.map(String));
            }
          } catch (error) {
            bridgeFailed = true;
            checks.push("Premiere bridge: FAIL - " + messageOf(error));
          }

          var report = checks.join("\n");
          appendLog("DIAGNOSTICS:\n" + report);

          setStatus(
            bridgeFailed
              ? "Diagnostics completed with a bridge error."
              : "Diagnostics complete.",
            bridgeFailed
          );

          if (window.confirm(
            "DIAGNOSTICS REPORT\n\n" + report +
            "\n\nThis report may contain local file paths. Copy it to the clipboard?"
          )) {
            await copyToClipboard(report);
            setStatus("Diagnostics copied to the clipboard.", false, false, true);
          }
        }
      );
    }

    function clearLogs() {
      return runOperation("Clearing panel logs...", async function () {
        if (previewMode) {
          setStatus("Preview mode does not write panel log files.");
          return;
        }

        var location = getLogLocation();

        if (logTimer !== null) {
          window.clearTimeout(logTimer);
          logTimer = null;
        }

        // Drop queued entries; wait for any already-started write.
        logQueue = [];

        await enqueueLogOperation(function () {
          return ensureDirectory(location.services, location.directory)
            .then(function () {
              return nodeCall(location.services.fs, "writeFile", [
                location.file,
                "",
                "utf8"
              ]);
            })
            .then(function () {
              return removeFileIfPresent(
                location.services.fs,
                location.backup
              );
            });
        });

        // This status intentionally becomes the first new log entry.
        setStatus("Panel logs cleared.", false, false, true);
      });
    }

    /*
     * Tabs and event binding.
     */

    var tabs = [
      {
        name: "markers",
        button: dom.mainTabMarkersButton,
        panel: dom.mainTabMarkers
      },
      {
        name: "color",
        button: dom.mainTabColorButton,
        panel: dom.mainTabColor
      },
      {
        name: "tools",
        button: dom.mainTabToolsButton,
        panel: dom.mainTabTools
      },
      {
        name: "diagnostics",
        button: dom.mainTabDiagnosticsButton,
        panel: dom.mainTabDiagnostics
      }
    ];

    function activateMainTab(name, focus) {
      if (!tabs.some(function (tab) { return tab.name === name; })) return;

      tabs.forEach(function (tab) {
        var active = tab.name === name;

        if (tab.button) {
          tab.button.classList.toggle("is-active", active);
          tab.button.setAttribute("role", "tab");
          tab.button.setAttribute("aria-selected", active ? "true" : "false");
          tab.button.setAttribute("tabindex", active ? "0" : "-1");

          if (tab.panel) {
            tab.button.setAttribute("aria-controls", tab.panel.id);
          }

          if (active && focus) tab.button.focus();
        }

        if (tab.panel) {
          tab.panel.classList.toggle("is-active", active);
          tab.panel.setAttribute("role", "tabpanel");

          if (tab.button) {
            tab.panel.setAttribute("aria-labelledby", tab.button.id);
          }

          tab.panel.hidden = !active;
        }
      });
    }

    function guardedControl(handler) {
      return function (event) {
        if (state.isBusy || state.bridgeUncertain || state.disposed) {
          if (event) event.preventDefault();
          return;
        }

        try {
          var result = handler.call(this, event);

          if (result && typeof result.catch === "function") {
            result.catch(function (error) {
              logError(error);
              setStatus(messageOf(error), true);
            });
          }
        } catch (error) {
          logError(error);
          setStatus(messageOf(error), true);
        }
      };
    }

    var actions = {
      analyzeButton: analyzeTrack,
      diagnosticsButton: runDiagnostics,
      applyButton: applyMarkers,
      removeButton: removeMarkers,
      gimbalZoomButton: applyGimbalZoom,
      clearZoomButton: clearGimbalZoom,
      autoColorButton: autoColorSelectedClips,
      resetColorButton: resetColorGrade,
      clearLogsButton: clearLogs
    };

    Object.keys(actions).forEach(function (id) {
      listen(dom[id], "click", guardedControl(function (event) {
        event.preventDefault();
        return actions[id]();
      }));
    });

    colorLookButtons.forEach(function (button) {
      listen(button, "click", guardedControl(function (event) {
        event.preventDefault();

        var look = button.getAttribute("data-look") || "skin_tone";

        if (
          look !== "skin_tone" &&
          look !== "wedding_cinema" &&
          look !== "cinematic_warm"
        ) {
          throw new Error("Unsupported color look: " + look);
        }

        state.selectedColorLook = look;
        syncColorLookButtons();
        return autoColorSelectedClips();
      }));
    });

    listen(dom.colorIntensitySlider, "input", guardedControl(function () {
      setText(dom.colorIntensityLabel, colorIntensity() + "%");
    }));

    listen(dom.colorIntensitySlider, "change", guardedControl(function () {
      return autoColorSelectedClips();
    }));

    listen(
      dom.markerTimingOffsetSlider,
      "input",
      guardedControl(updateMarkerTimingOffsetLabel)
    );

    listen(
      dom.beatSelectionSlider,
      "input",
      guardedControl(filterEvents)
    );

    listen(dom.zoomSlider, "input", guardedControl(function () {
      if (dom.autoZoomRatio) dom.autoZoomRatio.checked = false;
      refreshZoomPreview();
    }));

    listen(dom.zoomMode, "change", guardedControl(function () {
      selectZoomMode(dom.zoomMode.value, false, "");
    }));

    listen(dom.autoZoomRatio, "change", guardedControl(function () {
      if (autoZoomEnabled()) applyAutoRatioForMode();
      refreshZoomPreview();
    }));

    movementButtons.forEach(function (button) {
      listen(button, "click", guardedControl(function (event) {
        event.preventDefault();

        selectZoomMode(
          button.getAttribute("data-mode"),
          false,
          String(button.textContent || "").trim()
        );

        var ratio = button.getAttribute("data-ratio");

        if (ratio !== null && ratio !== "") {
          // An explicit shortcut ratio is manual, not silently ignored by auto mode.
          setZoomRatio(ratio, false);
        }

        return applyGimbalZoom();
      }));
    });

    presetButtons.forEach(function (button) {
      // Avoid binding the same shortcut twice.
      if (movementButtons.indexOf(button) >= 0) return;

      listen(button, "click", guardedControl(function (event) {
        event.preventDefault();

        var mode = button.getAttribute("data-mode");
        var ratio = button.getAttribute("data-ratio");

        if (mode) {
          selectZoomMode(
            mode,
            false,
            String(button.textContent || "").trim()
          );
        }

        if (ratio !== null && ratio !== "") {
          setZoomRatio(ratio, false);
        }

        return applyGimbalZoom();
      }));
    });

    tabs.forEach(function (tab) {
      listen(tab.button, "click", function (event) {
        event.preventDefault();
        activateMainTab(tab.name, false);
      });

      listen(tab.button, "keydown", function (event) {
        var available = tabs.filter(function (candidate) {
          return !!candidate.button;
        });
        var index = available.indexOf(tab);
        var next = index;

        if (event.key === "ArrowRight") {
          next = (index + 1) % available.length;
        } else if (event.key === "ArrowLeft") {
          next = (index - 1 + available.length) % available.length;
        } else if (event.key === "Home") {
          next = 0;
        } else if (event.key === "End") {
          next = available.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        activateMainTab(available[next].name, true);
      });
    });

    listen(dom.githubLink, "click", function (event) {
      event.preventDefault();

      try {
        if (cs && typeof cs.openURLInDefaultBrowser === "function") {
          cs.openURLInDefaultBrowser(GITHUB_URL);
          return;
        }

        if (
          window.cep &&
          window.cep.util &&
          typeof window.cep.util.openURLInDefaultBrowser === "function"
        ) {
          window.cep.util.openURLInDefaultBrowser(GITHUB_URL);
          return;
        }

        var opened = window.open(GITHUB_URL, "_blank", "noopener,noreferrer");

        if (opened) opened.opener = null;
      } catch (error) {
        logError(error);
        setStatus("Could not open the project website: " + messageOf(error), true);
      }
    });

    window.addEventListener("error", function (event) {
      appendLog(
        "WINDOW ERROR: " + event.message +
        " at " + event.filename + ":" + event.lineno + ":" + event.colno
      );

      if (event.error) logError(event.error);
    });

    window.addEventListener("unhandledrejection", function (event) {
      appendLog(
        "UNHANDLED PROMISE: " +
        (event.reason && event.reason.stack
          ? event.reason.stack
          : messageOf(event.reason))
      );
    });

    window.addEventListener("beforeunload", function () {
      state.disposed = true;
      state.operationId++;

      if (state.analyzerProcess) {
        try {
          state.analyzerProcess.kill();
        } catch (_) { }
        state.analyzerProcess = null;
      }

      // Best effort only; browsers do not guarantee async work on unload.
      flushLogs().catch(function () { });
    });

    /*
     * Initial UI state.
     */

    if (dom.status) {
      dom.status.setAttribute("role", "status");
      dom.status.setAttribute("aria-live", "polite");
      dom.status.setAttribute("aria-atomic", "true");
    }

    var initialLookButton = colorLookButtons.filter(function (button) {
      return button.classList.contains("is-active");
    })[0];

    if (initialLookButton) {
      var initialLook = initialLookButton.getAttribute("data-look");

      if (
        initialLook === "skin_tone" ||
        initialLook === "wedding_cinema" ||
        initialLook === "cinematic_warm"
      ) {
        state.selectedColorLook = initialLook;
      }
    }

    var initialMode = dom.zoomMode ? dom.zoomMode.value : "smooth_in";

    if (owns(presetById, initialMode)) {
      state.activeZoomMode = initialMode;
    } else if (!owns(presetById, state.activeZoomMode) && MOVEMENT_PRESETS.length) {
      state.activeZoomMode = MOVEMENT_PRESETS[0].id;
    }

    var initialTab = tabs.filter(function (tab) {
      return tab.button && tab.button.classList.contains("is-active");
    })[0];

    activateMainTab(initialTab ? initialTab.name : "markers", false);
    syncColorLookButtons();
    setText(dom.colorIntensityLabel, colorIntensity() + "%");
    updateMarkerTimingOffsetLabel();
    updateBeatSelectionUI();

    try {
      if (autoZoomEnabled()) applyAutoRatioForMode();
      refreshZoomPreview();
    } catch (previewError) {
      logError(previewError);
    }

    syncControls();

    if (previewMode) {
      setStatus(
        "Browser preview mode. Analysis is simulated; Premiere actions " +
        "only update in-memory preview data."
      );
    } else {
      ensureHostReady().then(
        function (info) {
          appendLog(
            "Premiere host bridge ready: " +
            (info.hostVersion || "unknown version")
          );

          if (!state.isBusy && !state.disposed) {
            setStatus("Ready. Select a clip in Premiere to begin.");
          }

          // Do not automatically mutate or prune persistent state at startup.
          if (
            info.extensionVersion &&
            String(info.extensionVersion) !== String(APP_VERSION)
          ) {
            appendLog(
              "VERSION NOTICE: panel=" + APP_VERSION +
              ", host=" + info.extensionVersion
            );
          }
        },
        function (error) {
          logError(error);

          if (!state.disposed) {
            setStatus(messageOf(error), true);
          }
        }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();