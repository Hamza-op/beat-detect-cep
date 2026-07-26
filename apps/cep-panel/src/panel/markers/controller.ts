import type { PremiereBridge } from "../bridge";
import {
  clampToHalfOpenFrame,
  markerColorForScore,
  type BeatEvent,
} from "./selection";

export function createMarkerController(bridge: PremiereBridge) {
  return {
    colorForScore: markerColorForScore,
    clampToFrame: clampToHalfOpenFrame,
    async applyChunk(
      events: BeatEvent[],
      target: "clip" | "sequence",
      identity: string,
    ) {
      return bridge.request("markers.applyChunk", { events, target, identity });
    },
    async removeExactTimes(
      times: number[],
      target: "clip" | "sequence",
      identity: string,
    ) {
      return bridge.request("markers.removeExactTimes", {
        times,
        target,
        identity,
      });
    },
  };
}
