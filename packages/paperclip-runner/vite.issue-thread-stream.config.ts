import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { capabilityStreamFixtureTransportFactory } from "./devtools/issue-thread/stream-fixture-transport.mjs";
import { capabilityIssueThreadServerPlugin } from "./scripts/capability-issue-thread-server.mjs";

/**
 * Test-only preview of the issue-thread app for the Capability streaming check.
 *
 * Identical to `vite.issue-thread.config.ts` — same root, same built bundle,
 * same package server middleware — except that the Codex provider is scripted
 * so the browser test can control when a delta lands. Everything the test
 * actually asserts (the NDJSON turn stream, the live session, the projection,
 * and the browser client) is the shipped code path.
 *
 * The shipped config takes no such override, and none can be injected through a
 * request or an environment variable.
 */

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(packageRoot, "devtools/issue-thread"),
  plugins: [
    react(),
    capabilityIssueThreadServerPlugin({ transportFactory: capabilityStreamFixtureTransportFactory }),
  ],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  build: {
    outDir: resolve(packageRoot, "dist-issue-thread"),
    emptyOutDir: true,
    target: "esnext",
  },
});
