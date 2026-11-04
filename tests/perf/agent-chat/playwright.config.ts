import { defineConfig } from "@playwright/test";
import base from "../issue-detail/playwright.config";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: "agent-chat-startup.spec.ts",
  timeout: 60_000,
  workers: 1,
  use: { ...base.use, serviceWorkers: "block" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  outputDir: "../../../test-results/agent-chat/playwright",
});
