import type { PremiereBridge } from "./bridge";
import type { AppState } from "./state";

export function createControllers(bridge: PremiereBridge, state: AppState) {
  return {
    async scanMarkers(payload: unknown) {
      return bridge.request("markers.scan", payload);
    },
    async applyMarkers(payload: unknown) {
      return bridge.request("markers.applyChunk", payload);
    },
    async removeMarkers(payload: unknown) {
      return bridge.request("markers.remove", payload);
    },
    async clearExactMarkers(payload: unknown) {
      return bridge.request("markers.removeExactTimes", payload);
    },
    async applyMotion(payload: unknown) {
      return bridge.request("motion.apply", payload);
    },
    async clearMotion(payload: unknown) {
      return bridge.request("motion.clear", payload);
    },
    async autoColor(payload: unknown) {
      return bridge.request("color.configure", payload);
    },
    async resetColor(payload: unknown) {
      return bridge.request("color.reset", payload);
    },
    async warpStatus() {
      return bridge.request("warp.status", {});
    },
    async diagnostics() {
      return bridge.request<{ state: AppState }, { diagnostics: string[] }>(
        "diagnostics.run",
        { state },
      );
    },
  };
}
