import type { BeatEvent } from "./markers/selection";

export function validateAnalyzerOutput(value: unknown): BeatEvent[] {
  if (!Array.isArray(value))
    throw new Error("Analyzer output must be an array");
  return value
    .map((event) => {
      if (!event || typeof event !== "object")
        throw new Error("Analyzer returned an invalid event");
      const time = Number((event as { time?: unknown }).time);
      const score = Number((event as { score?: unknown }).score);
      if (!Number.isFinite(time) || time < 0 || !Number.isFinite(score))
        throw new Error("Analyzer returned non-finite data");
      return { time, score: Math.max(0, Math.min(1, score)) };
    })
    .sort((a, b) => a.time - b.time);
}
