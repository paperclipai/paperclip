import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "task-list-reproduction-trial.spec.ts",
  outputDir: "./test-results/task-list-reproduction-trial",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.STORYBOOK_TEST_BASE_URL ?? "http://127.0.0.1:6007",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    launchOptions: { executablePath: process.env.TRIAL_CHROMIUM_EXECUTABLE },
  },
});
