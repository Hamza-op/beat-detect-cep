var BeatDetect = BeatDetect || {};

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

    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var track = seq.videoTracks[i];
      if (!track || !track.clips) {
        continue;
      }
      for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        if (clip && clip.isSelected && clip.isSelected()) {
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
      outPointSeconds: timeToSeconds(clip.outPoint)
    };
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
    if (focus === "vocal") {
      return 4;
    }
    if (focus === "music") {
      return 3;
    }
    if (focus === "spikes") {
      return 1;
    }
    return target === "clip" ? 2 : 1;
  }

  function markerColorForEvent(event, focus, target) {
    var color = Number(event && event.colorIndex);
    if (!isNaN(color) && color >= 0 && color <= 16) {
      return Math.round(color);
    }
    return markerColorForFocus(focus, target);
  }

  // Color indices used by Beat Detect for identification:
  // vocal=4, music=3, spikes=1, default clip=2, default seq=1
  var BD_COLOR_INDICES = [1, 2, 3, 4];

  function isBeatDetectMarker(marker) {
    if (!marker) {
      return false;
    }
    // With blank markers, identify BD markers by checking they have
    // no name and no comments (plain markers created by Beat Detect)
    var name = marker.name || "";
    var comments = marker.comments || "";
    return name === "" && comments === "";
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
      if (isBeatDetectMarker(marker) && seconds >= startSeconds && seconds <= endSeconds) {
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

  BeatDetect.getSelectedClipInfo = function () {
    try {
      return ok({ clip: getClipInfo(getSelectedClip()) });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  BeatDetect.applyMarkers = function (payloadJson) {
    try {
      var payload = parseJson(payloadJson);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var focus = payload.focus || "spikes";
      var events = payload.events || [];
      var seq = app.project.activeSequence;
      var clip = getSelectedClip();
      var info = getClipInfo(clip);
      var applied = 0;
      var skipped = 0;

      if (!seq) {
        throw new Error("No active sequence is open.");
      }
      if (payload.mediaPath && payload.mediaPath !== info.mediaPath) {
        throw new Error("Selection changed after analysis. Re-select the analyzed clip or run analysis again.");
      }

      for (var i = 0; i < events.length; i++) {
        var eventTime = Number(events[i].time);
        var score = Number(events[i].score);
        if (isNaN(eventTime) || eventTime < info.inPointSeconds || eventTime > info.outPointSeconds) {
          skipped++;
          continue;
        }

        var color = markerColorForEvent(events[i], focus, target);

        if (target === "clip") {
          setMarkerFields(createClipMarker(clip, eventTime), color);
        } else {
          var sequenceTime = info.startSeconds + (eventTime - info.inPointSeconds);
          if (sequenceTime < info.startSeconds || sequenceTime > info.endSeconds) {
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

  BeatDetect.removeMarkers = function (payloadJson) {
    try {
      var payload = parseJson(payloadJson);
      var target = payload.target === "clip" ? "clip" : "sequence";
      var seq = app.project.activeSequence;
      var clip = getSelectedClip();
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

  BeatDetect.applyGimbalZoom = function (payloadJson) {
    try {
      var payload = payloadJson ? parseJson(payloadJson) : { zoom: 110.0 };
      var zoomTarget = payload.zoom || 110.0;
      
      var seq = app.project.activeSequence;
      if (!seq) {
        throw new Error("No active sequence is open.");
      }

      var clips = getAllSelectedVideoClips(seq);
      if (clips.length === 0) {
        throw new Error("Select at least one video clip in the active sequence.");
      }

      var appliedCount = 0;
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if (clip.components) {
          for (var c = 0; c < clip.components.numItems; c++) {
            var component = clip.components[c];
            if (component.matchName === "AE.ADBE Motion" || component.displayName === "Motion") {
              for (var p = 0; p < component.properties.numItems; p++) {
                var prop = component.properties[p];
                if (prop.matchName === "ADBE Video Scale" || prop.displayName === "Scale") {
                  try {
                    prop.setTimeVarying(true);
                    
                    // Add smooth 100% to 110% zoom over the clip duration using sequence time
                    // Ensure perfectly frame-aligned precision using ticks if available
                    var inTime = clip.start.ticks ? (parseInt(clip.start.ticks, 10) / TICKS_PER_SECOND) : (clip.start.seconds || timeToSeconds(clip.start));
                    var outTime = clip.end.ticks ? (parseInt(clip.end.ticks, 10) / TICKS_PER_SECOND) : (clip.end.seconds || timeToSeconds(clip.end));
                    
                    // Clear existing keyframes within range to prevent jitter
                    if (prop.getKeys) {
                      var keys = prop.getKeys() || [];
                      for (var k = keys.length - 1; k >= 0; k--) {
                        var kTime = keys[k].ticks ? (parseInt(keys[k].ticks, 10) / TICKS_PER_SECOND) : timeToSeconds(keys[k]);
                        if (kTime >= inTime && kTime <= outTime) {
                          try { prop.removeKey(kTime); } catch (e) {
                            try { prop.removeKey(keys[k]); } catch (e2) {}
                          }
                        }
                      }
                    }

                    prop.addKey(inTime);
                    prop.setValueAtKey(inTime, 100.0, true);
                    if (prop.setInterpolationTypeAtKey) {
                      prop.setInterpolationTypeAtKey(inTime, 5, true); // 5 = Bezier
                    }
                    
                    prop.addKey(outTime);
                    prop.setValueAtKey(outTime, zoomTarget, true);
                    if (prop.setInterpolationTypeAtKey) {
                      prop.setInterpolationTypeAtKey(outTime, 5, true); // 5 = Bezier
                    }
                    
                    appliedCount++;
                  } catch (err) {
                    // Gracefully handle if Motion component is hidden or Scale property is restricted
                  }
                  break;
                }
              }
              break; // Found Motion
            }
          }
        }
      }

      if (appliedCount === 0) {
        throw new Error("Could not find Motion properties on the selected clips.");
      }

      return ok({ applied: appliedCount });
    } catch (error) {
      return fail(error.message || String(error));
    }
  };

  BeatDetect.getSelectedVideoClipCount = function () {
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

  BeatDetect.applyWarpStabilizerToSelectedClip = function (payloadJson) {
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

  BeatDetect.isVideoEffectAnalysisDone = function () {
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

  BeatDetect.runDiagnostics = function () {
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
