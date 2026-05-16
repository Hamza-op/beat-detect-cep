var BeatDetect = BeatDetect || {};

(function () {
  var TICKS_PER_SECOND = 254016000000;

  function esc(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  }

  function jsonString(value) {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
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

  function setMarkerFields(marker, name, comments, colorIndex) {
    if (!marker) {
      return;
    }
    marker.name = name;
    marker.comments = comments;
    if (marker.setTypeAsComment) {
      marker.setTypeAsComment();
    }
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

  function markerPrefixForFocus(focus) {
    if (focus === "vocal") {
      return "BD Vocal";
    }
    if (focus === "music") {
      return "BD Music";
    }
    if (focus === "spikes") {
      return "BD Spike";
    }
    return "BD Event";
  }

  function isBeatDetectMarker(marker) {
    if (!marker) {
      return false;
    }
    var name = marker.name || "";
    var comments = marker.comments || "";
    return name.indexOf("BD Spike") === 0 ||
      name.indexOf("BD Music") === 0 ||
      name.indexOf("BD Vocal") === 0 ||
      name.indexOf("BD Event") === 0 ||
      comments.indexOf("Beat Detect ") === 0;
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

        var name = markerPrefixForFocus(focus) + " " + Math.round(score * 100) + "%";
        var comments = "Beat Detect " + focus + " marker at source " + eventTime.toFixed(3) + "s";
        var color = markerColorForFocus(focus, target);

        if (target === "clip") {
          setMarkerFields(createClipMarker(clip, eventTime), name, comments, color);
        } else {
          var sequenceTime = info.startSeconds + (eventTime - info.inPointSeconds);
          if (sequenceTime < info.startSeconds || sequenceTime > info.endSeconds) {
            skipped++;
            continue;
          }
          setMarkerFields(seq.markers.createMarker(sequenceTime), name, comments, color);
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
