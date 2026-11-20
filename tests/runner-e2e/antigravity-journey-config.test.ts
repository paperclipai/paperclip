import { expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { parseAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { ConnectionFailure } from "./connection-config.js";
import { antigravityNoLaunchReceipt, cleanupAntigravityJourney, observeAntigravityRun, parseAntigravityOwnedResources, selectAntigravityJourneyEnvironment, type AntigravityJourneyResources, type AntigravityProcessObservers } from "./antigravity-journey-fixtures.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import type { ConnectionApi } from "./connection-target.js";
import { antigravityKnownCostObservation } from "./antigravity-journey-launch.js";

// These cleanup-ordering calibrations use synthetic retired process receipts.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn(() => "") }));
vi.mock("./antigravity-journey-evidence.js", async original => ({ ...await original<typeof import("./antigravity-journey-evidence.js")>(),
  reacquireAntigravityNativeFences: vi.fn(async () => {}) }));

const companyId = "11111111-1111-4111-8111-111111111111", environmentId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333", agentId = "44444444-4444-4444-8444-444444444444", runId = "55555555-5555-4555-8555-555555555555";
function fixture() { return { version: 1, setupId: "synthetic", hosting: "self-hosted", executionEnvironment: "local",
  target: { mode: "attach", baseURL: "http://127.0.0.1:3104", expectedCommit: "a".repeat(40), deploymentMode: "local_trusted", companyId, environmentId },
  browser: { headed: false, channel: "chromium", freshness: "signed-in" }, savedConnection: { id: connectionId, name: "Synthetic Google subscription", ownerUserId: "synthetic-user" },
  candidate: { platform: "darwin", architecture: "arm64", nativeVersion: "1.4.3-paperclip.5", profileDigest: `sha256:${"b".repeat(64)}`, nativeClosureDigest: `sha256:${"c".repeat(64)}` },
  limits: { durationMs: 900_000, turnTimeoutMs: 300_000, maxRuns: 2, budgetCents: 100 } }; }
function resources(): AntigravityJourneyResources { return { version: 1, executionId: ANTIGRAVITY_JOURNEY_EXECUTION, origin: "http://127.0.0.1:3104",
  companyId, environmentId, connectionId, agentName: "Antigravity QA 0123456789ab", agentId, runIds: [], processes: {}, retained: false, setupProbe: "not_started" }; }
function neverLaunched() {
  const owned = resources(); owned.runIds = [runId]; owned.issueId = "66666666-6666-4666-8666-666666666666"; owned.setupProbe = "retired";
  const leaseId = "77777777-7777-4777-8777-777777777777";
  const run: Record<string, any> = { id: runId, companyId, agentId, issueId: owned.issueId, status: "cancelled", executionStage: "settled", costAccountingPending: false,
    runtimeMode: "legacy", runtimeModeResolvedAt: null, controllerLeaseExpiresAt: null, processPid: null, processGroupId: null, processStartedAt: null,
    runnerInstanceId: null, nativeSessionId: null, driverKind: null, completionContractId: null, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    resultJson: { startupCancellation: { beforeNativeSelection: true, errorCode: "cancelled", requestedAt: "2026-01-01T00:00:00Z" }, startupPreparationSettledAt: "2026-01-01T00:00:02Z" },
    contextSnapshot: { paperclipEnvironment: { id: environmentId, driver: "local", leaseId } } };
  const lease: Record<string, any> = { id: leaseId, companyId, heartbeatRunId: runId, environmentId, status: "expired", releasedAt: "2026-01-01T00:00:01Z" };
  return { owned, run, lease };
}
it("retains accepted physical ownership when a primary report projection throws", () => {
  const { owned, run } = neverLaunched(), pid = 900001, start = "2026-01-01T00:00:00Z";
  Object.assign(run, { processPid: pid, processGroupId: pid, processStartedAt: start });
  owned.processes[runId] = { captured: false, identityChanged: false, journal: [] };
  const journal = [{ pid, parent: 1, start }, { pid: pid + 1, parent: pid, start }];
  const observers = new Map([[runId, { sample: () => ({ captured: true, identityChanged: false, live: [pid, pid + 1], journal,
    authorityCheck: { accepted: true, commandSha256: "malformed-projection-digest", authority: { runId, pid, groupId: pid, startedAt: start }, observed: journal[0] } }) }]]) as unknown as AntigravityProcessObservers;
  expect(() => observeAntigravityRun(owned, run, observers)).toThrow(/primary_owner_/u);
  expect(owned.processes[runId]).toEqual({ captured: true, identityChanged: false, journal });
  expect(owned.processes[runId]!.primaryOwner).toBeUndefined();
});

it.each(["released", "expired"])("persists authoritative pre-native cancellation with a %s lease before purge", async status => {
  const { owned, run, lease } = neverLaunched(); lease.status = status;
  let lifecycleState = "ready", saved = false;
  const agent = () => ({ id: agentId, companyId, name: owned.agentName, lifecycleState });
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [agent()];
    if (route.includes("heartbeat-runs?")) return [run];
    if (route === `/api/heartbeat-runs/${runId}`) return run;
    if (route === `/api/environment-leases/${lease.id}`) return lease;
    if (route === `/api/issues/${owned.issueId}`) return { id: owned.issueId, companyId, assigneeAgentId: agentId, status: "cancelled" };
    if (route === `/api/agents/${agentId}`) return agent();
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error(`Unexpected cleanup read ${route}`);
  });
  const remove = vi.fn(async () => { expect(saved).toBe(true); expect(owned.processes[runId]?.captured).toBe(false); });
  const post = vi.fn(async (route: string) => { expect(route).toBe(`/api/agents/${agentId}/terminate`); lifecycleState = "terminated"; });
  const cleanup = { agent: false, runs: false, connectionPreserved: false };
  await cleanupAntigravityJourney({ api: { get, post, patch: async () => {}, delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup, captureRun: async () => {}, persistResources: async () => {
      if (owned.noLaunch?.[runId]) { expect(parseAntigravityOwnedResources(owned, parseAntigravityJourneyConfig(fixture()))).toBe(owned); saved = true; }
    } });
  expect(remove).toHaveBeenCalledOnce(); expect(cleanup).toEqual({ agent: true, runs: true, connectionPreserved: true });
  expect(owned.noLaunch?.[runId]).toMatchObject({ kind: "cancelled-before-native-selection", runId, leaseStatus: status, leaseReleasedAt: lease.releasedAt });
});

it.each([
  ["missing settlement", (f: ReturnType<typeof neverLaunched>) => { delete f.run.resultJson.startupPreparationSettledAt; }],
  ["false before-selection receipt", (f: ReturnType<typeof neverLaunched>) => { f.run.resultJson.startupCancellation.beforeNativeSelection = false; }],
  ["preparation pending", (f: ReturnType<typeof neverLaunched>) => { f.run.executionStage = "preparing"; }],
  ["unsettled accounting", (f: ReturnType<typeof neverLaunched>) => { f.run.costAccountingPending = true; }],
  ["native owner", (f: ReturnType<typeof neverLaunched>) => { f.run.runnerInstanceId = "native-owner"; }],
  ["missing null owner", (f: ReturnType<typeof neverLaunched>) => { delete f.run.processPid; }],
  ["captured process", (f: ReturnType<typeof neverLaunched>) => { f.owned.processes[runId] = { captured: true, identityChanged: false, journal: [] }; }],
  ["unreleased expired lease", (f: ReturnType<typeof neverLaunched>) => { f.lease.releasedAt = null; }],
  ["active lease", (f: ReturnType<typeof neverLaunched>) => { f.lease.status = "active"; }],
  ["late lease release", (f: ReturnType<typeof neverLaunched>) => { f.lease.releasedAt = "2026-01-01T00:00:03Z"; }],
  ["foreign lease", (f: ReturnType<typeof neverLaunched>) => { f.lease.heartbeatRunId = agentId; }],
  ["foreign environment", (f: ReturnType<typeof neverLaunched>) => { f.lease.environmentId = agentId; }],
])("rejects no-launch cleanup with %s", (_label, edit) => {
  const f = neverLaunched(); edit(f);
  expect(() => antigravityNoLaunchReceipt(f.run, f.lease, f.owned)).toThrow("cleanup_no_launch_receipt_unconfirmed");
});
it("retains the agent if authoritative no-launch evidence cannot be persisted", async () => {
  const { owned, run, lease } = neverLaunched(), post = vi.fn(), remove = vi.fn();
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [{ id: agentId, companyId, name: owned.agentName }];
    if (route.includes("heartbeat-runs?")) return [run];
    if (route === `/api/heartbeat-runs/${runId}`) return run;
    if (route === `/api/environment-leases/${lease.id}`) return lease;
    throw new Error("Unexpected cleanup read");
  });
  await expect(cleanupAntigravityJourney({ api: { get, post, patch: vi.fn(), delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: false, connectionPreserved: false }, captureRun: async () => {},
    persistResources: async () => { if (owned.noLaunch?.[runId]) throw new Error("fixture receipt storage unavailable"); } })).rejects.toThrow("fixture receipt storage unavailable");
  expect(remove).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
});
it("rejects altered retained no-launch identity, release timing, or extra fields", () => {
  for (const patch of [{ runId: agentId }, { leaseStatus: "active" }, { leaseReleasedAt: "2026-01-01T00:00:03Z" }, { rawPrivatePayload: "unexpected" }]) {
    const { owned, run, lease } = neverLaunched();
    owned.noLaunch = { [runId]: { ...antigravityNoLaunchReceipt(run, lease, owned), ...patch } as any };
    expect(() => parseAntigravityOwnedResources(owned, parseAntigravityJourneyConfig(fixture()))).toThrow("invalid_antigravity_owned_resources");
  }
});
it.each(["settles", "timeout", "wrong_owner", "malformed"])("waits for an original pre-native cleanup owner without weakening proof (%s)", async scenario => {
  vi.useFakeTimers();
  try {
    const { owned, run, lease } = neverLaunched(), settledRun = structuredClone(run), settledLease = structuredClone(lease);
    run.executionStage = "preparing"; run.costAccountingPending = true; delete run.resultJson.startupPreparationSettledAt;
    run.controllerLeaseExpiresAt = "2026-01-01T00:00:04Z"; lease.status = "active"; lease.releasedAt = null;
    if (scenario === "wrong_owner") lease.companyId = agentId;
    if (scenario === "malformed") run.resultJson.startupCancellation.requestedAt = "invalid-timestamp";
    let fullReads = 0, lifecycleState = "ready", persisted = false;
    const agent = () => ({ id: agentId, companyId, name: owned.agentName, lifecycleState });
    const get = vi.fn(async (route: string) => {
      if (route.endsWith("/agents")) return [agent()];
      if (route.includes("heartbeat-runs?")) return [structuredClone(run)];
      if (route === `/api/heartbeat-runs/${runId}`) {
        if (++fullReads >= 3 && scenario === "settles") { Object.assign(run, settledRun); Object.assign(lease, settledLease); }
        return structuredClone(run);
      }
      if (route === `/api/environment-leases/${lease.id}`) return structuredClone(lease);
      if (route === `/api/issues/${owned.issueId}`) return { id: owned.issueId, companyId, assigneeAgentId: agentId, status: "cancelled" };
      if (route === `/api/agents/${agentId}`) return agent();
      if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
      throw new Error("Unexpected cleanup read");
    });
    const remove = vi.fn(async () => { expect(persisted).toBe(true); });
    const post = vi.fn(async (route: string) => { expect(route).toBe(`/api/agents/${agentId}/terminate`); lifecycleState = "terminated"; });
    const outcome: { completed: boolean; error?: unknown } = { completed: false };
    const operation = cleanupAntigravityJourney({ api: { get, post, patch: vi.fn(), delete: remove } as unknown as ConnectionApi,
      config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: false, connectionPreserved: false }, captureRun: async () => {},
      persistResources: async () => { persisted ||= Boolean(owned.noLaunch?.[runId]); } }).then(() => { outcome.completed = true; }, error => { outcome.error = error; });
    await vi.advanceTimersByTimeAsync(scenario === "timeout" ? 60_500 : 1_000);
    await operation;
    if (scenario === "settles") {
      expect(outcome.error).toBeUndefined(); expect(outcome.completed).toBe(true); expect(fullReads).toBeGreaterThanOrEqual(3);
      expect(remove).toHaveBeenCalledOnce(); expect(owned.noLaunch?.[runId]).toMatchObject({ leaseStatus: "expired", startupPreparationSettledAt: settledRun.resultJson.startupPreparationSettledAt });
    } else {
      expect(String(outcome.error)).toContain(scenario === "timeout" ? "cleanup_run_retirement_unconfirmed" : scenario === "wrong_owner" ? "cleanup_lease_owner_mismatch" : "cleanup_no_launch_receipt_unconfirmed");
      expect(outcome.completed).toBe(false); expect(remove).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(persisted).toBe(false);
      if (scenario !== "timeout") expect(fullReads).toBeLessThan(3);
    }
  } finally { vi.useRealTimers(); }
});

