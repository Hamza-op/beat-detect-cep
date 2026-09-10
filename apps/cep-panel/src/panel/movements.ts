/**
 * Single source of truth for the ten Scale-keyframe movement presets.
 *
 * Consumed by the panel UI (legacy-main.js) for preview rendering and labels,
 * and referenced by the host (legacy.jsx) via matching `id` strings.
 */

export interface MovementPreset {
  /** Internal identifier, e.g. "smooth_in". */
  readonly id: string;
  /** User-facing name, e.g. "Slow Push-In". */
  readonly name: string;
  /** Short description for the selected-moment card. */
  readonly description: string;
  /** Default zoom percentage when Auto Ratio is enabled. */
  readonly autoRatio: number;
  /** True for beat-accent styles (punch_in, punch_out, pulse, snap_back). */
  readonly isFast: boolean;
  /**
   * Returns the normalised keyframe pattern for this movement.
   *
   * Each point is `[position%, scaleValue]` where position is 0–100 (percent
   * of clip duration) and scaleValue is the Scale percentage at that point.
   *
   * @param ratio - The zoom ratio (101–150) to apply.
   */
  keyframePattern(ratio: number): Array<[number, number]>;
}

function soft(ratio: number): number {
  return Math.round(100 + (ratio - 100) * 0.45);
}

function driftScale(ratio: number): number {
  return Math.round(100 + (ratio - 100) * 0.3);
}

function breathScale(ratio: number): number {
  return Math.round(100 + (ratio - 100) * 0.22);
}

function overshoot(ratio: number): number {
  return Math.min(150, Math.round(100 + (ratio - 100) * 1.18));
}

export const MOVEMENT_PRESETS: readonly MovementPreset[] = [
  {
    id: "smooth_in",
    name: "Slow Push-In",
    description:
      "Gradual cinematic emphasis for portraits, vows, and emotional detail shots.",
    autoRatio: 108,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, 100],
      [100, ratio],
    ],
  },
  {
    id: "smooth_out",
    name: "Slow Pull-Out",
    description:
      "Elegant release that opens the frame near the end of the shot.",
    autoRatio: 108,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, ratio],
      [100, 100],
    ],
  },
  {
    id: "drift",
    name: "Micro Drift",
    description: "Subtle motion for couple portraits and calm beauty shots.",
    autoRatio: 105,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, 100],
      [100, driftScale(ratio)],
    ],
  },
  {
    id: "breath",
    name: "Breathing Hold",
    description: "Soft organic movement that gently returns to neutral.",
    autoRatio: 106,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, 100],
      [50, breathScale(ratio)],
      [100, 100],
    ],
  },
  {
    id: "reveal",
    name: "Hold Then Reveal",
    description: "Held emphasis followed by a graceful reveal.",
    autoRatio: 112,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, ratio],
      [62, ratio],
      [100, 100],
    ],
  },
  {
    id: "settle_in",
    name: "Overshoot Settle",
    description: "Refined push with a controlled settle for detail emphasis.",
    autoRatio: 114,
    isFast: false,
    keyframePattern: (ratio) => [
      [0, 100],
      [22, overshoot(ratio)],
      [55, soft(ratio)],
      [100, ratio],
    ],
  },
  {
    id: "punch_in",
    name: "Beat Punch-In",
    description: "Strong beat accent for dance entries and energetic cuts.",
    autoRatio: 118,
    isFast: true,
    keyframePattern: (ratio) => [
      [0, 100],
      [8, ratio],
      [28, soft(ratio)],
      [100, soft(ratio)],
    ],
  },
  {
    id: "punch_out",
    name: "Beat Punch-Out",
    description: "Fast release after a strong visual or music hit.",
    autoRatio: 116,
    isFast: true,
    keyframePattern: (ratio) => [
      [0, ratio],
      [10, 100],
      [100, 100],
    ],
  },
  {
    id: "pulse",
    name: "Double Pulse",
    description: "Controlled rhythmic pulse for claps and dance beats.",
    autoRatio: 112,
    isFast: true,
    keyframePattern: (ratio) => [
      [0, 100],
      [18, ratio],
      [38, 100],
      [62, soft(ratio)],
      [100, 100],
    ],
  },
  {
    id: "snap_back",
    name: "Snap Back",
    description: "Sharp percussion accent that quickly returns to neutral.",
    autoRatio: 120,
    isFast: true,
    keyframePattern: (ratio) => [
      [0, 100],
      [10, ratio],
      [30, 100],
      [100, 100],
    ],
  },
];

/** Look up a preset by its `id` string. Returns `undefined` if not found. */
export function getPreset(id: string): MovementPreset | undefined {
  return MOVEMENT_PRESETS.find((p) => p.id === id);
}
