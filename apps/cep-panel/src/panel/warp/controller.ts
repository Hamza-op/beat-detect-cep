import type { PremiereBridge } from "../bridge";
export function createWarpController(bridge: PremiereBridge) {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    async queue(identities: string[]) {
      cancelled = false;
      const report = { applied: 0, skipped: 0, failed: 0, unprocessed: 0 };
      for (const identity of identities) {
        if (cancelled) {
          report.unprocessed +=
            identities.length - report.applied - report.skipped - report.failed;
          break;
        }
        const result = await bridge.request<
          { identity: string },
          { skipped?: boolean }
        >("warp.apply", { identity });
        if (result.skipped) report.skipped++;
        else report.applied++;
        const status = await bridge.request("warp.status", {});
        if (!(status as { done?: boolean }).done)
          throw new Error("ANALYSIS_STATUS_UNAVAILABLE");
      }
      return report;
    },
  };
}
