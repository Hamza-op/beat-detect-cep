import type { Keyframe } from "../motion/presets";

export interface MotionLedgerRecord {
  schemaVersion: 1;
  projectFingerprint: string;
  sequenceId: string;
  projectItemNodeId: string;
  originalTrackIndex: number;
  originalStartSeconds: number;
  inPointSeconds: number;
  outPointSeconds: number;
  effectMatchName: string;
  componentIndex: number;
  preset: string;
  generatedScaleKeys: Keyframe[];
  generatedPositionKeys: Keyframe[];
}

const storageKey = "autocutstudio.motion-ledger.v1";
export function readMotionLedger(): MotionLedgerRecord[] {
  try {
    return JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    ) as MotionLedgerRecord[];
  } catch {
    return [];
  }
}
export function writeMotionLedger(records: MotionLedgerRecord[]): void {
  localStorage.setItem(storageKey, JSON.stringify(records));
}
