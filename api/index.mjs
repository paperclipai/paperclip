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

const { app } = await startServer();

export default app;