it("discovers one explicit-only real-agent cell without ambient API-key requirements", () => {
  const selected = selectRunnerExecutions(parseRunnerSelectors(["--id", ANTIGRAVITY_JOURNEY_EXECUTION, "--antigravity-journey-config", "/private/binding.json", "--max-automatic-retries", "0"]), runnerMatrix);
  expect(selected).toHaveLength(1); expect(selected[0]!.suite.manualOnly).toBe(true); expect(selected[0]!.requiredCredentials).toEqual([]);
  expect(selected[0]!.task.automaticRetryPolicy).toBe("single_attempt");
  expect(selectRunnerExecutions(parseRunnerSelectors(["--all"]), runnerMatrix).some(row => row.id === ANTIGRAVITY_JOURNEY_EXECUTION)).toBe(false);
  expect(() => selected[0]!.profile.buildAgent({} as never)).toThrow("must be created through the ordinary UI");
});

it.each(["https://paperclip.example", "http://localhost:3104", "http://192.168.0.1:3104"])("does not claim same-host native retirement on %s", baseURL => {
  const value = fixture(); value.target.baseURL = baseURL;
  expect(() => parseAntigravityJourneyConfig(value)).toThrow("invalid_antigravity_journey_configuration");
});
it("rejects widened turns, Linux inventory, live credential values and a signed-out setup", () => {
  for (const edit of [
    (v: any) => { v.limits.maxRuns = 3; }, (v: any) => { v.candidate.platform = "linux"; },
    (v: any) => { v.savedConnection.accessToken = "must-never-be-a-config-value"; }, (v: any) => { v.browser.freshness = "signed-out"; },
    (v: any) => { v.limits.turnTimeoutMs = "300000"; },
  ]) { const value = fixture(); edit(value); expect(() => parseAntigravityJourneyConfig(value)).toThrow("invalid_antigravity_journey_configuration"); }
});
it("binds owned-resource recovery to the exact company, environment and saved account", () => {
  const config = parseAntigravityJourneyConfig(fixture());
  expect(parseAntigravityOwnedResources(resources(), config).agentId).toBe(agentId);
  for (const patch of [{ companyId: environmentId }, { environmentId: companyId }, { connectionId: agentId }, { origin: "https://other.example" }, { agentName: "Existing user agent" }])
    expect(() => parseAntigravityOwnedResources({ ...resources(), ...patch }, config)).toThrow("invalid_antigravity_owned_resources");
});
it("accepts a company-allowed instance environment without inventing company ownership", () => {
  const environment = { id: environmentId, name: "Local", driver: "local", status: "active" };
  expect(selectAntigravityJourneyEnvironment([environment], environmentId)).toBe(environment);
  expect(() => selectAntigravityJourneyEnvironment([{ ...environment, id: agentId }], environmentId)).toThrow("configured_execution_environment_unavailable");
  expect(() => selectAntigravityJourneyEnvironment([{ ...environment, status: "disabled" }], environmentId)).toThrow("configured_execution_environment_unavailable");
});
it.each(["failed", "interrupted", "timed_out"])("retains an owned %s run when physical ownership was never captured", async status => {
  const owned = resources(); owned.runIds = [runId];
  const agent = { id: agentId, companyId, name: owned.agentName }, run = { id: runId, agentId, companyId, status };
  const get = vi.fn(async (route: string) => route.includes("/agents") ? [agent] : route.includes("heartbeat-runs?") ? [run] : run);
  const remove = vi.fn(), patch = vi.fn();
  await expect(cleanupAntigravityJourney({ api: { get, patch, delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: false, connectionPreserved: false }, persistResources: async () => {}, captureRun: async () => {} }))
    .rejects.toThrow("cleanup_physical_owner_not_captured");
  expect(remove).not.toHaveBeenCalled(); expect(patch).toHaveBeenCalledWith(`/api/agents/${agentId}`, { status: "paused" });
});

