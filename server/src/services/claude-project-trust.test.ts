import { describe, expect, it } from "vitest";
import { matchesClaudeProjectTrustGrant, type ClaudeProjectTrustIdentity } from "./claude-project-trust.js";

describe("Claude project trust identity", () => {
  const grant: ClaudeProjectTrustIdentity = {
    companyId: "company", projectId: "project", workspaceId: "workspace", agentId: "agent",
    sourceType: "git_repo", cwd: "/workspace", repoUrl: "https://example.invalid/repo.git",
    repoRef: "main", defaultRef: "main", remoteProvider: null, remoteWorkspaceRef: null,
  };

  it("permits only the approved agent and exact workspace source", () => {
    expect(matchesClaudeProjectTrustGrant(grant, { ...grant })).toBe(true);
    for (const key of Object.keys(grant) as Array<keyof ClaudeProjectTrustIdentity>) {
      expect(matchesClaudeProjectTrustGrant(grant, { ...grant, [key]: "changed" }), key).toBe(false);
    }
  });

  it("rejects incomplete persisted grants", () => {
    expect(matchesClaudeProjectTrustGrant({ companyId: "company" } as ClaudeProjectTrustIdentity, grant)).toBe(false);
  });
});
