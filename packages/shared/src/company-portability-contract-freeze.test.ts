import { describe, expect, it } from "vitest";
import { portabilityManifestSchema } from "./validators/company-portability.js";

describe("worktree terminology portability contract freeze", () => {
  it("round-trips the persisted project workspaces key byte-for-byte", () => {
    const serialized = JSON.stringify({
      schemaVersion: 7,
      generatedAt: "2026-08-31T00:00:00.000Z",
      source: null,
      includes: { company: false, agents: false, projects: true, issues: false, skills: false },
      company: null,
      sidebar: null,
      labels: [],
      blobs: [],
      agents: [],
      skills: [],
      projects: [{
        slug: "paperclip",
        name: "Paperclip",
        path: "projects/paperclip.md",
        description: null,
        ownerAgentSlug: null,
        leadAgentSlug: null,
        targetDate: null,
        color: null,
        status: null,
        executionWorkspacePolicy: null,
        workspaces: [{
          key: "primary",
          name: "Primary",
          sourceType: "local_path",
          repoUrl: null,
          repoRef: null,
          defaultRef: null,
          visibility: "shared",
          setupCommand: null,
          cleanupCommand: null,
          metadata: null,
          isPrimary: true,
        }],
        metadata: null,
      }],
      issues: [],
      envInputs: [],
    });

    const parsed = portabilityManifestSchema.parse(JSON.parse(serialized));
    expect(JSON.stringify(parsed)).toBe(serialized);
    expect(serialized).toContain('"workspaces"');
    expect(serialized).not.toContain('"worktrees"');
  });
});
