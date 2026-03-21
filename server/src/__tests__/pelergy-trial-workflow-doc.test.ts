import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/pelergy-trial/WORKFLOW.md",
);

describe("Pelergy trial workflow doc", () => {
  it("exists with required sections", () => {
    expect(fs.existsSync(WORKFLOW_DOC_PATH)).toBe(true);

    const content = fs.readFileSync(WORKFLOW_DOC_PATH, "utf8");

    expect(content).toContain("# Pelergy Trial Workflow");
    expect(content).toContain("## Approval State Mapping");
    expect(content).toContain("## Routing Rules");
  });

  it("maps Felix, Katya, and Mike to approval states", () => {
    const content = fs.readFileSync(WORKFLOW_DOC_PATH, "utf8");

    expect(content).toContain("| Approval State | Felix | Katya | Mike | Meaning |");

    const states = content.match(/^\| `(?:draft|pending_felix|pending_katya|pending_mike|approved|rejected|cancelled)` \|/gm) ?? [];
    expect(states.length).toBe(7);
  });
});
