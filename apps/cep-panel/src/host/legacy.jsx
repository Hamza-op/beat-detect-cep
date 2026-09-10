var AutoCutStudio = AutoCutStudio || {};

(function () {
  /*
   * AutoCutStudio Premiere Pro ExtendScript bridge.
   *
   * Safety notes:
   * - ES3-compatible; no external JSON dependency.
   * - QE is used only to add effects, never to remove effects by name.
   * - Existing user-created Transform effects are never adopted.
   * - Destructive motion operations require current-session ownership.
   *   Disk ledger records alone do not authorize changes to an effect.
   * - Clear Zoom removes generated Scale keys, not the Transform component.
   * - Project-item markers are source markers shared by media instances.
   * - Motion keyframes use source-media time. Retimed/reversed clips are
   *   rejected conservatively rather than guessed.
   *
   * Verify QE and effect-property behavior on supported Premiere versions.
   */

  var TICKS_PER_SECOND = 254016000000;
  var AUTOCUT_EXTENSION_VERSION = "1.2.0";
  var BRIDGE_VERSION = 1;
  var LEDGER_SCHEMA_VERSION = 2;
  var MAX_LEDGER_RECORDS = 500;
  var MAX_JSON_LENGTH = 4194304;
  var MAX_JSON_DEPTH = 64;
  var MAX_MARKER_EVENTS = 10000;
  var TIME_EPSILON = 0.000001;
  var VALUE_EPSILON = 0.0001;

  var SESSION_ID =
    String(new Date().getTime()) +
    "-" +
    String(Math.floor(Math.random() * 1000000000));

  var MARKER_PREFIX = "AutoCutStudio Beat Marker v2\n";
  var LEGACY_MARKER_SIGNATURE = "AutoCutStudio Beat Marker v1";

  var motionOwners = [];
  var pendingEffects = {};
  var lastCaptureToken = 0;

  var hasOwn = Object.prototype.hasOwnProperty;
  var objectToString = Object.prototype.toString;

  function owns(object, key) {
    return hasOwn.call(object, key);
  }

  function isArray(value) {
    return objectToString.call(value) === "[object Array]";
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
  }

  function normalizedName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/^\s+|\s+$/g, "");
  }

  function canonicalName(value) {
    return normalizedName(value).replace(/[_\s]+/g, " ");
  }

  function finiteNumber(value, label) {
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error(label + " must be a finite number.");
    }

    if (typeof value === "string" && !value.replace(/\s/g, "").length) {
      throw new Error(label + " must be a finite number.");
    }

    var number = Number(value);

    if (!isFinite(number)) {
      throw new Error(label + " must be a finite number.");
    }

    return number;
  }

  function optionalNumber(value, fallback, label) {
    return value === undefined
      ? fallback
      : finiteNumber(value, label);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function sameNumber(a, b, tolerance) {
    var first = Number(a);
    var second = Number(b);

    return (
      isFinite(first) &&
      isFinite(second) &&
      Math.abs(first - second) <= tolerance
    );
  }

  function safeRead(object, property, fallback) {
    try {
      var value = object && object[property];
      return value === undefined || value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  /*
   * Local strict JSON codec.
   * Does not trust or modify an existing global JSON implementation.
   */
  var Codec = (function () {
    function parse(text) {
      if (typeof text !== "string") {
        throw new Error("JSON input must be a string.");
      }

      if (text.length > MAX_JSON_LENGTH) {
        throw new Error("JSON payload is too large.");
      }

      var index = 0;
      var length = text.length;

      function invalid(message) {
        throw new Error(
          "Invalid JSON at character " + index + ": " + message
        );
      }

      function whitespace() {
        while (index < length && /[ \t\r\n]/.test(text.charAt(index))) {
          index++;
        }
      }

      function readString() {
        var result = "";
        var character;
        var escape;
        var hex;

        if (text.charAt(index++) !== '"') {
          invalid("Expected a string.");
        }

        while (index < length) {
          character = text.charAt(index++);

          if (character === '"') {
            return result;
          }

          if (character === "\\") {
            if (index >= length) {
              invalid("Incomplete escape sequence.");
            }

            escape = text.charAt(index++);

            if (escape === '"' || escape === "\\" || escape === "/") {
              result += escape;
            } else if (escape === "b") {
              result += "\b";
            } else if (escape === "f") {
              result += "\f";
            } else if (escape === "n") {
              result += "\n";
            } else if (escape === "r") {
              result += "\r";
            } else if (escape === "t") {
              result += "\t";
            } else if (escape === "u") {
              hex = text.substr(index, 4);

              if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                invalid("Invalid Unicode escape.");
              }

              result += String.fromCharCode(parseInt(hex, 16));
              index += 4;
            } else {
              invalid("Unsupported escape sequence.");
            }
          } else {
            if (character.charCodeAt(0) < 32) {
              invalid("Unescaped control character.");
            }

            result += character;
          }
        }

        invalid("Unterminated string.");
      }

      function readValue(depth) {
        if (depth > MAX_JSON_DEPTH) {
          invalid("Maximum nesting depth exceeded.");
        }

        whitespace();

        var character = text.charAt(index);
        var value;
        var key;
        var match;

        if (character === '"') {
          return readString();
        }

        if (character === "{") {
          index++;
          value = {};
          whitespace();

          if (text.charAt(index) === "}") {
            index++;
            return value;
          }

          while (index < length) {
            whitespace();

            if (text.charAt(index) !== '"') {
              invalid("Expected an object key.");
            }

            key = readString();

            if (
              key === "__proto__" ||
              key === "constructor" ||
              key === "prototype"
            ) {
              invalid("Reserved object key.");
            }

            if (owns(value, key)) {
              invalid("Duplicate object key.");
            }

            whitespace();

            if (text.charAt(index++) !== ":") {
              invalid("Expected ':'.");
            }

            value[key] = readValue(depth + 1);
            whitespace();
            character = text.charAt(index++);

            if (character === "}") {
              return value;
            }

            if (character !== ",") {
              invalid("Expected ',' or '}'.");
            }
          }

          invalid("Unterminated object.");
        }

        if (character === "[") {
          index++;
          value = [];
          whitespace();

          if (text.charAt(index) === "]") {
            index++;
            return value;
          }

          while (index < length) {
            value.push(readValue(depth + 1));
            whitespace();
            character = text.charAt(index++);

            if (character === "]") {
              return value;
            }

            if (character !== ",") {
              invalid("Expected ',' or ']'.");
            }
          }

          invalid("Unterminated array.");
        }

        if (text.substr(index, 4) === "true") {
          index += 4;
          return true;
        }

        if (text.substr(index, 5) === "false") {
          index += 5;
          return false;
        }

        if (text.substr(index, 4) === "null") {
          index += 4;
          return null;
        }

        match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
          text.substring(index)
        );

        if (match) {
          index += match[0].length;
          value = Number(match[0]);

          if (!isFinite(value)) {
            invalid("Number is outside the supported range.");
          }

          return value;
        }

        invalid("Unexpected token.");
      }

      var result = readValue(0);
      whitespace();

      if (index !== length) {
        invalid("Unexpected trailing content.");
      }

      return result;
    }

    function quote(value) {
      return '"' + String(value).replace(
        /["\\\x00-\x1f\u2028\u2029]/g,
        function (character) {
          var escapes = {
            '"': '\\"',
            "\\": "\\\\",
            "\b": "\\b",
            "\f": "\\f",
            "\n": "\\n",
            "\r": "\\r",
            "\t": "\\t"
          };

          if (owns(escapes, character)) {
            return escapes[character];
          }

          var hex = character.charCodeAt(0).toString(16);
          return "\\u" + ("0000" + hex).slice(-4);
        }
      ) + '"';
    }

    function stringify(value) {
      var ancestors = [];

      function encode(item, depth) {
        if (depth > MAX_JSON_DEPTH) {
          throw new Error("JSON serialization depth exceeded.");
        }

        if (item === null) {
          return "null";
        }

        var type = typeof item;
        var parts = [];
        var i;
        var key;
        var encoded;

        if (type === "string") {
          return quote(item);
        }

        if (type === "number") {
          return isFinite(item) ? String(item) : "null";
        }

        if (type === "boolean") {
          return item ? "true" : "false";
        }

        if (type === "undefined" || type === "function") {
          return undefined;
        }

        if (type !== "object") {
          throw new Error("Unsupported JSON value.");
        }

        for (i = 0; i < ancestors.length; i++) {
          if (ancestors[i] === item) {
            throw new Error("Cannot serialize a circular object.");
          }
        }

        ancestors.push(item);

        if (isArray(item)) {
          for (i = 0; i < item.length; i++) {
            encoded = encode(item[i], depth + 1);
            parts.push(encoded === undefined ? "null" : encoded);
          }

          ancestors.pop();
          return "[" + parts.join(",") + "]";
        }

        for (key in item) {
          if (owns(item, key)) {
            encoded = encode(item[key], depth + 1);

            if (encoded !== undefined) {
              parts.push(quote(key) + ":" + encoded);
            }
          }
        }

        ancestors.pop();
        return "{" + parts.join(",") + "}";
      }

      return encode(value, 0);
    }

    return {
      parse: parse,
      stringify: stringify
    };
  })();

  function ok(payload) {
    var response = { ok: true };

    if (payload) {
      for (var key in payload) {
        if (owns(payload, key) && key !== "ok") {
          response[key] = payload[key];
        }
      }
    }

    return Codec.stringify(response);
  }

  function fail(error) {
    return Codec.stringify({
      ok: false,
      error: errorMessage(error)
    });
  }

  function expose(name, handler) {
    AutoCutStudio[name] = function (payloadJson) {
      try {
        return ok(handler(payloadJson) || {});
      } catch (error) {
        return fail(error);
      }
    };
  }

  function parsePayload(text, allowEmpty) {
    if (
      allowEmpty &&
      (text === undefined || text === null || text === "")
    ) {
      return {};
    }

    var payload = Codec.parse(text);

    if (!payload || typeof payload !== "object" || isArray(payload)) {
      throw new Error("Expected a JSON object payload.");
    }

    return payload;
  }

  function requireActiveSequence() {
    if (typeof app === "undefined" || !app.project) {
      throw new Error("No Premiere project is available.");
    }

    var sequence = app.project.activeSequence;

    if (!sequence) {
      throw new Error("No active sequence is open.");
    }

    return sequence;
  }

  function requireHostSuccess(result, operation) {
    /*
     * Use only for documented ComponentParam-style status returns.
     * QE and marker APIs may use different return conventions.
     */
    if (
      result === false ||
      (typeof result === "number" && result !== 0)
    ) {
      throw new Error(
        operation + " failed in Premiere (code " + result + ")."
      );
    }
  }

  function timeToSeconds(time) {
    if (time === null || time === undefined) {
      throw new Error("Premiere returned an unavailable time value.");
    }

    var seconds;

    if (typeof time === "number" || typeof time === "string") {
      return finiteNumber(time, "Time");
    }

    if (time.seconds !== undefined) {
      seconds = Number(time.seconds);

      if (isFinite(seconds)) {
        return seconds;
      }
    }

    if (time.ticks !== undefined) {
      seconds = Number(time.ticks) / TICKS_PER_SECOND;

      if (isFinite(seconds)) {
        return seconds;
      }
    }

    throw new Error("Premiere returned an invalid time value.");
  }

  function tryTimeToSeconds(time) {
    try {
      return timeToSeconds(time);
    } catch (_) {
      return NaN;
    }
  }

  function timeFromSeconds(seconds) {
    var value = finiteNumber(seconds, "Time");
    var time = new Time();

    /*
     * Let Premiere perform seconds-to-ticks conversion.
     * Avoid constructing large integer tick strings with JS arithmetic.
     */
    time.seconds = value;
    return time;
  }

  function activeFrameDuration(seq) {
    try {
      var timebase = Number(seq.timebase);

      if (isFinite(timebase) && timebase > 0) {
        return timebase / TICKS_PER_SECOND;
      }
    } catch (_) { }

    try {
      var settings = seq.getSettings ? seq.getSettings() : null;
      var duration = settings && settings.videoFrameRate
        ? timeToSeconds(settings.videoFrameRate)
        : NaN;

      if (isFinite(duration) && duration > 0) {
        return duration;
      }
    } catch (_) { }

    throw new Error("Could not determine the sequence frame duration.");
  }

  function sequencePlayheadSeconds(seq) {
    if (!seq.getPlayerPosition) {
      throw new Error("Premiere did not expose the playhead position.");
    }

    return timeToSeconds(seq.getPlayerPosition());
  }

  function clipName(clip, index) {
    return String(
      safeRead(clip, "name", "") ||
      safeRead(safeRead(clip, "projectItem", null), "name", "") ||
      "Clip " + (index + 1)
    );
  }

  function projectKey() {
    var project = app.project;
    var path = String(safeRead(project, "path", ""));
    var documentId = String(safeRead(project, "documentID", ""));

    if (path) {
      return "path:" + path;
    }

    return documentId
      ? "document:" + documentId
      : "unsaved:" + SESSION_ID;
  }

  function sequenceKey(seq) {
    var id = safeRead(seq, "sequenceID", "");

    if (id !== "") {
      return String(id);
    }

    return "name:" + String(safeRead(seq, "name", ""));
  }

  function projectItemId(clip) {
    var item = safeRead(clip, "projectItem", null);
    return String(
      safeRead(item, "nodeId", "") ||
      safeRead(item, "treePath", "")
    );
  }

  function trackItemId(clip) {
    return String(safeRead(clip, "nodeId", ""));
  }

  function mediaType(clip) {
    return normalizedName(safeRead(clip, "mediaType", ""));
  }

  function clipTimelineRange(clip) {
    var start = timeToSeconds(clip.start);
    var end = timeToSeconds(clip.end);

    if (end <= start) {
      throw new Error("Clip has an invalid timeline range.");
    }

    return {
      start: start,
      end: end,
      duration: end - start
    };
  }

  function clipIdentity(clip, seq) {
    return [
      projectKey(),
      sequenceKey(seq),
      trackItemId(clip),
      projectItemId(clip),
      timeToSeconds(clip.start).toFixed(9),
      timeToSeconds(clip.end).toFixed(9),
      timeToSeconds(clip.inPoint).toFixed(9),
      timeToSeconds(clip.outPoint).toFixed(9),
      mediaType(clip)
    ].join("|");
  }

  function samePhysicalTrackItem(a, b) {
    if (!a || !b) {
      return false;
    }

    if (a === b) {
      return true;
    }

    var firstId = trackItemId(a);
    var secondId = trackItemId(b);

    return !!firstId && !!secondId && firstId === secondId;
  }

  function selectionFlag(clip) {
    try {
      var selected = clip.isSelected;

      if (typeof selected === "function") {
        return { available: true, selected: !!clip.isSelected() };
      }

      if (typeof selected === "boolean" || typeof selected === "number") {
        return { available: true, selected: !!selected };
      }

      // ExtendScript host methods do not always report "function".
      if (selected) {
        return { available: true, selected: !!clip.isSelected() };
      }
    } catch (_) { }

    return { available: false, selected: false };
  }

  function getSelectionItems(seq) {
    var items = [];

    try {
      var selection = seq.getSelection ? seq.getSelection() : null;

      if (selection) {
        for (var i = 0; i < selection.length; i++) {
          if (selection[i]) {
            items.push(selection[i]);
          }
        }
      }
    } catch (_) { }

    return items;
  }

  function selectedByReference(clip, selectedItems) {
    var state = selectionFlag(clip);

    if (state.available) {
      return state.selected;
    }

    for (var i = 0; i < selectedItems.length; i++) {
      if (samePhysicalTrackItem(clip, selectedItems[i])) {
        return true;
      }
    }

    return false;
  }

  function getSelectedClipRefs(seq, videoOnly) {
    var result = [];
    var selection = getSelectionItems(seq);
    var groups = videoOnly
      ? [{ tracks: seq.videoTracks, type: "video" }]
      : [
        { tracks: seq.audioTracks, type: "audio" },
        { tracks: seq.videoTracks, type: "video" }
      ];

    for (var g = 0; g < groups.length; g++) {
      var tracks = groups[g].tracks;

      if (!tracks) {
        continue;
      }

      for (var t = 0; t < tracks.numTracks; t++) {
        var track = tracks[t];

        if (!track || !track.clips) {
          continue;
        }

        for (var c = 0; c < track.clips.numItems; c++) {
          var clip = track.clips[c];

          if (!clip || !selectedByReference(clip, selection)) {
            continue;
          }

          result.push({
            clip: clip,
            trackIndex: t,
            clipIndex: c,
            mediaType: groups[g].type,
            name: clipName(clip, c),
            identity: clipIdentity(clip, seq),
            projectKey: projectKey(),
            sequenceId: sequenceKey(seq)
          });
        }
      }
    }

    return result;
  }

  function getSelectedVideoClipRefs(seq) {
    return getSelectedClipRefs(seq, true);
  }

  function requireSelectedVideoRefs(seq) {
    var refs = getSelectedVideoClipRefs(seq);

    if (!refs.length) {
      throw new Error("Select at least one video clip in the active sequence.");
    }

    return refs;
  }

  function sameLogicalMediaRange(a, b) {
    return (
      projectItemId(a) !== "" &&
      projectItemId(a) === projectItemId(b) &&
      sameNumber(
        timeToSeconds(a.start),
        timeToSeconds(b.start),
        TIME_EPSILON
      ) &&
      sameNumber(
        timeToSeconds(a.end),
        timeToSeconds(b.end),
        TIME_EPSILON
      ) &&
      sameNumber(
        timeToSeconds(a.inPoint),
        timeToSeconds(b.inPoint),
        TIME_EPSILON
      ) &&
      sameNumber(
        timeToSeconds(a.outPoint),
        timeToSeconds(b.outPoint),
        TIME_EPSILON
      )
    );
  }

  function explicitlyLinked(a, b) {
    try {
      if (!a.getLinkedItems) {
        return false;
      }

      var linked = a.getLinkedItems();

      if (!linked) {
        return false;
      }

      var count = linked.length !== undefined
        ? linked.length
        : linked.numItems;

      for (var i = 0; i < count; i++) {
        if (samePhysicalTrackItem(linked[i], b)) {
          return true;
        }
      }
    } catch (_) { }

    return false;
  }

  function getExactlyOneSelectedClip() {
    var seq = requireActiveSequence();
    var refs = getSelectedClipRefs(seq, false);
    var eligible = [];
    var i;

    for (i = 0; i < refs.length; i++) {
      if (refs[i].clip.projectItem) {
        eligible.push(refs[i]);
      }
    }

    if (!eligible.length) {
      throw new Error("Select one audio or linked media clip first.");
    }

    if (eligible.length === 1) {
      return eligible[0].clip;
    }

    var first = eligible[0];
    var allExplicitlyLinked = true;

    for (i = 1; i < eligible.length; i++) {
      if (
        !sameLogicalMediaRange(first.clip, eligible[i].clip) ||
        !(
          explicitlyLinked(first.clip, eligible[i].clip) ||
          explicitlyLinked(eligible[i].clip, first.clip)
        )
      ) {
        allExplicitlyLinked = false;
        break;
      }
    }

    if (allExplicitlyLinked) {
      return first.clip;
    }

    /*
     * Compatibility fallback: exactly one audio + one video item with
     * identical media/source/timeline ranges. This is a linkage heuristic.
     * Multiple same-type items are deliberately not collapsed.
     */
    if (
      eligible.length === 2 &&
      eligible[0].mediaType !== eligible[1].mediaType &&
      sameLogicalMediaRange(eligible[0].clip, eligible[1].clip)
    ) {
      return eligible[0].mediaType === "audio"
        ? eligible[0].clip
        : eligible[1].clip;
    }

    throw new Error(
      "Select exactly one media clip. If linked multi-channel audio is " +
      "ambiguous, select only its audio or video TrackItem."
    );
  }

  function getMediaPath(projectItem) {
    if (!projectItem || !projectItem.getMediaPath) {
      return "";
    }

    return String(projectItem.getMediaPath() || "");
  }

  function clipIsReversed(clip) {
    try {
      if (clip.isSpeedReversed) {
        return !!clip.isSpeedReversed();
      }
    } catch (_) { }

    try {
      var item = clip.projectItem;
      var interpretation = item && item.getFootageInterpretation
        ? item.getFootageInterpretation()
        : null;

      return !!(interpretation && interpretation.reverse);
    } catch (_) { }

    return false;
  }

  function getClipInfo(clip) {
    var seq = requireActiveSequence();
    var mediaPath = getMediaPath(clip.projectItem);

    if (!mediaPath) {
      throw new Error("Could not read the selected clip's media path.");
    }

    var range = clipTimelineRange(clip);
    var inPoint = timeToSeconds(clip.inPoint);
    var outPoint = timeToSeconds(clip.outPoint);
    var sourceDuration = outPoint - inPoint;

    if (sourceDuration <= 0) {
      throw new Error("Selected clip has an invalid source range.");
    }

    var speed = null;

    try {
      if (clip.getSpeed) {
        var reportedSpeed = Number(clip.getSpeed());

        if (isFinite(reportedSpeed)) {
          speed = reportedSpeed;
        }
      }
    } catch (_) { }

    return {
      identity: clipIdentity(clip, seq),
      name: clipName(clip, 0),
      mediaPath: mediaPath,
      projectKey: projectKey(),
      projectItemNodeId: projectItemId(clip),
      trackItemNodeId: trackItemId(clip),
      sequenceId: sequenceKey(seq),
      startSeconds: range.start,
      endSeconds: range.end,
      inPointSeconds: inPoint,
      outPointSeconds: outPoint,
      sourceDurationSeconds: sourceDuration,
      timelineDurationSeconds: range.duration,
      durationSeconds: sourceDuration,

      // Kept for bridge compatibility: timeline seconds per source second.
      playbackRate: range.duration / sourceDuration,

      speed: speed,
      reversed: clipIsReversed(clip),
      variableTimeRemap: !!safeRead(clip, "timeRemappingEnabled", false)
    };
  }

  function verifyClipInfo(payload, info) {
    var identityFields = [
      "identity",
      "mediaPath",
      "projectKey",
      "projectItemNodeId",
      "trackItemNodeId",
      "sequenceId"
    ];

    for (var i = 0; i < identityFields.length; i++) {
      var field = identityFields[i];

      if (
        payload[field] !== undefined &&
        String(payload[field]) !== String(info[field])
      ) {
        throw new Error(
          "Selection changed after analysis. Re-select the analyzed clip " +
          "or run analysis again."
        );
      }
    }

    var timeFields = [
      "startSeconds",
      "endSeconds",
      "inPointSeconds",
      "outPointSeconds"
    ];

    for (i = 0; i < timeFields.length; i++) {
      field = timeFields[i];

      if (
        payload[field] !== undefined &&
        !sameNumber(
          finiteNumber(payload[field], field),
          info[field],
          0.002
        )
      ) {
        throw new Error(
          "Selected clip timing changed after analysis. Run analysis again."
        );
      }
    }
  }

  function assertRefCurrent(ref) {
    var seq = requireActiveSequence();

    if (
      ref.projectKey !== projectKey() ||
      ref.sequenceId !== sequenceKey(seq) ||
      ref.identity !== clipIdentity(ref.clip, seq)
    ) {
      throw new Error("The selected clip changed during the operation.");
    }

    return seq;
  }

  function assertPlayheadInsideClip(ref, seconds) {
    var range = clipTimelineRange(ref.clip);

    if (seconds < range.start || seconds >= range.end) {
      throw new Error(
        "Move the playhead over the selected clip before running Auto Color."
      );
    }
  }

  function assertNormalSpeed(clip, seq, operation) {
    if (clipIsReversed(clip)) {
      throw new Error(operation + " does not support reversed clips.");
    }

    if (safeRead(clip, "timeRemappingEnabled", false)) {
      throw new Error(
        operation + " does not support variable time-remapped clips."
      );
    }

    var range = clipTimelineRange(clip);
    var sourceDuration =
      timeToSeconds(clip.outPoint) - timeToSeconds(clip.inPoint);
    var tolerance = Math.max(TIME_EPSILON, activeFrameDuration(seq) * 0.01);

    if (!sameNumber(sourceDuration, range.duration, tolerance)) {
      throw new Error(
        operation + " currently requires a normal-speed clip."
      );
    }

    try {
      if (clip.getSpeed) {
        var speed = Number(clip.getSpeed());

        if (isFinite(speed) && Math.abs(speed - 1) > 0.000001) {
          throw new Error(
            operation + " currently requires a normal-speed clip."
          );
        }
      }
    } catch (error) {
      if (
        errorMessage(error).indexOf("currently requires") >= 0
      ) {
        throw error;
      }
    }
  }

  /*
   * Effect and parameter discovery.
   */

  function propertyMatches(prop, aliases) {
    var display = canonicalName(safeRead(prop, "displayName", ""));
    var match = canonicalName(safeRead(prop, "matchName", ""));

    for (var i = 0; i < aliases.length; i++) {
      var alias = canonicalName(aliases[i]);

      if (alias && (display === alias || match === alias)) {
        return true;
      }
    }

    return false;
  }

  function collectProperties(container, aliases, depth, found) {
    if (!container || !container.properties || depth > 8) {
      return;
    }

    for (var i = 0; i < container.properties.numItems; i++) {
      var prop = container.properties[i];

      if (!prop) {
        continue;
      }

      if (prop.setValue && propertyMatches(prop, aliases)) {
        found.push(prop);
      }

      collectProperties(prop, aliases, depth + 1, found);
    }
  }

  function findProperty(container, aliases) {
    var found = [];
    collectProperties(container, aliases, 0, found);

    if (found.length > 1) {
      throw new Error(
        "Ambiguous effect property: " + aliases.join(" / ")
      );
    }

    return found.length ? found[0] : null;
  }

  function setProperty(component, aliases, value, updateUI) {
    var prop = findProperty(component, aliases);

    if (!prop) {
      return false;
    }

    requireHostSuccess(
      prop.setValue(
        finiteNumber(value, aliases[0]),
        updateUI === false ? 0 : 1
      ),
      "Set " + aliases[0]
    );

    return true;
  }

  function findScalePropertyOnComponent(component) {
    return findProperty(component, [
      "ADBE Scale",
      "Scale",
      "Scale Height",
      "Scale (Height)",
      "Scale_Height",
      "Skalierung",
      "Skalierungshöhe",
      "Échelle",
      "Hauteur d'échelle",
      "Escala",
      "Altura de escala",
      "缩放",
      "高度缩放",
      "拡大縮小",
      "高さの拡大縮小"
    ]);
  }

  function findUniformScalePropertyOnComponent(component) {
    return findProperty(component, [
      "ADBE Uniform Scale",
      "Uniform Scale",
      "Uniform",
      "Einheitliche Skalierung",
      "Échelle uniforme",
      "Escala uniforme",
      "等比缩放"
    ]);
  }

  function isTransformComponent(component) {
    var match = normalizedName(safeRead(component, "matchName", ""));
    var display = normalizedName(safeRead(component, "displayName", ""));

    var matches = {
      "adbe transform": true,
      "ae.adbe transform": true,
      "ae.adbe geometry2": true,
      "com.autocutstudio.transform": true
    };

    var displays = {
      "transform": true,
      "transformation": true,
      "transformieren": true,
      "autocutstudio transform": true
    };

    return (
      (owns(matches, match) && matches[match]) ||
      (owns(displays, display) && displays[display])
    );
  }

  function isAutoCutColorComponent(component) {
    var match = canonicalName(safeRead(component, "matchName", ""));
    var display = canonicalName(safeRead(component, "displayName", ""));
    var names = {
      "autocutstudio color engine": true,
      "autocutstudiocolorengine": true,
      "autocut color engine": true,
      "autocutcolorengine": true,
      "com.autocutstudio.color.engine": true
    };

    return (
      (owns(names, match) && names[match]) ||
      (owns(names, display) && names[display])
    );
  }

  function findComponents(clip, predicate) {
    var found = [];

    if (!clip || !clip.components) {
      return found;
    }

    for (var i = 0; i < clip.components.numItems; i++) {
      var component = clip.components[i];

      if (predicate(component)) {
        found.push(component);
      }
    }

    return found;
  }

  function findAutoCutColorComponent(clip) {
    var found = findComponents(clip, isAutoCutColorComponent);

    if (found.length > 1) {
      throw new Error(
        "Multiple AutoCutStudio Color Engine effects were found. " +
        "Keep one engine instance before applying Auto Color."
      );
    }

    return found.length ? found[0] : null;
  }

  function enableQEProject() {
    if (!app.enableQE) {
      throw new Error("Premiere QE DOM is unavailable.");
    }

    app.enableQE();

    if (typeof qe === "undefined" || !qe.project) {
      throw new Error("Premiere QE project API is unavailable.");
    }

    return qe.project;
  }

  function getVideoEffectByNames(names, label) {
    var project = enableQEProject();

    if (!project.getVideoEffectByName) {
      throw new Error("QE effect lookup is unavailable.");
    }

    for (var i = 0; i < names.length; i++) {
      try {
        var effect = project.getVideoEffectByName(names[i]);

        if (effect) {
          return effect;
        }
      } catch (_) { }
    }

    throw new Error(
      "Could not find " + label + " in this Premiere installation."
    );
  }

  function resolveQEVideoClip(ref) {
    var seq = assertRefCurrent(ref);
    var project = enableQEProject();
    var qeSeq = project.getActiveSequence();

    if (!qeSeq || !qeSeq.getVideoTrackAt) {
      throw new Error("QE active sequence is unavailable.");
    }

    var track = qeSeq.getVideoTrackAt(ref.trackIndex);

    if (!track || !track.getItemAt) {
      throw new Error("QE video track is unavailable.");
    }

    var range = clipTimelineRange(ref.clip);
    var count = Number(track.numItems);

    if (!isFinite(count) || count < 0) {
      throw new Error("QE track returned an invalid item count.");
    }

    var tolerance = Math.max(
      TIME_EPSILON,
      activeFrameDuration(seq) / 100
    );
    var matches = [];

    for (var i = 0; i < count; i++) {
      var item = track.getItemAt(i);

      if (!item || !item.addVideoEffect) {
        continue;
      }

      var start = tryTimeToSeconds(item.start);
      var end = tryTimeToSeconds(item.end);

      if (
        sameNumber(start, range.start, tolerance) &&
        sameNumber(end, range.end, tolerance)
      ) {
        matches.push(item);
      }
    }

    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? "QE clip lookup is ambiguous; no effect was changed."
          : "Could not safely identify the selected clip through QE."
      );
    }

    return matches[0];
  }

  function addVideoEffect(ref, effect) {
    var qeClip = resolveQEVideoClip(ref);
    var result = qeClip.addVideoEffect(effect);

    if (result === false) {
      throw new Error("Premiere rejected the video effect.");
    }
  }

  function ensureAutoCutColorComponent(ref) {
    var existing = findAutoCutColorComponent(ref.clip);
    var pendingKey = "color:" + ref.identity;

    if (existing) {
      delete pendingEffects[pendingKey];
      return existing;
    }

    if (owns(pendingEffects, pendingKey)) {
      return null;
    }

    var effect = getVideoEffectByNames(
      ["AutoCutStudio Color Engine"],
      "AutoCutStudio Color Engine"
    );

    pendingEffects[pendingKey] = true;

    try {
      addVideoEffect(ref, effect);
    } catch (error) {
      // Keep pending state if QE may have partially applied the effect.
      throw new Error(
        "Could not confirm Color Engine insertion. Check Effect Controls " +
        "before retrying. " + errorMessage(error)
      );
    }

    existing = findAutoCutColorComponent(ref.clip);

    if (existing) {
      delete pendingEffects[pendingKey];
    }

    return existing;
  }

  /*
   * Motion ownership is intentionally session-local.
   * Persistent component indexes are diagnostic metadata, not authority.
   */

  function componentStillAttached(clip, component) {
    if (!clip || !clip.components) {
      return false;
    }

    for (var i = 0; i < clip.components.numItems; i++) {
      if (clip.components[i] === component) {
        return true;
      }
    }

    return false;
  }

  function findMotionOwner(ref) {
    for (var i = 0; i < motionOwners.length; i++) {
      var owner = motionOwners[i];

      if (
        owner.identity === ref.identity &&
        owner.projectKey === ref.projectKey &&
        owner.sequenceId === ref.sequenceId &&
        owner.trackIndex === ref.trackIndex &&
        componentStillAttached(ref.clip, owner.component)
      ) {
        return owner;
      }
    }

    return null;
  }

  function ensureMotionOwner(ref) {
    var owner = findMotionOwner(ref);

    if (owner) {
      return owner;
    }

    var pendingKey = "motion:" + ref.identity;

    if (owns(pendingEffects, pendingKey)) {
      throw new Error(
        "A Transform insertion is awaiting confirmation. Check Effect " +
        "Controls; no additional Transform was added."
      );
    }

    var clip = ref.clip;
    var before = clip.components ? clip.components.numItems : 0;
    var effect = getVideoEffectByNames(
      [
        "Transform",
        "ADBE Transform",
        "AE.ADBE Transform",
        "Transformation",
        "Transformieren"
      ],
      "Premiere Transform"
    );

    pendingEffects[pendingKey] = true;
    addVideoEffect(ref, effect);

    if (
      !clip.components ||
      clip.components.numItems !== before + 1 ||
      !isTransformComponent(clip.components[before])
    ) {
      throw new Error(
        "Transform insertion could not be confirmed safely. Check Effect " +
        "Controls before retrying."
      );
    }

    var component = clip.components[before];

    owner = {
      identity: ref.identity,
      projectKey: ref.projectKey,
      sequenceId: ref.sequenceId,
      trackIndex: ref.trackIndex,
      component: component,
      scale: null,
      baselineScale: null,
      keys: [],
      interpolationType: 0,
      preset: ""
    };

    motionOwners.push(owner);
    delete pendingEffects[pendingKey];

    return owner;
  }

  /*
   * Cross-platform diagnostic ledger.
   */

  function ensureFolder(folder) {
    if (folder.exists) {
      return;
    }

    var parent = folder.parent;

    if (parent && !parent.exists && parent.fsName !== folder.fsName) {
      ensureFolder(parent);
    }

    if (!folder.create() && !folder.exists) {
      throw new Error("Could not create state directory: " + folder.fsName);
    }
  }

  function motionLedgerPath() {
    var directory = new Folder(
      Folder.userData.fsName + "/AutoCutStudio/state/v2"
    );

    ensureFolder(directory);
    return new File(directory.fsName + "/motion-ledger.json");
  }

  function readMotionLedger() {
    var file = motionLedgerPath();

    if (!file.exists) {
      return [];
    }

    file.encoding = "UTF-8";

    if (!file.open("r")) {
      throw new Error("Could not open motion ledger: " + file.error);
    }

    var text;

    try {
      text = file.read();
    } finally {
      file.close();
    }

    if (!text.length) {
      return [];
    }

    var records = Codec.parse(text);

    if (!isArray(records)) {
      throw new Error("Motion ledger is not a JSON array.");
    }

    return records;
  }

  function writeMotionLedger(records) {
    var file = motionLedgerPath();
    var temp = new File(file.fsName + "." + SESSION_ID + ".tmp");
    var backup = new File(file.fsName + ".bak");
    var text = Codec.stringify(records);

    temp.encoding = "UTF-8";

    if (!temp.open("w")) {
      throw new Error("Could not open temporary motion ledger.");
    }

    try {
      if (!temp.write(text)) {
        throw new Error("Could not write temporary motion ledger.");
      }
    } finally {
      temp.close();
    }

    if (file.exists) {
      if (backup.exists && !backup.remove()) {
        temp.remove();
        throw new Error("Could not replace motion ledger backup.");
      }

      if (!file.copy(backup.fsName)) {
        temp.remove();
        throw new Error("Could not back up motion ledger.");
      }

      if (!file.remove()) {
        temp.remove();
        throw new Error("Could not replace motion ledger.");
      }
    }

    if (!temp.rename(file.name)) {
      if (backup.exists) {
        backup.copy(file.fsName);
      }

      temp.remove();
      throw new Error("Could not commit motion ledger.");
    }

    if (backup.exists) {
      backup.remove();
    }
  }

  function persistMotionOwner(ref, owner) {
    var records = readMotionLedger();
    var next = [];
    var keyTimes = [];
    var keyValues = [];

    for (var i = 0; i < records.length; i++) {
      var record = records[i];

      if (
        record &&
        record.projectKey === ref.projectKey &&
        record.identity === ref.identity &&
        record.trackIndex === ref.trackIndex &&
        record.sessionId === SESSION_ID
      ) {
        continue;
      }

      next.push(record);
    }

    for (i = 0; i < owner.keys.length; i++) {
      keyTimes.push(owner.keys[i][0]);
      keyValues.push(owner.keys[i][1]);
    }

    next.push({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      sessionId: SESSION_ID,
      projectKey: ref.projectKey,
      identity: ref.identity,
      sequenceId: ref.sequenceId,
      projectItemNodeId: projectItemId(ref.clip),
      trackItemNodeId: trackItemId(ref.clip),
      trackIndex: ref.trackIndex,
      preset: owner.preset,
      generatedScaleKeys: keyTimes,
      generatedScaleValues: keyValues,
      updatedAt: new Date().getTime(),
      ownershipPolicy: "current-session-only"
    });

    if (next.length > MAX_LEDGER_RECORDS) {
      next = next.slice(next.length - MAX_LEDGER_RECORDS);
    }

    writeMotionLedger(next);
  }

  function deleteMotionLedgerForRef(ref) {
    var records = readMotionLedger();
    var next = [];

    for (var i = 0; i < records.length; i++) {
      var record = records[i];

      if (
        record &&
        record.projectKey === ref.projectKey &&
        record.identity === ref.identity &&
        record.trackIndex === ref.trackIndex &&
        record.sessionId === SESSION_ID
      ) {
        continue;
      }

      next.push(record);
    }

    if (next.length !== records.length) {
      writeMotionLedger(next);
    }
  }

  /*
   * Scale animation.
   */

  var ZOOM_BASES = {
    smooth_in: 108,
    smooth_out: 108,
    drift: 105,
    breath: 106,
    reveal: 112,
    settle_in: 114,
    punch_in: 118,
    punch_out: 116,
    pulse: 112,
    snap_back: 120
  };

  function boundedZoom(value) {
    return clamp(finiteNumber(value, "Zoom"), 101, 150);
  }

  function isSupportedZoomStyle(style) {
    return owns(ZOOM_BASES, style);
  }

  function isFastZoomStyle(style) {
    return (
      style === "punch_in" ||
      style === "punch_out" ||
      style === "pulse" ||
      style === "snap_back"
    );
  }

  function durationZoomScale(style, duration) {
    var fast = isFastZoomStyle(style);

    if (duration < 0.35) return fast ? 0.52 : 0.62;
    if (duration < 0.75) return fast ? 0.72 : 0.78;
    if (duration < 1.25) return fast ? 0.88 : 0.92;
    if (duration > 12) return fast ? 0.82 : 1.28;
    if (duration > 6) return fast ? 0.90 : 1.16;
    if (duration > 3.5) return fast ? 0.96 : 1.08;

    return 1;
  }

  function resolveZoomTarget(zoom, style, duration, autoRatio) {
    if (!autoRatio) {
      return boundedZoom(zoom);
    }

    return boundedZoom(
      100 +
      (ZOOM_BASES[style] - 100) * durationZoomScale(style, duration)
    );
  }

  function buildZoomKeys(style, start, end, zoom) {
    var duration = end - start;

    if (!isFinite(duration) || duration <= 0) {
      throw new Error("Clip is too short for a two-keyframe animation.");
    }

    var soft = 100 + (zoom - 100) * 0.45;
    var drift = 100 + (zoom - 100) * 0.30;
    var breath = 100 + (zoom - 100) * 0.22;
    var overshoot = boundedZoom(100 + (zoom - 100) * 1.18);

    var presets = {
      smooth_in: [[0, 100], [1, zoom]],
      smooth_out: [[0, zoom], [1, 100]],
      drift: [[0, 100], [1, drift]],
      breath: [[0, 100], [0.50, breath], [1, 100]],
      reveal: [[0, zoom], [0.62, zoom], [1, 100]],
      settle_in: [
        [0, 100],
        [0.22, overshoot],
        [0.55, soft],
        [1, zoom]
      ],
      punch_in: [
        [0, 100],
        [0.08, zoom],
        [0.28, soft],
        [1, soft]
      ],
      punch_out: [[0, zoom], [0.10, 100], [1, 100]],
      pulse: [
        [0, 100],
        [0.18, zoom],
        [0.38, 100],
        [0.62, soft],
        [1, 100]
      ],
      snap_back: [
        [0, 100],
        [0.10, zoom],
        [0.30, 100],
        [1, 100]
      ]
    };

    if (!owns(presets, style)) {
      throw new Error("Unsupported Scale movement: " + style);
    }

    var preset = presets[style];
    var result = [];

    for (var i = 0; i < preset.length; i++) {
      result.push([
        start + duration * preset[i][0],
        preset[i][1]
      ]);
    }

    return result;
  }

  function frameAlignKeys(keys, start, end, frameDuration) {
    var result = [];
    var lastFrame = Math.round((end - start) / frameDuration);

    for (var i = 0; i < keys.length; i++) {
      var frameIndex = clamp(
        Math.round((keys[i][0] - start) / frameDuration),
        0,
        lastFrame
      );

      var key = [
        start + frameIndex * frameDuration,
        keys[i][1]
      ];

      if (
        result.length &&
        sameNumber(
          result[result.length - 1][0],
          key[0],
          TIME_EPSILON
        )
      ) {
        // Keep the first endpoint if a very short clip collapses keys.
        if (frameIndex !== 0) {
          result[result.length - 1] = key;
        }
      } else {
        result.push(key);
      }
    }

    if (result.length < 2) {
      throw new Error("Clip is too short for two distinct animation frames.");
    }

    return result;
  }

  function getPropertyKeys(prop) {
    if (!prop || !prop.getKeys) {
      throw new Error("Scale does not expose keyframe inspection.");
    }

    var keys = prop.getKeys();

    if (!keys) {
      return [];
    }

    if (keys.length === undefined) {
      throw new Error("Premiere returned an unsupported keyframe collection.");
    }

    var result = [];

    for (var i = 0; i < keys.length; i++) {
      result.push(keys[i]);
    }

    return result;
  }

  function findKeyBySeconds(keys, seconds) {
    for (var i = 0; i < keys.length; i++) {
      if (
        sameNumber(timeToSeconds(keys[i]), seconds, TIME_EPSILON)
      ) {
        return keys[i];
      }
    }

    return null;
  }

  function setKeyframingEnabled(prop, enabled) {
    if (!prop || !prop.setTimeVarying) {
      throw new Error("Scale does not expose keyframing controls.");
    }

    requireHostSuccess(
      prop.setTimeVarying(enabled),
      enabled ? "Enable Scale keyframing" : "Disable Scale keyframing"
    );
  }

  function assertGeneratedKeysUnchanged(owner, allowAdditionalKeys) {
    var prop = owner.scale;
    var existing = getPropertyKeys(prop);

    if (!prop.getValueAtKey) {
      throw new Error("Scale does not expose keyframe value inspection.");
    }

    for (var i = 0; i < owner.keys.length; i++) {
      var expected = owner.keys[i];
      var actualTime = findKeyBySeconds(existing, expected[0]);

      if (!actualTime) {
        throw new Error(
          "Generated Scale keys were moved or removed. Existing edits " +
          "were preserved."
        );
      }

      var actualValue = prop.getValueAtKey(actualTime);

      if (
        typeof actualValue !== "number" ||
        !sameNumber(actualValue, expected[1], VALUE_EPSILON)
      ) {
        throw new Error(
          "Generated Scale values were edited. Existing edits were preserved."
        );
      }
    }

    if (!allowAdditionalKeys && existing.length !== owner.keys.length) {
      throw new Error(
        "Scale contains additional keyframes. Existing edits were preserved."
      );
    }

    return existing;
  }

  function writeScaleKey(prop, key, interpolationType, updateUI) {
    var time = timeFromSeconds(key[0]);

    requireHostSuccess(prop.addKey(time), "Add Scale keyframe");
    requireHostSuccess(
      prop.setValueAtKey(time, key[1], updateUI ? 1 : 0),
      "Set Scale keyframe value"
    );

    if (prop.setInterpolationTypeAtKey) {
      requireHostSuccess(
        prop.setInterpolationTypeAtKey(
          time,
          interpolationType,
          updateUI ? 1 : 0
        ),
        "Set Scale keyframe interpolation"
      );
    }
  }

  function removeKeyAtSeconds(prop, seconds) {
    if (!prop.removeKey) {
      throw new Error("Scale does not expose keyframe removal.");
    }

    var existing = getPropertyKeys(prop);
    var time = findKeyBySeconds(existing, seconds);

    if (!time) {
      return;
    }

    requireHostSuccess(prop.removeKey(time), "Remove Scale keyframe");

    if (findKeyBySeconds(getPropertyKeys(prop), seconds)) {
      throw new Error("Premiere did not remove the Scale keyframe.");
    }
  }

  function configureOwnedTransform(owner, warnings) {
    var component = owner.component;
    var prop = owner.scale;

    if (!prop) {
      prop = findScalePropertyOnComponent(component);

      if (!prop) {
        throw new Error(
          "Premiere Transform > Scale was not exposed. No property index " +
          "fallback was used."
        );
      }

      if (prop.areKeyframesSupported && !prop.areKeyframesSupported()) {
        throw new Error("Transform Scale does not support keyframes.");
      }

      if (
        !prop.getValue ||
        !prop.addKey ||
        !prop.setValueAtKey ||
        !prop.getValueAtKey ||
        !prop.removeKey
      ) {
        throw new Error("Transform Scale keyframe API is incomplete.");
      }

      var baseline = prop.getValue();

      if (typeof baseline !== "number" || !isFinite(baseline)) {
        throw new Error("Transform Scale is not a scalar numeric property.");
      }

      if (getPropertyKeys(prop).length) {
        throw new Error("New Transform unexpectedly contains Scale keys.");
      }

      owner.scale = prop;
      owner.baselineScale = baseline;
    }

    var uniform = findUniformScalePropertyOnComponent(component);

    if (uniform) {
      requireHostSuccess(
        uniform.setValue(1, 0),
        "Enable uniform Transform Scale"
      );
    } else {
      warnings.push(
        "Uniform Scale was not exposed; the Transform default was preserved."
      );
    }

    var useComp = findProperty(component, [
      "Use Composition's Shutter Angle",
      "Use Composition Shutter Angle",
      "Use Composition's Shutter",
      "Use Composition Shutter"
    ]);

    var shutter = findProperty(component, ["Shutter Angle"]);

    if (useComp && shutter) {
      requireHostSuccess(
        useComp.setValue(0, 0),
        "Disable composition shutter angle"
      );
      requireHostSuccess(
        shutter.setValue(180, 1),
        "Set Transform shutter angle"
      );
    } else {
      warnings.push(
        "Shutter controls were not fully exposed; motion blur defaults " +
        "were preserved."
      );
    }

    return prop;
  }

  function replaceOwnedScaleKeys(owner, keys, interpolationType) {
    var prop = owner.scale;

    assertGeneratedKeysUnchanged(owner, false);

    var previous = owner.keys.slice(0);
    var previousInterpolation = owner.interpolationType;
    var attempted = [];

    try {
      for (var i = previous.length - 1; i >= 0; i--) {
        removeKeyAtSeconds(prop, previous[i][0]);
      }

      setKeyframingEnabled(prop, true);

      for (i = 0; i < keys.length; i++) {
        attempted.push(keys[i]);
        writeScaleKey(
          prop,
          keys[i],
          interpolationType,
          i === keys.length - 1
        );
      }

      owner.keys = keys.slice(0);
      owner.interpolationType = interpolationType;
      assertGeneratedKeysUnchanged(owner, false);
    } catch (error) {
      var rollbackErrors = [];

      for (var r = attempted.length - 1; r >= 0; r--) {
        try {
          removeKeyAtSeconds(prop, attempted[r][0]);
        } catch (removeError) {
          rollbackErrors.push(errorMessage(removeError));
        }
      }

      try {
        if (previous.length) {
          setKeyframingEnabled(prop, true);

          for (r = 0; r < previous.length; r++) {
            // Remove any surviving old key before restoring its value.
            removeKeyAtSeconds(prop, previous[r][0]);
            writeScaleKey(
              prop,
              previous[r],
              previousInterpolation,
              r === previous.length - 1
            );
          }
        } else if (!getPropertyKeys(prop).length) {
          setKeyframingEnabled(prop, false);
          requireHostSuccess(
            prop.setValue(owner.baselineScale, 1),
            "Restore Scale baseline"
          );
        }
      } catch (restoreError) {
        rollbackErrors.push(errorMessage(restoreError));
      }

      owner.keys = previous;
      owner.interpolationType = previousInterpolation;

      throw new Error(
        errorMessage(error) +
        (rollbackErrors.length
          ? " Rollback was incomplete: " + rollbackErrors.join("; ")
          : " Previous Scale state was restored.")
      );
    }
  }

  expose("applyGimbalZoom", function (payloadJson) {
    var payload = parsePayload(payloadJson, true);
    var style = payload.style === undefined
      ? "smooth_in"
      : String(payload.style);

    if (!isSupportedZoomStyle(style)) {
      throw new Error("Unsupported Scale movement: " + style);
    }

    var zoom = boundedZoom(
      optionalNumber(payload.zoom, 110, "Zoom")
    );

    var autoRatio = payload.autoRatio !== false;
    var interpolationType = optionalNumber(
      payload.interpolationType,
      0,
      "Interpolation type"
    );

    if (
      interpolationType !== Math.floor(interpolationType) ||
      interpolationType < 0 ||
      interpolationType > 5
    ) {
      throw new Error("Interpolation type must be an integer from 0 to 5.");
    }

    var seq = requireActiveSequence();
    var refs = requireSelectedVideoRefs(seq);
    var frame = activeFrameDuration(seq);
    var applied = 0;
    var skipped = 0;
    var errors = [];
    var warnings = [];

    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];

      try {
        assertRefCurrent(ref);
        assertNormalSpeed(ref.clip, seq, "Gimbal Zoom");

        var range = clipTimelineRange(ref.clip);
        var lastFrameIndex =
          Math.ceil(range.duration / frame - TIME_EPSILON) - 1;

        if (lastFrameIndex < 1) {
          throw new Error("Clip must contain at least two video frames.");
        }

        var sourceStart = timeToSeconds(ref.clip.inPoint);
        var sourceEnd = sourceStart + lastFrameIndex * frame;
        var target = resolveZoomTarget(
          zoom,
          style,
          range.duration,
          autoRatio
        );

        var keys = frameAlignKeys(
          buildZoomKeys(style, sourceStart, sourceEnd, target),
          sourceStart,
          sourceEnd,
          frame
        );

        var owner = ensureMotionOwner(ref);
        var localWarnings = [];

        configureOwnedTransform(owner, localWarnings);
        replaceOwnedScaleKeys(owner, keys, interpolationType);
        owner.preset = style;

        try {
          persistMotionOwner(ref, owner);
        } catch (ledgerError) {
          localWarnings.push(
            "Motion ledger was not saved: " + errorMessage(ledgerError)
          );
        }

        for (var w = 0; w < localWarnings.length; w++) {
          warnings.push(ref.name + ": " + localWarnings[w]);
        }

        applied++;
      } catch (error) {
        skipped++;
        errors.push(ref.name + ": " + errorMessage(error));
      }
    }

    if (!applied) {
      throw new Error(errors.join(" | ") || "No zoom animation was applied.");
    }

    return {
      applied: applied,
      skipped: skipped,
      errors: errors,
      warnings: warnings,
      ownershipPolicy: "current-session-only"
    };
  });

  expose("clearGimbalZoom", function () {
    var seq = requireActiveSequence();
    var refs = requireSelectedVideoRefs(seq);
    var cleared = 0;
    var skipped = 0;
    var errors = [];
    var warnings = [];

    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];

      try {
        assertRefCurrent(ref);

        var owner = findMotionOwner(ref);

        if (!owner || !owner.scale || !owner.keys.length) {
          skipped++;
          errors.push(
            ref.name + ": No current-session owned Scale animation was " +
            "found. Existing Transform effects were preserved."
          );
          continue;
        }

        assertGeneratedKeysUnchanged(owner, true);

        /*
         * Keep ownership synchronized after every successful removal.
         * A partial failure can then be retried without deleting unrelated keys.
         */
        for (var k = owner.keys.length - 1; k >= 0; k--) {
          removeKeyAtSeconds(owner.scale, owner.keys[k][0]);
          owner.keys.splice(k, 1);
        }

        var remaining = getPropertyKeys(owner.scale);

        if (!remaining.length) {
          setKeyframingEnabled(owner.scale, false);
          requireHostSuccess(
            owner.scale.setValue(owner.baselineScale, 1),
            "Restore Scale baseline"
          );
        } else {
          warnings.push(
            ref.name + ": Additional Scale keys were preserved."
          );
        }

        owner.preset = "";

        try {
          deleteMotionLedgerForRef(ref);
        } catch (ledgerError) {
          warnings.push(
            ref.name + ": Ledger cleanup failed: " +
            errorMessage(ledgerError)
          );
        }

        cleared++;
      } catch (error) {
        skipped++;
        errors.push(ref.name + ": " + errorMessage(error));
      }
    }

    if (!cleared) {
      throw new Error(errors.join(" | ") || "No zoom keyframes were cleared.");
    }

    return {
      cleared: cleared,
      skipped: skipped,
      errors: errors,
      warnings: warnings,
      effectsRemoved: 0
    };
  });

  expose("cleanMotionLedger", function () {
    var currentProject = projectKey();
    var records = readMotionLedger();
    var validSequences = {};
    var sequences = app.project.sequences;

    if (!sequences) {
      throw new Error("Premiere did not expose the project's sequences.");
    }

    for (var i = 0; i < sequences.numSequences; i++) {
      validSequences["$" + sequenceKey(sequences[i])] = true;
    }

    var next = [];

    for (i = 0; i < records.length; i++) {
      var record = records[i];

      if (!record || typeof record !== "object") {
        continue;
      }

      // Never prune another project's records using this project's sequences.
      if (
        record.projectKey === currentProject &&
        !owns(validSequences, "$" + String(record.sequenceId))
      ) {
        continue;
      }

      next.push(record);
    }

    var removed = records.length - next.length;

    if (removed) {
      writeMotionLedger(next);
    }

    return {
      removed: removed,
      remaining: next.length
    };
  });

  /*
   * Beat marker operations.
   */

  function markerTarget(payload) {
    var target = payload.target === undefined
      ? "sequence"
      : String(payload.target);

    if (target !== "clip" && target !== "sequence") {
      throw new Error("Marker target must be 'clip' or 'sequence'.");
    }

    return target;
  }

  function clipMarkerCollection(clip) {
    /*
     * Explicitly use source/project-item markers.
     * Do not mix source-time coordinates with an undocumented clip.markers API.
     */
    var item = clip && clip.projectItem;

    if (item && item.getMarkers) {
      var collection = item.getMarkers();

      if (collection) {
        return collection;
      }
    }

    if (item && item.markers) {
      return item.markers;
    }

    throw new Error(
      "Source markers are unavailable for this media. Use sequence markers."
    );
  }

  function markerOwner(target, info) {
    if (target === "clip") {
      // Source markers are shared by all timeline uses of this project item.
      return Codec.stringify([
        info.projectKey,
        info.projectItemNodeId,
        info.mediaPath,
        "source"
      ]);
    }

    return Codec.stringify([
      info.projectKey,
      info.sequenceId,
      info.identity,
      "sequence"
    ]);
  }

  function markerContext(payload) {
    var seq = requireActiveSequence();
    var clip = getExactlyOneSelectedClip();
    var info = getClipInfo(clip);
    var target = markerTarget(payload);

    verifyClipInfo(payload, info);

    var collection = target === "clip"
      ? clipMarkerCollection(clip)
      : seq.markers;

    if (!collection || !collection.getFirstMarker) {
      throw new Error("Marker collection is unavailable.");
    }

    return {
      sequence: seq,
      clip: clip,
      info: info,
      target: target,
      collection: collection,
      owner: markerOwner(target, info),
      start: target === "clip" ? info.inPointSeconds : info.startSeconds,
      end: target === "clip" ? info.outPointSeconds : info.endSeconds,
      includeLegacy: payload.includeLegacy === true
    };
  }

  function markerTimeSeconds(marker) {
    return timeToSeconds(marker.start);
  }

  function markerOwnedByContext(marker, context) {
    var comments = String(marker.comments || "");

    if (comments === MARKER_PREFIX + context.owner) {
      return true;
    }

    // Legacy markers had no per-clip ownership. Only touch them by opt-in.
    return (
      context.includeLegacy &&
      comments === LEGACY_MARKER_SIGNATURE
    );
  }

  function collectMarkers(context) {
    var found = [];
    var marker = context.collection.getFirstMarker();
    var guard = 0;

    while (marker) {
      if (++guard > 1000000) {
        throw new Error("Marker enumeration exceeded its safety limit.");
      }

      var seconds = markerTimeSeconds(marker);

      if (
        seconds >= context.start - TIME_EPSILON &&
        seconds < context.end &&
        markerOwnedByContext(marker, context)
      ) {
        found.push(marker);
      }

      if (!context.collection.getNextMarker) {
        break;
      }

      var next = context.collection.getNextMarker(marker);

      if (next === marker) {
        throw new Error("Premiere returned a cyclic marker iterator.");
      }

      marker = next;
    }

    return found;
  }

  function deleteMarker(collection, marker) {
    if (!collection.deleteMarker) {
      throw new Error("Marker collection does not expose deletion.");
    }

    var result = collection.deleteMarker(marker);

    if (result === false) {
      throw new Error("Premiere rejected marker deletion.");
    }
  }

  function sourceToSequenceTime(seconds, info) {
    if (info.reversed) {
      return (
        info.endSeconds -
        (seconds - info.inPointSeconds) * info.playbackRate
      );
    }

    return (
      info.startSeconds +
      (seconds - info.inPointSeconds) * info.playbackRate
    );
  }

  function snapSequenceMarker(seconds, context) {
    var frame = activeFrameDuration(context.sequence);
    var first = Math.ceil(
      context.info.startSeconds / frame - TIME_EPSILON
    );
    var last = Math.ceil(
      context.info.endSeconds / frame - TIME_EPSILON
    ) - 1;

    if (last < first) {
      throw new Error("Selected clip contains no valid sequence frame.");
    }

    return clamp(Math.round(seconds / frame), first, last) * frame;
  }

  function markerTimeKey(seconds) {
    return "$" + seconds.toFixed(6);
  }

  expose("applyMarkersChunk", function (payloadJson) {
    var payload = parsePayload(payloadJson, false);
    var context = markerContext(payload);
    var events = payload.events === undefined ? [] : payload.events;

    if (!isArray(events)) {
      throw new Error("Marker events must be an array.");
    }

    if (events.length > MAX_MARKER_EVENTS) {
      throw new Error(
        "Too many marker events in one chunk. Maximum: " + MAX_MARKER_EVENTS
      );
    }

    if (!context.collection.createMarker) {
      throw new Error("Marker creation is unavailable.");
    }

    if (
      context.target === "sequence" &&
      context.info.variableTimeRemap
    ) {
      throw new Error(
        "Sequence marker mapping is unavailable for variable time remapping."
      );
    }

    var planned = [];
    var existing = collectMarkers(context);
    var seen = {};
    var skipped = 0;
    var duplicates = 0;
    var i;

    for (i = 0; i < existing.length; i++) {
      seen[markerTimeKey(markerTimeSeconds(existing[i]))] = true;
    }

    // Validate the entire chunk before creating any markers.
    for (i = 0; i < events.length; i++) {
      if (!events[i] || typeof events[i] !== "object") {
        throw new Error("Marker event " + i + " must be an object.");
      }

      var sourceTime = finiteNumber(
        events[i].time,
        "Marker event " + i + " time"
      );

      if (
        sourceTime < context.info.inPointSeconds ||
        sourceTime >= context.info.outPointSeconds
      ) {
        skipped++;
        continue;
      }

      /*
       * Source markers preserve analysis precision. They are not snapped
       * using a potentially unrelated sequence frame rate.
       */
      var markerTime = context.target === "clip"
        ? sourceTime
        : snapSequenceMarker(
          sourceToSequenceTime(sourceTime, context.info),
          context
        );

      var key = markerTimeKey(markerTime);

      if (owns(seen, key)) {
        skipped++;
        duplicates++;
        continue;
      }

      seen[key] = true;
      planned.push(markerTime);
    }

    var applied = 0;
    var createdTimes = [];
    var errors = [];
    var warnings = [];

    for (i = 0; i < planned.length; i++) {
      var marker = null;

      try {
        marker = context.collection.createMarker(planned[i]);

        if (!marker) {
          throw new Error("Premiere did not return the created marker.");
        }

        marker.comments = MARKER_PREFIX + context.owner;
        marker.name = "";

        if (String(marker.comments || "") !== MARKER_PREFIX + context.owner) {
          throw new Error("Could not verify marker ownership metadata.");
        }

        if (marker.setColorByIndex) {
          try {
            marker.setColorByIndex(3, 0);
          } catch (colorError) {
            warnings.push(
              "Marker " + planned[i] + ": " + errorMessage(colorError)
            );
          }
        }

        applied++;
        createdTimes.push(planned[i]);
      } catch (error) {
        if (marker) {
          try {
            deleteMarker(context.collection, marker);
          } catch (cleanupError) {
            warnings.push(
              "An incompletely configured marker may remain at " +
              planned[i] + ": " + errorMessage(cleanupError)
            );
          }
        }

        errors.push(errorMessage(error));
        skipped += planned.length - i;
        break;
      }
    }

    return {
      applied: applied,
      skipped: skipped,
      duplicates: duplicates,
      createdTimes: createdTimes,
      errors: errors,
      warnings: warnings,
      partial: errors.length > 0,
      target: context.target,
      sharedSourceMarkers: context.target === "clip"
    };
  });

  expose("scanMarkers", function (payloadJson) {
    var payload = parsePayload(payloadJson, true);
    var context = markerContext(payload);
    var markers = collectMarkers(context);
    var times = [];

    for (var i = 0; i < markers.length; i++) {
      times.push(markerTimeSeconds(markers[i]));
    }

    return {
      count: times.length,
      times: times,
      target: context.target,
      sharedSourceMarkers: context.target === "clip"
    };
  });

  function removeMarkerList(context, markers) {
    var removed = 0;
    var errors = [];

    for (var i = markers.length - 1; i >= 0; i--) {
      try {
        deleteMarker(context.collection, markers[i]);
        removed++;
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

    return {
      removed: removed,
      failed: errors.length,
      errors: errors,
      partial: errors.length > 0
    };
  }

  expose("removeMarkers", function (payloadJson) {
    var payload = parsePayload(payloadJson, true);
    var context = markerContext(payload);

    return removeMarkerList(context, collectMarkers(context));
  });

  expose("removeMarkersExactTimes", function (payloadJson) {
    var payload = parsePayload(payloadJson, false);
    var context = markerContext(payload);
    var wanted = payload.times === undefined ? [] : payload.times;

    if (!isArray(wanted)) {
      throw new Error("Marker times must be an array.");
    }

    if (wanted.length > MAX_MARKER_EVENTS) {
      throw new Error("Too many marker times in one request.");
    }

    var sorted = [];

    for (var i = 0; i < wanted.length; i++) {
      sorted.push(finiteNumber(wanted[i], "Marker time " + i));
    }

    sorted.sort(function (a, b) {
      return a - b;
    });

    var markers = collectMarkers(context);
    var matches = [];

    for (i = 0; i < markers.length; i++) {
      var seconds = markerTimeSeconds(markers[i]);
      var low = 0;
      var high = sorted.length - 1;
      var found = false;

      while (low <= high) {
        var middle = Math.floor((low + high) / 2);
        var delta = sorted[middle] - seconds;

        if (Math.abs(delta) < 0.0005) {
          found = true;
          break;
        }

        if (delta < 0) {
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      if (found) {
        matches.push(markers[i]);
      }
    }

    return removeMarkerList(context, matches);
  });

  /*
   * Native Auto Color.
   */

  var COLOR_PROPERTIES = [
    { key: "temperature", names: ["temperature"] },
    { key: "tint", names: ["tint"] },
    { key: "exposure", names: ["exposure"] },
    { key: "contrast", names: ["contrast"] },
    { key: "highlights", names: ["highlights"] },
    { key: "shadows", names: ["shadows"] },
    { key: "whites", names: ["whites"] },
    { key: "blacks", names: ["blacks"] },
    { key: "saturation", names: ["saturation"] },
    { key: "vibrance", names: ["vibrance"] },
    {
      key: "shadows_temp",
      names: ["shadows temp", "shadows temp (lift)", "shadows_temp"]
    },
    {
      key: "shadows_tint",
      names: ["shadows tint", "shadows tint (lift)", "shadows_tint"]
    },
    {
      key: "highlights_temp",
      names: [
        "highlights temp",
        "highlights temp (gain)",
        "highlights_temp"
      ]
    },
    {
      key: "highlights_tint",
      names: [
        "highlights tint",
        "highlights tint (gain)",
        "highlights_tint"
      ]
    }
  ];

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

  function getLookModifiers(look, intensity) {
    var amount = clamp(
      optionalNumber(intensity, 1, "Look intensity"),
      0,
      2
    );

    var values = defaultAutoCutColorValues();
    var offsets;

    if (look === "wedding_cinema" || look === "cinematic_warm") {
      offsets = {
        temperature: 14,
        tint: 3,
        contrast: 12,
        highlights: -6,
        shadows: 8,
        whites: 5,
        blacks: -4,
        saturation: 10,
        vibrance: 15,
        highlights_temp: 12,
        shadows_temp: -4,
        shadows_tint: -6
      };
    } else if (look === "skin_tone") {
      offsets = {
        contrast: 8,
        highlights: -4,
        shadows: 4,
        whites: 2,
        blacks: -2,
        vibrance: 10,
        saturation: 4,
        highlights_temp: 2,
        shadows_tint: -2
      };
    } else {
      throw new Error("Unsupported color look: " + look);
    }

    for (var key in offsets) {
      if (owns(offsets, key)) {
        values[key] += Math.round(offsets[key] * amount);
      }
    }

    return values;
  }

  function buildColorPlan(component, values) {
    var writes = [];
    var missing = [];

    for (var i = 0; i < COLOR_PROPERTIES.length; i++) {
      var entry = COLOR_PROPERTIES[i];

      if (values[entry.key] === undefined) {
        continue;
      }

      var value = finiteNumber(values[entry.key], entry.key);
      var prop = findProperty(component, entry.names);

      if (!prop) {
        missing.push(entry.key);
      } else {
        writes.push({
          prop: prop,
          value: value,
          label: entry.key
        });
      }
    }

    if (!writes.length) {
      throw new Error("Color Engine grading properties were not exposed.");
    }

    return {
      writes: writes,
      missing: missing
    };
  }

  function buildCapturePlan(component, token, seconds, autoAmount) {
    var definitions = [
      {
        names: ["frame capture seconds", "capture seconds"],
        value: finiteNumber(seconds, "Capture seconds"),
        label: "capture seconds"
      },
      {
        names: ["auto amount"],
        value: finiteNumber(autoAmount, "Auto amount"),
        label: "auto amount"
      },
      {
        names: ["frame capture token", "capture token"],
        value: finiteNumber(token, "Capture token"),
        label: "capture token"
      }
    ];

    if (definitions[0].value < 0) {
      throw new Error("Capture seconds cannot be negative.");
    }

    var writes = [];

    for (var i = 0; i < definitions.length; i++) {
      var definition = definitions[i];
      var prop = findProperty(component, definition.names);

      if (!prop) {
        throw new Error(
          "Color Engine did not expose " + definition.label + "."
        );
      }

      writes.push({
        prop: prop,
        value: definition.value,
        label: definition.label
      });
    }

    // Capture token is last: configure first, trigger last.
    return writes;
  }

  function applyPropertyWrites(writes) {
    var snapshots = [];
    var i;

    // Validate and snapshot all controls before any mutation.
    for (i = 0; i < writes.length; i++) {
      var write = writes[i];

      if (write.prop.isTimeVarying && write.prop.isTimeVarying()) {
        throw new Error(
          write.label + " is animated. Existing keyframes were preserved."
        );
      }

      if (!write.prop.getValue) {
        throw new Error(write.label + " cannot be read for safe rollback.");
      }

      snapshots.push(write.prop.getValue());
    }

    var attempted = -1;

    try {
      for (i = 0; i < writes.length; i++) {
        attempted = i;

        requireHostSuccess(
          writes[i].prop.setValue(
            writes[i].value,
            i === writes.length - 1 ? 1 : 0
          ),
          "Set " + writes[i].label
        );
      }
    } catch (error) {
      var rollbackErrors = [];

      for (i = attempted; i >= 0; i--) {
        try {
          requireHostSuccess(
            writes[i].prop.setValue(snapshots[i], 1),
            "Restore " + writes[i].label
          );
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }

      throw new Error(
        errorMessage(error) +
        (rollbackErrors.length
          ? " Rollback was incomplete: " + rollbackErrors.join("; ")
          : " Previous parameter values were restored.") +
        " Native analysis side effects, if already triggered, may not be reversible."
      );
    }
  }

  function newCaptureToken() {
    var token =
      ((new Date().getTime() + Math.floor(Math.random() * 99999)) %
        999999) + 1;

    token = Math.floor(token);

    if (token === lastCaptureToken) {
      token = token % 999999 + 1;
    }

    lastCaptureToken = token;
    return token;
  }

  function getClipColorScience(clip) {
    var colorSpace = "Unknown";
    var colorScience = "Unknown";

    try {
      var item = clip.projectItem;
      var space = item && item.getColorSpace ? item.getColorSpace() : null;

      if (space) {
        colorSpace = String(space.name || "Unknown");
        var name = normalizedName(colorSpace);
        var transfer = normalizedName(space.transferCharacteristic);

        if (name.indexOf("log") >= 0 || transfer.indexOf("log") >= 0) {
          colorScience = "Camera Log Curve (" + colorSpace + ")";
        } else if (
          name.indexOf("hlg") >= 0 ||
          name.indexOf("hdr") >= 0 ||
          name.indexOf("pq") >= 0 ||
          transfer.indexOf("hlg") >= 0 ||
          transfer.indexOf("pq") >= 0
        ) {
          colorScience = "High Dynamic Range (" + colorSpace + ")";
        } else {
          colorScience = "SDR / other (" + colorSpace + ")";
        }
      }
    } catch (_) { }

    return {
      colorSpace: colorSpace,
      colorScience: colorScience
    };
  }

  function selectedAutoColorRef() {
    var seq = requireActiveSequence();
    var refs = getSelectedVideoClipRefs(seq);

    if (refs.length !== 1) {
      throw new Error(
        refs.length
          ? "Select exactly one video clip for playhead-frame Auto Color."
          : "Select one video clip in the active sequence."
      );
    }

    return {
      sequence: seq,
      ref: refs[0]
    };
  }

  expose("prepareAutoColorAtPlayhead", function () {
    var selected = selectedAutoColorRef();
    var seconds = sequencePlayheadSeconds(selected.sequence);

    assertPlayheadInsideClip(selected.ref, seconds);
    assertNormalSpeed(
      selected.ref.clip,
      selected.sequence,
      "Playhead-frame Auto Color"
    );

    var component = ensureAutoCutColorComponent(selected.ref);

    return {
      ready: !!component,
      pending: !component
    };
  });

  expose("autoColorSelectedClips", function (payloadJson) {
    var options = parsePayload(payloadJson, true);
    var look = options.look === undefined
      ? "skin_tone"
      : String(options.look);

    var modifiers = getLookModifiers(look, options.intensity);
    var autoAmount = clamp(
      optionalNumber(options.autoAmount, 80, "Auto amount"),
      0,
      100
    );

    var selected = selectedAutoColorRef();
    var ref = selected.ref;
    var seq = selected.sequence;
    var seconds = sequencePlayheadSeconds(seq);

    assertPlayheadInsideClip(ref, seconds);
    assertNormalSpeed(ref.clip, seq, "Playhead-frame Auto Color");

    var component = ensureAutoCutColorComponent(ref);

    if (!component) {
      throw new Error(
        "Color Engine insertion is pending. Wait for Effect Controls to " +
        "update, then retry. No duplicate engine was added."
      );
    }

    /*
     * Native plugin contract retained from the original bridge:
     * capture seconds are relative to the timeline clip start.
     */
    var localSeconds = seconds - timeToSeconds(ref.clip.start);
    var token = newCaptureToken();
    var colorPlan = buildColorPlan(component, modifiers);
    var capturePlan = buildCapturePlan(
      component,
      token,
      localSeconds,
      autoAmount
    );

    // Write look parameters before triggering native frame capture.
    applyPropertyWrites(colorPlan.writes.concat(capturePlan));

    var colorInfo = getClipColorScience(ref.clip);
    var warnings = [];

    if (colorPlan.missing.length) {
      warnings.push(
        "Unavailable look controls: " + colorPlan.missing.join(", ")
      );
    }

    var clipResult = {
      name: ref.name,
      trackIndex: ref.trackIndex,
      clipIndex: ref.clipIndex,
      engine: "AutoCutStudio Native Color Engine (Playhead Frame Grade)",
      usedNativeAuto: true,
      missing: colorPlan.missing,
      warnings: warnings,
      autoAmount: autoAmount,
      look: look,
      captureToken: token,
      captureFrameSeconds: seconds,
      captureLocalSeconds: localSeconds,
      colorSpace: colorInfo.colorSpace,
      colorScience: colorInfo.colorScience,
      captureRequested: true
    };

    return {
      applied: 1,
      skipped: 0,
      errors: [],
      warnings: warnings,
      clips: [clipResult],
      engine: clipResult.engine,
      usedNativeAuto: true,
      autoAmount: autoAmount,
      look: look,
      name: ref.name,
      captureFrameSeconds: seconds,
      colorScience: colorInfo.colorScience,
      captureRequested: true
    };
  });

  expose("resetColorGrade", function () {
    var seq = requireActiveSequence();
    var refs = requireSelectedVideoRefs(seq);
    var defaults = defaultAutoCutColorValues();
    var reset = 0;
    var skipped = 0;
    var errors = [];
    var warnings = [];

    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];

      try {
        assertRefCurrent(ref);

        var components = findComponents(
          ref.clip,
          isAutoCutColorComponent
        );

        if (!components.length) {
          skipped++;
          errors.push(ref.name + ": No AutoCutStudio Color Engine found.");
          continue;
        }

        var plans = [];

        // Preflight all matching engine instances before changing this clip.
        for (var c = 0; c < components.length; c++) {
          var component = components[c];
          var colorPlan = buildColorPlan(component, defaults);
          var capturePlan = buildCapturePlan(component, 0, 0, 0);
          var writes = colorPlan.writes.slice(0);

          var confidence = findProperty(component, [
            "analysis confidence",
            "confidence"
          ]);

          var trigger = findProperty(component, ["auto trigger"]);

          if (confidence) {
            writes.push({
              prop: confidence,
              value: 0,
              label: "analysis confidence"
            });
          }

          if (trigger) {
            writes.push({
              prop: trigger,
              value: 0,
              label: "auto trigger"
            });
          }

          writes = writes.concat(capturePlan);
          plans.push(writes);

          if (colorPlan.missing.length) {
            warnings.push(
              ref.name + ": Unavailable reset controls: " +
              colorPlan.missing.join(", ")
            );
          }
        }

        for (c = 0; c < plans.length; c++) {
          applyPropertyWrites(plans[c]);
        }

        delete pendingEffects["color:" + ref.identity];
        reset++;
      } catch (error) {
        skipped++;
        errors.push(ref.name + ": " + errorMessage(error));
      }
    }

    if (!reset) {
      throw new Error(errors.join(" | ") || "No color controls were reset.");
    }

    return {
      reset: reset,
      skipped: skipped,
      errors: errors,
      warnings: warnings,
      effectsRemoved: 0
    };
  });

  /*
   * Information and diagnostics.
   */

  expose("hostInfo", function () {
    var available = typeof app !== "undefined";

    return {
      bridgeVersion: BRIDGE_VERSION,
      extensionVersion: AUTOCUT_EXTENSION_VERSION,
      hostName: available
        ? String(safeRead(app, "name", "Premiere Pro"))
        : "Unavailable",
      hostVersion: available
        ? String(safeRead(app, "version", "unknown"))
        : "unknown",
      projectAvailable: !!(available && app.project),
      motionOwnershipPolicy: "current-session-only",
      ledgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      markerSchemaVersion: 2
    };
  });

  expose("getSelectedClipInfo", function () {
    return {
      clip: getClipInfo(getExactlyOneSelectedClip())
    };
  });

  expose("getSelectedVideoClipCount", function () {
    var seq = requireActiveSequence();

    return {
      count: getSelectedVideoClipRefs(seq).length
    };
  });

  expose("runDiagnostics", function () {
    var diagnostics = [];

    diagnostics.push("Premiere bridge: OK");
    diagnostics.push("Extension version: " + AUTOCUT_EXTENSION_VERSION);
    diagnostics.push("JSON codec: strict local implementation");
    diagnostics.push("Motion ownership: current session only");
    diagnostics.push("QE removal: disabled for safety");

    if (typeof app === "undefined") {
      diagnostics.push("Host: FAIL - app unavailable");
      return { diagnostics: diagnostics };
    }

    diagnostics.push(
      "Premiere version: " + String(safeRead(app, "version", "unknown"))
    );

    if (!app.project) {
      diagnostics.push("Project: FAIL - app.project unavailable");
      return { diagnostics: diagnostics };
    }

    diagnostics.push("Project key: " + projectKey());

    var seq = app.project.activeSequence;

    if (!seq) {
      diagnostics.push("Sequence: FAIL - no active sequence");
      return { diagnostics: diagnostics };
    }

    diagnostics.push("Sequence: OK - " + String(seq.name));
    diagnostics.push("Sequence ID: " + sequenceKey(seq));

    try {
      diagnostics.push(
        "Frame duration: " + activeFrameDuration(seq) + " seconds"
      );
    } catch (frameError) {
      diagnostics.push("Frame duration: FAIL - " + errorMessage(frameError));
    }

    diagnostics.push(
      "Sequence marker API: " +
      (seq.markers && seq.markers.createMarker ? "OK" : "Unavailable")
    );

    try {
      var videoRefs = getSelectedVideoClipRefs(seq);

      diagnostics.push("Selected video clips: " + videoRefs.length);

      var allRefs = getSelectedClipRefs(seq, false);

      if (!allRefs.length) {
        diagnostics.push("Selection: no clips selected");
      } else {
        var clip = allRefs[0].clip;

        diagnostics.push("Inspected clip: " + allRefs[0].name);
        diagnostics.push("TrackItem node ID: " + trackItemId(clip));
        diagnostics.push("ProjectItem node ID: " + projectItemId(clip));

        try {
          var info = getClipInfo(clip);

          diagnostics.push("Media path: " + info.mediaPath);
          diagnostics.push(
            "Timeline range: " + info.startSeconds + " - " + info.endSeconds
          );
          diagnostics.push(
            "Source range: " + info.inPointSeconds + " - " + info.outPointSeconds
          );
          diagnostics.push("Reverse: " + info.reversed);
          diagnostics.push(
            "Variable time remap flag: " + info.variableTimeRemap
          );
        } catch (infoError) {
          diagnostics.push("Clip info: " + errorMessage(infoError));
        }

        try {
          var markers = clipMarkerCollection(clip);

          diagnostics.push(
            "Source marker API: " +
            (markers && markers.createMarker ? "OK" : "Unavailable")
          );
        } catch (markerError) {
          diagnostics.push("Source marker API: " + errorMessage(markerError));
        }

        diagnostics.push("--- CLIP COMPONENTS ---");

        if (clip.components) {
          diagnostics.push(
            "Component count: " + clip.components.numItems
          );

          for (var c = 0; c < clip.components.numItems; c++) {
            var component = clip.components[c];

            diagnostics.push(
              "Component " + c +
              ": display='" + safeRead(component, "displayName", "") +
              "', match='" + safeRead(component, "matchName", "") + "'"
            );

            if (!component.properties) {
              continue;
            }

            var count = Math.min(component.properties.numItems, 20);

            for (var p = 0; p < count; p++) {
              var prop = component.properties[p];

              diagnostics.push(
                "  Property " + p +
                ": display='" + safeRead(prop, "displayName", "") +
                "', match='" + safeRead(prop, "matchName", "") +
                "', writable=" + !!safeRead(prop, "setValue", false)
              );
            }

            if (component.properties.numItems > count) {
              diagnostics.push(
                "  ... " +
                (component.properties.numItems - count) +
                " additional properties"
              );
            }
          }
        }

        diagnostics.push(
          "AutoCut Color Engine instances: " +
          findComponents(clip, isAutoCutColorComponent).length
        );
      }
    } catch (selectionError) {
      diagnostics.push("Selection: FAIL - " + errorMessage(selectionError));
    }

    try {
      var qeProject = enableQEProject();
      var qeSeq = qeProject.getActiveSequence();

      diagnostics.push("QE DOM: OK");
      diagnostics.push("QE active sequence: " + (qeSeq ? "OK" : "Unavailable"));
    } catch (qeError) {
      diagnostics.push("QE DOM: " + errorMessage(qeError));
    }

    try {
      diagnostics.push("Motion ledger: " + motionLedgerPath().fsName);
      diagnostics.push("Motion ledger records: " + readMotionLedger().length);
    } catch (ledgerError) {
      diagnostics.push("Motion ledger: " + errorMessage(ledgerError));
    }

    diagnostics.push(
      "Legacy marker removal requires payload.includeLegacy = true."
    );
    diagnostics.push(
      "Native capture completion is asynchronous; a successful request " +
      "does not itself verify rendered analysis completion."
    );

    return {
      diagnostics: diagnostics
    };
  });
})();