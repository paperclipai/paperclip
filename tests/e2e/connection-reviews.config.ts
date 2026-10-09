import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Inherits the normal throwaway instance and adds explicit process restart control.
const controlPath =
  process.env.PAPERCLIP_REVIEW_RESTART_FILE ??
  path.join(process.env.PAPERCLIP_HOME!, "connection-review-restart.txt");
process.env.PAPERCLIP_REVIEW_RESTART_FILE = controlPath;
export default defineConfig({
  ...base,
  testMatch: "connection-reviews.spec.ts",
  use: { ...base.use, trace: "on" },
  webServer: {
    ...(base.webServer as Exclude<typeof base.webServer, unknown[]>),
    cwd: path.resolve(import.meta.dirname, "../.."),
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    command:
      "node --import ./cli/node_modules/tsx/dist/loader.mjs tests/e2e/connection-reviews-server.ts",
    env: {
      ...(base.webServer as { env: Record<string, string> }).env,
      PAPERCLIP_REVIEW_RESTART_FILE: controlPath,
    },
  },
});
