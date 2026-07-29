export type HostMethod =
  | "system.ping"
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
  ready(): Promise<void>;
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
      async ready(): Promise<void> {},
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

  const evaluate = (script: string, timeoutMs: number): Promise<string> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Premiere host bridge timed out."));
      }, timeoutMs);
      cep.evalScript(script, (raw) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        const text = String(raw ?? "").trim();
        if (!text || text.startsWith("EvalScript error")) {
          reject(
            new Error(
              "Premiere host bridge is unavailable. Restart Premiere Pro and reopen AutoCut Studio.",
            ),
          );
          return;
        }
        resolve(text);
      });
    });

  const invoke = async <TPayload, TResult>(
    method: HostMethod,
    payload: TPayload,
    timeoutMs: number,
  ): Promise<TResult> => {
    const id = `acs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request: HostRequestV1<TPayload> = {
      version: 1,
      id,
      method,
      payload,
    };
    const raw = await evaluate(
      `AutoCutStudio.invoke(${JSON.stringify(JSON.stringify(request))})`,
      timeoutMs,
    );
    let response: HostResponseV1<TResult>;
    try {
      response = JSON.parse(raw) as HostResponseV1<TResult>;
    } catch {
      throw new Error("Premiere returned invalid host bridge data.");
    }
    if (response.version !== 1 || response.id !== id) {
      throw new Error("Premiere returned a mismatched host bridge response.");
    }
    if (!response.ok) {
      const error = new Error(
        response.error?.message ?? "Premiere request failed",
      );
      (error as Error & { code?: string }).code =
        response.error?.code ?? errorCode(error.message);
      throw error;
    }
    return response.data as TResult;
  };

  let readyPromise: Promise<void> | undefined;
  const waitForReady = (): Promise<void> => {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const retryDelays = [0, 100, 250, 500, 1_000];
      let lastError: unknown;
      for (const delayMs of retryDelays) {
        if (delayMs > 0)
          await new Promise<void>((resolve) =>
            window.setTimeout(resolve, delayMs),
          );
        try {
          await invoke<Record<string, never>, unknown>(
            "system.ping",
            {},
            2_500,
          );
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(
        `Premiere host bridge did not become ready: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    })().catch((error) => {
      readyPromise = undefined;
      throw error;
    });
    return readyPromise;
  };

  const isTransportFailure = (error: unknown): boolean => {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    return (
      message.includes("host bridge") ||
      message.includes("invalid host") ||
      message.includes("mismatched host")
    );
  };

  return {
    ready: waitForReady,
    async request<TPayload, TResult>(
      method: HostMethod,
      payload: TPayload,
      options: { timeoutMs?: number } = {},
    ): Promise<TResult> {
      await waitForReady();
      try {
        return await invoke<TPayload, TResult>(
          method,
          payload,
          options.timeoutMs ?? 30_000,
        );
      } catch (error) {
        if (isTransportFailure(error)) readyPromise = undefined;
        throw error;
      }
    },
  };
}

export { errorCode };
