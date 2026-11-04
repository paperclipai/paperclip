import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { gradeLegacyWorkspaceMigration, isLegacyWorkspaceMigration, type MigrationPoint } from "./legacy-workspace-migration.js";
import { remoteWorkspaceStorageServerEnvironment } from "./remote-workspace-storage.js";

const before: MigrationPoint = { workspaceId: "workspace", providerType: "isolated_worktree", migrated: false,
  proofSha256: "original-file", runId: "first", sessionId: "session", providerSessionSha256: "provider-session",
  logicalCwd: "/old-controller/workspace", remoteCwd: "/home/daytona/paperclip-workspace" };
const after: MigrationPoint = { ...before, runId: "second", migrated: true, providerType: "cloud_sandbox" };

describe("legacy workspace migration qualification", () => {
  it("requires the preserved session and file, not only a successful new turn", () => {
    expect(gradeLegacyWorkspaceMigration(before, after).every(check => check.passed)).toBe(true);
    for (const patch of [{ proofSha256: "recreated" }, { sessionId: "fresh" }, { providerSessionSha256: "fresh" },
      { logicalCwd: "/new-home/workspace" }, { remoteCwd: "/new-sandbox/workspace" }, { workspaceId: "other" },
      { runId: before.runId }, { migrated: false }]) {
      expect(gradeLegacyWorkspaceMigration(before, { ...after, ...patch }).every(check => check.passed)).toBe(false);
    }
    expect(gradeLegacyWorkspaceMigration(before).every(check => check.passed)).toBe(false);
  });

  it("registers explicit warm and per-turn production profiles with isolated object storage", () => {
    const cells = runnerMatrix.filter(isLegacyWorkspaceMigration);
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells.map(cell => cell.suite.id)).size).toBe(2);
    expect(cells.every(cell => cell.suite.manualOnly && cell.task.flow === "continuation" && cell.task.expectedRunCount === 2)).toBe(true);
    expect(remoteWorkspaceStorageServerEnvironment({ executions: [cells[0]!], instanceId: "migration-test",
      env: { PAPERCLIP_RUNNER_E2E_WORKSPACE_STORAGE_BUCKET: "owned-migration-bucket" } })).toMatchObject({ PAPERCLIP_STORAGE_PROVIDER: "s3" });
  });
});
