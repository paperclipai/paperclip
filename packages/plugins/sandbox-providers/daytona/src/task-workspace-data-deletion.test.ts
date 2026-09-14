import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { SERVICE_DATA_DELETION_LABEL } from "./service-data-deletion.js";
import { daytonaTaskWorkspaceOwnership, deleteDaytonaTaskWorkspaceData, TASK_WORKSPACE_LABEL } from "./task-workspace-data-deletion.js";

function fixture() {
  const companyId = randomUUID(), environmentId = randomUUID(), providerLeaseId = randomUUID(), deletionId = randomUUID();
  const ownership = { version: 1 as const, executionWorkspaceId: randomUUID(), createdByRunId: randomUUID(), sandboxName: "task-sandbox" };
  let present = true;
  const sandbox = { id: providerLeaseId, name: ownership.sandboxName, state: "stopped", labels: {
    "paperclip-provider": "daytona", "paperclip-company-id": companyId, "paperclip-environment-id": environmentId,
    "paperclip-run-id": ownership.createdByRunId, [TASK_WORKSPACE_LABEL]: ownership.executionWorkspaceId, "paperclip-services-retained": "true",
  } as Record<string, string>, refreshData: vi.fn(async () => {}), setLabels: vi.fn(async (labels: Record<string, string>) => { sandbox.labels = labels; }),
  delete: vi.fn(async (_seconds: number, _wait: boolean) => { present = false; }), start: vi.fn(), stop: vi.fn() };
  const get = vi.fn(async (id: string) => { expect(id).toBe(providerLeaseId); if (!present) throw new DaytonaNotFoundError("Missing"); return sandbox as unknown as Sandbox; });
  const input = { companyId, environmentId, providerLeaseId, deletionId, ownership, timeoutSeconds: 30, client: { get } as unknown as Pick<Daytona, "get"> };
  return { input, sandbox, get, gone: () => { present = false; }, run: () => deleteDaytonaTaskWorkspaceData(input) };
}

describe("explicit Daytona task-workspace deletion", () => {
  it.each(["started", "stopped", "archived"])("deletes the original %s sandbox without starting compute and replays a missing receipt", async (state) => {
    const f = fixture(); f.sandbox.state = state;
    const receipt = await f.run(); expect(receipt).toEqual({ providerLeaseId: f.input.providerLeaseId, executionWorkspaceId: f.input.ownership.executionWorkspaceId, deletionId: f.input.deletionId, state: "destroyed" });
    expect(await f.run()).toEqual(receipt); expect(f.sandbox.delete).toHaveBeenCalledExactlyOnceWith(30, true);
    expect(f.sandbox.labels[SERVICE_DATA_DELETION_LABEL]).toBe(f.input.deletionId); expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.stop).not.toHaveBeenCalled();
  });
  it.each(["paperclip-provider", "paperclip-company-id", "paperclip-environment-id", "paperclip-run-id", TASK_WORKSPACE_LABEL, "paperclip-services-retained"])("refuses changed %s ownership before deletion", async (label) => {
    const f = fixture(); f.sandbox.refreshData.mockImplementationOnce(async () => { f.sandbox.labels[label] = randomUUID(); });
    await expect(f.run()).rejects.toThrow("does not match"); expect(f.sandbox.delete).not.toHaveBeenCalled(); expect(f.sandbox.setLabels).not.toHaveBeenCalled();
  });
  it.each(["paperclip-purpose", "paperclip-service-allocation-id"])("refuses standalone allocations or setup/probe ownership with %s", async (label) => {
    const f = fixture(); f.sandbox.labels[label] = "runtime_service";
    expect(daytonaTaskWorkspaceOwnership(f.sandbox as unknown as Sandbox)).toBeNull(); await expect(f.run()).rejects.toThrow("does not match");
    expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it.each(["id", "name"] as const)("refuses a replaced sandbox %s", async (field) => {
    const f = fixture(); f.sandbox[field] = randomUUID(); await expect(f.run()).rejects.toThrow("does not match"); expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("does not manufacture ownership for an older unlabelled task sandbox", async () => {
    const f = fixture(); delete f.sandbox.labels[TASK_WORKSPACE_LABEL];
    await expect(f.run()).rejects.toThrow("does not match"); expect(f.sandbox.setLabels).not.toHaveBeenCalled();
  });
  it("requires a confirmed same-job deletion marker and preserves ambiguous cleanup", async () => {
    const f = fixture(); f.sandbox.setLabels.mockResolvedValueOnce(undefined);
    await expect(f.run()).rejects.toThrow("fence was not confirmed"); expect(f.sandbox.delete).not.toHaveBeenCalled();
    f.sandbox.labels[SERVICE_DATA_DELETION_LABEL] = randomUUID(); await expect(f.run()).rejects.toThrow("different deletion");
    f.sandbox.labels[SERVICE_DATA_DELETION_LABEL] = f.input.deletionId; f.sandbox.delete.mockResolvedValueOnce(undefined);
    await expect(f.run()).rejects.toThrow("has not completed"); expect(await f.run()).toMatchObject({ state: "destroyed" });
  });
  it("recovers lost responses only from fresh provider absence or a destroyed tombstone", async () => {
    const f = fixture(); f.sandbox.delete.mockImplementationOnce(async () => { f.gone(); throw new Error("Lost response"); });
    expect(await f.run()).toMatchObject({ state: "destroyed" }); expect(f.get).toHaveBeenCalledTimes(2);
    const tombstone = fixture(); tombstone.sandbox.delete.mockImplementationOnce(async () => { tombstone.sandbox.state = "destroyed"; });
    expect(await tombstone.run()).toMatchObject({ state: "destroyed" });
  });
  it("preserves uncertainty on provider errors and rejects reassignment during final verification", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new Error("Connection unavailable")); await expect(f.run()).rejects.toThrow("Connection unavailable");
    expect(f.sandbox.delete).not.toHaveBeenCalled();
    f.sandbox.delete.mockImplementationOnce(async () => { f.get.mockRejectedValueOnce(new Error("Verification unavailable")); });
    await expect(f.run()).rejects.toThrow("Verification unavailable");
    f.sandbox.delete.mockImplementationOnce(async () => { f.sandbox.labels[TASK_WORKSPACE_LABEL] = randomUUID(); });
    await expect(f.run()).rejects.toThrow("does not match");
  });
  it("validates identifiers, ownership and timeout before a lookup, including already missing resources", async () => {
    const f = fixture(); f.gone();
    for (const patch of [{ providerLeaseId: "reusable-name" }, { deletionId: "../outside" }, { timeoutSeconds: 0 }, { timeoutSeconds: 121 },
      { ownership: { ...f.input.ownership, executionWorkspaceId: "not-an-id" } }, { ownership: { ...f.input.ownership, sandboxName: "paperclip-service-foreign" } }]) {
      await expect(deleteDaytonaTaskWorkspaceData({ ...f.input, ...patch })).rejects.toThrow();
    }
    expect(f.get).not.toHaveBeenCalled();
  });
});
