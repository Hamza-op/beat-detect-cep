(function () {
  "use strict";

  if (window.CSInterface) {
    return;
  }

  function CSInterface() {}

  if (!window.SystemPath) {
    window.SystemPath = {
      EXTENSION: "extension"
    };
  }

  CSInterface.prototype.getSystemPath = function (path) {
    if (path !== window.SystemPath.EXTENSION) {
      return "";
    }
    var locationPath = decodeURIComponent(window.location.pathname);
    if (/^\/[A-Za-z]:\//.test(locationPath)) {
      locationPath = locationPath.slice(1);
    }
    return locationPath.replace(/[\\/][^\\/]*$/, "");
  };

  CSInterface.prototype.evalScript = function (script, callback) {
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
      window.__adobe_cep__.evalScript(script, callback);
      return;
    }

    if (typeof callback === "function") {
      if (script.indexOf("AutoCutStudio.getSelectedClipInfo") === 0) {
        callback(JSON.stringify({
          ok: true,
          clip: {
            name: "Browser Preview Track",
            mediaPath: "__autocut_studio_preview__",
            startSeconds: 0,
            endSeconds: 42,
            inPointSeconds: 0,
            outPointSeconds: 42
          }
        }));
        return;
      }

      if (script.indexOf("AutoCutStudio.applyMarkers") === 0) {
        var match = script.match(/AutoCutStudio\.applyMarkers\((.*)\)/);
        var applied = 0;
        if (match && match[1]) {
          try {
            var payload = JSON.parse(JSON.parse(match[1]));
            applied = payload.events ? payload.events.length : 0;
          } catch (_) {
            applied = 0;
          }
        }
        callback(JSON.stringify({ ok: true, applied: applied, skipped: 0 }));
        return;
      }

      if (script.indexOf("AutoCutStudio.removeMarkers") === 0) {
        callback(JSON.stringify({ ok: true, removed: 12 }));
        return;
      }

      if (script.indexOf("AutoCutStudio.getDollyFrameInfo") === 0) {
        callback(JSON.stringify({ ok: true, width: 1920, height: 1080, orientation: "landscape", sequenceName: "Browser Preview Sequence" }));
        return;
      }

      if (script.indexOf("AutoCutStudio.applyGimbalZoom") === 0) {
        callback(JSON.stringify({ ok: true, applied: 3 }));
        return;
      }

      if (script.indexOf("AutoCutStudio.clearGimbalZoom") === 0) {
        callback(JSON.stringify({ ok: true, cleared: 3, skipped: 0, errors: [] }));
        return;
      }

      if (script.indexOf("AutoCutStudio.autoColorSelectedClips") === 0 || script.indexOf("AutoCutStudio.autoColorAtPlayhead") === 0) {
        callback(JSON.stringify({
          ok: true,
          applied: 1,
          skipped: 0,
          errors: [],
          clips: [
            { name: "Preview Clip", trackIndex: 0, clipIndex: 0 }
          ],
          engine: "AutoCutStudio Native Color Engine (Playhead Frame Grade)",
          usedNativeAuto: true,
          captureFrameSeconds: 12.5,
          colorScience: "SDR Standard (Preview)"
        }));
        return;
      }

      if (script.indexOf("AutoCutStudio.resetColorGrade") === 0) {
        callback(JSON.stringify({ ok: true, reset: 1, skipped: 0, errors: [] }));
        return;
      }

      if (script.indexOf("AutoCutStudio.getSelectedVideoClipCount") === 0) {
        callback(JSON.stringify({ ok: true, count: 3 }));
        return;
      }

      if (script.indexOf("AutoCutStudio.applyWarpStabilizerToSelectedClip") === 0) {
        var warpMatch = script.match(/AutoCutStudio\.applyWarpStabilizerToSelectedClip\((.*)\)/);
        var index = 0;
        if (warpMatch && warpMatch[1]) {
          try {
            index = JSON.parse(JSON.parse(warpMatch[1])).index || 0;
          } catch (_) {
            index = 0;
          }
        }
        callback(JSON.stringify({
          ok: true,
          applied: 1,
          skipped: false,
          index: index,
          total: 3,
          name: "Preview Clip " + (index + 1)
        }));
        return;
      }

      if (script.indexOf("AutoCutStudio.isVideoEffectAnalysisDone") === 0) {
        callback(JSON.stringify({ ok: true, done: true }));
        return;
      }

      if (script.indexOf("AutoCutStudio.runDiagnostics") === 0) {
        callback(JSON.stringify({
          ok: true,
          diagnostics: [
            "Browser preview: OK",
            "Premiere bridge: simulated",
            "Selection: simulated"
          ]
        }));
        return;
      }

      callback(JSON.stringify({ ok: false, error: "Adobe CEP bridge is unavailable." }));
    }
  };

  window.CSInterface = CSInterface;
})();

