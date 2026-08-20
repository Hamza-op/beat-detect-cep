export interface BeatEvent {
  time: number;
  score: number;
}

function clampPercentage(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 100;
  return Math.max(5, Math.min(100, Math.round(numeric)));
}

/**
 * Keeps an exact percentage of the detected grid without changing detection.
 * The ordered grid is divided into equal index windows, then one locally strong
 * beat near the centre of each window is retained. This preserves coverage
 * through the whole performance instead of keeping only one loud section.
 */
export function selectDistributedBeats<T extends BeatEvent>(
  events: readonly T[],
  percentage: unknown,
): T[] {
  if (events.length === 0) return [];

  const amount = clampPercentage(percentage);
  const targetCount = Math.max(
    1,
    Math.min(events.length, Math.round((events.length * amount) / 100)),
  );
  if (targetCount === events.length) return events.slice();

  const selected: T[] = [];
  for (let slot = 0; slot < targetCount; slot += 1) {
    const start = Math.floor((slot * events.length) / targetCount);
    const end = Math.floor(((slot + 1) * events.length) / targetCount);
    const middle = (start + end - 1) / 2;
    const radius = Math.max(1, (end - start) / 2);

    let minimumScore = Number.POSITIVE_INFINITY;
    let maximumScore = Number.NEGATIVE_INFINITY;
    for (let index = start; index < end; index += 1) {
      const score = Number(events[index].score) || 0;
      minimumScore = Math.min(minimumScore, score);
      maximumScore = Math.max(maximumScore, score);
    }

    let bestIndex = start;
    let bestPriority = Number.NEGATIVE_INFINITY;
    const scoreRange = maximumScore - minimumScore;
    for (let index = start; index < end; index += 1) {
      const score = Number(events[index].score) || 0;
      const strength =
        scoreRange > 1e-9 ? (score - minimumScore) / scoreRange : 1;
      const centrality = 1 - Math.min(1, Math.abs(index - middle) / radius);
      const priority = strength * 0.72 + centrality * 0.28;
      if (priority > bestPriority) {
        bestPriority = priority;
        bestIndex = index;
      }
    }
    selected.push(events[bestIndex]);
  }

  return selected;
}

if (typeof window !== "undefined") {
  (
    window as Window & {
      AutoCutBeatDistribution?: {
        select: typeof selectDistributedBeats;
      };
    }
  ).AutoCutBeatDistribution = { select: selectDistributedBeats };
}
