import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { assertDaytonaServiceDataAvailable, deleteDaytonaServiceData, SERVICE_DATA_DELETION_LABEL } from "./service-data-deletion.js";

function fixture() {
  const input = { companyId: randomUUID(), environmentId: randomUUID(), allocationId: randomUUID(), providerLeaseId: randomUUID(), deletionId: randomUUID(), timeoutSeconds: 30 };
  let present = true;
  const sandbox = {
    id: input.providerLeaseId, name: `paperclip-service-${input.allocationId}`, state: "stopped",
    labels: { "paperclip-provider": "daytona", "paperclip-company-id": input.companyId, "paperclip-environment-id": input.environmentId,
      "paperclip-purpose": "runtime_service", "paperclip-service-allocation-id": input.allocationId, "paperclip-services-retained": "true" } as Record<string, string>,
    refreshData: vi.fn(async () => {}),
    setLabels: vi.fn(async (labels: Record<string, string>) => { sandbox.labels = labels; }),
    delete: vi.fn(async (_timeout: number, _wait: boolean) => { present = false; }),
    start: vi.fn(), stop: vi.fn(),
  };
  const get = vi.fn(async (id: string) => {
    expect(id).toBe(input.providerLeaseId);
    if (!present) throw new DaytonaNotFoundError("Not found");
    return sandbox as unknown as Sandbox;
  });
  const client = { get } as unknown as Pick<Daytona, "get">;
  return { input: { ...input, client }, sandbox, get, gone: () => { present = false; }, run: () => deleteDaytonaServiceData({ ...input, client }) };
}

describe("explicit Daytona service data deletion", () => {
  it.each(["started", "stopped", "archived"])("deletes a verified %s allocation and replays its destruction receipt", async (state) => {
    const f = fixture(); f.sandbox.state = state;
    const receipt = await f.run();
    expect(receipt).toEqual({ providerLeaseId: f.input.providerLeaseId, serviceAllocationId: f.input.allocationId, deletionId: f.input.deletionId, state: "destroyed" });
    expect(await f.run()).toEqual(receipt);
    expect(f.sandbox.delete).toHaveBeenCalledExactlyOnceWith(30, true);
    expect(f.sandbox.labels[SERVICE_DATA_DELETION_LABEL]).toBe(f.input.deletionId);
    expect(f.sandbox.start).not.toHaveBeenCalled(); expect(f.sandbox.stop).not.toHaveBeenCalled();
  });
  it("recovers a lost delete response only after a fresh lookup confirms destruction", async () => {
    const f = fixture();
    f.sandbox.delete.mockImplementationOnce(async () => { f.gone(); throw new Error("Delete response lost"); });
    expect(await f.run()).toMatchObject({ state: "destroyed" });
    expect(f.get).toHaveBeenCalledTimes(2);
  });
  it("does not treat an accepted deletion or a stopped sandbox as destroyed", async () => {
    const f = fixture(); f.sandbox.delete.mockResolvedValueOnce(undefined);
    await expect(f.run()).rejects.toThrow("has not completed");
    expect(() => assertDaytonaServiceDataAvailable(f.sandbox as unknown as Sandbox)).toThrow("being deleted");
    expect(await f.run()).toMatchObject({ state: "destroyed" });
    expect(f.sandbox.setLabels).toHaveBeenCalledTimes(1);
  });
  it("accepts a fresh destroyed-state receipt when the provider keeps its tombstone", async () => {
    const f = fixture(); f.sandbox.delete.mockImplementationOnce(async () => { f.sandbox.state = "destroyed"; });
    expect(await f.run()).toMatchObject({ state: "destroyed" });
    expect(f.sandbox.refreshData).toHaveBeenCalledTimes(3);
  });
  it.each(["paperclip-provider", "paperclip-company-id", "paperclip-environment-id", "paperclip-purpose", "paperclip-service-allocation-id", "paperclip-services-retained"])("rejects a changed %s label before mutating data", async (label) => {
    const f = fixture(); f.sandbox.refreshData.mockImplementationOnce(async () => { f.sandbox.labels[label] = "foreign"; });
    await expect(f.run()).rejects.toThrow("does not match");
    expect(f.sandbox.setLabels).not.toHaveBeenCalled(); expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it.each(["id", "name"] as const)("does not follow a reassigned %s", async (field) => {
    const f = fixture(); f.sandbox[field] = randomUUID();
    await expect(f.run()).rejects.toThrow("does not match"); expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("does not replace another committed deletion identity", async () => {
    const f = fixture(); f.sandbox.labels[SERVICE_DATA_DELETION_LABEL] = randomUUID();
    await expect(f.run()).rejects.toThrow("different deletion");
    expect(f.sandbox.setLabels).not.toHaveBeenCalled(); expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("requires the provider to confirm the deletion fence before deleting", async () => {
    const f = fixture(); f.sandbox.setLabels.mockResolvedValueOnce(undefined);
    await expect(f.run()).rejects.toThrow("fence was not confirmed"); expect(f.sandbox.delete).not.toHaveBeenCalled();
  });
  it("retains an ambiguous deletion when either provider lookup fails", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new Error("Lookup unauthorized"));
    await expect(f.run()).rejects.toThrow("Lookup unauthorized"); expect(f.sandbox.delete).not.toHaveBeenCalled();
    f.sandbox.delete.mockImplementationOnce(async () => { f.get.mockRejectedValueOnce(new Error("Verification unavailable")); });
    await expect(f.run()).rejects.toThrow("Verification unavailable");
    expect(f.sandbox.labels[SERVICE_DATA_DELETION_LABEL]).toBe(f.input.deletionId);
    expect(await f.run()).toMatchObject({ state: "destroyed" });
  });
  it("does not mutate a replacement returned by the final verification lookup", async () => {
    const f = fixture(); f.sandbox.delete.mockImplementationOnce(async () => { f.sandbox.labels["paperclip-company-id"] = randomUUID(); });
    await expect(f.run()).rejects.toThrow("does not match"); expect(f.sandbox.delete).toHaveBeenCalledTimes(1);
  });
  it("validates deletion IDs and bounded timeouts before provider lookup", async () => {
    const f = fixture();
    for (const patch of [{ deletionId: "../foreign" }, { providerLeaseId: "a-reusable-name" }, { allocationId: "" }, { timeoutSeconds: 0 }, { timeoutSeconds: 121 }]) {
      await expect(deleteDaytonaServiceData({ ...f.input, ...patch })).rejects.toThrow();
    }
    expect(f.get).not.toHaveBeenCalled();
  });
});
