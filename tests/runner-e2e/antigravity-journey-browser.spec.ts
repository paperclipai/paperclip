import { test } from "@playwright/test";
import { runAntigravityBrowserCalibration } from "./antigravity-journey-browser.smoke.js";

test("Antigravity selectors match the shipped activity and artifact components", async ({ page }) => {
  test.setTimeout(60_000);
  await runAntigravityBrowserCalibration(page);
});
