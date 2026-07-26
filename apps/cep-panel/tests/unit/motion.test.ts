import { describe, expect, it } from "vitest";
import {
  getMotionPreset,
  listMotionPresets,
} from "../../src/panel/motion/presets";

describe("motion presets", () => {
  it("has a computed animation for every selectable preset", () => {
    for (const preset of listMotionPresets()) {
      expect(Number.isFinite(preset.scale(0.5, 1))).toBe(true);
      expect(preset.position(0.5, 1)).toHaveLength(2);
    }
    expect(getMotionPreset("missing").name).toBe("Slow Advance");
  });
});
