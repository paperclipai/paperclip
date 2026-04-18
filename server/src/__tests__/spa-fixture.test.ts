import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpaFixture, cleanupSpaFixture } from "../test-support/spa-fixture.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("spa fixture helpers", () => {
  it("preserves pre-existing ui/dist siblings during cleanup", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-fixture-"));
    tempRoots.push(tempRoot);

    const uiDistDir = path.join(tempRoot, "ui", "dist");
    fs.mkdirSync(uiDistDir, { recursive: true });

    const siblingPath = path.join(uiDistDir, "asset.txt");
    fs.writeFileSync(siblingPath, "keep", "utf8");

    const fixture = createSpaFixture(uiDistDir, "<html>fixture</html>");
    cleanupSpaFixture(fixture);

    expect(fs.existsSync(siblingPath)).toBe(true);
    expect(fs.existsSync(fixture.uiIndexPath)).toBe(false);
  });

  it("removes the created ui/dist directory when the fixture created it", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-spa-fixture-"));
    tempRoots.push(tempRoot);

    const uiDistDir = path.join(tempRoot, "ui", "dist");
    const fixture = createSpaFixture(uiDistDir, "<html>fixture</html>");
    cleanupSpaFixture(fixture);

    expect(fs.existsSync(uiDistDir)).toBe(false);
  });
});
