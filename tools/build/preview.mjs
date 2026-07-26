import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../apps/cep-panel/src",
);
const workspace = path.resolve(root, "../..", "..");
try {
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build"],
    { cwd: workspace, stdio: "ignore" },
  );
} catch {
  /* source preview still serves HTML */
}
const mime = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/javascript",
  ".ttf": "font/ttf",
};
const server = createServer(async (req, res) => {
  const requested = req.url === "/" ? "/index.html" : req.url;
  const builtAsset = requested === "/js/main.js";
  const sourceAsset = requested.startsWith("/css/")
    ? requested.replace("/css/", "/styles/")
    : requested;
  const fileRoot = builtAsset
    ? path.join(workspace, "dist", "com.autocutstudio.panel")
    : root;
  const file = path.normalize(
    path.join(fileRoot, builtAsset ? requested : sourceAsset),
  );
  if (!file.startsWith(fileRoot)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": mime[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(4173, "127.0.0.1", () =>
  console.log("AutoCut Studio preview: http://127.0.0.1:4173"),
);
