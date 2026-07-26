import type { PremiereBridge } from "../bridge";
import { getMotionPreset } from "./presets";
export function createMotionController(bridge: PremiereBridge) {
  return {
    preset: getMotionPreset,
    async apply(payload: unknown) {
      return bridge.request("motion.apply", payload);
    },
    async clear(payload: unknown) {
      return bridge.request("motion.clear", payload);
    },
  };
}
