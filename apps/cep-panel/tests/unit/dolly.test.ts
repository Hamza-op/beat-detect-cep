import { describe, expect, it } from "vitest";
import { computeDollyKeyframes } from "../../src/panel/motion/dolly";

const values = {
  startScale: 100,
  midScale: 140,
  endScale: 120,
  intensity: 100,
  startX: 50,
  startY: 50,
  midX: 60,
  midY: 40,
  endX: 55,
  endY: 45,
  easing: "linear",
};

describe("Dolly-Style Motion", () => {
  it("uses explicit start, midpoint, and end values", () => {
    const result = computeDollyKeyframes(values);
    expect(result.easing).toBe("linear");
    expect(result.scaleKeys).toEqual([
      { ratio: 0, value: 100 },
      { ratio: 0.5, value: 140 },
      { ratio: 1, value: 120 },
    ]);
    expect(result.positionKeys[1].value).toEqual([60, 40]);
  });

  it("blends every key toward a neutral flat clip at lower intensity", () => {
    const result = computeDollyKeyframes({ ...values, intensity: 50 });
    expect(result.scaleKeys.map((key) => key.value)).toEqual([100, 120, 110]);
    expect(result.positionKeys[1].value).toEqual([55, 45]);
  });

  it("is neutral at zero intensity and clamps unsafe scales", () => {
    const result = computeDollyKeyframes({
      ...values,
      intensity: 0,
      startScale: 20,
      midScale: 500,
    });
    expect(result.scaleKeys.map((key) => key.value)).toEqual([100, 100, 100]);
    expect(result.positionKeys.map((key) => key.value)).toEqual([
      [50, 50],
      [50, 50],
      [50, 50],
    ]);
  });
});
