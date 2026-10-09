import { defineConfig } from "@playwright/test";
import visualConfig from "./playwright.config";
export default defineConfig({
  webServer: process.env.PAPERCLIP_PERSONA_STORYBOOK_URL ? undefined : visualConfig.webServer,
  testDir: ".", testMatch: "agent-personas.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  outputDir: "./test-results/agent-personas", reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/.snapshots/agent-personas/{arg}{ext}",
  use: {
    browserName: "chromium", baseURL: process.env.PAPERCLIP_PERSONA_STORYBOOK_URL ?? "http://localhost:6106",
    viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
});
