import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { shouldPreserveEquivalentSharedWorkspaceBinding } from "../services/heartbeat.ts";

function makeWorkspace(overrides: Partial<ExecutionWorkspace>): ExecutionWorkspace {
  const now = new Date("2026-05-10T00:00:00.000Z");
  return {
    id: overrides.id ?? "workspace-1",
    companyId: overrides.companyId ?? "company-1",
    projectId: overrides.projectId ?? "project-1",
    projectWorkspaceId: overrides.projectWorkspaceId ?? "project-workspace-1",
    sourceIssueId: overrides.sourceIssueId ?? null,
    mode: overrides.mode ?? "shared_workspace",
    strategyType: overrides.strategyType ?? "project_primary",
    name: overrides.name ?? "Workspace",
    status: overrides.status ?? "idle",
    cwd: overrides.cwd ?? "/repo/server",
    repoUrl: overrides.repoUrl ?? null,
    baseRef: overrides.baseRef ?? null,
    branchName: overrides.branchName ?? null,
    providerType: overrides.providerType ?? "local_fs",
    providerRef: overrides.providerRef ?? "/repo/server",
    derivedFromExecutionWorkspaceId: overrides.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: overrides.lastUsedAt ?? now,
    openedAt: overrides.openedAt ?? now,
    closedAt: overrides.closedAt ?? null,
    cleanupEligibleAt: overrides.cleanupEligibleAt ?? null,
    cleanupReason: overrides.cleanupReason ?? null,
    config: overrides.config ?? null,
    metadata: overrides.metadata ?? null,
    runtimeServices: overrides.runtimeServices,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe("shouldPreserveEquivalentSharedWorkspaceBinding", () => {
  it("keeps an explicit reuse_existing binding when heartbeat materializes an equivalent shared workspace row", () => {
    const existing = makeWorkspace({
      id: "workspace-a",
      cwd: "/Users/mstatev/dev/paperclip/server/",
      providerRef: "/Users/mstatev/dev/paperclip/server/",
    });
    const persisted = makeWorkspace({
      id: "workspace-b",
      cwd: "/Users/mstatev/dev/paperclip/server",
      providerRef: "/Users/mstatev/dev/paperclip/server",
    });

    expect(shouldPreserveEquivalentSharedWorkspaceBinding({
      issueExecutionWorkspacePreference: "reuse_existing",
      existingExecutionWorkspace: existing,
      persistedExecutionWorkspace: persisted,
    })).toBe(true);
  });

  it("does not preserve when the realized workspace is materially different", () => {
    const existing = makeWorkspace({
      id: "workspace-a",
      projectWorkspaceId: "project-workspace-1",
      cwd: "/Users/mstatev/dev/paperclip/server",
      providerRef: "/Users/mstatev/dev/paperclip/server",
    });
    const persisted = makeWorkspace({
      id: "workspace-b",
      projectWorkspaceId: "project-workspace-2",
      cwd: "/Users/mstatev/dev/paperclip/other",
      providerRef: "/Users/mstatev/dev/paperclip/other",
    });

    expect(shouldPreserveEquivalentSharedWorkspaceBinding({
      issueExecutionWorkspacePreference: "reuse_existing",
      existingExecutionWorkspace: existing,
      persistedExecutionWorkspace: persisted,
    })).toBe(false);
  });
});
