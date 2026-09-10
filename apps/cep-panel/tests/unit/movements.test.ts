import { describe, expect, it } from "vitest";
import { MOVEMENT_PRESETS, getPreset } from "../../src/panel/movements";

describe("movement presets", () => {
  it("defines exactly ten distinct movement presets", () => {
    expect(MOVEMENT_PRESETS).toHaveLength(10);
    const ids = MOVEMENT_PRESETS.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });

  it("retrieves each preset by its ID via getPreset", () => {
    for (const preset of MOVEMENT_PRESETS) {
      const found = getPreset(preset.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe(preset.name);
      expect(found?.autoRatio).toBeGreaterThanOrEqual(101);
      expect(found?.autoRatio).toBeLessThanOrEqual(150);
    }
  });

  it("returns undefined for unknown preset IDs", () => {
    expect(getPreset("non_existent")).toBeUndefined();
  });

  it("generates valid keyframe patterns within bounds", () => {
    for (const preset of MOVEMENT_PRESETS) {
      const pattern = preset.keyframePattern(115);
      expect(pattern.length).toBeGreaterThanOrEqual(2);

      // Verify bounds
      for (const [pos, val] of pattern) {
        expect(pos).toBeGreaterThanOrEqual(0);
        expect(pos).toBeLessThanOrEqual(100);
        expect(val).toBeGreaterThanOrEqual(100);
        expect(val).toBeLessThanOrEqual(150);
      }

      // First point at 0%, last point at 100%
      expect(pattern[0][0]).toBe(0);
      expect(pattern[pattern.length - 1][0]).toBe(100);
    }
  });
});
