import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const providerHome = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-provider-"));
const server = base.webServer as Exclude<typeof base.webServer, unknown[]>;
export default defineConfig({
  ...base,
  testMatch: "transcript-delivery.journey.ts",
  use: { ...base.use, actionTimeout: 15_000, trace: "retain-on-failure" },
  webServer: {
    ...server,
    env: {
      ...server?.env,
      PAPERCLIP_STOP_CODEX_COMMAND: path.resolve(import.meta.dirname, "fixtures/completion-stream-bin/codex"),
      CODEX_HOME: providerHome,
      OPENAI_API_KEY: "transcript-fixture-key",
      NODE_OPTIONS: `${server?.env?.NODE_OPTIONS ?? ""} --import=${path.resolve(import.meta.dirname, "fixtures/composer-stop-codex-loader.mjs")}`,
    },
  },
});
