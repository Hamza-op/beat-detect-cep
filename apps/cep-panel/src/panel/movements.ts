/**
 * Scale-keyframe movement presets used by the panel.
 *
 * Host compatibility:
 * - IDs, base ratios, intensity factors, and duration adjustments mirror
 *   the ExtendScript bridge.
 * - The host does not import this module. Keep both implementations aligned
 *   or generate host preset data from this module during the build.
 *
 * Keyframe positions are percentages of the usable animation interval.
 * The host is responsible for time-coordinate conversion, frame alignment,
 * interpolation, and ownership checks.
 */

export type MovementId =
  | "smooth_in"
  | "smooth_out"
  | "drift"
  | "breath"
  | "reveal"
  | "settle_in"
  | "punch_in"
  | "punch_out"
  | "pulse"
  | "snap_back";

/**
 * A fresh, mutable tuple returned for each generated keyframe.
 *
 * positionPercent: 0–100.
 * scalePercent: Premiere Scale percentage.
 */
export type MovementKeyframe = [positionPercent: number, scalePercent: number];

export interface MovementPreset {
  readonly id: MovementId;
  readonly name: string;
  readonly description: string;

  /**
   * Base target percentage for Auto Ratio.
   * The final target can change with clip duration.
   */
  readonly autoRatio: number;

  /** Whether this is a fast, beat-accent movement. */
  readonly isFast: boolean;

  /**
   * Generate a fresh normalized keyframe pattern.
   *
   * Finite ratios are clamped to 101–150. Invalid numbers throw.
   * Fractional Scale values are preserved to match the host.
   *
   * This method does not apply duration-based Auto Ratio adjustments.
   */
  readonly keyframePattern: (ratio: number) => MovementKeyframe[];
}

export interface MovementOptions {
  /** Matches the host default: true. */
  readonly autoRatio?: boolean;

  /** Manual target percentage. Defaults to 110 when Auto Ratio is off. */
  readonly zoom?: number;

  /**
   * Actual clip duration in seconds, not the normalized keyframe span.
   * A supplied duration must be finite and positive.
   * When omitted, no duration adjustment is applied.
   */
  readonly durationSeconds?: number;
}

export interface ResolvedMovement {
  readonly preset: MovementPreset;
  readonly autoRatio: boolean;
  readonly targetRatio: number;
  readonly keyframes: MovementKeyframe[];
}

export const NEUTRAL_SCALE = 100;
export const MIN_ZOOM_RATIO = 101;
export const MAX_ZOOM_RATIO = 150;
export const DEFAULT_ZOOM_RATIO = 110;
export const DEFAULT_MOVEMENT_ID: MovementId = "smooth_in";

export const MOVEMENT_SCALE_FACTORS = Object.freeze({
  soft: 0.45,
  drift: 0.3,
  breath: 0.22,
  overshoot: 1.18,
});

type ScaleLevel =
  | "neutral"
  | "target"
  | "soft"
  | "drift"
  | "breath"
  | "overshoot";

type PatternPoint = readonly [positionPercent: number, level: ScaleLevel];

interface PresetDefinition {
  readonly id: MovementId;
  readonly name: string;
  readonly description: string;
  readonly autoRatio: number;
  readonly isFast: boolean;
  readonly pattern: readonly PatternPoint[];
}

function assertFiniteNumber(value: number, label: string): number {
  if (typeof value !== "number" || !isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }

  return value;
}

