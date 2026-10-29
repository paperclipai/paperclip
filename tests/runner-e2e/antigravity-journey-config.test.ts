import { expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { parseAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { antigravityNoLaunchReceipt, cleanupAntigravityJourney, parseAntigravityOwnedResources, selectAntigravityJourneyEnvironment, type AntigravityJourneyResources } from "./antigravity-journey-fixtures.js";
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
it("retains an owned failed run when physical ownership was never captured", async () => {
  const owned = resources(); owned.runIds = [runId];
  const agent = { id: agentId, companyId, name: owned.agentName }, run = { id: runId, agentId, companyId, status: "failed" };
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
