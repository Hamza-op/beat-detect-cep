(function () {
  "use strict";

  if (window.CSInterface) {
    return;
  }

  function CSInterface() {}

  CSInterface.prototype.evalScript = function (script, callback) {
    if (window.__adobe_cep__ && typeof window.__adobe_cep__.evalScript === "function") {
      window.__adobe_cep__.evalScript(script, callback);
      return;
    }

    if (typeof callback === "function") {
      if (script.indexOf("BeatDetect.getSelectedClipInfo") === 0) {
        callback(JSON.stringify({
          ok: true,
          clip: {
            name: "Browser Preview Track",
            mediaPath: "__beat_detect_preview__",
            startSeconds: 0,
            endSeconds: 42,
            inPointSeconds: 0,
            outPointSeconds: 42
          }
        }));
        return;
      }

      if (script.indexOf("BeatDetect.applyMarkers") === 0) {
        var match = script.match(/BeatDetect\.applyMarkers\((.*)\)/);
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

      if (script.indexOf("BeatDetect.removeMarkers") === 0) {
        callback(JSON.stringify({ ok: true, removed: 12 }));
        return;
      }

      if (script.indexOf("BeatDetect.runDiagnostics") === 0) {
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