function assertDuration(durationSeconds: number): number {
  assertFiniteNumber(durationSeconds, "Clip duration");

  if (durationSeconds <= 0) {
    throw new RangeError("Clip duration must be greater than zero.");
  }

  return durationSeconds;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Validate and clamp a target ratio without rounding fractional values. */
export function clampZoomRatio(ratio: number): number {
  return clamp(
    assertFiniteNumber(ratio, "Zoom ratio"),
    MIN_ZOOM_RATIO,
    MAX_ZOOM_RATIO,
  );
}

function scaleForLevel(level: ScaleLevel, ratio: number): number {
  switch (level) {
    case "neutral":
      return NEUTRAL_SCALE;

    case "target":
      return ratio;

    case "soft":
      return (
        NEUTRAL_SCALE + (ratio - NEUTRAL_SCALE) * MOVEMENT_SCALE_FACTORS.soft
      );

    case "drift":
      return (
        NEUTRAL_SCALE + (ratio - NEUTRAL_SCALE) * MOVEMENT_SCALE_FACTORS.drift
      );

    case "breath":
      return (
        NEUTRAL_SCALE + (ratio - NEUTRAL_SCALE) * MOVEMENT_SCALE_FACTORS.breath
      );

    case "overshoot":
      return clampZoomRatio(
        NEUTRAL_SCALE +
          (ratio - NEUTRAL_SCALE) * MOVEMENT_SCALE_FACTORS.overshoot,
      );

    default:
      throw new Error(`Unsupported movement scale level: ${String(level)}`);
  }
}

function definePreset(definition: PresetDefinition): MovementPreset {
  assertFiniteNumber(definition.autoRatio, "Preset Auto Ratio");

  if (
    definition.autoRatio < MIN_ZOOM_RATIO ||
    definition.autoRatio > MAX_ZOOM_RATIO
  ) {
    throw new RangeError(
      `Preset "${definition.id}" has an out-of-range Auto Ratio.`,
    );
  }

  if (definition.pattern.length < 2) {
    throw new Error(`Preset "${definition.id}" requires at least two keys.`);
  }

  let previousPosition = -1;

  const pattern: readonly PatternPoint[] = Object.freeze(
    definition.pattern.map((point): PatternPoint => {
      const position = assertFiniteNumber(point[0], "Keyframe position");

      if (position < 0 || position > 100 || position <= previousPosition) {
        throw new Error(
          `Preset "${definition.id}" requires strictly increasing ` +
            "keyframe positions within 0–100.",
        );
      }

      previousPosition = position;

      // Validate scale-level definitions at module initialization.
      scaleForLevel(point[1], definition.autoRatio);

      return Object.freeze([position, point[1]] as [number, ScaleLevel]);
    }),
  );

  if (pattern[0][0] !== 0 || pattern[pattern.length - 1][0] !== 100) {
    throw new Error(
      `Preset "${definition.id}" must start at 0 and end at 100.`,
    );
  }

  return Object.freeze({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    autoRatio: definition.autoRatio,
    isFast: definition.isFast,

    keyframePattern(ratio: number): MovementKeyframe[] {
      const target = clampZoomRatio(ratio);

      return pattern.map(
        (point): MovementKeyframe => [
          point[0],
          scaleForLevel(point[1], target),
        ],
      );
    },
  });
}

export const MOVEMENT_PRESETS: readonly MovementPreset[] = Object.freeze([
  definePreset({
    id: "smooth_in",
    name: "Slow Push-In",
    description:
      "Gradual cinematic emphasis for portraits, vows, and emotional detail shots.",
    autoRatio: 108,
    isFast: false,
    pattern: [
      [0, "neutral"],
      [100, "target"],
    ],
  }),

  definePreset({
    id: "smooth_out",
    name: "Slow Pull-Out",
    description:
      "Elegant release that opens the frame near the end of the shot.",
    autoRatio: 108,
    isFast: false,
    pattern: [
      [0, "target"],
      [100, "neutral"],
    ],
  }),

  definePreset({
    id: "drift",
    name: "Micro Drift",
    description: "Subtle motion for couple portraits and calm beauty shots.",
    autoRatio: 105,
    isFast: false,
    pattern: [
      [0, "neutral"],
      [100, "drift"],
    ],
  }),

  definePreset({
    id: "breath",
    name: "Breathing Hold",
    description: "Soft organic movement that gently returns to neutral.",
    autoRatio: 106,
    isFast: false,
    pattern: [
      [0, "neutral"],
      [50, "breath"],
      [100, "neutral"],
    ],
  }),

  definePreset({
    id: "reveal",
    name: "Hold Then Reveal",
    description: "Held emphasis followed by a graceful reveal.",
    autoRatio: 112,
    isFast: false,
    pattern: [
      [0, "target"],
      [62, "target"],
      [100, "neutral"],
    ],
  }),

  definePreset({
    id: "settle_in",
    name: "Overshoot Settle",
    description: "Refined push with a controlled settle for detail emphasis.",
    autoRatio: 114,
    isFast: false,
    pattern: [
      [0, "neutral"],
      [22, "overshoot"],
      [55, "soft"],
      [100, "target"],
    ],
  }),

  definePreset({
    id: "punch_in",
    name: "Beat Punch-In",
    description: "Strong beat accent for dance entries and energetic cuts.",
    autoRatio: 118,
    isFast: true,
    pattern: [
      [0, "neutral"],
      [8, "target"],
      [28, "soft"],
      [100, "soft"],
    ],
  }),

  definePreset({
    id: "punch_out",
    name: "Beat Punch-Out",
    description: "Fast release after a strong visual or music hit.",
    autoRatio: 116,
    isFast: true,
    pattern: [
      [0, "target"],
      [10, "neutral"],
      [100, "neutral"],
    ],
  }),

  definePreset({
    id: "pulse",
    name: "Double Pulse",
    description: "Controlled rhythmic pulse for claps and dance beats.",
    autoRatio: 112,
    isFast: true,
    pattern: [
      [0, "neutral"],
      [18, "target"],
      [38, "neutral"],
      [62, "soft"],
      [100, "neutral"],
    ],
  }),

  definePreset({
    id: "snap_back",
    name: "Snap Back",
    description: "Sharp percussion accent that quickly returns to neutral.",
    autoRatio: 120,
    isFast: true,
    pattern: [
      [0, "neutral"],
      [10, "target"],
      [30, "neutral"],
      [100, "neutral"],
    ],
  }),
]);

const presetLookup: { [id: string]: MovementPreset | undefined } =
  Object.create(null);

for (const preset of MOVEMENT_PRESETS) {
  if (Object.prototype.hasOwnProperty.call(presetLookup, preset.id)) {
    throw new Error(`Duplicate movement preset ID: ${preset.id}`);
  }

  presetLookup[preset.id] = preset;
}

Object.freeze(presetLookup);

export const MOVEMENT_IDS: readonly MovementId[] = Object.freeze(
  MOVEMENT_PRESETS.map((preset) => preset.id),
);

/** Exact, case-sensitive ID validation. */
export function isMovementId(value: unknown): value is MovementId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(presetLookup, value)
  );
}

