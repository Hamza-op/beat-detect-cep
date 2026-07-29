export interface BeatEvent {
  time: number;
  score: number;
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
