import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const canaryVersion = process.env.PAPERCLIPAI_VERSION?.trim();
if (!canaryVersion || !/^[0-9A-Za-z.+-]+$/.test(canaryVersion)) {
  throw new Error(
    "PAPERCLIPAI_VERSION must name the exact published canary version to test",
  );
}

const baseUrl =
  process.env.PAPERCLIP_CANARY_SMOKE_BASE_URL ?? "http://127.0.0.1:3233";
const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.hostname !== "127.0.0.1" || !parsedBaseUrl.port) {
  throw new Error("PAPERCLIP_CANARY_SMOKE_BASE_URL must use 127.0.0.1 and an explicit port");
}

const workspace = fs.mkdtempSync(
  path.join(os.tmpdir(), "paperclip-canary-onboarding-smoke-"),
);
const dataDir = path.join(workspace, "data");
const npmCache = path.join(workspace, "npm-cache");
fs.mkdirSync(dataDir);
fs.mkdirSync(npmCache);

const serverLog =
  process.env.PAPERCLIP_CANARY_SMOKE_SERVER_LOG ??
  path.join(workspace, "canary-onboarding-server.log");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const command = [
  "npx",
  "--yes",
  shellQuote(`paperclipai@${canaryVersion}`),
  "onboard",
  "--yes",
  "--data-dir",
  shellQuote(dataDir),
  ">",
  shellQuote(serverLog),
  "2>&1",
].join(" ");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  retries: 0,
  workers: 1,
  use: {
    baseURL: baseUrl,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL
          ? { channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL }
          : {}),
      },
    },
  ],
  webServer: {
    command,
    url: `${baseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      ...process.env,
      PORT: parsedBaseUrl.port,
      PAPERCLIP_NO_BROWSER: "1",
      PAPERCLIP_OPEN_ON_LISTEN: "false",
      npm_config_cache: npmCache,
    },
  },
  outputDir: "./test-results",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./playwright-report" }],
  ],
});
