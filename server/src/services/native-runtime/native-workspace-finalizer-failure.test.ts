import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitShallowMetadataError } from "@paperclipai/adapter-utils/git-workspace-sync";
import type { Db } from "@paperclipai/db";

const sync = vi.hoisted(() => ({ resume: vi.fn(), save: vi.fn() }));
vi.mock("./native-workspace-finalization-ownership.js", () => ({
  withNativeWorkspaceFinalizationOwnership: async (_input: unknown, action: (owner: unknown) => unknown) =>
    ({ acquired: true, value: await action({ token: "fixture-owner", assertHeld: async () => {} }) }),
}));
vi.mock("./native-workspace-sync.js", () => ({
  readNativeWorkspaceSyncReference: () => ({ leaseId: "lease", providerLeaseId: "sandbox", workspaceId: "workspace" }),
  resumeNativeWorkspaceSync: sync.resume,
}));
vi.mock("../remote-workspaces.js", () => ({
  readRemoteWorkspaceAuthority: (metadata: { remoteWorkspace?: unknown } | null) => metadata?.remoteWorkspace ?? null,
  saveRemoteWorkspace: sync.save,
}));
vi.mock("../environments.js", () => ({ environmentService: () => ({
  getLeaseById: async () => ({ id: "lease", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", status: "active",
    heartbeatRunId: "run", executionWorkspaceId: "workspace" }),
  getById: async () => ({ id: "environment", companyId: "company" }),
}) }));
vi.mock("../environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async () => ({ kind: "remote" }) }));
vi.mock("../workspace-operations.js", () => ({ workspaceOperationService: () => ({
  createRecorder: () => ({ recordOperation: async (input: { run: () => Promise<unknown> }) => input.run() }),
}) }));
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL, RemoteWorkspaceOperationError } from "../remote-workspace-transport.js";

function fixtureDb(workspace?: Record<string, unknown>): Db {
  const responses = [[{
    companyId: "company", runtimeMode: "native", issueId: "issue", resultId: "result", issueWorkspaceId: workspace?.id,
    runnerProfileJson: { nativeWorkspaceSync: {}, nativeExecutionInput: { binding: {} } },
  }], [{ phase: "result_accepted", nextAttemptAt: null, resultId: "result" }], [], [], ...(workspace ? [[workspace]] : [])];
  return { select: () => {
    const query = {
      from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query,
      limit: async () => responses.shift() ?? [],
    };
    return query;
  } } as unknown as Db;
}

describe("native workspace finalization without a manual export repair", () => {
  beforeEach(() => sync.resume.mockReset());
  it.each([
    "Daytona syncOut refusing tarball link whose target escapes the extraction dir: tools/pnpm -> /usr/bin/pnpm",
    "Daytona syncOut refusing tarball member that escapes the extraction dir: ../private",
  ])("settles unsafe exports successfully after restart: %s", async (message) => {
    sync.resume.mockRejectedValueOnce(new Error(message));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(sync.resume).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("tools/pnpm");
  });

  it.each([
    ["daytona_sandbox_not_found", "workspace_sync_out_unrecoverable"],
    ["Daytona syncOut directory download failed: timeout", "workspace_sync_out_failed"],
  ])("retains unrelated failure handling: %s", async (message, code) => {
    sync.resume.mockRejectedValueOnce(new Error(message));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: `${code}\n` });
  });

  it("fails copyback for invalid Git metadata instead of successfully omitting saved files", async () => {
    sync.resume.mockRejectedValueOnce(new GitShallowMetadataError("Git shallow metadata exceeds its byte limit"));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: "workspace_sync_out_unrecoverable\n" });
    expect(sync.resume).toHaveBeenCalledOnce();
  });

  it("does not treat a missing workspace reference as an omitted unsafe archive", async () => {
    sync.resume.mockResolvedValueOnce(false);
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: "workspace_sync_out_unrecoverable\n" });
  });
});

describe("native remote workspace save failures", () => {
  const workspace = { id: "workspace", companyId: "company", cwd: "/workspace",
    metadata: { remoteWorkspace: { location: { leaseId: "lease", providerLeaseId: "sandbox", environmentId: "environment" } } } };
  beforeEach(() => sync.save.mockReset());

  it("names a full sandbox disk on the failed operation without changing the retry code", async () => {
    sync.save.mockRejectedValueOnce(new Error(REMOTE_WORKSPACE_SANDBOX_DISK_FULL));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(workspace), runId: "run", environmentRuntime: {} as never });
    expect(sync.save).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "failed", exitCode: 1,
      stderr: `workspace_sync_out_failed\n${REMOTE_WORKSPACE_SANDBOX_DISK_FULL}\n`,
      metadata: { workspaceSync: { code: "workspace_sync_out_failed", cause: REMOTE_WORKSPACE_SANDBOX_DISK_FULL } } });
  });

  it("keeps the redacted remote operation cause on retried copy-back", async () => {
    const cause = "remote_workspace_operation_failed: operation=capture exit=1; "
      + "remote_workspace_capture_failed: stage=archive exit=128 program=git helper_exit=1";
    sync.save.mockRejectedValueOnce(new RemoteWorkspaceOperationError(cause));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(workspace), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: `workspace_sync_out_failed\n${cause}\n`,
      metadata: { workspaceSync: { code: "workspace_sync_out_failed", cause } } });
  });

  it("keeps other save failures to the bare code", async () => {
    sync.save.mockRejectedValueOnce(new Error("remote_workspace_operation_failed: SYNTHETIC_PRIVATE_PATH"));
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(workspace), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: "workspace_sync_out_failed\n" });
  });
});
