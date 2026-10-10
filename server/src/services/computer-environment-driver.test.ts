import { describe, expect, it, vi } from "vitest";
import { createComputerEnvironmentDriver } from "./computer-environment-driver.js";

const state = vi.hoisted(() => {
  const binding = { owner: { computerId: "computer", ownerId: "owner", generation: 1 },
    listenerPort: 43127, remoteCwd: "/remote/workspace", placementId: "placement", agentHome: "/remote/home" };
  return { admit: vi.fn(async () => binding), admitProbe: vi.fn(async () => binding),
    retire: vi.fn(async () => ({ retired: true })), acquireLease: vi.fn(async (input: unknown) => input) };
});
vi.mock("../modules/computers/index.js", () => ({ computerService: () => state }));
vi.mock("./environments.js", () => ({ environmentService: () => state }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableBoatEnvironments: true }) }) }));

describe("computer environment probe ownership", () => {
  it("admits a bounded probe without fabricating a heartbeat run", async () => {
    const db = { update: () => ({ set: () => ({ where: async () => undefined }) }) };
    const driver = createComputerEnvironmentDriver(db as never);
    await driver.acquireRunLease({ companyId: "company", agentId: "agent", heartbeatRunId: null,
      environment: { id: "environment", config: {} }, adapterType: "paperclip_runner" } as never);
    expect(state.admit).not.toHaveBeenCalled();
    expect(state.admitProbe).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company", environmentId: "environment", agentId: "agent", probeId: expect.any(String) }));
    expect(state.acquireLease).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: null, providerLeaseId: "owner", metadata: expect.objectContaining({ driver: "computer", computerOwner: { computerId: "computer", ownerId: "owner", generation: 1 } }) }));
  });
});
