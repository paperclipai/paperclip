import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VERIFY_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/pelergy-trial/VERIFY.md",
);

describe("Pelergy trial verify doc", () => {
  it("exists with required verification sections", () => {
    expect(fs.existsSync(VERIFY_DOC_PATH)).toBe(true);

    const content = fs.readFileSync(VERIFY_DOC_PATH, "utf8");

    expect(content).toContain("# Pelergy Trial Verification");
    expect(content).toContain("## Verification Notes");
    expect(content).toContain("## Screenshot Checklist");
  });

  it("records screenshot path and sandbox capture status", () => {
    const content = fs.readFileSync(VERIFY_DOC_PATH, "utf8");

    expect(content).toContain("docs/pelergy-trial/screenshots/");
    expect(content).toContain("not captured in this sandbox");
  });
});
