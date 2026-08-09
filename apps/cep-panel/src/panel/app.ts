import "./CSInterface.js";
import "./motion/dolly";
import "./legacy-main.js";

export function startApp(): void {
  document.documentElement.dataset.autocutReady = "true";
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", startApp, { once: true });
else startApp();
