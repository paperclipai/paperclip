import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensurePersistedExecutionWorkspaceAvailable } from "../services/workspace-runtime.js";
import { describe, expect, it } from "vitest";
import { canApplyTaskWorkspaceSelectionAtAdmission, taskWorkspaceRuntimeSelectionEnabled, parseIssueExecutionWorkspaceSettings, resolveExecutionWorkspaceMode } from "../services/execution-workspace-policy.js";

describe("task workspace admission authority", () => {
  it.each([{ hasTypedSelection: true, hasBinding: false }, { hasTypedSelection: false, hasBinding: true }])("keeps isolated intent authoritative with the legacy UI disabled: %j", flags => {
    const enabled = taskWorkspaceRuntimeSelectionEnabled({ legacyUiEnabled: false, ...flags });
    const settings = enabled ? parseIssueExecutionWorkspaceSettings({ mode: "isolated_workspace" }) : null;
    expect(resolveExecutionWorkspaceMode({ projectPolicy: null, issueSettings: settings, legacyUseProjectWorkspace: null })).toBe("isolated_workspace");
  });
  it.each([
    { admittedInput: { schema: "paperclip.native-execution-input.v3", binding: { executionWorkspaceId: "old-projectless-run" } }, restarting: false, hasLeaseOwner: false },
    { admittedInput: null, restarting: true, hasLeaseOwner: false },
    { admittedInput: null, restarting: false, hasLeaseOwner: true },
  ])("defers pending root changes while immutable execution/recovery owns the root", admission => {
    expect(canApplyTaskWorkspaceSelectionAtAdmission(admission)).toBe(false);
  });
  it("keeps a persisted task-owned source projectless when current organizational defaults have a project", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-source-authority-"));
    try {
      const restored = await ensurePersistedExecutionWorkspaceAvailable({
        base: { baseCwd: cwd, source: "project_primary", projectId: "org-project", workspaceId: "org-source", repoUrl: "https://github.com/organization/source", repoRef: "organization-main" },
        workspace: { mode: "shared_workspace", strategyType: "project_primary", cwd, providerRef: cwd,
          projectId: null, projectWorkspaceId: null, repoUrl: null, baseRef: null, branchName: null, metadata: { source: "task_session" } },
        issue: { id: "task", identifier: null, title: "Retain files" },
        agent: { id: "agent", companyId: "company", name: "Agent" },
      });
      expect(restored).toMatchObject({ cwd, projectId: null, workspaceId: null, repoUrl: null, repoRef: null, source: "task_session" });
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });
  it.each([
    { projectId: "configured-project" }, { projectWorkspaceId: "configured-source" }, { repoUrl: "https://github.com/configured/source" },
  ])("retains configured-source classification despite task_session metadata: %j", async configured => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-configured-source-"));
    try {
      const restored = await ensurePersistedExecutionWorkspaceAvailable({
        base: { baseCwd: cwd, source: "task_session", projectId: null, workspaceId: null, repoUrl: null, repoRef: null },
        workspace: { mode: "shared_workspace", strategyType: "project_primary", cwd, providerRef: cwd,
          projectId: null, projectWorkspaceId: null, repoUrl: null, baseRef: null, branchName: null, metadata: { source: "task_session" }, ...configured },
        issue: { id: "task", identifier: null, title: "Configured source" }, agent: { id: "agent", companyId: "company", name: "Agent" },
      });
      expect(restored?.source).toBe("project_primary");
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });
  it("permits new admission to apply explicit pending intent", () => {
    expect(canApplyTaskWorkspaceSelectionAtAdmission({ admittedInput: null, restarting: false, hasLeaseOwner: false })).toBe(true);
  });
});
