export interface BeatEvent {
  time: number;
  score: number;
}

export const RESERVED_MARKER_COLORS = [1, 3, 6, 11] as const;

export function markerColorForScore(score: number): number {
  if (score < 0.5) return 1;
  if (score < 0.7) return 3;
  if (score < 0.85) return 6;
  return 11;
}

export function clampToHalfOpenFrame(
  time: number,
  start: number,
  end: number,
  frameDuration: number,
): number | null {
  if (
    ![time, start, end, frameDuration].every(Number.isFinite) ||
    frameDuration <= 0 ||
    end <= start
  )
    return null;
  const lastValid = Math.max(start, end - frameDuration);
  const snapped = Math.round(time / frameDuration) * frameDuration;
  return Math.min(lastValid, Math.max(start, snapped));
}

export function exactCount(events: BeatEvent[], target: number): BeatEvent[] {
  const sorted = events
    .filter((e) => Number.isFinite(e.time) && Number.isFinite(e.score))
    .map((e) => ({ time: e.time, score: Math.max(0, Math.min(1, e.score)) }))
    .sort((a, b) => a.time - b.time);
  if (!Number.isInteger(target) || target <= 0) return [];
  if (target >= sorted.length) return sorted;
  return [...sorted]
    .sort((a, b) => b.score - a.score || a.time - b.time)
    .slice(0, target)
    .sort((a, b) => a.time - b.time);
}

export function evenSpread(events: BeatEvent[], target: number): BeatEvent[] {
  if (target <= 0 || events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.time - b.time);
  if (target >= sorted.length) return sorted;
  return Array.from(
    { length: target },
    (_, i) => sorted[Math.floor((i * sorted.length) / target)],
  ).filter(Boolean);
}
