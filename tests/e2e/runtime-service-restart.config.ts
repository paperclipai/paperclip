import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";
const server = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
process.env.PAPERCLIP_RESTART_FIXTURE_HOME ??= server.env!.PAPERCLIP_HOME;
export default defineConfig({ ...base, testMatch: "runtime-service-restart.spec.ts", webServer: { ...server,
  command: "node --import ./cli/node_modules/tsx/dist/loader.mjs tests/e2e/runtime-service-restart-server.ts",
  gracefulShutdown: { signal: "SIGTERM", timeout: 40_000 },
  env: { ...server.env, PAPERCLIP_SERVICE_PREVIEW_BASE_URL: `http://localhost:${process.env.PAPERCLIP_E2E_PORT ?? 3199}` },
} });
