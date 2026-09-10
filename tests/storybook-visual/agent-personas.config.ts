import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "agent-personas.spec.ts", workers: 1, retries: 0, timeout: 45_000,
  outputDir: "./test-results/agent-personas", reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/.snapshots/agent-personas/{arg}{ext}",
  use: {
    browserName: "chromium", baseURL: process.env.PAPERCLIP_PERSONA_STORYBOOK_URL ?? "http://127.0.0.1:6017",
    viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
});
