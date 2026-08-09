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
  var AUTOCUT_EXTENSION_VERSION = "1.1.1";

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

  function clipHasWarpStabilizer(clip) {
    if (!clip || !clip.components) {
      return false;
    }
    for (var c = 0; c < clip.components.numItems; c++) {
      var component = clip.components[c];
      var matchName = String(component.matchName || "");
      var displayName = String(component.displayName || "");
      if (
        matchName.indexOf("SubspaceStabilizer") >= 0 ||
        displayName.toLowerCase().indexOf("warp stabilizer") >= 0
      ) {
        return true;
      }
    }
    return false;
  }

  function normalizedName(value) {
    return String(value || "").toLowerCase();
  }

  function isScaleProperty(prop) {
    var matchName = normalizedName(prop && prop.matchName);
    var displayName = normalizedName(prop && prop.displayName);
    return displayName === "scale" || matchName.indexOf("scale") >= 0;
  }

  function isPositionProperty(prop) {
    var matchName = normalizedName(prop && prop.matchName);
    var displayName = normalizedName(prop && prop.displayName);
    return displayName === "position" || matchName.indexOf("position") >= 0;
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
    for (var i = 0; i < important.length; i++) {
      setScaleKey(
        prop,
        important[i][0],
        important[i][1],
        interpolationType
      );
    }
  }

  function boundedZoom(value) {
    return Math.max(101.0, Math.min(150.0, Number(value) || 110.0));
  }

  function setValueKey(prop, seconds, value, label, interpolationType) {
    var time = timeFromSeconds(seconds);
    var addError = null;
    try {
      requireHostSuccess(prop.addKey(time), "Add " + label + " keyframe");
    } catch (error) {
      addError = error;
    }

    try {
      requireHostSuccess(
        prop.setValueAtKey(time, value, 1),
        "Set " + label + " keyframe value"
      );
    } catch (valueError) {
      if (addError) {
        throw new Error(
          "Could not add " +
            label +
            " keyframe: " +
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
        "Set " + label + " keyframe interpolation"
      );
    }
  }

  function setValueKeys(prop, keys, label, interpolationType, frameDuration) {
    var important = importantKeyframes(keys, frameDuration);
    for (var i = 0; i < important.length; i++) {
      setValueKey(
        prop,
        important[i][0],
        important[i][1],
        label,
        interpolationType
      );
    }
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

  function boundedScale(value, fallback, min, max) {
    var scale = Number(value);
    if (!isFinite(scale)) {
      scale = fallback;
    }
    return Math.max(min, Math.min(max, scale));
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

  function pointFromPercent(xPercent, yPercent) {
    var x = boundedScale(xPercent, 50.0, 0.0, 100.0);
    var y = boundedScale(yPercent, 50.0, 0.0, 100.0);
    return [x / 100.0, y / 100.0];
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

  function dollyInterpolationType(easing) {
    if (easing === "linear") return 0;
    if (easing === "ease_in") return 1;
    if (easing === "ease_out") return 2;
    if (easing === "ease_in_out") return 3;
    return 5;
  }

  function dollyScaleValue(keys, index, fallback) {
    if (
      keys &&
      keys.length > index &&
      keys[index] &&
      keys[index].value !== undefined
    ) {
      return boundedScale(keys[index].value, fallback, 100.0, 180.0);
    }
    return boundedScale(fallback, 100.0, 100.0, 180.0);
  }

  function dollyPositionValue(keys, index, fallbackX, fallbackY) {
    if (
      keys &&
      keys.length > index &&
      keys[index] &&
      keys[index].value &&
      keys[index].value.length >= 2
    ) {
      return pointFromPercent(keys[index].value[0], keys[index].value[1]);
    }
    return pointFromPercent(fallbackX, fallbackY);
  }

  function baseZoomForStyle(style) {
    var bases = {
      smooth_in: 108.0,
      smooth_out: 108.0,
      drift: 105.0,
      breath: 106.0,
      reveal: 112.0,
      dolly_zoom: 118.0,
      settle_in: 114.0,
      swell: 110.0,
      crash_in: 126.0,
      crash_out: 124.0,
      punch_in: 118.0,
      punch_out: 116.0,
      pulse: 112.0,
      snap_back: 120.0,
      triple_hit: 116.0
    };
    return bases[style] || 110.0;
  }

  function isFastZoomStyle(style) {
    return (
      style === "crash_in" ||
      style === "crash_out" ||
      style === "punch_in" ||
      style === "punch_out" ||
      style === "pulse" ||
      style === "snap_back" ||
      style === "triple_hit"
    );
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

  function getWarpStabilizerEffect() {
    if (!app.enableQE) {
      throw new Error(
        "Premiere QE DOM is unavailable; cannot apply Warp Stabilizer by script."
      );
    }
    app.enableQE();
    if (
      typeof qe === "undefined" ||
      !qe.project ||
      !qe.project.getVideoEffectByName
    ) {
      throw new Error(
        "Premiere QE project API is unavailable; cannot find Warp Stabilizer."
      );
    }

    var names = ["Warp Stabilizer", "Warp Stabilizer VFX"];
    for (var i = 0; i < names.length; i++) {
      var effect = qe.project.getVideoEffectByName(names[i]);
      if (effect) {
        return effect;
      }
    }

    throw new Error(
      "Could not find the Warp Stabilizer video effect in this Premiere installation."
    );
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
      ["Transform"],
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
      display === "transform"
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

  function persistMotionLedger(ref, component, preset) {
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
        generatedScaleKeys: [],
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
    for (var i = 0; i < clip.components.numItems; i++) {
      var candidate = clip.components[i];
      if (
        isAutoCutTransformComponent(candidate) &&
        hasAutoCutTransformOwnership(candidate, ref)
      ) {
        return candidate;
      }
    }
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
    return null;
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

  function ensureAutoCutColorComponent(ref) {
    var component = findAutoCutColorComponent(ref.clip);
    if (component) {
      return component;
    }

    // Try to apply via QE DOM
    try {
      applyVideoEffectToClipRef(ref, getAutoCutColorEffect());
    } catch (_applyErr) {
      return null;
    }
    return null;
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
        ensureAutoCutColorComponent(selected.ref);
        existing = findAutoCutColorComponent(selected.ref.clip);
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

  function setAutoCutCaptureControls(component, token, localSeconds) {
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
    return tokenSet && secondsSet;
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

  function applyLumetriValues(component, values) {
    var applied = 0;
    var missing = [];
    var map = [
      {
        key: "temperature",
        names: ["temperature", "temp"],
        value: values.temperature
      },
      { key: "tint", names: ["tint"], value: values.tint },
      { key: "exposure", names: ["exposure"], value: values.exposure },
      { key: "contrast", names: ["contrast"], value: values.contrast },
      {
        key: "highlights",
        names: ["highlights", "highlight"],
        value: values.highlights
      },
      { key: "shadows", names: ["shadows", "shadow"], value: values.shadows },
      { key: "whites", names: ["whites", "white"], value: values.whites },
      { key: "blacks", names: ["blacks", "black"], value: values.blacks },
      { key: "saturation", names: ["saturation"], value: values.saturation },
      { key: "vibrance", names: ["vibrance"], value: values.vibrance }
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
        "Lumetri properties were not exposed by this Premiere version."
      );
    }
    return missing;
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

  AutoCutStudio.getDollyFrameInfo = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      var size = getSequenceSize(seq);
      return ok({
        width: size.width,
        height: size.height,
        orientation: size.height > size.width ? "portrait" : "landscape",
        sequenceName: seq.name || ""
      });
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
          var prop = findScalePropertyOnComponent(transform);
          var positionProp = findPositionPropertyOnComponent(transform);
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

          var endTime = Math.max(
            inTime + 0.001,
            rawOutTime - Math.min(frameDuration, duration * 0.25)
          );
          var safeEndTime = endTime;
          var punchWindow = Math.min(0.22, duration * 0.2);
          var pulseWindow = Math.min(0.42, duration * 0.45);
          var midTime = timeAt(inTime, safeEndTime - inTime, 0.5);
          var beatSettle = clampTime(inTime + punchWindow, inTime, safeEndTime);
          var pulseA = clampTime(
            inTime + pulseWindow * 0.28,
            inTime,
            safeEndTime
          );
          var pulseB = clampTime(
            inTime + pulseWindow * 0.58,
            inTime,
            safeEndTime
          );
          var pulseC = clampTime(inTime + pulseWindow, inTime, safeEndTime);
          var tripleA = clampTime(
            inTime + pulseWindow * 0.2,
            inTime,
            safeEndTime
          );
          var tripleB = clampTime(
            inTime + pulseWindow * 0.38,
            inTime,
            safeEndTime
          );
          var tripleC = clampTime(
            inTime + pulseWindow * 0.56,
            inTime,
            safeEndTime
          );
          var tripleD = clampTime(
            inTime + pulseWindow * 0.74,
            inTime,
            safeEndTime
          );
          var snapReturn = clampTime(
            inTime + Math.min(0.28, duration * 0.28),
            inTime,
            safeEndTime
          );
          var softTarget = 100.0 + (zoomTarget - 100.0) * 0.45;
          var driftTarget = 100.0 + (zoomTarget - 100.0) * 0.3;
          var breathTarget = 100.0 + (zoomTarget - 100.0) * 0.22;
          var overshootTarget = boundedZoom(
            100.0 + (zoomTarget - 100.0) * 1.18
          );
          removeKeysInRange(prop, inTime, rawOutTime);

          if (zoomStyle === "smooth_out") {
            setScaleKeys(prop, [
              [inTime, zoomTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "crash_in") {
            var crashInStart = Math.max(
              inTime,
              safeEndTime - Math.min(0.35, duration * 0.25)
            );
            setScaleKeys(prop, [
              [inTime, 100.0],
              [crashInStart, 100.0],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "crash_out") {
            var crashOutEnd = Math.min(
              safeEndTime,
              inTime + Math.min(0.35, duration * 0.25)
            );
            setScaleKeys(prop, [
              [inTime, zoomTarget],
              [crashOutEnd, 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "punch_in") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [
                clampTime(inTime + frameDuration, inTime, safeEndTime),
                zoomTarget
              ],
              [beatSettle, softTarget],
              [safeEndTime, softTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "punch_out") {
            setScaleKeys(prop, [
              [inTime, zoomTarget],
              [clampTime(inTime + frameDuration, inTime, safeEndTime), 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "pulse") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [pulseA, zoomTarget],
              [pulseB, 100.0],
              [pulseC, softTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "snap_back") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [
                clampTime(inTime + frameDuration, inTime, safeEndTime),
                zoomTarget
              ],
              [snapReturn, 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "triple_hit") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [tripleA, zoomTarget],
              [tripleB, 100.0],
              [tripleC, softTarget],
              [tripleD, 100.0],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "breath") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [midTime, breathTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "reveal") {
            var revealStart = timeAt(inTime, safeEndTime - inTime, 0.62);
            setScaleKeys(prop, [
              [inTime, zoomTarget],
              [revealStart, zoomTarget],
              [safeEndTime, 100.0]
            ], undefined, frameDuration);
          } else if (zoomStyle === "dolly_zoom") {
            var dolly = payload.dolly || {};
            var interpolationType = dollyInterpolationType(dolly.easing);
            var scaleKeys = dolly.scaleKeys;
            var positionKeys = dolly.positionKeys;
            var startScale;
            var midpointScale;
            var endScale;
            var startPoint;
            var midpointPoint;
            var endPoint;

            if (scaleKeys && scaleKeys.length >= 3) {
              startScale = dollyScaleValue(scaleKeys, 0, 100.0);
              midpointScale = dollyScaleValue(scaleKeys, 1, 118.0);
              endScale = dollyScaleValue(scaleKeys, 2, 108.0);
              startPoint = dollyPositionValue(positionKeys, 0, 50.0, 50.0);
              midpointPoint = dollyPositionValue(positionKeys, 1, 50.0, 50.0);
              endPoint = dollyPositionValue(positionKeys, 2, 50.0, 50.0);
            } else {
              var fallbackIntensity =
                boundedScale(dolly.intensity, 65.0, 0.0, 100.0) / 100.0;
              var rawStartScale = boundedScale(
                dolly.startScale,
                100.0,
                100.0,
                180.0
              );
              var rawMidScale = boundedScale(
                dolly.midScale,
                118.0,
                100.0,
                180.0
              );
              var rawEndScale = boundedScale(
                dolly.endScale,
                108.0,
                100.0,
                180.0
              );
              startScale = 100.0 + (rawStartScale - 100.0) * fallbackIntensity;
              midpointScale = 100.0 + (rawMidScale - 100.0) * fallbackIntensity;
              endScale = 100.0 + (rawEndScale - 100.0) * fallbackIntensity;
              startPoint = pointFromPercent(
                50.0 +
                  (boundedScale(dolly.startX, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity,
                50.0 +
                  (boundedScale(dolly.startY, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity
              );
              midpointPoint = pointFromPercent(
                50.0 +
                  (boundedScale(dolly.midX, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity,
                50.0 +
                  (boundedScale(dolly.midY, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity
              );
              endPoint = pointFromPercent(
                50.0 +
                  (boundedScale(dolly.endX, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity,
                50.0 +
                  (boundedScale(dolly.endY, 50.0, 0.0, 100.0) - 50.0) *
                    fallbackIntensity
              );
            }

            var sequenceSize = getSequenceSize(seq);
            startPoint = positionValueForProperty(
              positionProp,
              startPoint,
              sequenceSize
            );
            midpointPoint = positionValueForProperty(
              positionProp,
              midpointPoint,
              sequenceSize
            );
            endPoint = positionValueForProperty(
              positionProp,
              endPoint,
              sequenceSize
            );

            setScaleKeys(
              prop,
              [
                [inTime, startScale],
                [midTime, midpointScale],
                [safeEndTime, endScale]
              ],
              interpolationType,
              frameDuration
            );
            if (
              positionProp &&
              (!positionProp.areKeyframesSupported ||
                positionProp.areKeyframesSupported())
            ) {
              setKeyframingEnabled(positionProp, true, "Position");
              removeKeysInRange(positionProp, inTime, rawOutTime);
              setValueKeys(
                positionProp,
                [
                  [inTime, startPoint],
                  [midTime, midpointPoint],
                  [safeEndTime, endPoint]
                ],
                "Position",
                interpolationType,
                frameDuration
              );
            } else {
              errors.push(
                name +
                  ": Transform > Position not found; applied scale-only Dolly-Style Motion"
              );
            }
          } else if (zoomStyle === "settle_in") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, safeEndTime - inTime, 0.22), overshootTarget],
              [timeAt(inTime, safeEndTime - inTime, 0.55), softTarget],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "swell") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [timeAt(inTime, safeEndTime - inTime, 0.45), 100.0],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          } else if (zoomStyle === "drift") {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [safeEndTime, driftTarget]
            ], undefined, frameDuration);
          } else {
            setScaleKeys(prop, [
              [inTime, 100.0],
              [safeEndTime, zoomTarget]
            ], undefined, frameDuration);
          }

          markAutoCutTransformOwnership(transform, ref, zoomStyle);
          persistMotionLedger(ref, transform, zoomStyle);
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
          if (scale) {
            resetAnimatedProperty(
              scale,
              range.start,
              range.end,
              100.0,
              "Scale"
            );
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

  function applyNativeAutoColor(ref, captureFrameSeconds, captureToken) {
    var component = ensureAutoCutColorComponent(ref);

    if (!component) {
      throw new Error(
        "AutoCutStudio Color Engine is not installed or not exposed to Premiere."
      );
    }

    try {
      component.enabled = true;
    } catch (_) {}

    var values = defaultAutoCutColorValues();
    var captureLocalSeconds = clipLocalSecondsAtPlayhead(
      ref,
      captureFrameSeconds
    );
    var missing = [];
    var warnings = [];

    try {
      missing = applyAutoCutColorValues(component, values);
    } catch (error) {
      throw new Error(
        "Native engine properties were not exposed: " +
          (error.message || String(error))
      );
    }

    if (
      !setAutoCutCaptureControls(component, captureToken, captureLocalSeconds)
    ) {
      throw new Error(
        "Native capture controls were not exposed; cannot lock Auto Color to the playhead frame."
      );
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
      values: values,
      captureFrameSeconds: captureFrameSeconds,
      captureLocalSeconds: captureLocalSeconds,
      colorSpace: colorInfo.colorSpace,
      colorScience: colorInfo.colorScience
    };
  }

  AutoCutStudio.autoColorSelectedClips = function () {
    try {
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
            captureToken
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
        var removed = false;
        for (var c = qeClip.numComponents() - 1; c >= 0; c--) {
          try {
            var comp = qeClip.getComponentAt(c);
            if (comp) {
              var compName = (comp.name || "").toLowerCase();
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

      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i];
        try {
          var appliedToThisClip = false;

          // 1. Try to find and reset AutoCut Color Engine via ExtendScript
          var autocutComponent = findAutoCutColorComponent(ref.clip);
          if (autocutComponent) {
            try {
              autocutComponent.enabled = false;
            } catch (_) {}
            try {
              setAutoCutCaptureControls(autocutComponent, 0, 0);
              setLumetriProperty(
                autocutComponent,
                ["analysis confidence", "confidence"],
                0.0
              );
              applyAutoCutColorValues(autocutComponent, defaults);
            } catch (_) {}
            appliedToThisClip = true;
          } else {
            // AutoCut component not found via ExtendScript - try removing via QE DOM
            var qeRemoved = removeEffectViaQE(ref, [
              "AutoCutStudio Color Engine",
              "com.autocutstudio.color.engine",
              "AutoCut Color Engine"
            ]);
            if (qeRemoved) {
              appliedToThisClip = true;
            }
          }

          // Reset is intentionally scoped to the exact AutoCutStudio instance.
          // Lumetri and unrelated user effects are never disabled or rewritten.

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

  AutoCutStudio.applyWarpStabilizerToSelectedClip = function (payloadJson) {
    try {
      var payload = payloadJson ? parseJson(payloadJson) : {};
      var index = Number(payload.index) || 0;
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
      if (index < 0 || index >= refs.length) {
        throw new Error("Selected clip index is out of range.");
      }

      var ref = null;
      if (payload.identity) {
        for (var ri = 0; ri < refs.length; ri++) {
          if (refs[ri].identity === String(payload.identity)) {
            ref = refs[ri];
            index = ri;
            break;
          }
        }
        if (!ref) {
          throw new Error("Selected clip identity is no longer present.");
        }
      } else {
        ref = refs[index];
      }
      if (clipHasWarpStabilizer(ref.clip)) {
        return ok({
          applied: 0,
          skipped: true,
          reason: "Warp Stabilizer already exists",
          index: index,
          total: refs.length,
          name: ref.name
        });
      }

      applyVideoEffectToClipRef(ref, getWarpStabilizerEffect());
      return ok({
        applied: 1,
        skipped: false,
        index: index,
        total: refs.length,
        name: ref.name
      });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.listWarpSelection = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) throw new Error("No active sequence is open.");
      var refs = getSelectedVideoClipRefs(seq);
      var identities = [];
      for (var i = 0; i < refs.length; i++)
        identities.push({ identity: refs[i].identity, name: refs[i].name });
      return ok({ clips: identities });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.isVideoEffectAnalysisDone = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      if (!seq.isDoneAnalyzingForVideoEffects) {
        throw new Error(
          "This Premiere version does not expose video-effect analysis status to scripts."
        );
      }
      return ok({ done: Boolean(seq.isDoneAnalyzingForVideoEffects()) });
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
