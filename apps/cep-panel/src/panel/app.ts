import "./CSInterface.js";
import "./markers/distribution";
import "./legacy-main.js";

export function startApp(): void {
  document.documentElement.dataset.autocutReady = "true";
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", startApp, { once: true });
else startApp();
