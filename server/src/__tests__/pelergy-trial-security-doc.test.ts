import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SECURITY_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/pelergy-trial/SECURITY.md",
);

describe("Pelergy trial security doc", () => {
  it("exists with required sections", () => {
    expect(fs.existsSync(SECURITY_DOC_PATH)).toBe(true);

    const content = fs.readFileSync(SECURITY_DOC_PATH, "utf8");

    expect(content).toContain("# Pelergy Trial Security");
    expect(content).toContain("## Current Vulnerabilities");
    expect(content).toContain("## Trial Mitigation Plan");
  });

  it("tracks at least three explicit vulnerabilities", () => {
    const content = fs.readFileSync(SECURITY_DOC_PATH, "utf8");
    const vulnerabilityRows = content.match(/^\| PT-SEC-\d{3} \|/gm) ?? [];

    expect(vulnerabilityRows.length).toBeGreaterThanOrEqual(3);
  });
});
