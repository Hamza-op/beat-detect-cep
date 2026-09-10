var AutoCutStudio = AutoCutStudio || {};

// ExtendScript JSON polyfill
var JSON = JSON || {};
if (!JSON.parse) {
  JSON.parse = function (text) {
    try {
      return eval("(" + text + ")");
    } catch (e) {
      throw new Error("JSON parsing failed: " + e.message);
    }
  };
}

(function () {
  var TICKS_PER_SECOND = 254016000000;
  var AUTOCUT_EXTENSION_VERSION = "1.2.0";

  function esc(value) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t");
  }

  function jsonString(value) {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    // Handle dates if any
    if (value instanceof Date) {
      return '"' + value.toISOString() + '"';
    }
    return '"' + esc(value) + '"';
  }

  function stringify(value) {
    var i;
    var parts = [];

    if (value === null || value === undefined) {
      return "null";
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return jsonString(value);
    }
    if (value instanceof Array) {
      for (i = 0; i < value.length; i++) {
        parts.push(stringify(value[i]));
      }
      return "[" + parts.join(",") + "]";
    }
    for (var key in value) {
      if (value.hasOwnProperty(key)) {
        parts.push(jsonString(key) + ":" + stringify(value[key]));
      }
    }
    return "{" + parts.join(",") + "}";
  }

  function ok(payload) {
    payload.ok = true;
    return stringify(payload);
  }

  function fail(message) {
    return stringify({ ok: false, error: message });
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("JSON parsing failed in scripting host: " + e.message);
    }
  }

  AutoCutStudio.hostInfo = function () {
    try {
      return ok({
        bridgeVersion: 1,
        extensionVersion: AUTOCUT_EXTENSION_VERSION,
        hostName: app && app.name ? String(app.name) : "Premiere Pro",
        hostVersion: app && app.version ? String(app.version) : "unknown",
        projectAvailable: Boolean(app && app.project)
      });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  function timeToSeconds(time) {
    if (!time) {
      return 0;
    }
    if (time.seconds !== undefined) {
      return Number(time.seconds);
    }
    if (time.ticks !== undefined) {
      return Number(time.ticks) / TICKS_PER_SECOND;
    }
    return Number(time) || 0;
  }

  function timeFromSeconds(seconds) {
    var safeSeconds = Math.max(0, Number(seconds) || 0);
    var time = new Time();
    var ticks = Math.round(safeSeconds * TICKS_PER_SECOND);
    time.ticks = String(ticks);
    return time;
  }

  function clipName(clip, index) {
    return (
      (clip && (clip.name || (clip.projectItem && clip.projectItem.name))) ||
      "clip " + (index + 1)
    );
  }

  function sameTrackItem(a, b) {
    if (!a || !b) {
      return false;
    }
    if (a === b) {
      return true;
    }
    return (
      a.projectItem &&
      b.projectItem &&
      (a.projectItem === b.projectItem ||
        (a.projectItem.nodeId &&
          b.projectItem.nodeId &&
          String(a.projectItem.nodeId) === String(b.projectItem.nodeId))) &&
      timeToSeconds(a.start) === timeToSeconds(b.start) &&
      timeToSeconds(a.end) === timeToSeconds(b.end)
    );
  }

  function isTrackItemSelected(clip, selectedItems) {
    if (clip && clip.isSelected) {
      try {
        var isSel =
          typeof clip.isSelected === "function"
            ? clip.isSelected()
            : clip.isSelected;
        if (isSel) {
          return true;
        }
      } catch (_) {}
    }
    if (!selectedItems) {
      return false;
    }
    for (var i = 0; i < selectedItems.length; i++) {
      if (sameTrackItem(clip, selectedItems[i])) {
        return true;
      }
    }
    return false;
  }

  function getSelectedClip() {
    var seq = app.project.activeSequence;
    if (!seq) {
      throw new Error("No active sequence is open.");
    }

    var selection = seq.getSelection ? seq.getSelection() : null;
    if (!selection || selection.length < 1) {
      var fallback = scanSelectedClip(seq);
      if (fallback) {
        return fallback;
      }
      throw new Error(
        "Select one audio or linked clip in the active sequence first."
      );
    }

    for (var i = 0; i < selection.length; i++) {
      if (selection[i] && selection[i].projectItem) {
        return selection[i];
      }
    }

    throw new Error("The current selection has no linked project media.");
  }

  function getExactlyOneSelectedClip() {
    var seq = app.project.activeSequence;
    if (!seq) {
      throw new Error("No active sequence is open.");
    }

    var selection = seq.getSelection ? seq.getSelection() : null;
    var selected = [];
    if (selection && selection.length) {
      for (var i = 0; i < selection.length; i++) {
        if (selection[i] && selection[i].projectItem) {
          selected.push(selection[i]);
        }
      }
    } else {
      var fallback = scanSelectedClip(seq);
      if (fallback) {
        selected.push(fallback);
      }
    }

    // Premiere returns linked audio and video TrackItems separately. Treat
    // matching project item + timeline range as one logical clip.
    var logical = [];
    for (var l = 0; l < selected.length; l++) {
      var candidate = selected[l];
      var found = false;
      for (var m = 0; m < logical.length; m++) {
        if (sameTrackItem(candidate, logical[m])) {
          found = true;
          break;
        }
      }
      if (!found) {
        logical.push(candidate);
      }
    }

    if (logical.length !== 1) {
      throw new Error(
        logical.length < 1
          ? "Select one audio or linked clip in the active sequence first."
          : "Select exactly one clip for beat analysis and marker apply."
      );
    }
    return logical[0];
  }

  function scanSelectedClip(seq) {
    var groups = [seq.audioTracks, seq.videoTracks];
    for (var g = 0; g < groups.length; g++) {
      var tracks = groups[g];
      if (!tracks) {
        continue;
      }
      for (var i = 0; i < tracks.numTracks; i++) {
        var track = tracks[i];
        if (!track || !track.clips) {
          continue;
        }
        for (var j = 0; j < track.clips.numItems; j++) {
          var clip = track.clips[j];
          if (clip && clip.projectItem && clip.isSelected) {
            try {
              var isSel =
                typeof clip.isSelected === "function"
                  ? clip.isSelected()
                  : clip.isSelected;
              if (isSel) {
                return clip;
              }
            } catch (_) {}
          }
        }
      }
    }
    return null;
  }

  function getAllSelectedVideoClips(seq) {
    var selected = [];
    var selection = seq && seq.getSelection ? seq.getSelection() : null;
    if (selection && selection.length) {
      for (var s = 0; s < selection.length; s++) {
        if (
          selection[s] &&
          selection[s].components &&
          selection[s].mediaType &&
          String(selection[s].mediaType).toLowerCase() === "video"
        ) {
          selected.push(selection[s]);
        }
      }
      if (selected.length) {
        return selected;
      }
    }

    var groups = [seq.videoTracks];
    for (var g = 0; g < groups.length; g++) {
      var tracks = groups[g];
      if (!tracks) continue;
      for (var i = 0; i < tracks.numTracks; i++) {
        var track = tracks[i];
        if (!track || !track.clips) continue;
        for (var j = 0; j < track.clips.numItems; j++) {
          var clip = track.clips[j];
          if (clip && clip.isSelected) {
            try {
              var isSel =
                typeof clip.isSelected === "function"
                  ? clip.isSelected()
                  : clip.isSelected;
              if (isSel) {
                selected.push(clip);
              }
            } catch (_) {}
          }
        }
      }
    }
    return selected;
  }

  function getSelectedVideoClipRefs(seq) {
    var selected = [];
    if (!seq || !seq.videoTracks) {
      return selected;
    }
    var selectedItems = seq.getSelection ? seq.getSelection() : null;

    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var track = seq.videoTracks[i];
      if (!track || !track.clips) {
        continue;
      }
      for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        if (clip && isTrackItemSelected(clip, selectedItems)) {
          selected.push({
            clip: clip,
            trackIndex: i,
            clipIndex: j,
            name: clip.name || "Selected clip",
            identity: (function () {
              try {
                return getClipInfo(clip).identity;
              } catch (_) {
                return String(i) + ":" + String(j);
              }
            })()
          });
        }
      }
    }

    return selected;
  }

  function normalizedName(value) {
    return String(value || "").toLowerCase();
  }

  function isUniformScaleProperty(prop) {
    if (!prop) return false;
    var matchName = normalizedName(prop.matchName);
    var displayName = normalizedName(prop.displayName);
    if (
      matchName === "adbe transform-0003" ||
      matchName === "adbe uniform scale" ||
      matchName === "uniform scale" ||
      matchName.indexOf("uniform") >= 0
    ) {
      return true;
    }
    if (
      displayName === "uniform scale" ||
      displayName === "uniform" ||
      (displayName.indexOf("uniform") >= 0 && displayName.indexOf("scale") >= 0) ||
      displayName.indexOf("uniform") >= 0 ||
      displayName.indexOf("einheitliche") >= 0 ||
      displayName.indexOf("uniforme") >= 0 ||
      displayName.indexOf("等比") >= 0 ||
      displayName.indexOf("固定") >= 0
    ) {
      return true;
    }
    return false;
  }

  function isScaleProperty(prop) {
    if (!prop) return false;
    if (isUniformScaleProperty(prop)) {
      return false;
    }
    var matchName = normalizedName(prop.matchName);
    var displayName = normalizedName(prop.displayName);

    if (
      matchName === "adbe transform-0004" ||
      matchName === "adbe scale" ||
      matchName === "scale" ||
      matchName === "scale height" ||
      matchName === "scale_height"
    ) {
      return true;
    }

    if (
      displayName === "scale" ||
      displayName === "scale height" ||
      displayName === "scale (height)" ||
      displayName === "height"
    ) {
      return true;
    }

    if (
      (displayName.indexOf("scale") >= 0 || matchName.indexOf("scale") >= 0) &&
      displayName.indexOf("width") < 0 &&
      matchName.indexOf("width") < 0
    ) {
      return true;
    }

    if (
      displayName.indexOf("skalierungshöhe") >= 0 ||
      (displayName.indexOf("skalierung") >= 0 && displayName.indexOf("breite") < 0) ||
      displayName.indexOf("hauteur d'échelle") >= 0 ||
      (displayName.indexOf("échelle") >= 0 && displayName.indexOf("largeur") < 0) ||
      displayName.indexOf("altura de escala") >= 0 ||
      (displayName.indexOf("escala") >= 0 && displayName.indexOf("anchura") < 0) ||
      displayName.indexOf("高度缩放") >= 0 ||
      (displayName.indexOf("缩放") >= 0 && displayName.indexOf("宽度") < 0) ||
      displayName.indexOf("高さの拡大縮小") >= 0 ||
      (displayName.indexOf("拡大縮小") >= 0 && displayName.indexOf("幅") < 0)
    ) {
      return true;
    }

    return false;
  }

  function isPositionProperty(prop) {
    if (!prop) return false;
    var matchName = normalizedName(prop.matchName);
    var displayName = normalizedName(prop.displayName);
    if (
      matchName === "adbe transform-0002" ||
      matchName === "adbe position" ||
      matchName === "position"
    ) {
      return true;
    }
    if (
      displayName === "position" ||
      matchName.indexOf("position") >= 0 ||
      displayName.indexOf("position") >= 0 ||
      displayName.indexOf("posición") >= 0 ||
      displayName.indexOf("位置") >= 0
    ) {
      return true;
    }
    return false;
  }

  function findScalePropertyOnComponent(component) {
    if (!component || !component.properties) {
      return null;
    }
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (isScaleProperty(prop)) {
        return prop;
      }
    }
    var cName = normalizedName(
      (component && component.displayName) ||
        (component && component.matchName) ||
        ""
    );
    if (cName.indexOf("transform") >= 0 && component.properties.numItems >= 4) {
      var candidateTransform = component.properties[3];
      if (
        candidateTransform &&
        !isUniformScaleProperty(candidateTransform) &&
        !isPositionProperty(candidateTransform)
      ) {
        return candidateTransform;
      }
    } else if (cName.indexOf("motion") >= 0 && component.properties.numItems >= 2) {
      var candidateMotion = component.properties[1];
      if (
        candidateMotion &&
        !isUniformScaleProperty(candidateMotion) &&
        !isPositionProperty(candidateMotion)
      ) {
        return candidateMotion;
      }
    }
    return null;
  }

  function findUniformScalePropertyOnComponent(component) {
    if (!component || !component.properties) {
      return null;
    }
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (isUniformScaleProperty(prop)) {
        return prop;
      }
    }
    var cName = normalizedName(
      (component && component.displayName) ||
        (component && component.matchName) ||
        ""
    );
    if (cName.indexOf("transform") >= 0 && component.properties.numItems >= 3) {
      var candidate = component.properties[2];
      if (candidate && isUniformScaleProperty(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  function findPositionPropertyOnComponent(component) {
    if (!component || !component.properties) {
      return null;
    }
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (isPositionProperty(prop)) {
        return prop;
      }
    }
    var cName = normalizedName(
      (component && component.displayName) ||
        (component && component.matchName) ||
        ""
    );
    if (cName.indexOf("transform") >= 0 && component.properties.numItems >= 2) {
      var candidate = component.properties[1];
      if (candidate && isPositionProperty(candidate)) {
        return candidate;
      }
    } else if (cName.indexOf("motion") >= 0 && component.properties.numItems >= 1) {
      var candidateMotion = component.properties[0];
      if (candidateMotion && isPositionProperty(candidateMotion)) {
        return candidateMotion;
      }
    }
    return null;
  }

  function isShutterAngleProperty(prop) {
    if (!prop) return false;
    var matchName = normalizedName(prop.matchName);
    var displayName = normalizedName(prop.displayName);
    if (matchName === "adbe transform-0011") return true;
    if (displayName.indexOf("shutter angle") >= 0 || (displayName.indexOf("shutter") >= 0 && displayName.indexOf("angle") >= 0)) return true;
    return false;
  }

  function isUseCompShutterProperty(prop) {
    if (!prop) return false;
    var matchName = normalizedName(prop.matchName);
    var displayName = normalizedName(prop.displayName);
    if (matchName === "adbe transform-0010") return true;
    if (displayName.indexOf("composition") >= 0 && displayName.indexOf("shutter") >= 0) return true;
    return false;
  }

  function findShutterAnglePropertyOnComponent(component) {
    if (!component || !component.properties) return null;
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (isShutterAngleProperty(prop)) return prop;
    }
    return null;
  }

  function findUseCompShutterPropertyOnComponent(component) {
    if (!component || !component.properties) return null;
    for (var p = 0; p < component.properties.numItems; p++) {
      var prop = component.properties[p];
      if (isUseCompShutterProperty(prop)) return prop;
    }
    return null;
  }

  function requireHostSuccess(result, operation) {
    if ((typeof result === "number" && result !== 0) || result === false) {
      throw new Error(operation + " failed in Premiere (code " + result + ").");
    }
  }

  function removeKeysInRange(prop, startSeconds, endSeconds) {
    if (!prop) {
      return;
    }
    var startTime = timeFromSeconds(startSeconds);
    var endTime = timeFromSeconds(endSeconds);
    var rangeError = null;

    if (prop.removeKeyRange) {
      try {
        var rangeResult = prop.removeKeyRange(startTime, endTime);
        if (
          !(
            (typeof rangeResult === "number" && rangeResult !== 0) ||
            rangeResult === false
          )
        ) {
          return;
        }
        rangeError = new Error(
          "Remove keyframe range failed in Premiere (code " +
            rangeResult +
            ")."
        );
      } catch (error) {
        rangeError = error;
      }
    }

    if (!prop.getKeys || !prop.removeKey) {
      if (rangeError) {
        throw rangeError;
      }
      return;
    }
    var keys = prop.getKeys() || [];
    for (var k = keys.length - 1; k >= 0; k--) {
      var keyTime = keys[k];
      var keySeconds = timeToSeconds(keyTime);
      if (keySeconds >= startSeconds && keySeconds <= endSeconds) {
        requireHostSuccess(prop.removeKey(keyTime), "Remove keyframe");
      }
    }
  }

  function prop_removeKey_safe(prop, keyTime) {
    if (!prop || !prop.removeKey) return;
    try {
      prop.removeKey(keyTime);
    } catch (_) {}
  }

  function setScaleKey(prop, seconds, value, interpolationType) {
    var time = timeFromSeconds(seconds);
    var addError = null;
    try {
      requireHostSuccess(prop.addKey(time), "Add Scale keyframe");
    } catch (error) {
      addError = error;
    }

    try {
      requireHostSuccess(
        prop.setValueAtKey(time, value, 1),
        "Set Scale keyframe value"
      );
    } catch (valueError) {
      if (addError) {
        throw new Error(
          "Could not add Scale keyframe: " +
            (addError.message || addError) +
            "; " +
            (valueError.message || valueError)
        );
      }
      throw valueError;
    }

    if (prop.setInterpolationTypeAtKey) {
      requireHostSuccess(
        prop.setInterpolationTypeAtKey(
          time,
          typeof interpolationType === "number" ? interpolationType : 5,
          1
        ),
        "Set Scale keyframe interpolation"
      );
    }
  }

  function clampTime(seconds, startSeconds, endSeconds) {
    return Math.max(startSeconds, Math.min(endSeconds, seconds));
  }

  function timeAt(startSeconds, duration, ratio) {
    return startSeconds + duration * Math.max(0, Math.min(1, ratio));
  }

  function importantKeyframes(keys, frameDuration) {
    var sorted = keys.slice(0).sort(function (a, b) {
      return a[0] - b[0];
    });
    var result = [];
    var minGap = Math.max(0.0005, (Number(frameDuration) || 1 / 30) * 0.5);
    for (var i = 0; i < sorted.length; i++) {
      if (
        result.length &&
        sorted[i][0] - result[result.length - 1][0] < minGap
      ) {
        result[result.length - 1] = sorted[i];
      } else {
        result.push(sorted[i]);
      }
    }
    return result;
  }

  function setScaleKeys(prop, keys, interpolationType, frameDuration) {
    var important = importantKeyframes(keys, frameDuration);
    var writtenTimes = [];
    for (var i = 0; i < important.length; i++) {
      setScaleKey(
        prop,
        important[i][0],
        important[i][1],
        interpolationType
      );
      writtenTimes.push(important[i][0]);
    }
    return writtenTimes;
  }

  function boundedZoom(value) {
    return Math.max(101.0, Math.min(150.0, Number(value) || 110.0));
  }

  function setKeyframingEnabled(prop, enabled, label) {
    if (!prop || !prop.setTimeVarying) {
      throw new Error(label + " does not expose keyframing controls.");
    }
    requireHostSuccess(
      prop.setTimeVarying(enabled),
      (enabled ? "Enable " : "Disable ") + label + " keyframing"
    );
  }

  function resetAnimatedProperty(prop, startSeconds, endSeconds, value, label) {
    if (!prop) {
      return false;
    }
    removeKeysInRange(prop, startSeconds, endSeconds);
    setKeyframingEnabled(prop, false, label);
    if (!prop.setValue) {
      throw new Error(label + " does not expose a static value control.");
    }
    requireHostSuccess(prop.setValue(value, 1), "Reset " + label);
    return true;
  }

  function getSequenceSize(seq) {
    var size = { width: 1920.0, height: 1080.0 };
    try {
      var settings = seq && seq.getSettings ? seq.getSettings() : null;
      if (settings) {
        size.width =
          Number(settings.videoFrameWidth) ||
          Number(settings.frameSizeHorizontal) ||
          size.width;
        size.height =
          Number(settings.videoFrameHeight) ||
          Number(settings.frameSizeVertical) ||
          size.height;
      }
    } catch (_) {}
    return size;
  }

  function positionPropertyUsesPixels(prop) {
    try {
      var value = prop && prop.getValue ? prop.getValue() : null;
      return (
        value &&
        value.length >= 2 &&
        (Math.abs(Number(value[0])) > 2 || Math.abs(Number(value[1])) > 2)
      );
    } catch (_) {
      return false;
    }
  }

  function positionValueForProperty(prop, normalizedPoint, sequenceSize) {
    if (!positionPropertyUsesPixels(prop)) {
      return normalizedPoint;
    }
    return [
      normalizedPoint[0] * sequenceSize.width,
      normalizedPoint[1] * sequenceSize.height
    ];
  }

  function baseZoomForStyle(style) {
    var bases = {
      smooth_in: 108.0,
      smooth_out: 108.0,
      drift: 105.0,
      breath: 106.0,
      reveal: 112.0,
      settle_in: 114.0,
      punch_in: 118.0,
      punch_out: 116.0,
      pulse: 112.0,
      snap_back: 120.0
    };
    return bases[style] || 110.0;
  }

  function isFastZoomStyle(style) {
    return (
      style === "punch_in" ||
      style === "punch_out" ||
      style === "pulse" ||
      style === "snap_back"
    );
  }

  function isSupportedZoomStyle(style) {
    var supported = {
      smooth_in: true,
      smooth_out: true,
      drift: true,
      breath: true,
      reveal: true,
      settle_in: true,
      punch_in: true,
      punch_out: true,
      pulse: true,
      snap_back: true
    };
    return supported[style] === true;
  }

  function durationZoomScale(style, duration) {
    if (!isFinite(duration) || duration <= 0) {
      return 1.0;
    }

    var fast = isFastZoomStyle(style);
    if (duration < 0.35) return fast ? 0.52 : 0.62;
    if (duration < 0.75) return fast ? 0.72 : 0.78;
    if (duration < 1.25) return fast ? 0.88 : 0.92;
    if (duration > 12.0) return fast ? 0.82 : 1.28;
    if (duration > 6.0) return fast ? 0.9 : 1.16;
    if (duration > 3.5) return fast ? 0.96 : 1.08;
    return 1.0;
  }

  function resolveZoomTarget(payloadZoom, style, duration, autoRatio) {
    if (!autoRatio) {
      return boundedZoom(payloadZoom);
    }

    var base = baseZoomForStyle(style);
    var intensity = (base - 100.0) * durationZoomScale(style, duration);
    return boundedZoom(100.0 + intensity);
  }

  function getVideoEffectByNames(names, label) {
    if (!app.enableQE) {
      throw new Error(
        "Premiere QE DOM is unavailable; cannot apply " + label + " by script."
      );
    }
    app.enableQE();
    if (
      typeof qe === "undefined" ||
      !qe.project ||
      !qe.project.getVideoEffectByName
    ) {
      throw new Error(
        "Premiere QE project API is unavailable; cannot find " + label + "."
      );
    }

    for (var i = 0; i < names.length; i++) {
      var effect = qe.project.getVideoEffectByName(names[i]);
      if (effect) {
        return effect;
      }
    }

    throw new Error(
      "Could not find " + label + " in this Premiere installation."
    );
  }

  function applyVideoEffectToClipRef(ref, effect) {
    if (!app.enableQE) {
      throw new Error("Premiere QE DOM is unavailable.");
    }
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq || !qeSeq.getVideoTrackAt) {
      throw new Error("Could not access the active sequence through QE DOM.");
    }

    var qeTrack = qeSeq.getVideoTrackAt(ref.trackIndex);
    if (!qeTrack || !qeTrack.getItemAt) {
      throw new Error("Could not access selected video track through QE DOM.");
    }

    // Time-based lookup to avoid index mismatch caused by gaps/transitions in QE DOM
    var qeClip = null;
    var targetStart = clipSequenceStartSeconds(ref.clip);
    var targetEnd = clipSequenceEndSeconds(ref.clip);
    if (qeTrack.numItems !== undefined) {
      for (var k = 0; k < qeTrack.numItems; k++) {
        var item = qeTrack.getItemAt(k);
        if (item) {
          var itemStart = timeToSeconds(item.start);
          var itemEnd = timeToSeconds(item.end);
          if (
            Math.abs(itemStart - targetStart) < 0.05 &&
            Math.abs(itemEnd - targetEnd) < 0.05
          ) {
            qeClip = item;
            break;
          }
        }
      }
    }
    if (!qeClip) {
      qeClip = qeTrack.getItemAt(ref.clipIndex); // fallback to index
    }
    if (!qeClip || !qeClip.addVideoEffect) {
      throw new Error("Could not access selected clip through QE DOM.");
    }

    qeClip.addVideoEffect(effect);
  }

  function getAutoCutTransformEffect() {
    return getVideoEffectByNames(
      [
        "Transform",
        "ADBE Transform",
        "AE.ADBE Transform",
        "Transformation",
        "Transformieren"
      ],
      "Premiere Transform"
    );
  }

  function isAutoCutTransformComponent(component) {
    var name = normalizedName((component && component.matchName) || "");
    var display = normalizedName((component && component.displayName) || "");
    return (
      name.indexOf("com.autocutstudio.transform") >= 0 ||
      display === "autocutstudio transform" ||
      name === "adbe transform" ||
      display === "transform" ||
      name.indexOf("adbe transform") >= 0 ||
      name.indexOf("transform") >= 0 ||
      display.indexOf("transform") >= 0
    );
  }

  function markAutoCutTransformOwnership(component, ref, preset) {
    try {
      var info = getClipInfo(ref.clip);
      component.__autocutstudioOwnership = {
        schemaVersion: 1,
        identity: info.identity,
        projectItemNodeId: info.projectItemNodeId,
        sequenceId: info.sequenceId,
        inPointSeconds: info.inPointSeconds,
        outPointSeconds: info.outPointSeconds,
        preset: preset || ""
      };
    } catch (_) {}
  }

  function motionLedgerPath() {
    try {
      var appData = $.getenv("APPDATA");
      if (!appData) return null;
      var directory = new Folder(appData + "/AutoCutStudio/state/v1");
      if (!directory.exists) directory.create();
      return new File(directory.fsName + "/motion-ledger.json");
    } catch (_) {
      return null;
    }
  }

  function readMotionLedger() {
    var file = motionLedgerPath();
    if (!file || !file.exists) return [];
    try {
      file.open("r");
      var text = file.read();
      file.close();
      var parsed = text ? JSON.parse(text) : [];
      return parsed instanceof Array ? parsed : [];
    } catch (_) {
      try {
        file.close();
      } catch (_) {}
      return [];
    }
  }

  function writeMotionLedger(records) {
    var file = motionLedgerPath();
    if (!file) return;
    try {
      file.open("w");
      file.write(JSON.stringify(records));
      file.close();
    } catch (_) {
      try {
        file.close();
      } catch (_) {}
    }
  }

  function persistMotionLedger(ref, component, preset, scaleKeyTimes) {
    try {
      var info = getClipInfo(ref.clip);
      var componentIndex = -1;
      for (var i = 0; i < ref.clip.components.numItems; i++) {
        if (
          ref.clip.components[i] === component ||
          hasAutoCutTransformOwnership(ref.clip.components[i], ref)
        ) {
          componentIndex = i;
          break;
        }
      }
      if (componentIndex < 0) {
        for (var fallback = ref.clip.components.numItems - 1; fallback >= 0; fallback--) {
          if (isAutoCutTransformComponent(ref.clip.components[fallback])) {
            componentIndex = fallback;
            break;
          }
        }
      }
      if (componentIndex < 0) return;
      var records = readMotionLedger();
      var record = {
        schemaVersion: 1,
        projectFingerprint: info.mediaPath + "|" + info.projectItemNodeId,
        sequenceId: info.sequenceId,
        projectItemNodeId: info.projectItemNodeId,
        originalTrackIndex: ref.trackIndex,
        originalStartSeconds: info.startSeconds,
        inPointSeconds: info.inPointSeconds,
        outPointSeconds: info.outPointSeconds,
        effectMatchName:
          normalizedName(component && component.matchName) || "adbe transform",
        componentIndex: componentIndex,
        preset: preset || "",
        generatedScaleKeys: scaleKeyTimes || [],
        generatedPositionKeys: []
      };
      var next = [];
      for (var r = 0; r < records.length; r++) {
        if (
          records[r].projectItemNodeId === record.projectItemNodeId &&
          records[r].sequenceId === record.sequenceId &&
          Math.abs(
            Number(records[r].originalStartSeconds) -
              record.originalStartSeconds
          ) < 0.002
        ) {
          continue;
        }
        next.push(records[r]);
      }
      next.push(record);
      // Cap ledger to 500 most recent records to prevent unbounded growth
      if (next.length > 500) {
        next = next.slice(next.length - 500);
      }
      writeMotionLedger(next);
    } catch (_) {}
  }

  function persistedMotionRecord(ref) {
    try {
      var info = getClipInfo(ref.clip);
      var records = readMotionLedger();
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (
          record.schemaVersion === 1 &&
          record.projectItemNodeId === info.projectItemNodeId &&
          record.sequenceId === info.sequenceId &&
          Math.abs(Number(record.originalStartSeconds) - info.startSeconds) <
            0.002 &&
          Math.abs(Number(record.inPointSeconds) - info.inPointSeconds) <
            0.002 &&
          Math.abs(Number(record.outPointSeconds) - info.outPointSeconds) <
            0.002
        ) {
          return record;
        }
      }
    } catch (_) {}
    return null;
  }

  function hasPersistedMotionLedger(ref) {
    return !!persistedMotionRecord(ref);
  }

  function deleteMotionLedgerForRef(ref) {
    try {
      var info = getClipInfo(ref.clip);
      var records = readMotionLedger();
      var next = [];
      for (var r = 0; r < records.length; r++) {
        if (
          records[r].projectItemNodeId === info.projectItemNodeId &&
          records[r].sequenceId === info.sequenceId
        ) {
          continue;
        }
        next.push(records[r]);
      }
      if (next.length !== records.length) {
        writeMotionLedger(next);
      }
    } catch (_) {}
  }

  function hasAutoCutTransformOwnership(component, ref) {
    try {
      var ownership = component && component.__autocutstudioOwnership;
      var info = getClipInfo(ref.clip);
      return (
        !!ownership &&
        ownership.schemaVersion === 1 &&
        ownership.identity === info.identity &&
        ownership.projectItemNodeId === info.projectItemNodeId &&
        ownership.sequenceId === info.sequenceId &&
        Math.abs(Number(ownership.inPointSeconds) - info.inPointSeconds) <
          0.002 &&
        Math.abs(Number(ownership.outPointSeconds) - info.outPointSeconds) <
          0.002
      );
    } catch (_) {
      return false;
    }
  }

  function findOwnedTransformComponent(ref) {
    var clip = ref && ref.clip;
    if (!clip || !clip.components) {
      return null;
    }
    // 1. Exact ownership check (in-memory, rarely survives across calls)
    for (var i = 0; i < clip.components.numItems; i++) {
      var candidate = clip.components[i];
      if (
        isAutoCutTransformComponent(candidate) &&
        hasAutoCutTransformOwnership(candidate, ref)
      ) {
        return candidate;
      }
    }
    // 2. Ledger lookup (disk-persisted, fails if clip was moved/trimmed)
    var record = persistedMotionRecord(ref);
    if (record) {
      var index = Number(record.componentIndex);
      if (
        isFinite(index) &&
        index >= 0 &&
        index < clip.components.numItems &&
        isAutoCutTransformComponent(clip.components[index])
      ) {
        return clip.components[index];
      }
    }
    // 3. Fallback: find the LAST Transform component on the clip.
    //    We are the only code that adds Transform effects; the built-in
    //    Motion effect is not matched by isAutoCutTransformComponent.
    var lastTransform = null;
    for (var f = 0; f < clip.components.numItems; f++) {
      if (isAutoCutTransformComponent(clip.components[f])) {
        lastTransform = clip.components[f];
      }
    }
    return lastTransform;
  }

  function ensureAutoCutTransformComponent(ref) {
    var clip = ref.clip;
    var before = clip && clip.components ? clip.components.numItems : 0;
    var existing = findOwnedTransformComponent(ref);
    if (existing) return existing;
    applyVideoEffectToClipRef(ref, getAutoCutTransformEffect());
    if (clip && clip.components) {
      for (var j = before; j < clip.components.numItems; j++) {
        if (isAutoCutTransformComponent(clip.components[j])) {
          return clip.components[j];
        }
      }
    }
    throw new Error(
      "Premiere Transform was added but could not be identified."
    );
  }

  function componentName(component) {
    return normalizedName(
      (component && component.displayName) ||
        (component && component.matchName) ||
        ""
    );
  }

  function isLumetriComponent(component) {
    var name = componentName(component);
    return name.indexOf("lumetri") >= 0;
  }

  function findLumetriComponent(clip) {
    if (!clip || !clip.components) {
      return null;
    }
    for (var c = 0; c < clip.components.numItems; c++) {
      var component = clip.components[c];
      if (isLumetriComponent(component)) {
        return component;
      }
    }
    return null;
  }

  function getAutoCutColorEffect() {
    return getVideoEffectByNames(
      ["AutoCutStudio Color Engine"],
      "AutoCutStudio Color Engine"
    );
  }

  function isAutoCutColorComponent(component) {
    var name = componentName(component);
    return (
      name.indexOf("autocutstudio color engine") >= 0 ||
      name.indexOf("autocutstudiocolorengine") >= 0 ||
      name.indexOf("autocut color engine") >= 0 ||
      name.indexOf("autocutcolorengine") >= 0 ||
      name.indexOf("com.autocutstudio.color.engine") >= 0
    );
  }

  function findAutoCutColorComponent(clip) {
    if (!clip || !clip.components) {
      return null;
    }
    for (var c = 0; c < clip.components.numItems; c++) {
      var component = clip.components[c];
      if (isAutoCutColorComponent(component)) {
        return component;
      }
    }
    return null;
  }

  var pendingAutoColorIdentity = "";
  var pendingAutoColorStarted = 0;

  function ensureAutoCutColorComponent(ref) {
    var component = findAutoCutColorComponent(ref.clip);
    if (component) {
      pendingAutoColorIdentity = "";
      pendingAutoColorStarted = 0;
      return component;
    }

    var identity = getClipInfo(ref.clip).identity;
    var now = new Date().getTime();
    if (
      pendingAutoColorIdentity === identity &&
      now - pendingAutoColorStarted < 5000
    ) {
      return null;
    }

    try {
      applyVideoEffectToClipRef(ref, getAutoCutColorEffect());
      pendingAutoColorIdentity = identity;
      pendingAutoColorStarted = now;
    } catch (applyError) {
      throw new Error(
        "Could not add AutoCutStudio Color Engine. Restart Premiere after installing AutoCutStudioSetup.exe as Administrator. " +
          (applyError.message || String(applyError))
      );
    }
    component = findAutoCutColorComponent(ref.clip);
    if (component) {
      pendingAutoColorIdentity = "";
      pendingAutoColorStarted = 0;
    }
    return component;
  }

  function selectedAutoColorRef() {
    var seq = app.project.activeSequence;
    if (!seq) {
      throw new Error("No active sequence is open.");
    }
    var refs = getSelectedVideoClipRefs(seq);
    if (refs.length !== 1) {
      throw new Error(
        refs.length < 1
          ? "Select one video clip in the active sequence."
          : "Select exactly one video clip for playhead-frame Auto Color."
      );
    }
    return { sequence: seq, ref: refs[0] };
  }

  AutoCutStudio.prepareAutoColorAtPlayhead = function () {
    try {
      var selected = selectedAutoColorRef();
      var playheadSeconds = sequencePlayheadSeconds(selected.sequence);
      assertPlayheadInsideClip(selected.ref, playheadSeconds);
      var existing = findAutoCutColorComponent(selected.ref.clip);
      if (!existing) {
        existing = ensureAutoCutColorComponent(selected.ref);
      }
      return ok({ ready: !!existing });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  function applyAutoCutColorValues(component, values) {
    var applied = 0;
    var missing = [];
    var map = [
      { key: "temperature", names: ["temperature"], value: values.temperature },
      { key: "tint", names: ["tint"], value: values.tint },
      { key: "exposure", names: ["exposure"], value: values.exposure },
      { key: "contrast", names: ["contrast"], value: values.contrast },
      { key: "highlights", names: ["highlights"], value: values.highlights },
      { key: "shadows", names: ["shadows"], value: values.shadows },
      { key: "whites", names: ["whites"], value: values.whites },
      { key: "blacks", names: ["blacks"], value: values.blacks },
      { key: "saturation", names: ["saturation"], value: values.saturation },
      { key: "vibrance", names: ["vibrance"], value: values.vibrance },
      {
        key: "shadows_temp",
        names: ["shadows temp", "shadows temp (lift)", "shadows_temp"],
        value: values.shadows_temp
      },
      {
        key: "shadows_tint",
        names: ["shadows tint", "shadows tint (lift)", "shadows_tint"],
        value: values.shadows_tint
      },
      {
        key: "highlights_temp",
        names: ["highlights temp", "highlights temp (gain)", "highlights_temp"],
        value: values.highlights_temp
      },
      {
        key: "highlights_tint",
        names: ["highlights tint", "highlights tint (gain)", "highlights_tint"],
        value: values.highlights_tint
      }
    ];

    for (var i = 0; i < map.length; i++) {
      if (map[i].value === undefined || map[i].value === null) {
        continue;
      }
      if (setLumetriProperty(component, map[i].names, map[i].value)) {
        applied++;
      } else {
        missing.push(map[i].key);
      }
    }

    if (applied === 0) {
      throw new Error(
        "AutoCut Color Engine properties were not exposed by this Premiere version."
      );
    }
    return missing;
  }

  function setAutoCutCaptureControls(component, token, localSeconds, autoAmount) {
    var tokenSet = setLumetriProperty(
      component,
      ["frame capture token", "capture token"],
      token
    );
    var secondsSet = setLumetriProperty(
      component,
      ["frame capture seconds", "capture seconds"],
      localSeconds
    );
    var targetAmount =
      typeof autoAmount === "number" ? autoAmount : 80.0;
    var amountSet = setLumetriProperty(
      component,
      ["auto amount"],
      targetAmount
    );
    return tokenSet && secondsSet && amountSet;
  }

  function sequencePlayheadSeconds(seq) {
    if (!seq || !seq.getPlayerPosition) {
      throw new Error("Premiere did not expose the active playhead position.");
    }
    return timeToSeconds(seq.getPlayerPosition());
  }

  function newCaptureToken() {
    var millis = new Date().getTime();
    var randomPart = Math.floor(Math.random() * 99999);
    return Math.max(1, Math.min(999999, ((millis + randomPart) % 999999) + 1));
  }

  function clipSequenceStartSeconds(clip) {
    return timeToSeconds(clip && clip.start);
  }

  function clipSequenceEndSeconds(clip) {
    return timeToSeconds(clip && clip.end);
  }

  function clipTimelineRange(clip) {
    var start = clipSequenceStartSeconds(clip);
    var end = clipSequenceEndSeconds(clip);
    var duration = end - start;
    return {
      start: start,
      end: end,
      duration: duration
    };
  }

  function assertPlayheadInsideClip(ref, playheadSeconds) {
    var start = clipSequenceStartSeconds(ref.clip);
    var end = clipSequenceEndSeconds(ref.clip);
    if (!isFinite(start) || !isFinite(end) || end <= start) {
      throw new Error(
        ref.name + ": selected clip has an invalid timeline range."
      );
    }
    if (playheadSeconds < start || playheadSeconds >= end) {
      throw new Error(
        "Move the playhead over the selected clip before running Auto Color."
      );
    }
  }

  function clipLocalSecondsAtPlayhead(ref, playheadSeconds) {
    return Math.max(0, playheadSeconds - clipSequenceStartSeconds(ref.clip));
  }

  function propertyName(prop) {
    return normalizedName(
      (prop && prop.displayName) || (prop && prop.matchName) || ""
    );
  }

  function propertyMatches(prop, needles) {
    var name = propertyName(prop);
    for (var i = 0; i < needles.length; i++) {
      if (name.indexOf(needles[i]) >= 0) {
        return true;
      }
    }
    return false;
  }

  function findPropertyRecursive(container, needles, depth) {
    if (!container || !container.properties || depth > 8) {
      return null;
    }

    for (var p = 0; p < container.properties.numItems; p++) {
      var prop = container.properties[p];
      if (propertyMatches(prop, needles) && prop.setValue) {
        return prop;
      }
      var nested = findPropertyRecursive(prop, needles, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  function setLumetriProperty(component, needles, value) {
    var prop = findPropertyRecursive(component, needles, 0);
    if (!prop) {
      return false;
    }
    prop.setValue(Number(value), 1);
    return true;
  }

  function getMediaPath(projectItem) {
    if (!projectItem) {
      return "";
    }
    if (projectItem.getMediaPath) {
      return projectItem.getMediaPath();
    }
    return "";
  }

  function getClipInfo(clip) {
    var mediaPath = getMediaPath(clip.projectItem);
    if (!mediaPath) {
      throw new Error("Could not read the selected clip's media path.");
    }

    var sourceDuration = Math.max(
      0,
      timeToSeconds(clip.outPoint) - timeToSeconds(clip.inPoint)
    );
    var timelineDuration = Math.max(
      0,
      timeToSeconds(clip.end) - timeToSeconds(clip.start)
    );
    var projectNodeId = "";
    try {
      projectNodeId = String(
        clip.projectItem.nodeId ||
          clip.projectItem.treePath ||
          clip.projectItem.name ||
          ""
      );
    } catch (_) {}
    var playbackRate =
      sourceDuration > 0 ? timelineDuration / sourceDuration : 1;
    var reversed = false;
    try {
      reversed = Boolean(
        clip.projectItem &&
          clip.projectItem.getFootageInterpretation &&
          clip.projectItem.getFootageInterpretation().reverse
      );
    } catch (_) {}
    var identity = [
      projectNodeId,
      timeToSeconds(clip.start).toFixed(6),
      timeToSeconds(clip.end).toFixed(6),
      timeToSeconds(clip.inPoint).toFixed(6),
      timeToSeconds(clip.outPoint).toFixed(6)
    ].join("|");
    return {
      identity: identity,
      name: clip.name || clip.projectItem.name || "Selected clip",
      mediaPath: mediaPath,
      projectItemNodeId: projectNodeId,
      sequenceId: String(
        (app.project.activeSequence &&
          (app.project.activeSequence.sequenceID ||
            app.project.activeSequence.name)) ||
          ""
      ),
      startSeconds: timeToSeconds(clip.start),
      endSeconds: timeToSeconds(clip.end),
      inPointSeconds: timeToSeconds(clip.inPoint),
      outPointSeconds: timeToSeconds(clip.outPoint),
      sourceDurationSeconds: sourceDuration,
      timelineDurationSeconds: timelineDuration,
      durationSeconds: sourceDuration,
      playbackRate: playbackRate,
      reversed: reversed,
      variableTimeRemap: Boolean(clip.timeRemappingEnabled)
    };
  }

  function sameNumber(a, b, tolerance) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= tolerance;
  }

  function verifyClipInfo(payload, info) {
    if (!payload || !info) {
      return;
    }
    if (payload.mediaPath && payload.mediaPath !== info.mediaPath) {
      throw new Error(
        "Selection changed after analysis. Re-select the analyzed clip or run analysis again."
      );
    }
    if (payload.identity && payload.identity !== info.identity) {
      throw new Error(
        "Selection changed after analysis. Re-select the analyzed clip or run analysis again."
      );
    }

    var tolerance = 0.002;
    var checks = [
      ["startSeconds", info.startSeconds],
      ["endSeconds", info.endSeconds],
      ["inPointSeconds", info.inPointSeconds],
      ["outPointSeconds", info.outPointSeconds]
    ];

    for (var i = 0; i < checks.length; i++) {
      var key = checks[i][0];
      if (
        payload[key] !== undefined &&
        !sameNumber(payload[key], checks[i][1], tolerance)
      ) {
        throw new Error(
          "Selected clip timing changed after analysis. Re-select the analyzed clip or run analysis again."
        );
      }
    }
  }

  var AUTOCUT_BEAT_MARKER_SIGNATURE = "AutoCutStudio Beat Marker v1";

  function setMarkerFields(marker, colorIndex) {
    if (!marker) {
      return;
    }
    marker.name = "";
    marker.comments = AUTOCUT_BEAT_MARKER_SIGNATURE;
    if (
      marker.setColorByIndex &&
      colorIndex !== null &&
      colorIndex !== undefined
    ) {
      marker.setColorByIndex(colorIndex, 0);
    }
  }

  function createClipMarker(clip, seconds) {
    var collection = clipMarkerCollection(clip);
    if (collection && collection.createMarker) {
      return collection.createMarker(seconds);
    }
    throw new Error(
      "This selected clip does not support clip marker creation. Try using Sequence Timeline Markers instead."
    );
  }

  function beatMarkerColor() {
    return 3;
  }

  function isAutoCutStudioMarker(marker) {
    if (!marker) {
      return false;
    }
    var comments = marker.comments || "";
    return comments === AUTOCUT_BEAT_MARKER_SIGNATURE;
  }

  function markerTimeSeconds(marker) {
    if (!marker) {
      return 0;
    }
    if (marker.start) {
      return timeToSeconds(marker.start);
    }
    if (marker.end) {
      return timeToSeconds(marker.end);
    }
    return 0;
  }

  function collectMarkers(markerCollection, startSeconds, endSeconds) {
    var found = [];
    if (!markerCollection || !markerCollection.getFirstMarker) {
      return found;
    }

    var marker = markerCollection.getFirstMarker();
    while (marker) {
      var seconds = markerTimeSeconds(marker);
      if (
        isAutoCutStudioMarker(marker) &&
        seconds >= startSeconds &&
        seconds < endSeconds
      ) {
        found.push(marker);
      }
      if (!markerCollection.getNextMarker) {
        break;
      }
      marker = markerCollection.getNextMarker(marker);
    }
    return found;
  }

  function deleteMarker(markerCollection, marker) {
    if (!markerCollection || !marker) {
      return false;
    }
    if (markerCollection.deleteMarker) {
      markerCollection.deleteMarker(marker);
      return true;
    }
    if (marker.remove) {
      marker.remove();
      return true;
    }
    return false;
  }

  function clipMarkerCollection(clip) {
    // Try clip-level markers first (timeline clip markers in newer Premiere versions)
    if (clip && clip.markers) {
      return clip.markers;
    }
    // Then try projectItem.getMarkers() - source/bin markers
    if (clip && clip.projectItem && clip.projectItem.getMarkers) {
      try {
        var m = clip.projectItem.getMarkers();
        if (m) return m;
      } catch (_) {}
    }
    // Then try projectItem.markers
    if (clip && clip.projectItem && clip.projectItem.markers) {
      return clip.projectItem.markers;
    }
    return null;
  }

  function activeFrameDuration(seq) {
    var fallback = 1 / 30;
    try {
      var settings = seq && seq.getSettings ? seq.getSettings() : null;
      if (
        settings &&
        settings.videoFrameRate &&
        settings.videoFrameRate.seconds
      ) {
        return Number(settings.videoFrameRate.seconds) || fallback;
      }
    } catch (_) {}
    return fallback;
  }

  function snapToFrame(seconds, seq) {
    var frame = activeFrameDuration(seq);
    if (!isFinite(frame) || frame <= 0) {
      return seconds;
    }
    return Math.round(seconds / frame) * frame;
  }

  function isClipSourceTimeInRange(seconds, info) {
    var tolerance = 0.0005;
    return (
      isFinite(seconds) &&
      seconds >= info.inPointSeconds - tolerance &&
      seconds < info.outPointSeconds + tolerance
    );
  }

  function clipSourceTimeToSequenceTime(seconds, info) {
    if (info.reversed) {
      return (
        info.endSeconds - (seconds - info.inPointSeconds) * info.playbackRate
      );
    }
    return (
      info.startSeconds + (seconds - info.inPointSeconds) * info.playbackRate
    );
  }

  function isSequenceTimeInClipRange(seconds, info) {
    var tolerance = 0.0005;
    return (
      isFinite(seconds) &&
      seconds >= info.startSeconds - tolerance &&
      seconds < info.endSeconds + tolerance
    );
  }

  function snapToLastValidFrame(seconds, seq, startSeconds, endSeconds) {
    var frame = activeFrameDuration(seq);
    if (!isFinite(frame) || frame <= 0) {
      return Math.max(startSeconds, Math.min(endSeconds - 0.000001, seconds));
    }
    var lastValid = Math.max(startSeconds, endSeconds - frame);
    return Math.max(
      startSeconds,
      Math.min(lastValid, snapToFrame(seconds, seq))
    );
  }

  AutoCutStudio.getSelectedClipInfo = function () {
    try {
      return ok({ clip: getClipInfo(getExactlyOneSelectedClip()) });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.applyMarkersChunk = function (payloadJson) {
    try {
      var payload = parseJson(payloadJson);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var events = payload.events || [];
      var seq = app.project.activeSequence;
      var clip = getExactlyOneSelectedClip();
      var info = getClipInfo(clip);
      var applied = 0;
      var skipped = 0;
      var createdTimes = [];

      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      verifyClipInfo(payload, info);
      if (target === "sequence" && info.variableTimeRemap) {
        throw new Error(
          "Sequence markers cannot be mapped safely on a variable time-remapped clip."
        );
      }

      for (var i = 0; i < events.length; i++) {
        var eventTime = Number(events[i].time);
        if (!isClipSourceTimeInRange(eventTime, info)) {
          skipped++;
          continue;
        }

        var color = beatMarkerColor();

        if (target === "clip") {
          var clipTime = snapToLastValidFrame(
            eventTime,
            seq,
            info.inPointSeconds,
            info.outPointSeconds
          );
          setMarkerFields(createClipMarker(clip, clipTime), color);
          createdTimes.push(clipTime);
        } else {
          var sequenceTime = clipSourceTimeToSequenceTime(eventTime, info);
          sequenceTime = snapToLastValidFrame(
            sequenceTime,
            seq,
            info.startSeconds,
            info.endSeconds
          );
          if (!isSequenceTimeInClipRange(sequenceTime, info)) {
            skipped++;
            continue;
          }
          setMarkerFields(seq.markers.createMarker(sequenceTime), color);
          createdTimes.push(sequenceTime);
        }
        applied++;
      }

      return ok({
        applied: applied,
        skipped: skipped,
        createdTimes: createdTimes
      });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.removeMarkers = function (payloadJson) {
    try {
      var payload = parseJson(payloadJson);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var seq = app.project.activeSequence;
      var clip = getExactlyOneSelectedClip();
      var info = getClipInfo(clip);
      var collection;
      var startSeconds;
      var endSeconds;

      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      verifyClipInfo(payload, info);

      if (target === "clip") {
        collection = clipMarkerCollection(clip);
        startSeconds = info.inPointSeconds;
        endSeconds = info.outPointSeconds;
        if (!collection) {
          throw new Error(
            "This selected clip does not expose a clip marker collection."
          );
        }
      } else {
        collection = seq.markers;
        startSeconds = info.startSeconds;
        endSeconds = info.endSeconds;
      }

      var markers = collectMarkers(collection, startSeconds, endSeconds);
      var removed = 0;
      for (var i = 0; i < markers.length; i++) {
        if (deleteMarker(collection, markers[i])) {
          removed++;
        }
      }

      return ok({ removed: removed });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.applyGimbalZoom = function (payloadJson) {
    try {
      var payload = payloadJson
        ? parseJson(payloadJson)
        : { zoom: 110.0, style: "smooth_in" };
      var payloadZoom = boundedZoom(payload.zoom);
      var zoomStyle = payload.style || "smooth_in";
      var autoRatio = payload.autoRatio !== false;
      if (!isSupportedZoomStyle(zoomStyle)) {
        throw new Error("Unsupported Scale movement: " + zoomStyle);
      }

      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var clips = getSelectedVideoClipRefs(seq);
      if (clips.length === 0) {
        throw new Error(
          "Select at least one video clip in the active sequence."
        );
      }

      var appliedCount = 0;
      var skipped = 0;
      var errors = [];
      for (var i = 0; i < clips.length; i++) {
        var ref = clips[i];
        var clip = ref.clip;
        var name = ref.name || clipName(clip, i);

        try {
          var transform = ensureAutoCutTransformComponent(ref);
          var uniformScaleProp = findUniformScalePropertyOnComponent(transform);
          if (uniformScaleProp && uniformScaleProp.setValue) {
            try {
              uniformScaleProp.setValue(1, 1);
            } catch (_) {
              try {
                uniformScaleProp.setValue(true, 1);
              } catch (_) {}
            }
          }
          var useCompShutterProp = findUseCompShutterPropertyOnComponent(transform);
          if (useCompShutterProp && useCompShutterProp.setValue) {
            try {
              useCompShutterProp.setValue(0, 1);
            } catch (_) {
              try {
                useCompShutterProp.setValue(false, 1);
              } catch (_) {}
            }
          }
          var shutterAngleProp = findShutterAnglePropertyOnComponent(transform);
          if (shutterAngleProp && shutterAngleProp.setValue) {
            try {
              shutterAngleProp.setValue(180, 1);
            } catch (_) {}
          }
          var prop = findScalePropertyOnComponent(transform);
          if (!prop) {
            skipped++;
            errors.push(name + ": Premiere Transform > Scale not found");
            continue;
          }
          if (prop.areKeyframesSupported && !prop.areKeyframesSupported()) {
            skipped++;
            errors.push(name + ": Scale does not support keyframes");
            continue;
          }

          setKeyframingEnabled(prop, true, "Scale");

          var range = clipTimelineRange(clip);
          var inTime = range.start;
          var rawOutTime = range.end;
          var duration = range.duration;
          if (!isFinite(duration) || duration <= 0.001) {
            skipped++;
            errors.push(name + ": clip duration is too short");
            continue;
          }
          var zoomTarget = resolveZoomTarget(
            payloadZoom,
            zoomStyle,
            duration,
            autoRatio
          );

          var frameDuration = 1 / 30;
          try {
            var settings = seq.getSettings ? seq.getSettings() : null;
            if (
              settings &&
              settings.videoFrameRate &&
              settings.videoFrameRate.seconds
            ) {
              frameDuration =
                Number(settings.videoFrameRate.seconds) || frameDuration;
            }
          } catch (_) {}

          var safeEndTime = rawOutTime;
          var softTarget = 100.0 + (zoomTarget - 100.0) * 0.45;
          var driftTarget = 100.0 + (zoomTarget - 100.0) * 0.3;
          var breathTarget = 100.0 + (zoomTarget - 100.0) * 0.22;
          var overshootTarget = boundedZoom(
            100.0 + (zoomTarget - 100.0) * 1.18
          );
          removeKeysInRange(prop, inTime, rawOutTime);

          var writtenKeyTimes;
          if (zoomStyle === "smooth_out") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, zoomTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "punch_in") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, duration, 0.08), zoomTarget],
              [timeAt(inTime, duration, 0.28), softTarget],
              [safeEndTime, softTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "punch_out") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, zoomTarget],
              [timeAt(inTime, duration, 0.10), 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "pulse") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, duration, 0.18), zoomTarget],
              [timeAt(inTime, duration, 0.38), 100.0],
              [timeAt(inTime, duration, 0.62), softTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "snap_back") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, duration, 0.10), zoomTarget],
              [timeAt(inTime, duration, 0.30), 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "breath") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, duration, 0.5), breathTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "reveal") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, zoomTarget],
              [timeAt(inTime, duration, 0.62), zoomTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "settle_in") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, duration, 0.22), overshootTarget],
              [timeAt(inTime, duration, 0.55), softTarget],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "drift") {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [safeEndTime, driftTarget]
            ], undefined, frameDuration);
          } else {
            writtenKeyTimes = setScaleKeys(prop, [
              [inTime, 100.0],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          }

          // Verify at least 2 keyframes were actually written
          if (writtenKeyTimes && writtenKeyTimes.length >= 2) {
            var verifyKeys = prop.getKeys ? prop.getKeys() : null;
            if (verifyKeys && verifyKeys.length < 2) {
              errors.push(
                name +
                  ": Warning — only " +
                  verifyKeys.length +
                  " keyframe(s) detected after write"
              );
            }
          }

          markAutoCutTransformOwnership(transform, ref, zoomStyle);
          persistMotionLedger(ref, transform, zoomStyle, writtenKeyTimes);
          appliedCount++;
        } catch (err) {
          skipped++;
          errors.push(name + ": " + (err.message || String(err)));
        }
      }

      if (appliedCount === 0) {
        throw new Error(
          errors.length
            ? errors.join(" | ")
            : "Could not apply Motion Scale keyframes to selected clips."
        );
      }

      return ok({ applied: appliedCount, skipped: skipped, errors: errors });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.clearGimbalZoom = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var clips = getSelectedVideoClipRefs(seq);
      if (clips.length === 0) {
        throw new Error(
          "Select at least one video clip in the active sequence."
        );
      }

      var cleared = 0;
      var skipped = 0;
      var errors = [];

      for (var i = 0; i < clips.length; i++) {
        var ref = clips[i];
        var clip = ref.clip;
        var name = ref.name || clipName(clip, i);
        try {
          var transform = findOwnedTransformComponent(ref);
          if (!transform) {
            skipped++;
            errors.push(
              name +
                ": owned Premiere Transform not found; built-in Motion was preserved"
            );
            continue;
          }
          if (
            !hasAutoCutTransformOwnership(transform, ref) &&
            !hasPersistedMotionLedger(ref)
          ) {
            skipped++;
            errors.push(
              name +
                ": Transform ownership could not be verified; no keys were cleared"
            );
            continue;
          }
          var scale = findScalePropertyOnComponent(transform);
          var position = findPositionPropertyOnComponent(transform);
          var range = clipTimelineRange(clip);
          var record = persistedMotionRecord(ref);
          var surgicalScale =
            record &&
            record.generatedScaleKeys &&
            record.generatedScaleKeys.length > 0;
          if (scale) {
            if (surgicalScale) {
              // Surgically remove only the keyframes we wrote
              for (var sk = 0; sk < record.generatedScaleKeys.length; sk++) {
                var keySeconds = Number(record.generatedScaleKeys[sk]);
                if (isFinite(keySeconds)) {
                  try {
                    var keyTime = timeFromSeconds(keySeconds);
                    prop_removeKey_safe(scale, keyTime);
                  } catch (_) {}
                }
              }
              setKeyframingEnabled(scale, false, "Scale");
              if (scale.setValue) {
                try { scale.setValue(100.0, 1); } catch (_) {}
              }
            } else {
              resetAnimatedProperty(
                scale,
                range.start,
                range.end,
                100.0,
                "Scale"
              );
            }
          }
          if (position) {
            var neutralPosition = positionValueForProperty(
              position,
              [0.5, 0.5],
              getSequenceSize(seq)
            );
            resetAnimatedProperty(
              position,
              range.start,
              range.end,
              neutralPosition,
              "Position"
            );
          }
          if (scale || position) {
            // Fully remove the Transform effect from the clip
            removeEffectViaQE(ref, [
              "Transform",
              "ADBE Transform",
              "Transformieren",
              "Transformation"
            ]);
            deleteMotionLedgerForRef(ref);
            cleared++;
          } else {
            skipped++;
            errors.push(name + ": Transform keyframes not found");
          }
        } catch (error) {
          skipped++;
          errors.push(name + ": " + (error.message || String(error)));
        }
      }

      if (cleared === 0) {
        throw new Error(
          errors.length ? errors.join(" | ") : "No zoom keyframes were cleared."
        );
      }

      return ok({ cleared: cleared, skipped: skipped, errors: errors });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.cleanMotionLedger = function () {
    try {
      var records = readMotionLedger();
      if (!records.length) {
        return ok({ removed: 0, remaining: 0 });
      }

      // Collect valid sequence IDs from the current project
      var validSequenceIds = {};
      try {
        if (app.project && app.project.sequences) {
          for (var s = 0; s < app.project.sequences.numSequences; s++) {
            var seq = app.project.sequences[s];
            if (seq && seq.sequenceID) {
              validSequenceIds[String(seq.sequenceID)] = true;
            }
          }
        }
      } catch (_) {}

      var hasSequenceCheck = false;
      for (var key in validSequenceIds) {
        if (validSequenceIds.hasOwnProperty(key)) {
          hasSequenceCheck = true;
          break;
        }
      }

      var next = [];
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        // Remove entries whose sequence no longer exists
        if (
          hasSequenceCheck &&
          rec.sequenceId &&
          !validSequenceIds[String(rec.sequenceId)]
        ) {
          continue;
        }
        next.push(rec);
      }

      // Cap to 500 most recent records
      if (next.length > 500) {
        next = next.slice(next.length - 500);
      }

      var removed = records.length - next.length;
      writeMotionLedger(next);
      return ok({ removed: removed, remaining: next.length });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  function defaultAutoCutColorValues() {
    return {
      temperature: 0,
      tint: 0,
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 100,
      vibrance: 0,
      shadows_temp: 0,
      shadows_tint: 0,
      highlights_temp: 0,
      highlights_tint: 0
    };
  }

  function getClipColorScience(clip) {
    var colorSpaceName = "Rec. 709 (Default)";
    var detectedColorScience = "SDR Standard";

    try {
      var projectItem = clip && clip.projectItem;
      if (projectItem && projectItem.getColorSpace) {
        var cs = projectItem.getColorSpace();
        if (cs) {
          colorSpaceName = cs.name || "Unknown";
          var lowerName = colorSpaceName.toLowerCase();
          var transfer = String(cs.transferCharacteristic || "").toLowerCase();
          if (lowerName.indexOf("log") >= 0 || transfer.indexOf("log") >= 0) {
            detectedColorScience = "Camera Log Curve (" + colorSpaceName + ")";
          } else if (
            lowerName.indexOf("hlg") >= 0 ||
            lowerName.indexOf("hdr") >= 0 ||
            transfer.indexOf("hlg") >= 0 ||
            transfer.indexOf("pq") >= 0
          ) {
            detectedColorScience =
              "High Dynamic Range (" + colorSpaceName + ")";
          } else {
            detectedColorScience = "SDR Standard (" + colorSpaceName + ")";
          }
        }
      }
    } catch (_) {}

    return {
      colorSpace: colorSpaceName,
      colorScience: detectedColorScience
    };
  }

  function getLookModifiers(look, intensity) {
    intensity = Math.max(0.2, Math.min(2.0, Number(intensity) || 1.0));
    var defaults = defaultAutoCutColorValues();
    if (look === "wedding_cinema" || look === "cinematic_warm") {
      // Cinematic Wedding Preset: rich warm film glow, creamy skin, gentle shadow lift
      defaults.temperature = Math.round(14 * intensity);
      defaults.tint = Math.round(3 * intensity);
      defaults.contrast = Math.round(12 * intensity);
      defaults.highlights = Math.round(-6 * intensity);
      defaults.shadows = Math.round(8 * intensity);
      defaults.whites = Math.round(5 * intensity);
      defaults.blacks = Math.round(-4 * intensity);
      defaults.saturation = Math.round(100 + 10 * intensity);
      defaults.vibrance = Math.round(15 * intensity);
      defaults.highlights_temp = Math.round(12 * intensity);
      defaults.shadows_temp = Math.round(-4 * intensity);
      defaults.shadows_tint = Math.round(-6 * intensity);
    } else {
      // Skin Tone & Balance (default): natural skin balance, clean highlights, true color tone
      defaults.contrast = Math.round(8 * intensity);
      defaults.highlights = Math.round(-4 * intensity);
      defaults.shadows = Math.round(4 * intensity);
      defaults.whites = Math.round(2 * intensity);
      defaults.blacks = Math.round(-2 * intensity);
      defaults.vibrance = Math.round(10 * intensity);
      defaults.saturation = Math.round(100 + 4 * intensity);
      defaults.highlights_temp = Math.round(2 * intensity);
      defaults.shadows_tint = Math.round(-2 * intensity);
    }
    return defaults;
  }

  function applyNativeAutoColor(ref, captureFrameSeconds, captureToken, options) {
    var component = ensureAutoCutColorComponent(ref);

    if (!component) {
      throw new Error(
        "AutoCutStudio Color Engine is not installed or not exposed to Premiere."
      );
    }

    try {
      component.enabled = true;
    } catch (_) {}

    var captureLocalSeconds = clipLocalSecondsAtPlayhead(
      ref,
      captureFrameSeconds
    );
    var missing = [];
    var warnings = [];

    if (
      !setAutoCutCaptureControls(component, captureToken, captureLocalSeconds)
    ) {
      throw new Error(
        "Native capture controls were not exposed; cannot lock Auto Color to the playhead frame."
      );
    }

    if (options && options.look) {
      try {
        var mods = getLookModifiers(options.look, options.intensity);
        applyAutoCutColorValues(component, mods);
      } catch (modErr) {
        warnings.push("Look preset: " + (modErr.message || String(modErr)));
      }
    }

    var colorInfo = getClipColorScience(ref.clip);

    return {
      name: ref.name,
      trackIndex: ref.trackIndex,
      clipIndex: ref.clipIndex,
      engine: "AutoCutStudio Native Color Engine (Playhead Frame Grade)",
      usedNativeAuto: true,
      missing: missing,
      warnings: warnings,
      autoAmount: 80,
      look: (options && options.look) || "skin_tone",
      captureFrameSeconds: captureFrameSeconds,
      captureLocalSeconds: captureLocalSeconds,
      colorSpace: colorInfo.colorSpace,
      colorScience: colorInfo.colorScience
    };
  }

  AutoCutStudio.autoColorSelectedClips = function (payloadJson) {
    try {
      var options = {};
      if (payloadJson) {
        try {
          options = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
        } catch (_) {}
      }

      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var refs = getSelectedVideoClipRefs(seq);
      if (refs.length !== 1) {
        throw new Error(
          refs.length < 1
            ? "Select one video clip in the active sequence."
            : "Select exactly one video clip for playhead-frame Auto Color."
        );
      }

      var playheadSeconds = sequencePlayheadSeconds(seq);
      assertPlayheadInsideClip(refs[0], playheadSeconds);
      var captureToken = newCaptureToken();
      var applied = 0;
      var skipped = 0;
      var errors = [];
      var warnings = [];
      var clips = [];

      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i];
        try {
          var clipResult = applyNativeAutoColor(
            ref,
            playheadSeconds,
            captureToken,
            options
          );
          clips.push(clipResult);
          if (clipResult.warnings && clipResult.warnings.length) {
            warnings.push(ref.name + ": " + clipResult.warnings.join("; "));
          }
          applied++;
        } catch (error) {
          skipped++;
          errors.push(ref.name + ": " + (error.message || String(error)));
        }
      }

      if (applied === 0) {
        throw new Error(
          errors.length
            ? errors.join(" | ")
            : "Could not load the AutoCutStudio Color Engine plugin. Run AutoCutStudioSetup.exe as Administrator to install native C++ assets."
        );
      }

      return ok({
        applied: applied,
        skipped: skipped,
        errors: errors.concat(warnings),
        clips: clips,
        engine: clips[0].engine,
        usedNativeAuto: true,
        autoAmount: clips[0].autoAmount,
        look: clips[0].look,
        name: applied === 1 ? clips[0].name : applied + " selected clips",
        captureFrameSeconds: playheadSeconds,
        colorScience:
          applied === 1 ? clips[0].colorScience : "mixed selected clips"
      });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  function removeEffectViaQE(ref, effectNames) {
    // Try to remove effects via QE DOM (works when ExtendScript can't see the component)
    try {
      if (!app.enableQE) return false;
      app.enableQE();
      var qeSeq = qe.project.getActiveSequence();
      if (!qeSeq) return false;
      var qeTrack = qeSeq.getVideoTrackAt(ref.trackIndex);
      if (!qeTrack) return false;

      // Time-based lookup to avoid index mismatch caused by gaps/transitions in QE DOM
      var qeClip = null;
      var targetStart = clipSequenceStartSeconds(ref.clip);
      var targetEnd = clipSequenceEndSeconds(ref.clip);
      if (qeTrack.numItems !== undefined) {
        for (var k = 0; k < qeTrack.numItems; k++) {
          var item = qeTrack.getItemAt(k);
          if (item) {
            var itemStart = timeToSeconds(item.start);
            var itemEnd = timeToSeconds(item.end);
            if (
              Math.abs(itemStart - targetStart) < 0.05 &&
              Math.abs(itemEnd - targetEnd) < 0.05
            ) {
              qeClip = item;
              break;
            }
          }
        }
      }
      if (!qeClip) {
        qeClip = qeTrack.getItemAt(ref.clipIndex); // fallback to index
      }
      if (!qeClip) return false;

      // Try to remove effects by iterating QE clip's effects
      if (qeClip.numComponents) {
        var numComp = typeof qeClip.numComponents === "function" ? qeClip.numComponents() : qeClip.numComponents;
        var removed = false;
        for (var c = numComp - 1; c >= 0; c--) {
          try {
            var comp = qeClip.getComponentAt(c);
            if (comp) {
              var compName = (comp.name || comp.displayName || comp.matchName || "").toLowerCase();
              for (var n = 0; n < effectNames.length; n++) {
                if (compName.indexOf(effectNames[n].toLowerCase()) >= 0) {
                  qeClip.removeComponentAt(c);
                  removed = true;
                  break;
                }
              }
            }
          } catch (_) {}
        }
        return removed;
      }
    } catch (_) {}
    return false;
  }

  AutoCutStudio.resetColorGrade = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var refs = getSelectedVideoClipRefs(seq);
      if (refs.length === 0) {
        throw new Error(
          "Select at least one video clip in the active sequence."
        );
      }

      var defaults = defaultAutoCutColorValues();
      var reset = 0;
      var skipped = 0;
      var errors = [];
      var effectTargetNames = [
        "AutoCutStudio Color Engine",
        "com.autocutstudio.color.engine",
        "AutoCut Color Engine",
        "AutoCutStudioColorEngine",
        "AutoCutColorEngine",
        "Color Engine"
      ];

      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i];
        try {
          var appliedToThisClip = false;

          // 1. Try full QE removal first (completely removes from Effect Controls)
          var qeRemoved = removeEffectViaQE(ref, effectTargetNames);
          if (qeRemoved) {
            appliedToThisClip = true;
          }

          // 2. Also find via ExtendScript and thoroughly zero out all properties & disable
          var autocutComponent = findAutoCutColorComponent(ref.clip);
          if (autocutComponent) {
            try {
              autocutComponent.enabled = false;
            } catch (_) {}
            try {
              setAutoCutCaptureControls(autocutComponent, 0, 0, 0.0);
              setLumetriProperty(
                autocutComponent,
                ["analysis confidence", "confidence"],
                0.0
              );
              setLumetriProperty(
                autocutComponent,
                ["auto trigger"],
                0.0
              );
              setLumetriProperty(
                autocutComponent,
                ["auto amount"],
                0.0
              );
              applyAutoCutColorValues(autocutComponent, defaults);
            } catch (_) {}

            // Zero out any remaining properties on the component
            try {
              if (autocutComponent.properties) {
                for (var p = 0; p < autocutComponent.properties.numItems; p++) {
                  var prop = autocutComponent.properties[p];
                  if (prop && prop.setValue) {
                    var pName = (prop.displayName || prop.matchName || "").toLowerCase();
                    if (pName.indexOf("saturation") >= 0) {
                      try { prop.setValue(100.0, 1); } catch (_) {}
                    } else if (pName.indexOf("confidence") >= 0 || pName.indexOf("amount") >= 0 || pName.indexOf("token") >= 0 || pName.indexOf("second") >= 0 || pName.indexOf("trigger") >= 0) {
                      try { prop.setValue(0.0, 1); } catch (_) {}
                    } else {
                      try { prop.setValue(0.0, 1); } catch (_) {}
                    }
                  }
                }
              }
            } catch (_) {}

            // Try QE removal again if it wasn't removed yet
            if (!qeRemoved) {
              qeRemoved = removeEffectViaQE(ref, effectTargetNames);
            }
            appliedToThisClip = true;
          }

          if (appliedToThisClip) {
            reset++;
          } else {
            skipped++;
            errors.push(ref.name + ": No color engine effects found to reset");
          }
        } catch (error) {
          skipped++;
          errors.push(ref.name + ": " + (error.message || String(error)));
        }
      }

      if (reset === 0) {
        throw new Error(
          errors.length ? errors.join(" | ") : "No color controls were reset."
        );
      }

      return ok({ reset: reset, skipped: skipped, errors: errors });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.getSelectedVideoClipCount = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      return ok({ count: getSelectedVideoClipRefs(seq).length });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.scanMarkers = function (payloadJson) {
    try {
      var payload = payloadJson ? parseJson(payloadJson) : {};
      var seq = app.project.activeSequence;
      if (!seq) throw new Error("No active sequence is open.");
      var clip = getExactlyOneSelectedClip();
      var info = getClipInfo(clip);
      verifyClipInfo(payload, info);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var collection =
        target === "clip" ? clipMarkerCollection(clip) : seq.markers;
      var start = target === "clip" ? info.inPointSeconds : info.startSeconds;
      var end = target === "clip" ? info.outPointSeconds : info.endSeconds;
      var markers = collectMarkers(collection, start, end);
      var times = [];
      for (var i = 0; i < markers.length; i++)
        times.push(markerTimeSeconds(markers[i]));
      return ok({ count: times.length, times: times });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.removeMarkersExactTimes = function (payloadJson) {
    try {
      var payload = payloadJson ? parseJson(payloadJson) : {};
      var seq = app.project.activeSequence;
      if (!seq) throw new Error("No active sequence is open.");
      var clip = getExactlyOneSelectedClip();
      var info = getClipInfo(clip);
      verifyClipInfo(payload, info);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var collection =
        target === "clip" ? clipMarkerCollection(clip) : seq.markers;
      var wanted = payload.times || [];
      var removed = 0;
      if (!collection) throw new Error("Marker collection is unavailable.");
      for (
        var marker = collection.getFirstMarker
          ? collection.getFirstMarker()
          : null;
        marker;

      ) {
        var next = collection.getNextMarker
          ? collection.getNextMarker(marker)
          : null;
        var time = markerTimeSeconds(marker);
        var owned = isAutoCutStudioMarker(marker);
        var match = false;
        for (var i = 0; i < wanted.length; i++) {
          if (Math.abs(time - Number(wanted[i])) < 0.0005) {
            match = true;
            break;
          }
        }
        if (owned && match && deleteMarker(collection, marker)) removed++;
        marker = next;
      }
      return ok({ removed: removed });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.runDiagnostics = function () {
    var diagnostics = [];
    try {
      diagnostics.push("Premiere bridge: OK");
      diagnostics.push("Premiere version: " + (app.version || "unknown"));
      if (!app.project) {
        diagnostics.push("Project: FAIL - app.project unavailable");
        return ok({ diagnostics: diagnostics });
      }
      if (!app.project.activeSequence) {
        diagnostics.push("Sequence: FAIL - no active sequence");
        return ok({ diagnostics: diagnostics });
      }
      var seq = app.project.activeSequence;
      diagnostics.push("Sequence: OK - " + seq.name);
      try {
        var clip = getSelectedClip();
        var info = getClipInfo(clip);
        diagnostics.push("Selection: OK - " + info.name);
        diagnostics.push("Media path: " + info.mediaPath);
        diagnostics.push(
          "Sequence marker API: " +
            (seq.markers && seq.markers.createMarker ? "OK" : "FAIL")
        );
        var clipMarkers = clipMarkerCollection(clip);
        diagnostics.push(
          "Clip marker API: " +
            (clipMarkers && clipMarkers.createMarker ? "OK" : "Unavailable")
        );
        diagnostics.push("clip.markers: " + (clip.markers ? "exists" : "null"));
        diagnostics.push(
          "projectItem.getMarkers: " +
            (clip.projectItem && clip.projectItem.getMarkers
              ? "exists"
              : "null")
        );
        diagnostics.push(
          "projectItem.markers: " +
            (clip.projectItem && clip.projectItem.markers ? "exists" : "null")
        );

        // Dump ALL components on the clip for debugging
        diagnostics.push("--- ALL CLIP COMPONENTS ---");
        if (clip.components) {
          diagnostics.push("Total components: " + clip.components.numItems);
          for (var c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c];
            var dn = "";
            var mn = "";
            try {
              dn = comp.displayName || "";
            } catch (_) {}
            try {
              mn = comp.matchName || "";
            } catch (_) {}
            diagnostics.push(
              "  Component " +
                c +
                ": dn='" +
                dn +
                "', mn='" +
                mn +
                "', enabled=" +
                (comp.enabled !== undefined ? comp.enabled : "?")
            );
            // Dump first-level properties of each component
            if (comp.properties) {
              try {
                for (
                  var p = 0;
                  p < Math.min(comp.properties.numItems, 8);
                  p++
                ) {
                  var prop = comp.properties[p];
                  var pdn = "";
                  try {
                    pdn = prop.displayName || "";
                  } catch (_) {}
                  diagnostics.push(
                    "    - Prop " +
                      p +
                      ": '" +
                      pdn +
                      "' hasSetValue=" +
                      Boolean(prop.setValue)
                  );
                }
                if (comp.properties.numItems > 8) {
                  diagnostics.push(
                    "    ... (" +
                      (comp.properties.numItems - 8) +
                      " more properties)"
                  );
                }
              } catch (_) {}
            }
          }
        } else {
          diagnostics.push("No components collection on clip");
        }

        // Print AutoCut Color Engine status
        var autocutComponent = findAutoCutColorComponent(clip);
        diagnostics.push(
          "AutoCut Color Engine via findAutoCutColorComponent: " +
            (autocutComponent ? "FOUND" : "NOT FOUND")
        );

        // Print Lumetri Color status
        var lumetriComponent = findLumetriComponent(clip);
        diagnostics.push(
          "Lumetri Color via findLumetriComponent: " +
            (lumetriComponent ? "FOUND" : "NOT FOUND")
        );

        // QE DOM check
        try {
          if (app.enableQE) {
            app.enableQE();
            var qeSeq = qe.project.getActiveSequence();
            diagnostics.push("QE DOM: OK");
            if (qeSeq) {
              diagnostics.push("QE Sequence: OK");
            }
          } else {
            diagnostics.push("QE DOM: UNAVAILABLE");
          }
        } catch (qeErr) {
          diagnostics.push(
            "QE DOM: ERROR - " + (qeErr.message || String(qeErr))
          );
        }
      } catch (selectionError) {
        diagnostics.push(
          "Selection: FAIL - " +
            (selectionError.message || String(selectionError))
        );
      }
      return ok({ diagnostics: diagnostics });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };
})();
