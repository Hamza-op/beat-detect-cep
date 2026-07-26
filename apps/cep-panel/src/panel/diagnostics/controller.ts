import type { PremiereBridge } from "../bridge";
export function createDiagnosticsController(bridge: PremiereBridge) {
  return {
    run: () =>
      bridge.request<Record<string, never>, { diagnostics: string[] }>(
        "diagnostics.run",
        {},
      ),
  };
}
