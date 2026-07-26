import { describe, expect, it } from "vitest";
import { validateAnalyzerOutput } from "../../src/panel/analyzer";

describe("analyzer contract", () => {
  it("sorts, clamps, and rejects non-finite output", () => {
    expect(
      validateAnalyzerOutput([
        { time: 2, score: 2 },
        { time: 1, score: -1 },
      ]),
    ).toEqual([
      { time: 1, score: 0 },
      { time: 2, score: 1 },
    ]);
    expect(() => validateAnalyzerOutput([{ time: NaN, score: 0.5 }])).toThrow();
  });
});
