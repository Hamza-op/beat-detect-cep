import "./CSInterface.js";
import "./legacy-main.js";
import { createBridge } from "./bridge";
import { createInitialState } from "./state";
import { createControllers } from "./controllers";

export function startApp(): void {
  const state = createInitialState();
  const bridge = window.__autocutBridge ?? createBridge();
  window.__autocutBridge = bridge;
  const controllers = createControllers(bridge, state);
  (window as Window & { AutoCutStudioCore?: unknown }).AutoCutStudioCore = {
    state,
    bridge,
    controllers,
  };
  document.documentElement.dataset.autocutReady = "true";
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", startApp, { once: true });
else startApp();
