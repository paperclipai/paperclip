import { describe, expect, it, vi } from "vitest";
import { resolveEnvironmentExecutionTarget, resolveEnvironmentExecutionTransport } from "./environment-execution-target.js";
import { createComputerEnvironmentDriver } from "./computer-environment-driver.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";

const state = vi.hoisted(() => {
  const binding = { owner: { computerId: "computer", ownerId: "owner", generation: 1 },
    listenerPort: 43127, remoteCwd: "/remote/workspace", placementId: "placement", agentHome: "/remote/home" };
  return { admit: vi.fn(async (_input: { sessionKey: string }) => binding), admitProbe: vi.fn(async () => binding),
    retire: vi.fn(async () => ({ retired: true })), acquireLease: vi.fn(async (input: unknown) => input) };
});
vi.mock("../modules/computers/index.js", () => ({ computerService: () => state }));
vi.mock("./environments.js", () => ({ environmentService: () => state }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({ getExperimental: async () => ({ enableBoatEnvironments: true }) }) }));

describe("computer environment probe ownership", () => {
  it("does not construct a computer owner for legacy transport serialization", async () => {
    const input = { db: {} as never, companyId: "company", adapterType: "paperclip_runner",
      environment: { id: "environment", driver: "computer", config: {} }, leaseMetadata: null };
    await expect(resolveEnvironmentExecutionTransport(input)).resolves.toBeNull();
    await expect(resolveEnvironmentExecutionTarget(input)).rejects.toThrow("computer_lease_required");
  });

  it("keeps stable configuration on one session key and fences a changed model", async () => {
    state.admit.mockClear();
    const db = { update: () => ({ set: () => ({ where: async () => undefined }) }) };
    const driver = createComputerEnvironmentDriver(db as never);
    for (const executionConfigurationKey of ["model-a", "model-a", "model-b"]) {
      await driver.acquireRunLease({ companyId: "company", agentId: "agent", heartbeatRunId: "run",
        environment: { id: "environment", config: {} }, adapterType: "paperclip_runner", executionConfigurationKey } as never);
    }
    const keys = state.admit.mock.calls.map(([input]) => input.sessionKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    state.admit.mockClear();
  });

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

describe("computer environment selection", () => {
  const environment = { id: "environment", driver: "computer", status: "active", config: {}, metadata: { computerCompanyId: "owner" } };
  const service = { getById: async () => environment };
  it("permits the attached company and rejects another company", async () => {
    await expect(assertEnvironmentSelectionForCompany(service, "owner", "environment")).resolves.toBeUndefined();
    await expect(assertEnvironmentSelectionForCompany(service, "other", "environment")).rejects.toThrow("not available in this company");
  });
});
