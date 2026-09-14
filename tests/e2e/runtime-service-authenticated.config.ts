import { defineConfig } from "@playwright/test";
import base from "./runtime-service-previews.config";

const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
const origin = `http://127.0.0.1:${process.env.PAPERCLIP_E2E_PORT ?? 3199}`;
// Playwright reevaluates the base config in workers. Preserve the server's
// original throwaway home before that base creates an unused worker home.
process.env.PAPERCLIP_AUTH_PREVIEW_FIXTURE_HOME ??= webServer.env!.PAPERCLIP_HOME;
export default defineConfig({
  ...base,
  testMatch: "runtime-service-authenticated.spec.ts",
  testIgnore: [],
  use: { ...base.use, actionTimeout: 20_000 },
  webServer: { ...webServer, env: { ...webServer.env,
    DATABASE_URL: "", PAPERCLIP_DEPLOYMENT_MODE: "authenticated", PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_AUTH_BASE_URL_MODE: "explicit", PAPERCLIP_AUTH_PUBLIC_BASE_URL: origin,
    PAPERCLIP_PUBLIC_URL: origin, PAPERCLIP_AUTH_DISABLE_SIGN_UP: "false",
  } },
});
