import { describe, expect, it } from "vitest";
import manifest, { ASSISTANT_EXPORT_NAME } from "../src/manifest.js";

describe("Operator Assistant manifest", () => {
  it("declares a global drawer launcher", () => {
    expect(manifest.ui?.launchers).toContainEqual(expect.objectContaining({
      placementZone: "globalToolbarButton",
      action: { type: "openDrawer", target: ASSISTANT_EXPORT_NAME },
    }));
  });

  it("has no issue mutation capability", () => {
    expect(manifest.capabilities.some((capability) => capability.startsWith("issues.create"))).toBe(false);
    expect(manifest.capabilities.some((capability) => capability.startsWith("issues.update"))).toBe(false);
    expect(manifest.capabilities.some((capability) => capability.startsWith("issue.comments.create"))).toBe(false);
    expect(manifest.agents?.[0]?.executionAccess).toBe("readOnly");
  });

  it("whitelists only the core tables needed for bounded retrieval", () => {
    expect(manifest.database?.coreReadTables).toEqual([
      "companies",
      "projects",
      "agents",
      "issues",
      "issue_comments",
      "issue_relations",
      "heartbeat_runs",
    ]);
  });
});
