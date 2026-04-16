import { describe, expect, it } from "vitest";
import {
  REDACTED_MARKER,
  redactDomHtml,
  redactScreenshotRegions,
} from "../src/server/tools/redaction.js";

describe("redactDomHtml", () => {
  it("blanks password input value attributes", () => {
    const html = `<form><input type="password" name="pw" value="hunter2"/></form>`;
    const out = redactDomHtml(html, { resolvedSecretValues: [] });
    expect(out).not.toContain("hunter2");
    expect(out).toContain(REDACTED_MARKER);
  });

  it("blanks data-secret value attributes", () => {
    const html = `<input data-secret value="s3cret"/>`;
    const out = redactDomHtml(html, { resolvedSecretValues: [] });
    expect(out).not.toContain("s3cret");
    expect(out).toContain(REDACTED_MARKER);
  });

  it("scrubs resolved secret values reflected into markup", () => {
    const html = `<div>Welcome back, your password was hunter2!</div>`;
    const out = redactDomHtml(html, { resolvedSecretValues: ["hunter2"] });
    expect(out).not.toContain("hunter2");
    expect(out).toContain(REDACTED_MARKER);
  });

  it("skips short secrets to avoid over-redacting common substrings", () => {
    const html = `<div>ok</div>`;
    const out = redactDomHtml(html, { resolvedSecretValues: ["ok"] });
    expect(out).toBe(html);
  });
});

describe("redactScreenshotRegions", () => {
  it("expands bounding boxes by 2px on every side", () => {
    const boxes = redactScreenshotRegions([
      { x: 10, y: 20, width: 100, height: 30, reason: "password" },
    ]);
    expect(boxes).toEqual([
      { x: 8, y: 18, width: 104, height: 34, reason: "password" },
    ]);
  });

  it("clamps expansion at the origin", () => {
    const [box] = redactScreenshotRegions([
      { x: 1, y: 0, width: 10, height: 10, reason: "data-secret" },
    ]);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });
});
