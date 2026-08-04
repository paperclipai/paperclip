import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveScreenshotPath } from "./qa-browser-bridge.mjs";

test("resolveScreenshotPath keeps absolute paths inside the screenshot directory", () => {
  const screenshotDir = path.resolve("screenshots", "qa-browser");
  const target = resolveScreenshotPath(screenshotDir, path.resolve("tmp", "outside.png"));

  assert.equal(target, path.join(screenshotDir, "outside.png"));
});

test("resolveScreenshotPath strips traversal and unsafe characters", () => {
  const screenshotDir = path.resolve("screenshots", "qa-browser");
  const target = resolveScreenshotPath(screenshotDir, "../nested/report:main?.png");

  assert.equal(target, path.join(screenshotDir, "report-main-.png"));
});
