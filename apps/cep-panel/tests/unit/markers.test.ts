import { describe, expect, it } from "vitest";
import { clampToHalfOpenFrame } from "../../src/panel/markers/selection";

describe("marker selection", () => {
  it("clamps a snapped end marker to the last valid frame", () => {
    expect(clampToHalfOpenFrame(10, 0, 10, 1 / 30)).toBeCloseTo(10 - 1 / 30, 8);
  });
});
