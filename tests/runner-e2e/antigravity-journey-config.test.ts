import { expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { parseAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { cleanupAntigravityJourney, parseAntigravityOwnedResources, selectAntigravityJourneyEnvironment, type AntigravityJourneyResources } from "./antigravity-journey-fixtures.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import type { ConnectionApi } from "./connection-target.js";

const companyId = "11111111-1111-4111-8111-111111111111", environmentId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333", agentId = "44444444-4444-4444-8444-444444444444", runId = "55555555-5555-4555-8555-555555555555";
function fixture() { return { version: 1, setupId: "synthetic", hosting: "self-hosted", executionEnvironment: "local",
  target: { mode: "attach", baseURL: "http://127.0.0.1:3104", expectedCommit: "a".repeat(40), deploymentMode: "local_trusted", companyId, environmentId },
  browser: { headed: false, channel: "chromium", freshness: "signed-in" }, savedConnection: { id: connectionId, name: "Synthetic Google subscription", ownerUserId: "synthetic-user" },
  candidate: { platform: "darwin", architecture: "arm64", nativeVersion: "1.4.3-paperclip.5", profileDigest: `sha256:${"b".repeat(64)}`, nativeClosureDigest: `sha256:${"c".repeat(64)}` },
  limits: { durationMs: 900_000, turnTimeoutMs: 300_000, maxRuns: 2, budgetCents: 100 } }; }
function resources(): AntigravityJourneyResources { return { version: 1, executionId: ANTIGRAVITY_JOURNEY_EXECUTION, origin: "http://127.0.0.1:3104",
  companyId, environmentId, connectionId, agentName: "Antigravity QA 0123456789ab", agentId, runIds: [], processes: {}, retained: false, setupProbe: "not_started" }; }

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
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: false, connectionPreserved: false }, persistResources: async () => {} }))
    .rejects.toThrow("cleanup_physical_owner_not_captured");
  expect(remove).not.toHaveBeenCalled(); expect(patch).toHaveBeenCalledWith(`/api/agents/${agentId}`, { status: "paused" });
});
it("does not erase a failed native setup Test's unconfirmed cleanup with an empty task-run list", async () => {
  const owned = resources(); owned.setupProbe = "retirement_unconfirmed";
  const agent = { id: agentId, companyId, name: owned.agentName }, remove = vi.fn();
  const get = vi.fn(async (route: string) => route.endsWith("/agents") ? [agent] : []);
  await expect(cleanupAntigravityJourney({ api: { get, patch: vi.fn(), delete: remove } as unknown as ConnectionApi,
    config: parseAntigravityJourneyConfig(fixture()), resources: owned, cleanup: { agent: false, runs: true, connectionPreserved: true }, persistResources: async () => {} }))
    .rejects.toThrow("setup_probe_retirement_unconfirmed");
  expect(remove).not.toHaveBeenCalled();
});
