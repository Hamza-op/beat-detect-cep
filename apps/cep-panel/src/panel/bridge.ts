export type HostMethod =
  | "clip.getSelected"
  | "markers.scan"
  | "markers.applyChunk"
  | "markers.remove"
  | "markers.removeExactTimes"
  | "motion.inspect"
  | "motion.apply"
  | "motion.clear"
  | "color.ensureEffect"
  | "color.configure"
  | "color.reset"
  | "warp.listSelection"
  | "warp.apply"
  | "warp.status"
  | "diagnostics.run";

export interface HostRequestV1<T = unknown> {
  version: 1;
  id: string;
  method: HostMethod;
  payload: T;
}

export interface HostResponseV1<T = unknown> {
  version: 1;
  id: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: string[];
    retryable: boolean;
  };
}

export interface PremiereBridge {
  request<TPayload, TResult>(
    method: HostMethod,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ): Promise<TResult>;
}

declare global {
  interface Window {
    __autocutPreview?: boolean;
    __adobe_cep__?: { evalScript?: unknown };
    __autocutBridge?: PremiereBridge;
  }
}

const errorCode = (message: string): string => {
  const text = message.toLowerCase();
  if (text.includes("active sequence")) return "NO_ACTIVE_SEQUENCE";
  if (text.includes("exactly one") || text.includes("one video"))
    return "AMBIGUOUS_SELECTION";
  if (text.includes("select")) return "NO_CLIP_SELECTED";
  if (text.includes("selection changed") || text.includes("timing changed"))
    return "SELECTION_CHANGED";
  if (text.includes("analysis status")) return "ANALYSIS_STATUS_UNAVAILABLE";
  if (text.includes("time remap")) return "UNSUPPORTED_TIME_REMAP";
  return "HOST_ERROR";
};

export function createBridge(): PremiereBridge {
  if (
    window.__autocutPreview ||
    !(window.__adobe_cep__?.evalScript instanceof Function)
  ) {
    return {
      async request<TPayload, TResult>(
        method: HostMethod,
        _payload: TPayload,
      ): Promise<TResult> {
        if (method === "clip.getSelected") {
          return {
            clip: {
              identity: "preview-clip",
              name: "Preview clip",
              mediaPath: "preview.wav",
              projectItemNodeId: "preview-item",
              sequenceId: "preview-sequence",
              startSeconds: 0,
              endSeconds: 12,
              inPointSeconds: 0,
              outPointSeconds: 12,
              sourceDurationSeconds: 12,
              timelineDurationSeconds: 12,
              playbackRate: 1,
              reversed: false,
              variableTimeRemap: false,
            },
          } as TResult;
        }
        if (method === "warp.status") return { done: true } as TResult;
        if (method === "diagnostics.run")
          return { diagnostics: ["Preview bridge: OK"] } as TResult;
        return { applied: 0, removed: 0, skipped: 0, clips: [] } as TResult;
      },
    };
  }

  const cep = window.__adobe_cep__ as {
    evalScript(script: string, callback: (result: string) => void): void;
  };
  return {
    request<TPayload, TResult>(
      method: HostMethod,
      payload: TPayload,
      options: { timeoutMs?: number } = {},
    ): Promise<TResult> {
      const id = `acs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request: HostRequestV1<TPayload> = {
        version: 1,
        id,
        method,
        payload,
      };
      return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Host request timed out: ${method}`));
          }
        }, options.timeoutMs ?? 30_000);
        cep.evalScript(
          `AutoCutStudio.invoke(${JSON.stringify(JSON.stringify(request))})`,
          (raw) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            try {
              const response = JSON.parse(raw) as HostResponseV1<TResult>;
              if (!response.ok) {
                const error = new Error(
                  response.error?.message ?? "Premiere request failed",
                );
                (error as Error & { code?: string }).code =
                  response.error?.code ?? errorCode(error.message);
                reject(error);
              } else {
                resolve(response.data as TResult);
              }
            } catch (error) {
              reject(error);
            }
          },
        );
      });
    },
  };
}

export { errorCode };
