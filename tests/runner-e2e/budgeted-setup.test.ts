import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { createEvalAttemptPhase, readEvalAttemptPhase } from "./attempt-phase.js";
import { createKimiLifecycleTiming, finishBudgetedEvalSetup, type EvalSetupObservation } from "./budgeted-setup.js";

import { runKimiLifecycleFlow } from "./kimi-lifecycle.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import { runnerE2EPlaywrightCaseTimeoutMs, runnerE2EPlaywrightWatchdogMs } from "./web-server-command.js";

const identity = { executionId: "fixture-execution", attemptId: "fixture-attempt" };
const ready = { id: "agent", companyId: "company", status: "idle", lifecycleState: "ready", lifecycleError: null };
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "budgeted-setup-"));
  const file = path.join(directory, "phase.json");
  await createEvalAttemptPhase(file, identity);
  return { directory, file, env: { PAPERCLIP_E2E_GATEWAY_BASE_URL: "http://127.0.0.1:12345",
    PAPERCLIP_E2E_GATEWAY_PHASE_PATH: file, PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID: identity.attemptId } };
}

it("keeps asynchronous hello probes in setup until the same agent is ready", async () => {
  const f = await fixture();
  const get = vi.fn().mockResolvedValueOnce({ ...ready, status: "paused", lifecycleState: "verifying", adapterConfig: { private: true } }).mockResolvedValue(ready);
  let saved: EvalSetupObservation[] = [];
  try {
    await finishBudgetedEvalSetup({ executionId: identity.executionId, environmentId: "local", agentId: "agent", companyId: "company",
      deadlineAt: Date.now() + 5_000, api: { get } as unknown as RunnerApi,
      observe: async observations => {
        expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("setup");
        saved = structuredClone(observations);
      } }, f.env);
    expect(saved.map(row => row.lifecycleState)).toEqual(["verifying", "ready"]);
    expect(saved[0]).not.toHaveProperty("adapterConfig");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.every(([url, options]) => url === "/api/agents/agent" && options.timeout > 0 && options.timeout <= 5_000)).toBe(true);
    expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("agent");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it.each([
  [{ ...ready, lifecycleError: "harness_command_unavailable" }, "setup failed"],
  [{ ...ready, lifecycleHolds: ["approval"] }, "setup is held"],
  [{ ...ready, companyId: "other" }, "scope changed"],
  [{ ...ready, lifecycleState: "terminated" }, "setup stopped"],
] as const)("preserves setup attribution and the failed state when readiness is rejected: %s", async (state, reason) => {
  const f = await fixture(), observe = vi.fn(async () => {}), get = vi.fn().mockResolvedValue(state);
  try {
    await expect(finishBudgetedEvalSetup({ executionId: identity.executionId, environmentId: "local", agentId: "agent", companyId: "company",
      deadlineAt: Date.now() + 5_000, api: { get } as unknown as RunnerApi, observe }, f.env)).rejects.toThrow(reason);
    expect(get).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("setup");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("does not start a readiness request after the attempt deadline", async () => {
  const f = await fixture(), get = vi.fn();
  try {
    await expect(finishBudgetedEvalSetup({ executionId: identity.executionId, environmentId: "local", agentId: "agent", companyId: "company",
      deadlineAt: Date.now() - 1, api: { get } as unknown as RunnerApi, observe: async () => {} }, f.env)).rejects.toThrow("Timed out");
    expect(get).not.toHaveBeenCalled();
    expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("setup");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it("does not advance when saving readiness crosses the deadline", async () => {
  const f = await fixture(), get = vi.fn().mockResolvedValue(ready);
  const deadlineAt = Date.now() + 5_000;
  const now = vi.spyOn(Date, "now");
  try {
    await expect(finishBudgetedEvalSetup({ executionId: identity.executionId, environmentId: "local", agentId: "agent", companyId: "company",
      deadlineAt, api: { get } as unknown as RunnerApi,
      observe: async () => { now.mockReturnValue(deadlineAt); } }, f.env)).rejects.toThrow("Timed out saving");
    expect(get).toHaveBeenCalledOnce();
    expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("setup");
  } finally { now.mockRestore(); await rm(f.directory, { recursive: true, force: true }); }
});

it.each(["local", "daytona"] as const)("uses the bounded attempt window for remote setup while keeping the local limit: %s", async environmentId => {
  const f = await fixture();
  let time = Date.now();
  const now = vi.spyOn(Date, "now").mockImplementation(() => time);
  const get = vi.fn().mockResolvedValueOnce({ ...ready, status: "paused", lifecycleState: "verifying" }).mockResolvedValue(ready);
  let observations = 0;
  try {
    const result = finishBudgetedEvalSetup({ executionId: identity.executionId, environmentId, agentId: "agent", companyId: "company",
      deadlineAt: time + 15 * 60_000, api: { get } as unknown as RunnerApi,
      observe: async () => { if (++observations === 1) time += 46_000; } }, f.env);
    if (environmentId === "daytona") {
      await result;
      expect(get).toHaveBeenCalledTimes(2);
      expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("agent");
    } else {
      await expect(result).rejects.toThrow("Timed out");
      expect(get).toHaveBeenCalledOnce();
      expect((await readEvalAttemptPhase(f.file, identity)).phase).toBe("setup");
    }
  } finally { now.mockRestore(); await rm(f.directory, { recursive: true, force: true }); }
});

it("waits for the same agent to be ready before changing Kimi lifecycle policy without a gateway", async () => {
  const execution = selectRunnerExecutions(parseRunnerSelectors(["--id", "kimi-qualification.runner-acpx-kimi.daytona.native-write-provider-loss"]))[0]!;
  const order: string[] = [], observations: EvalSetupObservation[][] = [];
  const configured = { ...ready, adapterConfig: { model: "kimi-for-coding" } };
  const get = vi.fn(async (url: string) => {
    if (url === "/api/health") return { deploymentMode: "local_trusted" };
    if (url === "/api/auth/get-session") return { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } };
    if (url === "/api/agents/agent") {
      order.push(order.length === 0 ? "verifying" : order.length === 1 ? "ready" : "policy-read");
      return order.length === 1 ? { ...configured, lifecycleState: "verifying" } : configured;
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  const patch = vi.fn(async () => { order.push("policy-patch"); throw new Error("stop-after-policy-patch"); });
  await expect(runKimiLifecycleFlow({ page: {} as any, api: { get, patch } as unknown as RunnerApi,
    fixtures: { company: { id: "company" }, agent: { id: "agent" }, environment: { id: "environment" } } as LiveFixtureValues,
    execution, nonce: "unit", workspacePath: "/unused", deadlineAt: Date.now() + 5_000, remoteBootstrap: {} as any,
    registerCleanupAssertion: () => {}, registerBeforeEnvironmentTeardownAssertion: () => {}, observe: () => {}, capture: async () => {},
    evidence: async (name, value) => { if (name === "kimi-lifecycle-agent-ready.json") observations.push(structuredClone((value as { observations: EvalSetupObservation[] }).observations)); },
  })).rejects.toThrow("stop-after-policy-patch");
  expect(order).toEqual(["verifying", "ready", "policy-read", "policy-patch"]);
  expect(observations.at(-1)?.map(row => row.lifecycleState)).toEqual(["verifying", "ready"]);
  expect(observations.flat()).not.toContainEqual(expect.objectContaining({ adapterConfig: expect.anything() }));
  expect(patch).toHaveBeenCalledOnce();
});

it("does not change Kimi lifecycle policy after readiness fails", async () => {
  const execution = selectRunnerExecutions(parseRunnerSelectors(["--id", "kimi-qualification.runner-acpx-kimi.daytona.native-write-provider-loss"]))[0]!;
  const get = vi.fn(async (url: string) => url === "/api/health" ? { deploymentMode: "local_trusted" }
    : url === "/api/auth/get-session" ? { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } }
      : { ...ready, lifecycleError: "harness_command_unavailable" });
  const patch = vi.fn();
  await expect(runKimiLifecycleFlow({ page: {} as any, api: { get, patch } as unknown as RunnerApi,
    fixtures: { company: { id: "company" }, agent: { id: "agent" }, environment: { id: "environment" } } as LiveFixtureValues,
    execution, nonce: "unit", workspacePath: "/unused", deadlineAt: Date.now() + 5_000, remoteBootstrap: {} as any,
    registerCleanupAssertion: () => {}, registerBeforeEnvironmentTeardownAssertion: () => {}, observe: () => {}, capture: async () => {}, evidence: async () => {},
  })).rejects.toThrow("setup failed");
  expect(patch).not.toHaveBeenCalled();
});

it("keeps a finite setup cap and one full graded Kimi window after the recorded 242s readiness delay", () => {
  const startedAt = 1_000_000, deadlineMs = 300_000;
  const timing = createKimiLifecycleTiming({ startedAt, deadlineMs });
  expect(timing.setupDeadlineAt).toBe(startedAt + 300_000);
  expect(timing.playwrightTimeoutMs).toBe(690_000);
  expect(timing.cleanupDeadlineAt).toBe(startedAt + 660_000);
  expect(startedAt + timing.playwrightTimeoutMs - timing.cleanupDeadlineAt).toBe(30_000);
  const readyAt = startedAt + 242_000;
  const workDeadlineAt = timing.beginWork(readyAt);
  expect(workDeadlineAt - readyAt).toBe(300_000);
  expect(workDeadlineAt + 90_000 - startedAt).toBeLessThanOrEqual(timing.playwrightTimeoutMs);
  expect(() => timing.beginWork(readyAt + 1_000)).toThrow("already started");
  for (const elapsed of [300_000, 301_000]) {
    expect(() => createKimiLifecycleTiming({ startedAt, deadlineMs }).beginWork(startedAt + elapsed)).toThrow("setup deadline expired");
  }
});

it.each([60_000, 300_000])("lets Kimi cleanup and its final report finish after %sms of server startup", async startupMs => {
  vi.useFakeTimers();
  try {
    const execution = selectRunnerExecutions(parseRunnerSelectors(["--id", "kimi-qualification.runner-acpx-kimi.daytona.native-write-provider-loss"]))[0]!;
    const deadlineMs = execution.task.attemptTimeoutMs[execution.environment.id];
    const spawnedAt = Date.now();
    let killed = false, cleanupFinished = false, reportSaved = false;
    const watchdog = setTimeout(() => { killed = true; }, runnerE2EPlaywrightWatchdogMs([execution]));
    await vi.advanceTimersByTimeAsync(startupMs);
    const timing = createKimiLifecycleTiming({ startedAt: Date.now(), deadlineMs });
    setTimeout(() => { if (!killed) cleanupFinished = true; }, timing.cleanupDeadlineAt - Date.now() - 1);
    setTimeout(() => { if (!killed && cleanupFinished) reportSaved = true; }, timing.playwrightTimeoutMs - 1);
    await vi.advanceTimersByTimeAsync(timing.playwrightTimeoutMs - 1);
    expect({ killed, cleanupFinished, reportSaved }).toEqual({ killed: false, cleanupFinished: true, reportSaved: true });
    expect(runnerE2EPlaywrightCaseTimeoutMs(execution.task.flow, deadlineMs)).toBe(timing.playwrightTimeoutMs);
    expect(Date.now() - spawnedAt).toBe(startupMs + 690_000 - 1);
    await vi.advanceTimersByTimeAsync(300_000 - startupMs + 1);
    expect(killed).toBe(true);
    clearTimeout(watchdog);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

it("keeps other launcher case and startup allowances unchanged", () => {
  const executions = selectRunnerExecutions(parseRunnerSelectors(["--suite", "kimi-qualification"]));
  const others = executions.filter(execution => execution.task.flow !== "kimi_native_lifecycle");
  expect(others.length).toBeGreaterThan(0);
  for (const execution of others) {
    const deadlineMs = execution.task.attemptTimeoutMs[execution.environment.id];
    expect(runnerE2EPlaywrightCaseTimeoutMs(execution.task.flow, deadlineMs)).toBe(deadlineMs + 90_000);
    expect(runnerE2EPlaywrightWatchdogMs([execution])).toBe(deadlineMs + 90_000 + 300_000);
  }
  expect(runnerE2EPlaywrightWatchdogMs(executions)).toBe(executions.reduce((total, execution) => total +
    (execution.task.flow === "kimi_native_lifecycle" ? 2 : 1) * execution.task.attemptTimeoutMs[execution.environment.id] + 90_000, 300_000));
});
