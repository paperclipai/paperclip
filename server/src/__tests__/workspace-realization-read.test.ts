import { describe, expect, it } from "vitest";
import { readWorkspaceRealizationRequest } from "../services/workspace-realization.js";

const baseValid = {
  version: 1,
  adapterType: "claude_local",
  companyId: "company-123",
  environmentId: "env-123",
  executionWorkspaceId: null,
  issueId: "issue-123",
  heartbeatRunId: "run-123",
  requestedMode: null,
  source: {
    localPath: "C:/repos/example",
    projectId: null,
    projectWorkspaceId: null,
    repoUrl: null,
    repoRef: null,
    strategy: "project_primary",
    branchName: null,
    worktreePath: null,
  },
  runtimeOverlay: {},
};

describe("readWorkspaceRealizationRequest — kind allowlist", () => {
  it("preserves kind=task_session", () => {
    const parsed = readWorkspaceRealizationRequest({
      ...baseValid,
      source: { ...baseValid.source, kind: "task_session" },
    });
    expect(parsed?.source.kind).toBe("task_session");
  });

  it("preserves kind=agent_home", () => {
    const parsed = readWorkspaceRealizationRequest({
      ...baseValid,
      source: { ...baseValid.source, kind: "agent_home" },
    });
    expect(parsed?.source.kind).toBe("agent_home");
  });

  it("preserves kind=agent_config (regression for upstream issue #4946 round-trip)", () => {
    // Without this case, persisted requests with kind=agent_config would be
    // silently coerced to project_primary on read — losing the signal that
    // the workspace was resolved from agent.adapterConfig.cwd, not the
    // project's primary workspace. See PR description.
    const parsed = readWorkspaceRealizationRequest({
      ...baseValid,
      source: { ...baseValid.source, kind: "agent_config" },
    });
    expect(parsed?.source.kind).toBe("agent_config");
  });

  it("falls through unknown kinds to project_primary (defensive default)", () => {
    const parsed = readWorkspaceRealizationRequest({
      ...baseValid,
      source: { ...baseValid.source, kind: "future_unknown_kind" },
    });
    expect(parsed?.source.kind).toBe("project_primary");
  });

  it("defaults to project_primary when source.kind is missing", () => {
    const parsed = readWorkspaceRealizationRequest({
      ...baseValid,
      source: { ...baseValid.source },
    });
    expect(parsed?.source.kind).toBe("project_primary");
  });

  it("returns null when version is not 1", () => {
    expect(
      readWorkspaceRealizationRequest({ ...baseValid, version: 2 }),
    ).toBeNull();
  });

  it("returns null when required string fields are missing", () => {
    expect(
      readWorkspaceRealizationRequest({
        ...baseValid,
        source: { ...baseValid.source, localPath: "" },
      }),
    ).toBeNull();
  });
});
