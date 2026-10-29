import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const sync = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("./native-workspace-finalization-ownership.js", () => ({
  withNativeWorkspaceFinalizationOwnership: async (_input: unknown, action: (owner: unknown) => unknown) =>
    ({ acquired: true, value: await action({ token: "fixture-owner", assertHeld: async () => {} }) }),
}));
vi.mock("./native-workspace-sync.js", () => ({
  readNativeWorkspaceSyncReference: () => ({ leaseId: "lease", providerLeaseId: "sandbox", workspaceId: "workspace" }),
  resumeNativeWorkspaceSync: sync.resume,
}));
vi.mock("../environments.js", () => ({ environmentService: () => ({
  getLeaseById: async () => ({ id: "lease", companyId: "company", environmentId: "environment", providerLeaseId: "sandbox", status: "active" }),
  getById: async () => ({ id: "environment", companyId: "company" }),
}) }));
vi.mock("../environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async () => ({ kind: "remote" }) }));
vi.mock("../workspace-operations.js", () => ({ workspaceOperationService: () => ({
  createRecorder: () => ({ recordOperation: async (input: { run: () => Promise<unknown> }) => input.run() }),
}) }));
import { resumeNativeWorkspaceFinalization } from "./native-workspace-finalizer.js";

function fixtureDb(): Db {
  const responses = [[{
    companyId: "company", runtimeMode: "native", issueId: "issue", resultId: "result",
    runnerProfileJson: { nativeWorkspaceSync: {}, nativeExecutionInput: { binding: {} } },
  }], [{ phase: "result_accepted", nextAttemptAt: null, resultId: "result" }], []];
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

  it("does not treat a missing workspace reference as an omitted unsafe archive", async () => {
    sync.resume.mockResolvedValueOnce(false);
    const result = await resumeNativeWorkspaceFinalization({ db: fixtureDb(), runId: "run", environmentRuntime: {} as never });
    expect(result).toMatchObject({ status: "failed", exitCode: 1, stderr: "workspace_sync_out_unrecoverable\n" });
  });
});
