import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, type ReporterDescription } from "@playwright/test";
import base from "./playwright.config";
import { h5Enabled, H5_LIMITS } from "./fixtures/native-ingestion-h5.mjs";

const server = base.webServer as Exclude<typeof base.webServer, unknown[]>;
const evidence = process.env.PAPERCLIP_INGESTION_EVIDENCE_DIR;
const h5 = h5Enabled(process.env.PAPERCLIP_INGESTION_OBSERVATION_MODE);
const browserRecording = Boolean(process.env.PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR) || process.env.PAPERCLIP_INGESTION_BROWSER_CAPTURE === "1";
process.env.PAPERCLIP_INGESTION_BROWSER_RECORDING = browserRecording ? "on" : "off";
const appRoot = path.resolve(process.env.PAPERCLIP_INGESTION_APP_ROOT ?? path.resolve(import.meta.dirname, "../.."));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const bootstrap = path.resolve(import.meta.dirname, "fixtures/native-ingestion-bootstrap.mjs");
const transport = process.env.PAPERCLIP_INGESTION_TRANSPORT ?? "sandbox-remote-with-local-stop";
if (transport !== "sandbox-remote-with-local-stop") throw new Error("H4 requires remote streaming with the original local Stop workload");
if (process.env.DATABASE_URL) {
  throw new Error("Remote ingestion fixture requires a new disposable embedded database");
}
const remoteServer = path.resolve(import.meta.dirname, "fixtures/native-ingestion-remote-server.mjs");
const compiledEntry = `${quote(remoteServer)} --compiled-entry=server/dist/index.js`;
const compiledCommand = `node --import ./server/node_modules/tsx/dist/loader.mjs ${quote(bootstrap)} && node --import ./server/node_modules/tsx/dist/loader.mjs ${compiledEntry}`;
const command = process.env.PAPERCLIP_INGESTION_SERVER_COMMAND ?? compiledCommand;
const autoStartingOnboard = /\bonboard\b[^;&]*(?:--yes|-y)\b/.test(command);
if (command.includes("server/dist/index.js") && autoStartingOnboard) {
  throw new Error("onboard --yes starts the source server before the compiled command; use native-ingestion-bootstrap.mjs for configuration only");
}
const compiled = Boolean(command.includes("server/dist/index.js") && !command.includes("server/src/index") && !autoStartingOnboard);
if (process.env.PAPERCLIP_INGESTION_SMOKE !== "1" && !compiled) {
  throw new Error("Full ingestion measurements require a compiled server/dist/index.js command; source CLI is qualification smoke only");
}
process.env.PAPERCLIP_INGESTION_SERVER_ARTIFACT = compiled ? "compiled" : "source-qualification";
const providerHome = fs.mkdtempSync(path.join(os.tmpdir(), "ingestion-provider-"));
export default defineConfig({
  ...base,
  testMatch: "native-event-ingestion.journey.ts",
  timeout: h5 ? H5_LIMITS.fullInvocationMs : 900_000,
  ...(evidence ? { outputDir: path.join(evidence, "test-results"),
    reporter: [["list"], ["json", { outputFile: path.join(evidence, "playwright.json") }]] as ReporterDescription[] } : {}),
  use: { ...base.use, trace: browserRecording ? "on" : "off", video: "off", actionTimeout: 20_000 },
  webServer: {
    ...server,
    cwd: appRoot,
    command,
    timeout: 240_000,
    env: {
      ...server?.env,
      PAPERCLIP_INGESTION_TRANSPORT: transport,
      PAPERCLIP_STOP_CODEX_COMMAND: path.resolve(import.meta.dirname, "fixtures/native-ingestion-bin/codex"),
      CODEX_HOME: providerHome,
      OPENAI_API_KEY: "ingestion-fixture-key",
      NODE_OPTIONS: `${server?.env?.NODE_OPTIONS ?? ""} --import=${path.resolve(import.meta.dirname, "fixtures/composer-stop-codex-loader.mjs")}`,
    },
  },
});
