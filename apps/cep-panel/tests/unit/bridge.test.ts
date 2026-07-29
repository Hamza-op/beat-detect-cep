import { afterEach, describe, expect, it } from "vitest";
import { createBridge } from "../../src/panel/bridge";

interface ScriptRequest {
  id: string;
  method: string;
}

const installCepWindow = (
  evaluate: (request: ScriptRequest, callback: (raw: string) => void) => void,
): void => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout,
      setTimeout,
      __adobe_cep__: {
        evalScript(script: string, callback: (raw: string) => void): void {
          const expression = script.match(/^AutoCutStudio\.invoke\((.*)\)$/);
          if (!expression) throw new Error(`Unexpected script: ${script}`);
          const request = JSON.parse(
            JSON.parse(expression[1]),
          ) as ScriptRequest;
          evaluate(request, callback);
        },
      },
    },
  });
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("Premiere CEP bridge readiness", () => {
  it("waits for the host to become ready before sending an operation once", async () => {
    let pingCalls = 0;
    let operationCalls = 0;
    installCepWindow((request, callback) => {
      if (request.method === "system.ping") {
        pingCalls++;
        if (pingCalls === 1) {
          callback("EvalScript error.");
          return;
        }
        callback(
          JSON.stringify({
            version: 1,
            id: request.id,
            ok: true,
            data: { bridgeVersion: 1 },
          }),
        );
        return;
      }
      operationCalls++;
      callback(
        JSON.stringify({
          version: 1,
          id: request.id,
          ok: true,
          data: { applied: 1 },
        }),
      );
    });

    const bridge = createBridge();
    const result = await bridge.request<
      Record<string, never>,
      { applied: number }
    >("markers.applyChunk", {});

    expect(result.applied).toBe(1);
    expect(pingCalls).toBe(2);
    expect(operationCalls).toBe(1);
  });

  it("does not retry a Premiere editing error", async () => {
    let operationCalls = 0;
    installCepWindow((request, callback) => {
      if (request.method === "system.ping") {
        callback(
          JSON.stringify({
            version: 1,
            id: request.id,
            ok: true,
            data: { bridgeVersion: 1 },
          }),
        );
        return;
      }
      operationCalls++;
      callback(
        JSON.stringify({
          version: 1,
          id: request.id,
          ok: false,
          error: {
            code: "NO_ACTIVE_SEQUENCE",
            message: "No active sequence is open.",
            retryable: false,
          },
        }),
      );
    });

    const bridge = createBridge();
    await expect(bridge.request("markers.scan", {})).rejects.toMatchObject({
      code: "NO_ACTIVE_SEQUENCE",
    });
    expect(operationCalls).toBe(1);
  });
});
