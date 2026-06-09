import express from "express";

// Vercel serverless entry for /api/* rewrites. Uses compiled server output only.
void express;

// --- cold-start boot timing (module phase) ---------------------------------
// The expensive server dependency graph is loaded via a dynamic import so we can
// time how long evaluating it takes — this segment runs BEFORE startServer() and
// is invisible to startServer's own bootMark() instrumentation. A static
// `import { startServer }` would evaluate the graph before any code here runs,
// leaving the segment unmeasurable. The string literal keeps @vercel/nft tracing
// intact. Logged once per cold instance; read alongside the `boot-timing:` lines.
const __moduleEvalStart = performance.now();
const { startServer } = await import("../server/dist/index.js");
const __importMs = Math.round(performance.now() - __moduleEvalStart);
console.log(
  `boot-timing: module-import (+${__importMs}ms) ` +
    JSON.stringify({ bootPhase: "module-import", phaseMs: __importMs }),
);

// Kick off the (heavy) boot WITHOUT blocking the module export. Previously this did
// `const { app } = await startServer()` at module scope, so the function answered NO
// request — not even /api/health — until the ENTIRE boot finished. Any unbounded boot
// op then pinned the whole function to the 300s ceiling → 504 clusters on health +
// every route (the cold-boot-hang). Now boot runs in the background; liveness probes
// answer immediately, and real app requests await the cached boot below.
const appPromise = startServer().then(({ app }) => app);
let readyApp = null;
let bootError = null;
appPromise.then(
  (app) => {
    readyApp = app;
  },
  (err) => {
    bootError = err;
    console.error("boot-failed: startServer rejected", err);
  },
);

function isHealthPath(url) {
  if (typeof url !== "string") return false;
  const path = url.split("?", 1)[0];
  return path === "/api/health" || path === "/api/health/";
}

function respondBootingHealth(res) {
  const deploymentMode =
    process.env.VALADRIEN_OS_DEPLOYMENT_MODE === "authenticated" ? "authenticated" : "local_trusted";
  const googleAuthEnabled =
    Boolean(process.env.GOOGLE_CLIENT_ID?.trim()) && Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim());
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // Mirror the unauthenticated health shape so the SPA's CloudAccessGate keeps working
  // mid-boot (it reads deploymentMode); bootstrapStatus is omitted (needs the DB).
  res.end(JSON.stringify({ status: "ok", deploymentMode, googleAuthEnabled, booting: true }));
}

// Vercel Node handler. Liveness must never hang on boot: answer /api/health straight
// away while booting (no DB touch) so a cold instance never 504s the probe, the warmer
// works, and the authed shell isn't wedged on full boot. Everything else awaits boot.
export default async function handler(req, res) {
  if (!readyApp) {
    if (bootError && isHealthPath(req.url)) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ status: "unhealthy", error: "boot_failed" }));
      return;
    }
    if (isHealthPath(req.url) && (req.method === "GET" || req.method === "HEAD")) {
      respondBootingHealth(res);
      return;
    }
  }
  const app = readyApp ?? (await appPromise);
  return app(req, res);
}
