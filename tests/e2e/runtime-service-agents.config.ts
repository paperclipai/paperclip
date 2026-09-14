import { defineConfig } from "@playwright/test";
import base from "./runtime-service-previews.config";

const webServer = base.webServer as Exclude<NonNullable<typeof base.webServer>, unknown[]>;
const codexHome = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_CODEX_HOME;
const profile = process.env.PAPERCLIP_RUNTIME_SERVICE_AGENT_PROFILE ?? "legacy-codex";
if (!["legacy-codex", "runner-codex", "legacy-acpx-codex"].includes(profile)) {
  throw new Error(`Unknown runtime service agent profile: ${profile}`);
}
if (process.env.PAPERCLIP_RUNTIME_SERVICE_LIVE_CODEX === "1" && !codexHome) {
  throw new Error("Live service acceptance requires an isolated, signed-in PAPERCLIP_RUNTIME_SERVICE_AGENT_CODEX_HOME");
}
export default defineConfig({
  ...base,
  testMatch: "runtime-service-agents.spec.ts",
  webServer: { ...webServer, env: { ...webServer.env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    PAPERCLIP_CODEX_AUTH_CACHE: "0",
  } },
});
