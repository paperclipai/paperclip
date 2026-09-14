import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The ordinary E2E bootstrap owns a fresh local_trusted instance. No source
// instance is mutated and no simulated service API is installed in the page.
const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ["runtime-services.spec.ts", "runtime-service-credentials.spec.ts", "runtime-service-company-policy.spec.ts", "runtime-service-storage.spec.ts"],
  use: { ...base.use, trace: "on" },
  webServer: {
    ...webServer,
    cwd: path.resolve(import.meta.dirname, "../.."),
    command: "node --import ./cli/node_modules/tsx/dist/loader.mjs tests/e2e/runtime-services-server.ts",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      ...webServer.env,
      PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
      PAPERCLIP_SERVICE_SANDBOX_COMMAND: process.env.PAPERCLIP_SERVICE_SANDBOX_COMMAND ?? "codex",
    },
  },
});
