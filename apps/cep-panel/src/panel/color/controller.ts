import type { PremiereBridge } from "../bridge";
export function createColorController(bridge: PremiereBridge) {
  return {
    async ensureEffect(payload: unknown) {
      return bridge.request("color.ensureEffect", payload);
    },
    async configure(payload: unknown) {
      return bridge.request("color.configure", payload);
    },
    async reset(payload: unknown) {
      return bridge.request("color.reset", payload);
    },
  };
}
