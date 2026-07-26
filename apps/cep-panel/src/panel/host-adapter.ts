import type { PremiereBridge } from "./bridge";
export interface PremiereApplicationAdapter {
  bridge: PremiereBridge;
  platform: "cep";
}
export function createPremiereAdapter(
  bridge: PremiereBridge,
): PremiereApplicationAdapter {
  return { bridge, platform: "cep" };
}
