import { describe, expect, it } from "vitest";
import {
  clampToHalfOpenFrame,
  exactCount,
  evenSpread,
  markerColorForScore,
} from "../../src/panel/markers/selection";

describe("marker selection", () => {
  it("maps score buckets to reserved colors", () => {
    expect([0.1, 0.5, 0.7, 0.85].map(markerColorForScore)).toEqual([
      1, 3, 6, 11,
    ]);
  });
  it("clamps a snapped end marker to the last valid frame", () => {
    expect(clampToHalfOpenFrame(10, 0, 10, 1 / 30)).toBeCloseTo(10 - 1 / 30, 8);
  });
  it("returns exact count in time order", () => {
    expect(
      exactCount(
        [
          { time: 2, score: 0.2 },
          { time: 1, score: 0.9 },
          { time: 3, score: 0.8 },
        ],
        2,
      ),
    ).toEqual([
      { time: 1, score: 0.9 },
      { time: 3, score: 0.8 },
    ]);
  });
  it("documents that even spread can return fewer than requested", () => {
    expect(evenSpread([{ time: 1, score: 1 }], 4)).toHaveLength(1);
  });
});