it("terminates the owned ready agent before purge and preserves the shared account", async () => {
  const owned = resources(); owned.setupProbe = "retired";
  const cleanup = { agent: false, runs: false, connectionPreserved: false };
  let lifecycleState = "ready";
  const agent = () => ({ id: agentId, companyId, name: owned.agentName, lifecycleState });
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [agent()];
    if (route.includes("heartbeat-runs?")) return [];
    if (route === `/api/agents/${agentId}`) return agent();
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error("Unexpected cleanup read");
  });
  const post = vi.fn(async (route: string) => { expect(route).toBe(`/api/agents/${agentId}/terminate`); lifecycleState = "terminated"; return agent(); });
  const remove = vi.fn(async () => { expect(lifecycleState).toBe("terminated"); });
  await cleanupAntigravityJourney({ api: { get, post, patch: async () => { lifecycleState = "paused"; }, delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup, persistResources: async () => {}, captureRun: async () => {} });
  expect(remove).toHaveBeenCalledWith(`/api/agents/${agentId}`);
  expect(cleanup).toEqual({ agent: true, runs: true, connectionPreserved: true });
});
it.each([false, true])("captures a cleanup-discovered run's settled usage before purge (storage failure: %s)", async storageFailure => {
  const owned = resources(); owned.setupProbe = "retired";
  owned.processes[runId] = { captured: true, identityChanged: false, journal: [
    { pid: 9000001, parent: 1, start: "2020-01-01T00:00:00Z" }, { pid: 9000002, parent: 9000001, start: "2020-01-01T00:00:00Z" },
  ] };
  let status = "running", lifecycleState = "ready";
  const agent = () => ({ id: agentId, companyId, name: owned.agentName, lifecycleState });
  const run = () => ({ id: runId, agentId, companyId, status, costAccountingPending: status === "running",
    usageJson: { inputTokens: 100, outputTokens: 20, costUsd: status === "running" ? 0.01 : 0.25 },
    contextSnapshot: { paperclipEnvironment: { leaseId: "lease" } } });
  const snapshots: any[] = [];
  const captureRun = vi.fn(async row => {
    if (storageFailure && row.status === "cancelled") throw new Error("fixture accounting storage unavailable");
    snapshots.push(structuredClone(row));
  });
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [agent()];
    if (route.includes("heartbeat-runs?")) return [run()];
    if (route === `/api/heartbeat-runs/${runId}`) return run();
    if (route === "/api/environment-leases/lease") return { companyId, heartbeatRunId: runId, environmentId, status: "released" };
    if (route === `/api/agents/${agentId}`) return agent();
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error("Unexpected cleanup read");
  });
  const post = vi.fn(async (route: string) => {
    if (route.endsWith("/cancel")) status = "cancelled";
    else if (route.endsWith("/terminate")) lifecycleState = "terminated";
    else throw new Error("Unexpected cleanup mutation");
  });
  const remove = vi.fn(async () => { expect(snapshots.at(-1)).toMatchObject({ status: "cancelled", costAccountingPending: false, usageJson: { costUsd: 0.25 } }); });
  const cleanup = cleanupAntigravityJourney({ api: { get, post, patch: async () => {}, delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: false, connectionPreserved: false }, persistResources: async () => {}, captureRun });
  if (storageFailure) { await expect(cleanup).rejects.toThrow("fixture accounting storage unavailable"); expect(remove).not.toHaveBeenCalled(); }
  else { await cleanup; expect(remove).toHaveBeenCalledOnce(); }
  expect(owned.runIds).toEqual([runId]);
  expect(snapshots[0]).toMatchObject({ status: "running", usageJson: { costUsd: 0.01 } });
});
it("does not erase a failed native setup Test's unconfirmed cleanup with an empty task-run list", async () => {
  const owned = resources(); owned.setupProbe = "retirement_unconfirmed";
  const agent = { id: agentId, companyId, name: owned.agentName }, remove = vi.fn();
  const get = vi.fn(async (route: string) => route.endsWith("/agents") ? [agent] : []);
  await expect(cleanupAntigravityJourney({ api: { get, patch: vi.fn(), delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: true, connectionPreserved: true }, persistResources: async () => {}, captureRun: async () => {} }))
    .rejects.toThrow("setup_probe_retirement_unconfirmed");
  expect(remove).not.toHaveBeenCalled();
});
it.each(["interrupted", "timed_out"].flatMap(status => [false, true].map(pending => ({ status, pending }))))("retires a $status run only after its accounting settles (pending: $pending)", async ({ status, pending }) => {
  vi.useFakeTimers();
  try {
    const owned = resources(); owned.setupProbe = "retired"; owned.runIds = [runId];
    owned.processes[runId] = { captured: true, identityChanged: false, journal: [
      { pid: 9000001, parent: 1, start: "2020-01-01T00:00:00Z" }, { pid: 9000002, parent: 9000001, start: "2020-01-01T00:00:00Z" },
    ] };
    const agent = { id: agentId, companyId, name: owned.agentName, status: "active" }, run = { id: runId, agentId, companyId, status,
      costAccountingPending: pending, contextSnapshot: { paperclipEnvironment: { leaseId: "lease" } } };
    const get = vi.fn(async (route: string) => {
      if (route.endsWith("/agents")) return [agent];
      if (route === `/api/agents/${agentId}`) return agent;
      if (route.includes("heartbeat-runs?")) return [run];
      if (route === `/api/heartbeat-runs/${runId}`) return run;
      if (route === "/api/environment-leases/lease") return { companyId, heartbeatRunId: runId, environmentId, status: "released" };
      if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
      throw new Error("Unexpected cleanup read");
    });
    const post = vi.fn(), remove = vi.fn(), cleanup = { agent: false, runs: false, connectionPreserved: false };
    const started = Date.now(); let error: unknown, finishedAt: number | undefined;
    const operation = cleanupAntigravityJourney({ api: { get, post, patch: vi.fn(async () => { agent.status = "paused"; }), delete: remove } as unknown as ConnectionApi,
      config: parseAntigravityJourneyConfig({ ...fixture(), retainAgent: true }), resources: owned, cleanup, captureRun: async () => {}, persistResources: async () => {} })
      .then(() => { finishedAt = Date.now(); }, caught => { error = caught; finishedAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(60_500); await operation;
    if (pending) { expect(String(error)).toContain("cleanup_run_retirement_unconfirmed"); expect(cleanup.runs).toBe(false); }
    else { expect(error).toBeUndefined(); expect(finishedAt! - started).toBeLessThan(1_000); expect(cleanup).toEqual({ agent: true, runs: true, connectionPreserved: true }); expect(owned.retained).toBe(true); }
    expect(post).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it("does not claim retained-agent cleanup when the pause PATCH was ignored", async () => {
  const owned = resources(); owned.setupProbe = "retired";
  const agent = { id: agentId, companyId, name: owned.agentName, status: "active" };
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [agent];
    if (route === `/api/agents/${agentId}`) return agent;
    if (route.includes("heartbeat-runs?")) return [];
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error("Unexpected cleanup read");
  });
  const post = vi.fn(), remove = vi.fn(), patch = vi.fn(), cleanup = { agent: false, runs: false, connectionPreserved: false };
  await expect(cleanupAntigravityJourney({ api: { get, post, patch, delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig({ ...fixture(), retainAgent: true }), resources: owned, cleanup, captureRun: async () => {}, persistResources: async () => {} }))
    .rejects.toThrow("cleanup_retained_agent_pause_unconfirmed");
  expect(patch).toHaveBeenCalledWith(`/api/agents/${agentId}`, { status: "paused" });
  expect(cleanup.agent).toBe(false); expect(post).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it("stops on combined reported and estimated known cost while retaining unknown subscription prices", () => {
  const usage = (id: string, usageJson: Record<string, unknown>) => ({ id, usageJson });
  expect(antigravityKnownCostObservation([
    usage("first", { inputTokens: 100, outputTokens: 20, costUsd: 0.6 }),
    usage("second", { inputTokens: 100, outputTokens: 20, costUsd: 0.41, costStatus: "estimated" }),
  ], 100)).toMatchObject({ knownCostUsd: 1.01, exceeded: true, hardCurrencyCap: false });
  expect(antigravityKnownCostObservation([
    usage("first", { inputTokens: 100, outputTokens: 20, costUsd: 0.1 }),
    usage("second", { inputTokens: 100, outputTokens: 20, costUsd: 0.2, costStatus: "estimated" }),
  ], 30).exceeded).toBe(false);
  expect(antigravityKnownCostObservation([
    usage("first", { inputTokens: 100, outputTokens: 20, costUsd: 0, costStatus: "unpriced", billingType: "subscription" }),
  ], 1)).toMatchObject({ exceeded: false, costStatus: "unpriced", priceCoverageComplete: false, hardCurrencyCap: false });
});

function deferredOwnerCleanup(discovery: "initial" | "poll" | "transition" = "initial") {
  const owned = resources(); owned.setupProbe = "retired"; owned.issueId = "66666666-6666-4666-8666-666666666666";
  owned.processes[runId] = { captured: true, identityChanged: false, journal: [
    { pid: 9000001, parent: 1, start: "2020-01-01T00:00:00Z" }, { pid: 9000002, parent: 9000001, start: "2020-01-01T00:00:00Z" },
  ] };
  const agent = { id: agentId, companyId, name: owned.agentName, status: "active" };
  const run: Record<string, any> = { id: runId, companyId, agentId, issueId: owned.issueId, nativeIssueId: owned.issueId,
    status: "failed", runtimeMode: "native", nativePhase: "retryable_failure", costAccountingPending: false,
    contextSnapshot: { paperclipEnvironment: { leaseId: "owned-lease" } }, resultJson: {} };
  const lease = { id: "owned-lease", companyId, heartbeatRunId: runId, environmentId, status: "released" };
  const state = { listReads: 0, fullReads: 0, stopAtListReads: [] as number[], fullPatch: {} as Record<string, unknown>,
    onStop: async (_body: Record<string, any>) => {} };
  const acknowledge = (body: Record<string, any>, patch: Record<string, unknown> = {}) => {
    run.status = "cancelled"; run.nativePhase = "terminal_failure";
    run.resultJson = { startupCancellation: { cancellationRequestId: body.cancellationRequestId }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${body.cancellationRequestId}`,
      companyId, runId, issueId: owned.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatched: false,
      dispatchState: "acknowledged", intentAuditId: "owned-intent-audit", acknowledgementAuditId: "owned-ack-audit", ...patch,
    } };
  };
  state.onStop = async body => { if (run.runtimeMode === "native") acknowledge(body); else { run.status = "cancelled"; run.resultJson = {}; } };
  const get = vi.fn(async (route: string) => {
    if (route.endsWith("/agents")) return [structuredClone(agent)];
    if (route === `/api/agents/${agentId}`) return structuredClone(agent);
    if (route.includes("heartbeat-runs?")) {
      state.listReads++;
      if (discovery === "poll" && state.listReads === 1) return [];
      return [{ ...structuredClone(run), ...(discovery === "transition" ? { nativePhase: "committed" } : {}) }];
    }
    if (route === `/api/heartbeat-runs/${runId}`) {
      state.fullReads++;
      return { ...structuredClone(run), ...(discovery === "transition" && state.fullReads === 1 ? { nativePhase: "committed" } : {}), ...state.fullPatch };
    }
    if (route === "/api/environment-leases/owned-lease") return structuredClone(lease);
    if (route === `/api/issues/${owned.issueId}`) return { id: owned.issueId, companyId, assigneeAgentId: agentId, status: "done" };
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error(`Unexpected deferred cleanup read ${route}`);
  });
  const post = vi.fn(async (route: string, body: Record<string, any> = {}) => {
    expect(route).toBe(`/api/heartbeat-runs/${runId}/cancel`);
    expect(owned.runIds).toContain(runId);
    if (run.runtimeMode === "native") expect(body.cancellationRequestId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
    else expect(body.cancellationRequestId).toBeUndefined();
    state.stopAtListReads.push(state.listReads); await state.onStop(body); return structuredClone(run);
  });
  const remove = vi.fn(), cleanup = { agent: false, runs: false, connectionPreserved: false };
  const start = () => cleanupAntigravityJourney({ api: { get, post, patch: vi.fn(async () => { agent.status = "paused"; }), delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig({ ...fixture(), retainAgent: true }), resources: owned, cleanup, captureRun: async () => {}, persistResources: async () => {} });
  return { owned, run, lease, state, post, remove, cleanup, acknowledge, start };
}

it.each(["initial", "poll"] as const)("owned deferred cleanup stops a failed native retry at %s discovery and waits for acknowledgement and lease retirement", async discovery => {
  vi.useFakeTimers();
  const f = deferredOwnerCleanup(discovery); f.lease.status = "active";
  let release!: () => void; const stop = new Promise<void>(resolve => { release = resolve; });
  f.state.onStop = async body => { await stop; f.acknowledge(body, { dispatched: discovery === "initial" }); };
  const outcome: { done: boolean; error?: unknown } = { done: false };
  const operation = f.start().then(() => { outcome.done = true; }, error => { outcome.error = error; });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(f.post).toHaveBeenCalledOnce(); expect(f.state.stopAtListReads).toEqual([discovery === "initial" ? 1 : 2]);
    expect(outcome.done).toBe(false); expect(f.cleanup.runs).toBe(false); expect(f.cleanup.agent).toBe(false);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(outcome.done).toBe(false); expect(f.cleanup.runs).toBe(false);
    f.lease.status = "released"; await vi.advanceTimersByTimeAsync(300); await operation;
    expect(outcome.error).toBeUndefined(); expect(outcome.done).toBe(true);
    expect(f.cleanup).toEqual({ agent: true, runs: true, connectionPreserved: true }); expect(f.owned.retained).toBe(true); expect(f.remove).not.toHaveBeenCalled();
  } finally { release(); f.lease.status = "released"; await vi.advanceTimersByTimeAsync(61_000); await operation; vi.useRealTimers(); }
});

it.each(["initial", "poll"] as const)("owned deferred cleanup requires Stop despite already retired processes, released lease and settled accounting (%s)", async discovery => {
  const f = deferredOwnerCleanup(discovery); await f.start();
  expect(f.post).toHaveBeenCalledOnce(); expect(f.state.stopAtListReads).toEqual([discovery === "initial" ? 1 : 2]);
  expect(f.cleanup.runs).toBe(true);
});

it("owned deferred cleanup observes a known run's transition into retry ownership", async () => {
  const f = deferredOwnerCleanup("transition"); await f.start();
  expect(f.state.fullReads).toBeGreaterThanOrEqual(2); expect(f.post).toHaveBeenCalledOnce(); expect(f.cleanup.runs).toBe(true);
});

it.each(["initial", "poll"] as const)("owned deferred cleanup stops a scheduled retry at %s discovery", async discovery => {
  vi.useFakeTimers();
  try {
    const f = deferredOwnerCleanup(discovery); Object.assign(f.run, { status: "scheduled_retry", runtimeMode: "legacy", nativePhase: null });
    let error: unknown; const operation = f.start().catch(caught => { error = caught; });
    await vi.advanceTimersByTimeAsync(61_000); await operation;
    expect(error).toBeUndefined(); expect(f.post).toHaveBeenCalledOnce(); expect(f.state.stopAtListReads).toEqual([discovery === "initial" ? 1 : 2]); expect(f.cleanup.runs).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each([
  ["failed", "native", "terminal_failure"], ["failed", "legacy", "retryable_failure"],
  ["succeeded", "native", "retryable_failure"], ["cancelled", "native", "retryable_failure"], ["timed_out", "native", "retryable_failure"],
])("owned deferred cleanup does not Stop ordinary terminal %s/%s/%s", async (status, runtimeMode, nativePhase) => {
  const f = deferredOwnerCleanup(); Object.assign(f.run, { status, runtimeMode, nativePhase });
  await f.start(); expect(f.post).not.toHaveBeenCalled(); expect(f.cleanup.runs).toBe(true);
});

it.each(["id", "companyId", "agentId", "issueId"])("owned deferred cleanup rejects foreign hydrated %s before Stop", async field => {
  const f = deferredOwnerCleanup(); f.state.fullPatch[field] = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await expect(f.start()).rejects.toThrow(/owner_mismatch/u); expect(f.post).not.toHaveBeenCalled(); expect(f.cleanup.agent).toBe(false);
});

it.each(["pending", "foreign_run", "foreign_company", "foreign_issue", "missing_audit", "same_audit", "stale_intent", "accounting_pending", "stop_error"])("owned deferred cleanup keeps failure when Stop proof is %s", async scenario => {
  vi.useFakeTimers();
  try {
    const f = deferredOwnerCleanup();
    f.state.onStop = async body => {
      if (scenario === "stop_error") throw new Error("synthetic Stop rejected");
      f.acknowledge(body, scenario === "pending" ? { dispatchState: "pending" }
        : scenario === "foreign_run" ? { runId: agentId } : scenario === "foreign_company" ? { companyId: agentId }
        : scenario === "foreign_issue" ? { issueId: agentId } : scenario === "missing_audit" ? { acknowledgementAuditId: "" }
        : scenario === "same_audit" ? { acknowledgementAuditId: "owned-intent-audit" }
        : scenario === "stale_intent" ? { intentId: "native-cancellation:ffffffff-ffff-4fff-8fff-ffffffffffff" } : {});
      if (scenario === "accounting_pending") f.run.costAccountingPending = true;
    };
    let error: unknown; const operation = f.start().catch(caught => { error = caught; });
    await vi.advanceTimersByTimeAsync(61_000); await operation;
    expect(f.post).toHaveBeenCalledOnce(); expect(error).toBeDefined(); expect(f.cleanup.agent).toBe(false); expect(f.cleanup.runs).toBe(false); expect(f.remove).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("owned deferred cleanup recovers a pending native Stop with its original request identity", async () => {
  const f = deferredOwnerCleanup(), requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  f.acknowledge({ cancellationRequestId: requestId }, { dispatchState: "pending", acknowledgementAuditId: null });
  f.run.status = "failed";
  await f.start(); expect(f.post).toHaveBeenCalledOnce(); expect(f.post.mock.calls[0]![1]).toEqual({ cancellationRequestId: requestId });
  expect(f.cleanup.runs).toBe(true);
});

it("owned deferred cleanup preserves cancelled unknown-accounting debt without a new Stop", async () => {
  vi.useFakeTimers();
  try {
    const f = deferredOwnerCleanup(); Object.assign(f.run, { status: "cancelled", costAccountingPending: true });
    let error: unknown; const operation = f.start().catch(caught => { error = caught; });
    await vi.advanceTimersByTimeAsync(61_000); await operation;
    expect(error).toBeDefined(); expect(f.post).not.toHaveBeenCalled(); expect(f.cleanup.runs).toBe(false); expect(f.cleanup.agent).toBe(false);
  } finally { vi.useRealTimers(); }
});

it("owned deferred cleanup retains a terminal native reservation without inventing Stop authority", async () => {
  vi.useFakeTimers();
  try {
    const f = deferredOwnerCleanup(); f.run.nativePhase = "terminal_failure";
    f.run.resultJson = { startupCancellation: { cancellationRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
    let error: unknown; const operation = f.start().catch(caught => { error = caught; });
    await vi.advanceTimersByTimeAsync(61_000); await operation;
    expect(error).toBeDefined(); expect(f.post).not.toHaveBeenCalled(); expect(f.cleanup.runs).toBe(false); expect(f.cleanup.agent).toBe(false); expect(f.remove).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("owned deferred cleanup reuses a reservation-only UUID while its native retry is eligible", async () => {
  const f = deferredOwnerCleanup(), requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  f.run.resultJson = { startupCancellation: { cancellationRequestId: requestId } };
  await f.start(); expect(f.post).toHaveBeenCalledOnce(); expect(f.post.mock.calls[0]![1]).toEqual({ cancellationRequestId: requestId });
  expect(f.cleanup.runs).toBe(true);
});

function interruptedAgentCreation() {
  const owned = resources(); delete owned.agentId;
  const witness = { setupId: agentId, companyId, agentName: owned.agentName, provider: "antigravity", creatorUserId: "synthetic-user", origin: owned.origin };
  (owned as any).agentCreationRequest = witness;
  let lifecycleState = "draft", persisted = false;
  const record = () => ({ id: agentId, companyId, name: owned.agentName, createdByUserId: "synthetic-user", lifecycleState });
  const get = vi.fn(async (route: string): Promise<Record<string, any> | Record<string, any>[]> => {
    if (route === `/api/companies/${companyId}/agents`) return [record()];
    if (route === `/api/agents/${agentId}?companyId=${companyId}`) return record();
    if (route.includes("heartbeat-runs?")) return [];
    if (route === `/api/agents/${agentId}`) return record();
    if (route.endsWith("/ai-connections")) return { connections: [{ id: connectionId, provider: "google", method: "subscription", ownerUserId: "synthetic-user", isDefault: true, status: "connected" }] };
    throw new Error(`Unexpected creation recovery read ${route}`);
  });
  const patch = vi.fn(async (route: string) => {
    expect(route).toBe(`/api/agents/${agentId}`); expect(persisted).toBe(true); lifecycleState = "paused";
  });
  const post = vi.fn(async (route: string) => { expect(route).toBe(`/api/agents/${agentId}/terminate`); lifecycleState = "terminated"; });
  const remove = vi.fn();
  const persistResources = vi.fn(async () => { expect(owned.agentId).toBe(agentId); persisted = true; });
  return { owned, witness, record, get, patch, post, remove, persistResources };
}
it("parses the minimal pre-forward creation witness without storing the UI request body", () => {
  const f = interruptedAgentCreation();
  expect(parseAntigravityOwnedResources(f.owned, parseAntigravityJourneyConfig(fixture()))).toMatchObject({ agentCreationRequest: f.witness });
});
it("recovers a committed UI draft by exact setupId before any pause or purge", async () => {
  const f = interruptedAgentCreation(), cleanup = { agent: false, runs: false, connectionPreserved: false };
  await cleanupAntigravityJourney({ api: { get: f.get, patch: f.patch, post: f.post, delete: f.remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: f.owned, cleanup, persistResources: f.persistResources, captureRun: async () => {} });
  expect(f.owned.agentId).toBe(agentId);
  expect(f.get).toHaveBeenCalledWith(`/api/agents/${agentId}?companyId=${companyId}`);
  expect(f.persistResources).toHaveBeenCalled(); expect(f.remove).toHaveBeenCalledWith(`/api/agents/${agentId}`);
  expect(cleanup).toEqual({ agent: true, runs: true, connectionPreserved: true });
});
it.each([
  ["foreign company", { companyId: environmentId }], ["different name", { agentName: "Antigravity QA fedcba987654" }],
  ["wrong provider", { provider: "codex" }], ["noncanonical setup UUID", { setupId: "NOT-A-UUID" }],
  ["uppercase setup UUID", { setupId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }],
  ["foreign origin", { origin: "http://127.0.0.1:9999" }], ["foreign creator", { creatorUserId: "another-user" }], ["missing creator", { creatorUserId: undefined }],
  ["extra private payload", { rawBody: { runtimeConfig: { env: { PRIVATE_VALUE: "never-store" } } } }],
  ["mismatched known agent", { setupId: environmentId }],
])("rejects a %s creation witness before recovery", (_label, patch) => {
  const f = interruptedAgentCreation();
  (f.owned as any).agentCreationRequest = { ...f.witness, ...patch };
  if (_label === "mismatched known agent") f.owned.agentId = agentId;
  expect(() => parseAntigravityOwnedResources(f.owned, parseAntigravityJourneyConfig(fixture()))).toThrow("invalid_antigravity_owned_resources");
});
it.each(["company", "name", "id", "creator", "missing-creator", "same-name-only", "duplicate-name"])("does not reclaim a creation draft with mismatched %s", async field => {
  const f = interruptedAgentCreation(), originalGet = f.get.getMockImplementation()!;
  f.get.mockImplementation(async route => {
    if (route === `/api/companies/${companyId}/agents` && field === "same-name-only") return [{ ...f.record(), id: environmentId }];
    if (route === `/api/companies/${companyId}/agents` && field === "duplicate-name") return [f.record(), { ...f.record(), id: environmentId }];
    if (route === `/api/agents/${agentId}?companyId=${companyId}`) return { ...f.record(),
      ...(field === "company" ? { companyId: environmentId } : field === "name" ? { name: "Existing user agent" } : field === "id" ? { id: environmentId } : field === "creator" ? { createdByUserId: "another-user" } : field === "missing-creator" ? { createdByUserId: undefined } : {}) };
    return originalGet(route);
  });
  await expect(cleanupAntigravityJourney({ api: { get: f.get, patch: f.patch, post: f.post, delete: f.remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: f.owned, cleanup: { agent: false, runs: false, connectionPreserved: false },
    persistResources: f.persistResources, captureRun: async () => {} })).rejects.toThrow(/cleanup_.*(?:mismatch|unconfirmed)/u);
  expect(f.patch).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
});
it("keeps a witnessed404 unconfirmed rather than treating an in-flight creation as absent", async () => {
  const f = interruptedAgentCreation(), cleanup = { agent: false, runs: false, connectionPreserved: false };
  f.get.mockImplementation(async route => {
    if (route === `/api/companies/${companyId}/agents`) return [];
    if (route === `/api/agents/${agentId}?companyId=${companyId}`) throw new ConnectionFailure("api_status_404");
    throw new Error(`Unexpected witnessed404 read ${route}`);
  });
  await expect(cleanupAntigravityJourney({ api: { get: f.get, patch: f.patch, post: f.post, delete: f.remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: f.owned, cleanup, persistResources: f.persistResources, captureRun: async () => {} }))
    .rejects.toThrow(/cleanup_agent_creation_unconfirmed/u);
  expect(f.patch).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  expect(cleanup.agent).toBe(false); expect(cleanup.runs).toBe(false);
});
it("does not mutate a recovered draft if its exact identity cannot be persisted", async () => {
  const f = interruptedAgentCreation(); f.persistResources.mockRejectedValue(new Error("owned creation receipt write failed"));
  await expect(cleanupAntigravityJourney({ api: { get: f.get, patch: f.patch, post: f.post, delete: f.remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: f.owned, cleanup: { agent: false, runs: false, connectionPreserved: false },
    persistResources: f.persistResources, captureRun: async () => {} })).rejects.toThrow("owned creation receipt write failed");
  expect(f.patch).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
});
