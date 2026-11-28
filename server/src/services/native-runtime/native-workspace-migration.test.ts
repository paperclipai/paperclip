import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resume = vi.hoisted(() => ({ run: null as null | { id: string; runnerProfileJson: { nativeExecutionInput: unknown } } }));
vi.mock("./native-session-resume.js", () => ({ findNativeSessionResumeRun: async () => resume.run }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({ parseNativeExecutionInput: (value: unknown) => value }));

const { inspectNativeWorkspaceMigration } = await import("./native-workspace-migration.js");

describe("native workspace migration identity", () => {
  const companyId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
  let sync: unknown;
  const db = {
    execute: async () => [{ agentId, issueId, sessionId, createdAt: new Date() }],
    select: () => ({ from: () => ({ where: async () => [{ sync }] }) }),
  } as never;
  const execution = (patch: Record<string, unknown> = {}, cwd = "/workspace") => ({ binding: { executionWorkspaceId: workspaceId,
    companyId, agentId, issueId, ...patch }, session: { normalizedSessionId: sessionId }, workspace: { cwd } });
  const syncReference = (patch: Record<string, unknown> = {}) => ({ schema: "paperclip.native-workspace-sync/v3", state: "finalized",
    descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId, leaseId: randomUUID(),
    providerLeaseId: randomUUID(), remoteCwd: "/home/daytona/workspace", ...patch });
  beforeEach(() => { sync = syncReference(); resume.run = { id: randomUUID(), runnerProfileJson: { nativeExecutionInput: execution() } }; });

  it("records the continuity of a proven session", async () => {
    expect(await inspectNativeWorkspaceMigration(db, { companyId, id: workspaceId }))
      .toMatchObject({ remoteCwd: "/home/daytona/workspace", sessions: [{ agentId, issueId, sessionId, logicalCwd: "/workspace" }] });
  });
  it.each([
    ["unsynced", () => { sync = null; }],
    ["other_workspace", () => { sync = syncReference({ workspaceId: randomUUID() }); }],
    ["rebound", () => { resume.run!.runnerProfileJson.nativeExecutionInput = execution({ executionWorkspaceId: randomUUID() }); }],
    ["path_invalid", () => { resume.run!.runnerProfileJson.nativeExecutionInput = execution({}, "workspace"); }],
  ])("names a session whose saved identity is %s", async (state, arrange) => {
    arrange();
    await expect(inspectNativeWorkspaceMigration(db, { companyId, id: workspaceId }))
      .rejects.toThrow(`native_workspace_migration_identity_${state}`);
  });
});
