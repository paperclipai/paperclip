#!/usr/bin/env node
/**
 * JAC-5156 — wire configureMemoryPlaneObserver into an already-built
 * global paperclipai server dist/index.js.
 *
 * The globally installed @paperclipai/server build ships
 * dist/services/memory-plane-observer.js but never calls
 * configureMemoryPlaneObserver, so the Honcho reachability probe never runs
 * (JAC-5155 / JAC-4883). This script injects the missing import + call.
 *
 * Idempotent: re-running on an already-patched file is a no-op.
 *
 * Usage: node jac5156-wire-global-observer.mjs [path/to/dist/index.js]
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TARGET =
  "/Users/hermes/.hermes/node/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js";

const target = process.argv[2] ?? DEFAULT_TARGET;
const MARKER = "// JAC-5156: memory-plane observer wiring";

if (!fs.existsSync(target)) {
  console.error(`target not found: ${target}`);
  process.exit(1);
}

const observerModule = path.join(
  path.dirname(target),
  "services",
  "memory-plane-observer.js",
);
if (!fs.existsSync(observerModule)) {
  console.error(`observer module not found next to target: ${observerModule}`);
  process.exit(1);
}

let source = fs.readFileSync(target, "utf8");

if (source.includes(MARKER)) {
  console.log("already patched (marker present) — no changes made");
  process.exit(0);
}

const IMPORT_LINE =
  `import { configureMemoryPlaneObserver as __jac5156ConfigureMemoryPlaneObserver } from "./services/memory-plane-observer.js";`;

// Anchor the call just before the runtime listen-host env assignments, which
// run after config resolution and before the server starts listening.
const ANCHOR = "    process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;";
if (!source.includes(ANCHOR)) {
  console.error("anchor not found; refusing to patch blindly");
  process.exit(1);
}

const CALL_BLOCK = [
  `    ${MARKER}`,
  "    // Honcho reachability depends on HONCHO_API_KEY being present; the call is",
  "    // fail-safe — a missing URL/key simply disables that plane.",
  "    try {",
  "        __jac5156ConfigureMemoryPlaneObserver({",
  "            honchoUrl: process.env.HONCHO_URL || null,",
  "            honchoApiKey: process.env." + "HONCHO_API_KEY || null,",
  "            honchoWorkspaceId: process.env.HONCHO_WORKSPACE_ID || null,",
  "            hindsightUrl: process.env.HINDSIGHT_URL || null,",
  "            holographicUrl: process.env.HOLOGRAPHIC_URL || null,",
  "            holographicApiKey: process.env." + "HOLOGRAPHIC_API_KEY || null,",
  "        });",
  "    }",
  "    catch (err) {",
  "        logger.warn(`memory-plane observer configuration failed: ${String(err)}`);",
  "    }",
  "",
].join("\n");

// Insert the import after the final top-level import line.
const importLines = [...source.matchAll(/^import .*$/gm)];
if (importLines.length === 0) {
  console.error("no import statements found; refusing to patch");
  process.exit(1);
}
const lastImport = importLines[importLines.length - 1];
const insertAt = lastImport.index + lastImport[0].length;

source =
  source.slice(0, insertAt) +
  "\n" +
  IMPORT_LINE +
  source.slice(insertAt);

source = source.replace(ANCHOR, CALL_BLOCK + ANCHOR);

fs.writeFileSync(target, source, "utf8");
console.log(`patched: ${target}`);
