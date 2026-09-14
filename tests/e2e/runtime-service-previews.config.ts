import { defineConfig } from "@playwright/test";
import base from "./runtime-services.config";

const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
export default defineConfig({
  ...base,
  testMatch: "runtime-service-previews.spec.ts",
  webServer: { ...webServer, env: { ...webServer.env, PAPERCLIP_SERVICE_PREVIEW_BASE_URL: `http://localhost:${process.env.PAPERCLIP_E2E_PORT ?? 3199}` } },
});
