/* Public CEP host boundary. Keep this file ES3-compatible: Premiere's
 * ExtendScript engine does not support modern JavaScript syntax. */
var AutoCutStudio = AutoCutStudio || {};
(function (api) {
  function quote(value) {
    return (
      '"' +
      String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n") +
      '"'
    );
  }
  function stringify(value) {
    var i;
    var parts = [];
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return quote(value);
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    if (value instanceof Array) {
      for (i = 0; i < value.length; i++) parts.push(stringify(value[i]));
      return "[" + parts.join(",") + "]";
    }
    for (var key in value) {
      if (value.hasOwnProperty(key))
        parts.push(quote(key) + ":" + stringify(value[key]));
    }
    return "{" + parts.join(",") + "}";
  }

  function response(request, data, error) {
    var result = {
      version: 1,
      id: request && request.id ? String(request.id) : "",
      ok: !error
    };
    if (error) {
      result.error = error;
    } else {
      result.data = data || {};
    }
    return stringify(result);
  }

  function stableError(message) {
    var text = String(message || "Premiere request failed");
    var lower = text.toLowerCase();
    var code = "HOST_ERROR";
    if (lower.indexOf("active sequence") >= 0) code = "NO_ACTIVE_SEQUENCE";
    else if (lower.indexOf("exactly one") >= 0) code = "AMBIGUOUS_SELECTION";
    else if (lower.indexOf("select") >= 0) code = "NO_CLIP_SELECTED";
    else if (
      lower.indexOf("selection changed") >= 0 ||
      lower.indexOf("timing changed") >= 0
    )
      code = "SELECTION_CHANGED";
    else if (
      lower.indexOf("time-remapped") >= 0 ||
      lower.indexOf("time remap") >= 0
    )
      code = "UNSUPPORTED_TIME_REMAP";
    else if (lower.indexOf("analysis status") >= 0)
      code = "ANALYSIS_STATUS_UNAVAILABLE";
    else if (lower.indexOf("effect") >= 0 && lower.indexOf("available") >= 0)
      code = "EFFECT_NOT_AVAILABLE";
    return { code: code, message: text, retryable: code === "HOST_ERROR" };
  }

  function parsePayload(payload) {
    if (payload === undefined || payload === null) return {};
    if (typeof payload === "string") return payload;
    return stringify(payload);
  }

  function call(request, fn, payload) {
    try {
      var raw = fn ? fn(parsePayload(payload)) : null;
      var legacy = raw ? JSON.parse(raw) : { ok: true };
      if (!legacy.ok) return response(request, null, stableError(legacy.error));
      delete legacy.ok;
      return response(request, legacy, null);
    } catch (error) {
      return response(
        request,
        null,
        stableError(error && error.message ? error.message : error)
      );
    }
  }

  api.invoke = function (requestJson) {
    var request;
    try {
      request =
        typeof requestJson === "string" ? JSON.parse(requestJson) : requestJson;
      if (
        !request ||
        Number(request.version) !== 1 ||
        !request.method ||
        !request.id
      ) {
        return response(request || {}, null, {
          code: "INVALID_REQUEST",
          message: "Invalid HostRequestV1",
          retryable: false
        });
      }
    } catch (error) {
      return response({}, null, {
        code: "INVALID_REQUEST",
        message: "Invalid request JSON",
        retryable: false
      });
    }

    var method = request.method;
    if (method === "system.ping")
      return call(request, api.hostInfo, request.payload);
    if (method === "clip.getSelected")
      return call(request, api.getSelectedClipInfo, request.payload);
    if (method === "markers.scan")
      return call(request, api.scanMarkers, request.payload);
    if (method === "markers.applyChunk")
      return call(request, api.applyMarkersChunk, request.payload);
    if (method === "markers.remove")
      return call(request, api.removeMarkers, request.payload);
    if (method === "markers.removeExactTimes")
      return call(request, api.removeMarkersExactTimes, request.payload);
    if (method === "motion.inspect")
      return call(request, api.getSelectedVideoClipCount, request.payload);
    if (method === "motion.apply")
      return call(request, api.applyGimbalZoom, request.payload);
    if (method === "motion.clear")
      return call(request, api.clearGimbalZoom, request.payload);
    if (method === "color.ensureEffect")
      return call(request, api.prepareAutoColorAtPlayhead, request.payload);
    if (method === "color.configure")
      return call(request, api.autoColorSelectedClips, request.payload);
    if (method === "color.reset")
      return call(request, api.resetColorGrade, request.payload);
    if (method === "warp.listSelection")
      return call(request, api.listWarpSelection, request.payload);
    if (method === "warp.apply")
      return call(
        request,
        api.applyWarpStabilizerToSelectedClip,
        request.payload
      );
    if (method === "warp.status")
      return call(request, api.isVideoEffectAnalysisDone, request.payload);
    if (method === "diagnostics.run")
      return call(request, api.runDiagnostics, request.payload);
    return response(request, null, {
      code: "METHOD_NOT_FOUND",
      message: "Unsupported host method: " + method,
      retryable: false
    });
  };
})(AutoCutStudio);
