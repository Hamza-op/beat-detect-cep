var AutoCutStudio = AutoCutStudio || {};

(function () {
  var TICKS_PER_SECOND = 254016000000;

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
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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
    if (typeof JSON !== "undefined" && JSON.parse) {
      return JSON.parse(text);
    }
    return eval("(" + text + ")");
  }

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
    return (clip && (clip.name || (clip.projectItem && clip.projectItem.name))) || ("clip " + (index + 1));
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
      a.projectItem === b.projectItem &&
      timeToSeconds(a.start) === timeToSeconds(b.start) &&
      timeToSeconds(a.end) === timeToSeconds(b.end)
    );
  }

  function isTrackItemSelected(clip, selectedItems) {
    if (clip && clip.isSelected && clip.isSelected()) {
      return true;
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
      throw new Error("Select one audio or linked clip in the active sequence first.");
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

    if (selected.length !== 1) {
      throw new Error(selected.length < 1
        ? "Select one audio or linked clip in the active sequence first."
        : "Select exactly one clip for beat analysis and marker apply.");
    }
    return selected[0];
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
          if (clip && clip.projectItem && clip.isSelected && clip.isSelected()) {
            return clip;
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
        if (selection[s] && selection[s].components) {
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
          if (clip && clip.isSelected && clip.isSelected()) {
            selected.push(clip);
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
            name: clip.name || "Selected clip"
          });
        }
      }
    }

    return selected;
  }

  function getPlayheadSeconds(seq) {
    if (!seq) {
      return 0;
    }
    if (seq.getPlayerPosition) {
      return timeToSeconds(seq.getPlayerPosition());
    }
    if (seq.getCTI) {
      return timeToSeconds(seq.getCTI());
    }
    throw new Error("This Premiere version does not expose the current playhead position to scripts.");
  }

  function getVideoClipRefAtPlayhead(seq) {
    if (!seq || !seq.videoTracks) {
      throw new Error("No active sequence video tracks are available.");
    }

    var playhead = getPlayheadSeconds(seq);
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var track = seq.videoTracks[i];
      if (!track || !track.clips) {
        continue;
      }
      for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        if (!clip) {
          continue;
        }
        var start = timeToSeconds(clip.start);
        var end = timeToSeconds(clip.end);
        if (playhead >= start && playhead < end) {
          return {
            clip: clip,
            trackIndex: i,
            clipIndex: j,
            name: clip.name || "Playhead clip"
          };
        }
      }
    }

    throw new Error("No video clip exists under the playhead.");
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

  function isMotionComponent(component) {
    var matchName = normalizedName(component && component.matchName);
    var displayName = normalizedName(component && component.displayName);
    return matchName.indexOf("motion") >= 0 || displayName === "motion";
  }

  function isScaleProperty(prop) {
    var matchName = normalizedName(prop && prop.matchName);
    var displayName = normalizedName(prop && prop.displayName);
    return displayName === "scale" || matchName.indexOf("scale") >= 0;
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

  function findMotionScaleProperty(clip) {
    if (!clip || !clip.components) {
      return null;
    }

    for (var c = 0; c < clip.components.numItems; c++) {
      var component = clip.components[c];
      if (isMotionComponent(component)) {
        var motionScale = findScalePropertyOnComponent(component);
        if (motionScale) {
          return motionScale;
        }
      }
    }

    // Fallback for localized or odd Premiere builds: use the first keyframeable
    // Scale property we can find on the selected video TrackItem.
    for (var c2 = 0; c2 < clip.components.numItems; c2++) {
      var fallbackScale = findScalePropertyOnComponent(clip.components[c2]);
      if (fallbackScale) {
        return fallbackScale;
      }
    }

    return null;
  }

  function removeKeysInRange(prop, startSeconds, endSeconds) {
    if (!prop) {
      return;
    }
    var startTime = timeFromSeconds(startSeconds);
    var endTime = timeFromSeconds(endSeconds);

    if (prop.removeKeyRange) {
      try {
        prop.removeKeyRange(startTime, endTime);
        return;
      } catch (_) {}
    }

    if (!prop.getKeys || !prop.removeKey) {
      return;
    }
    var keys = prop.getKeys() || [];
    for (var k = keys.length - 1; k >= 0; k--) {
      var keyTime = keys[k];
      var keySeconds = timeToSeconds(keyTime);
      if (keySeconds >= startSeconds && keySeconds <= endSeconds) {
        try {
          prop.removeKey(keyTime);
        } catch (_) {}
      }
    }
  }

  function setScaleKey(prop, seconds, value) {
    var time = timeFromSeconds(seconds);
    var addError = null;
    try {
      prop.addKey(time);
    } catch (error) {
      addError = error;
    }

    try {
      prop.setValueAtKey(time, value, 1);
    } catch (valueError) {
      if (addError) {
        throw new Error("Could not add Scale keyframe: " + (addError.message || addError) + "; " + (valueError.message || valueError));
      }
      throw valueError;
    }

    if (prop.setInterpolationTypeAtKey) {
      try {
        prop.setInterpolationTypeAtKey(time, 5, 1);
      } catch (_) {}
    }
  }

  function resetZoomOnClip(clip) {
    var prop = findMotionScaleProperty(clip);
    if (!prop) {
      return false;
    }

    var inTime = timeToSeconds(clip.inPoint);
    var outTime = timeToSeconds(clip.outPoint);
    var duration = outTime - inTime;
    if (!isFinite(duration) || duration <= 0) {
      duration = timeToSeconds(clip.end) - timeToSeconds(clip.start);
      outTime = inTime + duration;
    }
    if (!isFinite(duration) || duration <= 0.001) {
      throw new Error("clip duration is too short");
    }

    removeKeysInRange(prop, inTime, outTime);
    try {
      prop.setTimeVarying(false);
    } catch (_) {}
    if (prop.setValue) {
      prop.setValue(100.0, 1);
    }
    return true;
  }

  function getWarpStabilizerEffect() {
    if (!app.enableQE) {
      throw new Error("Premiere QE DOM is unavailable; cannot apply Warp Stabilizer by script.");
    }
    app.enableQE();
    if (typeof qe === "undefined" || !qe.project || !qe.project.getVideoEffectByName) {
      throw new Error("Premiere QE project API is unavailable; cannot find Warp Stabilizer.");
    }

    var names = ["Warp Stabilizer", "Warp Stabilizer VFX"];
    for (var i = 0; i < names.length; i++) {
      var effect = qe.project.getVideoEffectByName(names[i]);
      if (effect) {
        return effect;
      }
    }

    throw new Error("Could not find the Warp Stabilizer video effect in this Premiere installation.");
  }

  function getVideoEffectByNames(names, label) {
    if (!app.enableQE) {
      throw new Error("Premiere QE DOM is unavailable; cannot apply " + label + " by script.");
    }
    app.enableQE();
    if (typeof qe === "undefined" || !qe.project || !qe.project.getVideoEffectByName) {
      throw new Error("Premiere QE project API is unavailable; cannot find " + label + ".");
    }

    for (var i = 0; i < names.length; i++) {
      var effect = qe.project.getVideoEffectByName(names[i]);
      if (effect) {
        return effect;
      }
    }

    throw new Error("Could not find " + label + " in this Premiere installation.");
  }

  function getLumetriEffect() {
    return getVideoEffectByNames(["Lumetri Color", "Lumetri"], "Lumetri Color");
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

    var qeClip = qeTrack.getItemAt(ref.clipIndex);
    if (!qeClip || !qeClip.addVideoEffect) {
      throw new Error("Could not access selected clip through QE DOM.");
    }

    qeClip.addVideoEffect(effect);
  }

  function componentName(component) {
    return normalizedName((component && component.displayName) || (component && component.matchName) || "");
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

  function ensureLumetriComponent(ref) {
    var component = findLumetriComponent(ref.clip);
    if (component) {
      return component;
    }

    applyVideoEffectToClipRef(ref, getLumetriEffect());
    component = findLumetriComponent(ref.clip);
    if (!component) {
      throw new Error("Lumetri Color was applied but its properties were not exposed to ExtendScript.");
    }
    return component;
  }

  function propertyName(prop) {
    return normalizedName((prop && prop.displayName) || (prop && prop.matchName) || "");
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
      { key: "temperature", names: ["temperature", "temp"], value: values.temperature },
      { key: "tint", names: ["tint"], value: values.tint },
      { key: "exposure", names: ["exposure"], value: values.exposure },
      { key: "contrast", names: ["contrast"], value: values.contrast },
      { key: "saturation", names: ["saturation"], value: values.saturation },
      { key: "vibrance", names: ["vibrance"], value: values.vibrance }
    ];

    for (var i = 0; i < map.length; i++) {
      if (setLumetriProperty(component, map[i].names, map[i].value)) {
        applied++;
      } else {
        missing.push(map[i].key);
      }
    }

    if (applied === 0) {
      throw new Error("Lumetri properties were not exposed by this Premiere version.");
    }
    return missing;
  }

  function triggerLumetriAuto(component) {
    var prop = findPropertyRecursive(component, ["auto"], 0);
    if (!prop || !prop.setValue) {
      return false;
    }
    try {
      prop.setValue(1, 1);
      return true;
    } catch (_) {
      try {
        prop.setValue(true, 1);
        return true;
      } catch (error) {
        return false;
      }
    }
  }

  function normalizedColorPayload(payload) {
    payload = payload || {};
    function bounded(value, min, max, fallback) {
      var number = Number(value);
      if (isNaN(number)) {
        number = fallback;
      }
      return Math.max(min, Math.min(max, number));
    }

    return {
      temperature: bounded(payload.temperature, -100, 100, 0),
      tint: bounded(payload.tint, -100, 100, 0),
      exposure: bounded(payload.exposure, -5, 5, 0),
      contrast: bounded(payload.contrast, -100, 100, 0),
      saturation: bounded(payload.saturation, 0, 200, 100),
      vibrance: bounded(payload.vibrance, -100, 100, 0)
    };
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

    return {
      name: clip.name || clip.projectItem.name || "Selected clip",
      mediaPath: mediaPath,
      startSeconds: timeToSeconds(clip.start),
      endSeconds: timeToSeconds(clip.end),
      inPointSeconds: timeToSeconds(clip.inPoint),
      outPointSeconds: timeToSeconds(clip.outPoint),
      durationSeconds: Math.max(0, timeToSeconds(clip.outPoint) - timeToSeconds(clip.inPoint))
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
      throw new Error("Selection changed after analysis. Re-select the analyzed clip or run analysis again.");
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
      if (payload[key] !== undefined && !sameNumber(payload[key], checks[i][1], tolerance)) {
        throw new Error("Selected clip timing changed after analysis. Re-select the analyzed clip or run analysis again.");
      }
    }
  }

  function setMarkerFields(marker, colorIndex) {
    if (!marker) {
      return;
    }
    marker.name = "";
    marker.comments = "";
    if (marker.setColorByIndex) {
      marker.setColorByIndex(colorIndex, 0);
    }
  }

  function createClipMarker(clip, seconds) {
    var collection = clipMarkerCollection(clip);
    if (collection && collection.createMarker) {
      return collection.createMarker(seconds);
    }
    throw new Error("This selected clip does not support clip marker creation.");
  }

  function markerColorForFocus(focus, target) {
    return 3;
  }

  function markerColorForEvent(event, focus, target) {
    var color = Number(event && event.colorIndex);
    if (!isNaN(color) && color >= 0 && color <= 16) {
      return Math.round(color);
    }
    return markerColorForFocus(focus, target);
  }

  var BD_COLOR_INDICES = [3];

  function isAutoCutStudioMarker(marker) {
    if (!marker) {
      return false;
    }
    var name = marker.name || "";
    var comments = marker.comments || "";
    if (name !== "" || comments !== "") {
      return false;
    }

    var color = null;
    try {
      if (marker.getColorByIndex) {
        color = Number(marker.getColorByIndex());
      } else if (marker.getColor) {
        color = Number(marker.getColor());
      } else if (marker.color !== undefined) {
        color = Number(marker.color);
      }
    } catch (_) {}

    if (color === null || isNaN(color)) {
      return true;
    }
    for (var i = 0; i < BD_COLOR_INDICES.length; i++) {
      if (color === BD_COLOR_INDICES[i]) {
        return true;
      }
    }
    return false;
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
      if (isAutoCutStudioMarker(marker) && seconds >= startSeconds && seconds < endSeconds) {
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
    if (clip && clip.projectItem && clip.projectItem.getMarkers) {
      return clip.projectItem.getMarkers();
    }
    if (clip && clip.projectItem && clip.projectItem.markers) {
      return clip.projectItem.markers;
    }
    return null;
  }

  function activeFrameDuration(seq) {
    var fallback = 1 / 30;
    try {
      var settings = seq && seq.getSettings ? seq.getSettings() : null;
      if (settings && settings.videoFrameRate && settings.videoFrameRate.seconds) {
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

  AutoCutStudio.getSelectedClipInfo = function () {
    try {
      return ok({ clip: getClipInfo(getExactlyOneSelectedClip()) });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.applyMarkers = function (payloadJson) {
    try {
      var payload = parseJson(payloadJson);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var focus = payload.focus || "spikes";
      var events = payload.events || [];
      var seq = app.project.activeSequence;
      var clip = getExactlyOneSelectedClip();
      var info = getClipInfo(clip);
      var applied = 0;
      var skipped = 0;

      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      verifyClipInfo(payload, info);

      if (target === "clip") {
        var clipCollection = clipMarkerCollection(clip);
        var existingClipMarkers = collectMarkers(clipCollection, info.inPointSeconds, info.outPointSeconds);
        for (var cm = 0; cm < existingClipMarkers.length; cm++) {
          deleteMarker(clipCollection, existingClipMarkers[cm]);
        }
      } else {
        var existingSeqMarkers = collectMarkers(seq.markers, info.startSeconds, info.endSeconds);
        for (var sm = 0; sm < existingSeqMarkers.length; sm++) {
          deleteMarker(seq.markers, existingSeqMarkers[sm]);
        }
      }

      for (var i = 0; i < events.length; i++) {
        var eventTime = Number(events[i].time);
        var score = Number(events[i].score);
        if (isNaN(eventTime) || eventTime < info.inPointSeconds || eventTime >= info.outPointSeconds) {
          skipped++;
          continue;
        }

        var color = markerColorForEvent(events[i], focus, target);

        if (target === "clip") {
          setMarkerFields(createClipMarker(clip, snapToFrame(eventTime, seq)), color);
        } else {
          var sequenceTime = info.startSeconds + (eventTime - info.inPointSeconds);
          sequenceTime = snapToFrame(sequenceTime, seq);
          if (sequenceTime < info.startSeconds || sequenceTime >= info.endSeconds) {
            skipped++;
            continue;
          }
          setMarkerFields(seq.markers.createMarker(sequenceTime), color);
        }
        applied++;
      }

      return ok({ applied: applied, skipped: skipped });
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

      if (target === "clip") {
        collection = clipMarkerCollection(clip);
        startSeconds = info.inPointSeconds;
        endSeconds = info.outPointSeconds;
        if (!collection) {
          throw new Error("This selected clip does not expose a clip marker collection.");
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
      var payload = payloadJson ? parseJson(payloadJson) : { zoom: 110.0, style: "smooth_in" };
      var zoomTarget = Math.max(101.0, Math.min(150.0, Number(payload.zoom) || 110.0));
      var zoomStyle = payload.style || "smooth_in";
      
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var clips = getAllSelectedVideoClips(seq);
      if (clips.length === 0) {
        throw new Error("Select at least one video clip in the active sequence.");
      }

      var appliedCount = 0;
      var skipped = 0;
      var errors = [];
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        var prop = findMotionScaleProperty(clip);
        var name = clipName(clip, i);
        if (!prop) {
          skipped++;
          errors.push(name + ": Motion > Scale not found");
          continue;
        }

        try {
          if (prop.areKeyframesSupported && !prop.areKeyframesSupported()) {
            skipped++;
            errors.push(name + ": Scale does not support keyframes");
            continue;
          }

          prop.setTimeVarying(true);

          var inTime = timeToSeconds(clip.inPoint);
          var rawOutTime = timeToSeconds(clip.outPoint);
          var duration = rawOutTime - inTime;
          if (!isFinite(duration) || duration <= 0) {
            duration = timeToSeconds(clip.end) - timeToSeconds(clip.start);
            rawOutTime = inTime + duration;
          }
          if (!isFinite(duration) || duration <= 0.001) {
            skipped++;
            errors.push(name + ": clip duration is too short");
            continue;
          }

          var frameDuration = 1 / 30;
          try {
            var settings = seq.getSettings ? seq.getSettings() : null;
            if (settings && settings.videoFrameRate && settings.videoFrameRate.seconds) {
              frameDuration = Number(settings.videoFrameRate.seconds) || frameDuration;
            }
          } catch (_) {}

          var endTime = Math.max(inTime + 0.001, rawOutTime - Math.min(frameDuration, duration * 0.25));
          removeKeysInRange(prop, inTime, rawOutTime);

          if (zoomStyle === "smooth_out") {
            setScaleKey(prop, inTime, zoomTarget);
            setScaleKey(prop, endTime, 100.0);
          } else if (zoomStyle === "crash_in") {
            var crashInStart = Math.max(inTime, endTime - Math.min(0.35, duration * 0.25));
            setScaleKey(prop, inTime, 100.0);
            setScaleKey(prop, crashInStart, 100.0);
            setScaleKey(prop, endTime, zoomTarget);
          } else if (zoomStyle === "crash_out") {
            var crashOutEnd = Math.min(endTime, inTime + Math.min(0.35, duration * 0.25));
            setScaleKey(prop, inTime, zoomTarget);
            setScaleKey(prop, crashOutEnd, 100.0);
            setScaleKey(prop, endTime, 100.0);
          } else if (zoomStyle === "drift") {
            var driftTarget = 100.0 + (zoomTarget - 100.0) * 0.3;
            setScaleKey(prop, inTime, 100.0);
            setScaleKey(prop, endTime, driftTarget);
          } else {
            setScaleKey(prop, inTime, 100.0);
            setScaleKey(prop, endTime, zoomTarget);
          }

          appliedCount++;
        } catch (err) {
          skipped++;
          errors.push(name + ": " + (err.message || String(err)));
        }
      }

      if (appliedCount === 0) {
        throw new Error(errors.length ? errors.join(" | ") : "Could not apply Motion Scale keyframes to selected clips.");
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

      var clips = getAllSelectedVideoClips(seq);
      if (clips.length === 0) {
        throw new Error("Select at least one video clip in the active sequence.");
      }

      var cleared = 0;
      var skipped = 0;
      var errors = [];

      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        var name = clipName(clip, i);
        try {
          if (resetZoomOnClip(clip)) {
            cleared++;
          } else {
            skipped++;
            errors.push(name + ": Motion > Scale not found");
          }
        } catch (error) {
          skipped++;
          errors.push(name + ": " + (error.message || String(error)));
        }
      }

      if (cleared === 0) {
        throw new Error(errors.length ? errors.join(" | ") : "No zoom keyframes were cleared.");
      }

      return ok({ cleared: cleared, skipped: skipped, errors: errors });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.applyColorGrade = function (payloadJson) {
    try {
      var payload = payloadJson ? parseJson(payloadJson) : {};
      var values = normalizedColorPayload(payload);
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var refs = getSelectedVideoClipRefs(seq);
      if (refs.length === 0) {
        throw new Error("Select at least one video clip in the active sequence.");
      }

      var applied = 0;
      var skipped = 0;
      var errors = [];

      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i];
        try {
          var component = ensureLumetriComponent(ref);
          var missing = applyLumetriValues(component, values);
          if (missing.length) {
            errors.push(ref.name + ": missing " + missing.join(", "));
          }
          applied++;
        } catch (error) {
          skipped++;
          errors.push(ref.name + ": " + (error.message || String(error)));
        }
      }

      if (applied === 0) {
        throw new Error(errors.length ? errors.join(" | ") : "Could not apply Lumetri Color to selected clips.");
      }

      return ok({ applied: applied, skipped: skipped, errors: errors });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.autoColorAtPlayhead = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var ref = getVideoClipRefAtPlayhead(seq);
      var component = ensureLumetriComponent(ref);
      var usedNativeAuto = triggerLumetriAuto(component);

      if (!usedNativeAuto) {
        applyLumetriValues(component, {
          temperature: 0,
          tint: 0,
          exposure: 0,
          contrast: 12,
          saturation: 108,
          vibrance: 16
        });
      }

      return ok({
        name: ref.name,
        trackIndex: ref.trackIndex,
        clipIndex: ref.clipIndex,
        usedNativeAuto: usedNativeAuto
      });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  AutoCutStudio.resetColorGrade = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var refs = getSelectedVideoClipRefs(seq);
      if (refs.length === 0) {
        throw new Error("Select at least one video clip in the active sequence.");
      }

      var defaults = {
        temperature: 0,
        tint: 0,
        exposure: 0,
        contrast: 0,
        saturation: 100,
        vibrance: 0
      };
      var reset = 0;
      var skipped = 0;
      var errors = [];

      for (var i = 0; i < refs.length; i++) {
        var ref = refs[i];
        try {
          var component = findLumetriComponent(ref.clip);
          if (!component) {
            skipped++;
            errors.push(ref.name + ": Lumetri Color not found");
            continue;
          }
          var missing = applyLumetriValues(component, defaults);
          if (missing.length) {
            errors.push(ref.name + ": missing " + missing.join(", "));
          }
          reset++;
        } catch (error) {
          skipped++;
          errors.push(ref.name + ": " + (error.message || String(error)));
        }
      }

      if (reset === 0) {
        throw new Error(errors.length ? errors.join(" | ") : "No Lumetri Color controls were reset.");
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
        throw new Error("Select at least one video clip in the active sequence.");
      }
      if (index < 0 || index >= refs.length) {
        throw new Error("Selected clip index is out of range.");
      }

      var ref = refs[index];
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

  AutoCutStudio.isVideoEffectAnalysisDone = function () {
    try {
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      if (!seq.isDoneAnalyzingForVideoEffects) {
        throw new Error("This Premiere version does not expose video-effect analysis status to scripts.");
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
      diagnostics.push("Sequence: OK - " + app.project.activeSequence.name);
      try {
        var clip = getSelectedClip();
        var info = getClipInfo(clip);
        diagnostics.push("Selection: OK - " + info.name);
        diagnostics.push("Media path: OK");
        diagnostics.push("Sequence marker API: " + (app.project.activeSequence.markers && app.project.activeSequence.markers.createMarker ? "OK" : "FAIL"));
        var clipMarkers = clipMarkerCollection(clip);
        diagnostics.push("Clip marker API: " + (clipMarkers && clipMarkers.createMarker ? "OK" : "Unavailable"));
      } catch (selectionError) {
        diagnostics.push("Selection: FAIL - " + (selectionError.message || String(selectionError)));
      }
      return ok({ diagnostics: diagnostics });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };
})();

