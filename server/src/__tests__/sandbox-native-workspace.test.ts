import { describe, expect, it } from "vitest";
import {
  resolveEffectiveRepositoryCredentialsRequired,
  resolveEffectiveSandboxRepositoryRef,
} from "../services/heartbeat.js";
import { buildWorkspaceRealizationRequest } from "../services/workspace-realization.js";

describe("sandbox-native workspace revision selection", () => {
  it("uses the issue baseRef before project and default refs, including an API-90 SHA", () => {
    const api90Sha = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveEffectiveSandboxRepositoryRef({
      issueBaseRef: api90Sha,
      projectBaseRef: "main",
      defaultRepoRef: "develop",
    })).toBe(api90Sha);
  });

  it("resolves repository credentials from issue, project, then workspace policy", () => {
    expect(resolveEffectiveRepositoryCredentialsRequired({ workspacePolicy: true })).toBe(true);
    expect(resolveEffectiveRepositoryCredentialsRequired({ projectPolicy: false, workspacePolicy: true })).toBe(false);
    expect(resolveEffectiveRepositoryCredentialsRequired({ issuePolicy: true, projectPolicy: false })).toBe(true);
    expect(resolveEffectiveRepositoryCredentialsRequired({})).toBe(false);
  });

  it("carries the resolved credential policy and run-scoped binding into the realization request", () => {
    const request = buildWorkspaceRealizationRequest({
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: null,
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      requestedMode: "isolated_workspace",
      workspace: {
        baseCwd: "/workspace/repository",
        cwd: "/workspace/repository",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/org/private.git",
        repoRef: "0123456789abcdef0123456789abcdef01234567",
        repositoryCredentialsRequired: true,
        strategy: "sandbox_repository",
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      workspaceConfig: null,
      repositoryStrategy: "sandbox_repository",
      repositoryCredentialsRequired: true,
      repositoryCredentialSecretName: "git-read-only-run",
    });
    expect(request.source.credentialRequired).toBe(true);
    expect(request.source.credentialSecretName).toBe("git-read-only-run");
    expect(request.source.strategy).toBe("sandbox_repository");
  });
});
