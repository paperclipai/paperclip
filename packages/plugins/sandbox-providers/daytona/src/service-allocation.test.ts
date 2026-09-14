import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";

// Provider unit tests use injected sandbox objects; the standalone SDK is not
// installed by the root workspace test command.
vi.mock("@daytonaio/sdk", () => ({ DaytonaNotFoundError: class extends Error {} }));
import { acquireDaytonaServiceAllocation, SERVICE_ALLOCATION_LABEL } from "./service-allocation.js";

function fixture() {
  const sandboxes = new Map<string, Sandbox>();
  const get = vi.fn(async (name: string) => {
    const found = sandboxes.get(name);
    if (!found) throw new DaytonaNotFoundError("Not found");
    return found;
  });
  const create = vi.fn(async (params: { name: string; labels: Record<string, string> }) => {
    if (sandboxes.has(params.name)) throw new Error("Sandbox name already exists");
    const sandbox = { id: randomUUID(), name: params.name, labels: params.labels, refreshData: vi.fn().mockResolvedValue(undefined), delete: vi.fn() } as unknown as Sandbox;
    sandboxes.set(params.name, sandbox);
    return sandbox;
  });
  const input = { client: { get, create } as unknown as Pick<Daytona, "get" | "create">,
    allocationId: randomUUID(), companyId: randomUUID(), environmentId: randomUUID(),
    params: { image: "node:24", resources: { cpu: 1, memory: 2 }, autoStopInterval: 5, autoDeleteInterval: 0, ttlMinutes: 10, public: true }, timeoutSeconds: 30 };
  return { input, get, create, sandboxes };
}

describe("recoverable Daytona service allocation", () => {
  it("rechecks mutable snapshot configuration only before creating a new allocation", async () => {
    const f = fixture(), beforeCreate = vi.fn(async () => {});
    beforeCreate.mockRejectedValueOnce(new Error("snapshot resources changed"));
    await expect(acquireDaytonaServiceAllocation({ ...f.input, beforeCreate })).rejects.toThrow("snapshot resources changed");
    expect(f.create).not.toHaveBeenCalled();
    const original = await acquireDaytonaServiceAllocation({ ...f.input, beforeCreate });
    beforeCreate.mockRejectedValueOnce(new Error("snapshot no longer exists"));
    expect((await acquireDaytonaServiceAllocation({ ...f.input, beforeCreate })).id).toBe(original.id);
    expect(beforeCreate).toHaveBeenCalledTimes(2); expect(f.create).toHaveBeenCalledOnce();
  });
  it("disables provider destruction at creation and recovers the same owned allocation on replay", async () => {
    const f = fixture();
    const first = await acquireDaytonaServiceAllocation(f.input);
    const second = await acquireDaytonaServiceAllocation(f.input);
    expect(second.id).toBe(first.id); expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![0]).toMatchObject({ name: `paperclip-service-${f.input.allocationId}`, public: false, ephemeral: false,
      autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1, ttlMinutes: 0,
      labels: { [SERVICE_ALLOCATION_LABEL]: f.input.allocationId, "paperclip-services-retained": "true" } });
  });

  it("recovers when the create response is lost after the provider allocated the sandbox", async () => {
    const f = fixture(); const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (params) => { await create(params); throw new Error("Response lost"); });
    const recovered = await acquireDaytonaServiceAllocation(f.input);
    expect(recovered.id).toBe([...f.sandboxes.values()][0]!.id);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.sandboxes.size).toBe(1);
  });

  it("uses the same name across concurrent controllers and recovers the unique-name conflict", async () => {
    const f = fixture();
    const [left, right] = await Promise.all([acquireDaytonaServiceAllocation(f.input), acquireDaytonaServiceAllocation(f.input)]);
    expect(left.id).toBe(right.id); expect(f.sandboxes.size).toBe(1);
    expect(new Set(f.create.mock.calls.map(([params]) => params.name)).size).toBe(1);
  });

  it("preserves an uncertain claim when both creation and its recovery lookup time out", async () => {
    const f = fixture(); const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (params) => {
      await create(params); f.get.mockRejectedValueOnce(new Error("Lookup timeout")); throw new Error("Create timeout");
    });
    await expect(acquireDaytonaServiceAllocation(f.input)).rejects.toThrow("Create timeout");
    const recovered = await acquireDaytonaServiceAllocation(f.input);
    expect(f.create).toHaveBeenCalledTimes(1); expect(recovered.delete).not.toHaveBeenCalled();
  });

  it("does not create on lookup authentication, network, or rate-limit errors", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new Error("Unauthorized"));
    await expect(acquireDaytonaServiceAllocation(f.input)).rejects.toThrow("Unauthorized");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("rejects another company, environment, or changed resource request without touching the sandbox", async () => {
    const f = fixture(); const sandbox = await acquireDaytonaServiceAllocation(f.input);
    for (const patch of [{ companyId: randomUUID() }, { environmentId: randomUUID() }, { target: "eu" }, { params: { ...f.input.params, resources: { cpu: 4, memory: 8 } } }]) {
      await expect(acquireDaytonaServiceAllocation({ ...f.input, ...patch })).rejects.toThrow("ownership or configuration");
    }
    expect(f.create).toHaveBeenCalledTimes(1); expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("checks current provider labels on replay and rejects malformed identities before allocation", async () => {
    const f = fixture(); const sandbox = await acquireDaytonaServiceAllocation(f.input);
    vi.mocked(sandbox.refreshData).mockImplementationOnce(async () => { sandbox.labels[SERVICE_ALLOCATION_LABEL] = randomUUID(); });
    await expect(acquireDaytonaServiceAllocation(f.input)).rejects.toThrow("ownership or configuration");
    const other = fixture();
    await expect(acquireDaytonaServiceAllocation({ ...other.input, allocationId: "../foreign" })).rejects.toThrow("Invalid service allocation identity");
    expect(other.get).not.toHaveBeenCalled(); expect(other.create).not.toHaveBeenCalled();
  });
});
