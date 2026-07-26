export interface Keyframe {
  time: number;
  value: number | [number, number];
}
export interface MotionPreset {
  name: string;
  description: string;
  scale: (t: number, intensity: number) => number;
  position: (t: number, intensity: number) => [number, number];
}

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const presets: Record<string, MotionPreset> = {
  smooth_in: {
    name: "Slow Advance",
    description: "Clean scale movement",
    scale: (t, i) => 100 + 8 * i * clamp01(t),
    position: () => [0.5, 0.5],
  },
  smooth_out: {
    name: "Elegant Pullback",
    description: "Gentle scale release",
    scale: (t, i) => 100 + 8 * i * (1 - clamp01(t)),
    position: () => [0.5, 0.5],
  },
  drift: {
    name: "Subtle Drift",
    description: "Scale with a small diagonal drift",
    scale: (t, i) => 100 + 5 * i * clamp01(t),
    position: (t, i) => [0.5 + 0.04 * i * t, 0.5 - 0.02 * i * t],
  },
  breath: {
    name: "Soft Breathing",
    description: "A complete breathing cycle",
    scale: (t, i) => 100 + 4 * i * Math.sin(Math.PI * clamp01(t)),
    position: () => [0.5, 0.5],
  },
  reveal: {
    name: "Grace Reveal",
    description: "Scale and rising position",
    scale: (t, i) => 100 + 12 * i * clamp01(t),
    position: (t, i) => [0.5, 0.5 + 0.06 * i * (1 - t)],
  },
  settle_in: {
    name: "Refined Settle",
    description: "Fast settle into a stable frame",
    scale: (t, i) => 100 + 10 * i * (1 - Math.pow(1 - clamp01(t), 3)),
    position: () => [0.5, 0.5],
  },
  swell: {
    name: "Closing Swell",
    description: "Slow finish",
    scale: (t, i) => 100 + 10 * i * Math.pow(clamp01(t), 2),
    position: () => [0.5, 0.5],
  },
  punch_in: {
    name: "Dance Accent",
    description: "Hard beat push",
    scale: (t, i) => 100 + 18 * i * clamp01(t),
    position: () => [0.5, 0.5],
  },
  triple_hit: {
    name: "Procession Beat",
    description: "Three-step rhythmic hit",
    scale: (t, i) =>
      100 + 14 * i * (0.5 - 0.5 * Math.cos(Math.PI * 3 * clamp01(t))),
    position: () => [0.5, 0.5],
  },
  snap_back: {
    name: "Percussion Snap",
    description: "Quick push and return",
    scale: (t, i) => 100 + 20 * i * Math.sin(Math.PI * clamp01(t)),
    position: () => [0.5, 0.5],
  },
  pulse: {
    name: "Rhythm Pulse",
    description: "Even rhythmic pulse",
    scale: (t, i) =>
      100 + 12 * i * (0.5 - 0.5 * Math.cos(Math.PI * 2 * clamp01(t))),
    position: () => [0.5, 0.5],
  },
};

export function getMotionPreset(name: string): MotionPreset {
  return presets[name] ?? presets.smooth_in;
}
export function listMotionPresets(): MotionPreset[] {
  return Object.values(presets);
}
