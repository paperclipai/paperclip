import { afterEach, expect, it, vi } from "vitest";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { PluginEnvironmentLeaseObservation } from "@paperclipai/plugin-sdk";
import { observeStoppedExecutionResource, readEnvironmentResourceObservationFailure } from "./environment-resource-observation.js";

afterEach(() => vi.restoreAllMocks());
const lease: Pick<EnvironmentLease, "id" | "companyId" | "environmentId" | "heartbeatRunId" | "provider" | "providerLeaseId" | "status" | "releasedAt"> = {
  id: "lease", companyId: "company", environmentId: "environment", heartbeatRunId: "run",
  provider: "controlled-provider", providerLeaseId: "resource", status: "active", releasedAt: null,
};

it.each(["stopped", "destroyed"] as const)("accepts only an exact positive %s observation and retains the original cause", async state => {
  const cause = new Error("controlled_transport_failure");
  const inspect = vi.fn(async () => ({ providerLeaseId: "resource", state }));
  const result = await observeStoppedExecutionResource({
    expected: lease, originalError: cause, deadline: performance.now() + 1000,
    readCurrentLease: async () => lease, inspect,
  });
  expect(inspect).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ code: "environment_resource_stopped", state, cause });
  expect(result?.matches({ leaseId: "lease", environmentId: "environment", providerLeaseId: "resource" })).toBe(true);
  expect(result?.matches({ leaseId: "foreign", environmentId: "environment", providerLeaseId: "resource" })).toBe(false);
});

it("can inspect the same retained lease without requiring an active allocation", async () => {
  const retained = { ...lease, status: "retained" as const, releasedAt: new Date(1) };
  const result = await observeStoppedExecutionResource({
    expected: retained, originalError: new Error("transport"), deadline: performance.now() + 1000,
    readCurrentLease: async () => retained,
    inspect: async () => ({ providerLeaseId: "resource", state: "stopped" }),
  });
  expect(result?.state).toBe("stopped");
});

it.each([
  { id: "foreign" }, { companyId: "foreign" }, { environmentId: "foreign" },
  { heartbeatRunId: "foreign" }, { provider: "foreign" }, { providerLeaseId: "foreign" },
  { status: "retained" as const }, { releasedAt: new Date(1) },
])("refuses a changed current lease before provider inspection (%j)", async change => {
  const original = new Error("transport");
  const inspect = vi.fn();
  expect(await observeStoppedExecutionResource({
    expected: lease, originalError: original, deadline: performance.now() + 1000,
    readCurrentLease: async () => ({ ...lease, ...change }), inspect,
  })).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
  expect(readEnvironmentResourceObservationFailure(original)).toBe("lease_changed");
});

it.each([
  { observation: { providerLeaseId: "resource", state: "active" }, reason: "resource_active" },
  { observation: { providerLeaseId: "resource", state: "unknown" }, reason: "resource_unknown" },
  { observation: { providerLeaseId: "foreign", state: "stopped" }, reason: "foreign_observation" },
  { observation: undefined, reason: "inspection_unavailable" },
] satisfies Array<{ observation: PluginEnvironmentLeaseObservation | undefined; reason: string }>)("retains unknown/foreign observation (%s)", async ({ observation, reason }) => {
  const original = new Error("transport");
  expect(await observeStoppedExecutionResource({
    expected: lease, originalError: original, deadline: performance.now() + 1000,
    readCurrentLease: async () => lease, inspect: async () => observation,
  })).toBeNull();
  expect(readEnvironmentResourceObservationFailure(original)).toBe(reason);
});

it.each(["read", "inspect"] as const)("retains a fixed diagnostic for %s failure", async stage => {
  const original = new Error("transport");
  expect(await observeStoppedExecutionResource({
    expected: lease, originalError: original, deadline: performance.now() + 1000,
    readCurrentLease: async () => { if (stage === "read") throw new Error("private detail"); return lease; },
    inspect: async () => { throw new Error("private detail"); },
  })).toBeNull();
  expect(readEnvironmentResourceObservationFailure(original)).toBe(stage === "read" ? "lease_read_failed" : "inspection_failed");
});

it.each(["before_read", "after_read", "after_inspect"] as const)("never accepts proof outside the original budget (%s)", async boundary => {
  let now = boundary === "before_read" ? 1000 : 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const original = new Error("transport");
  const readCurrentLease = vi.fn(async () => { if (boundary === "after_read") now = 1000; return lease; });
  const inspect = vi.fn(async () => { if (boundary === "after_inspect") now = 1000; return { providerLeaseId: "resource", state: "stopped" as const }; });
  expect(await observeStoppedExecutionResource({ expected: lease, originalError: original, deadline: 1000, readCurrentLease, inspect })).toBeNull();
  if (boundary === "before_read") expect(readCurrentLease).not.toHaveBeenCalled();
  if (boundary !== "after_inspect") expect(inspect).not.toHaveBeenCalled();
  expect(readEnvironmentResourceObservationFailure(original)).toBe("budget_exhausted");
});

it.each([
  { id: "foreign" }, { companyId: "foreign" }, { environmentId: "foreign" },
  { heartbeatRunId: "foreign" }, { provider: "foreign" }, { providerLeaseId: "rotated" },
  { status: "released" as const }, { releasedAt: new Date(1) },
])("refuses a stale positive when the exact lease changes during inspection (%j)", async change => {
  const original = new Error("transport");
  let reads = 0;
  let inspectionSettled = false;
  const result = await observeStoppedExecutionResource({
    expected: lease, originalError: original, deadline: performance.now() + 1000,
    readCurrentLease: async () => { reads += 1; return inspectionSettled ? { ...lease, ...change } : lease; },
    inspect: async () => { inspectionSettled = true; return { providerLeaseId: "resource", state: "stopped" }; },
  });
  expect(reads).toBe(2);
  expect(result).toBeNull();
  expect(readEnvironmentResourceObservationFailure(original)).toBe("lease_changed");
});
