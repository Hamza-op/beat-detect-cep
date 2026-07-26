export interface DollyValues {
  startScale: number;
  midScale: number;
  endScale: number;
  intensity: number;
  startX: number;
  startY: number;
  midX: number;
  midY: number;
  endX: number;
  endY: number;
  easing: string;
}

export interface DollyScalarKey {
  ratio: number;
  value: number;
}

export interface DollyPositionKey {
  ratio: number;
  value: [number, number];
}

export interface DollyKeyframes {
  easing: string;
  scaleKeys: DollyScalarKey[];
  positionKeys: DollyPositionKey[];
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value);
  const finite = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(min, Math.min(max, finite));
}

export function computeDollyKeyframes(values: DollyValues): DollyKeyframes {
  const intensity = clamp(values.intensity, 0, 100, 65) / 100;
  const blendScale = (value: number) =>
    100 + (clamp(value, 100, 180, 100) - 100) * intensity;
  const blendPosition = (value: number) =>
    50 + (clamp(value, 0, 100, 50) - 50) * intensity;

  return {
    easing: values.easing || "bezier",
    scaleKeys: [
      { ratio: 0, value: blendScale(values.startScale) },
      { ratio: 0.5, value: blendScale(values.midScale) },
      { ratio: 1, value: blendScale(values.endScale) },
    ],
    positionKeys: [
      {
        ratio: 0,
        value: [blendPosition(values.startX), blendPosition(values.startY)],
      },
      {
        ratio: 0.5,
        value: [blendPosition(values.midX), blendPosition(values.midY)],
      },
      {
        ratio: 1,
        value: [blendPosition(values.endX), blendPosition(values.endY)],
      },
    ],
  };
}

if (typeof window !== "undefined") {
  (
    window as Window & {
      AutoCutDollyCore?: {
        compute: typeof computeDollyKeyframes;
      };
    }
  ).AutoCutDollyCore = { compute: computeDollyKeyframes };
}