/** Look up a preset without silently substituting another movement. */
export function getPreset(id: string): MovementPreset | undefined {
  return isMovementId(id) ? presetLookup[id] : undefined;
}

/** Look up a preset and fail explicitly for unsupported IDs. */
export function requirePreset(id: string): MovementPreset {
  const preset = getPreset(id);

  if (!preset) {
    throw new RangeError(`Unsupported movement preset: ${String(id)}`);
  }

  return preset;
}

/**
 * Duration-based intensity multiplier matching the host.
 * The returned multiplier applies to zoom above neutral, not to total Scale.
 */
export function durationZoomScale(id: string, durationSeconds: number): number {
  const preset = requirePreset(id);
  const duration = assertDuration(durationSeconds);
  const fast = preset.isFast;

  if (duration < 0.35) return fast ? 0.52 : 0.62;
  if (duration < 0.75) return fast ? 0.72 : 0.78;
  if (duration < 1.25) return fast ? 0.88 : 0.92;
  if (duration > 12) return fast ? 0.82 : 1.28;
  if (duration > 6) return fast ? 0.9 : 1.16;
  if (duration > 3.5) return fast ? 0.96 : 1.08;

  return 1;
}

/**
 * Resolve a movement target using the same Auto Ratio rules as the host.
 *
 * Existing panel code can continue using:
 *   getPreset(id)?.keyframePattern(ratio)
 *
 * Duration-aware previews can instead use:
 *   resolveMovement(id, { autoRatio: true, durationSeconds: 8 })
 */
export function resolveZoomTarget(
  id: string,
  options: MovementOptions = {},
): number {
  const preset = requirePreset(id);

  if (
    options.autoRatio !== undefined &&
    typeof options.autoRatio !== "boolean"
  ) {
    throw new TypeError("Auto Ratio must be a boolean.");
  }

  if (options.durationSeconds !== undefined) {
    assertDuration(options.durationSeconds);
  }

  // Validate a supplied manual target even when Auto Ratio ignores it.
  const manualRatio =
    options.zoom === undefined
      ? DEFAULT_ZOOM_RATIO
      : clampZoomRatio(options.zoom);

  if (options.autoRatio === false) {
    return manualRatio;
  }

  const multiplier =
    options.durationSeconds === undefined
      ? 1
      : durationZoomScale(id, options.durationSeconds);

  return clampZoomRatio(
    NEUTRAL_SCALE + (preset.autoRatio - NEUTRAL_SCALE) * multiplier,
  );
}

/** Resolve both the target ratio and a fresh normalized keyframe pattern. */
export function resolveMovement(
  id: string,
  options: MovementOptions = {},
): ResolvedMovement {
  const preset = requirePreset(id);
  const targetRatio = resolveZoomTarget(id, options);

  return {
    preset,
    autoRatio: options.autoRatio !== false,
    targetRatio,
    keyframes: preset.keyframePattern(targetRatio),
  };
}
