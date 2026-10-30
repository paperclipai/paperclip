import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { createEvalAttemptPhase, readEvalAttemptPhase } from "./attempt-phase.js";
import { finishBudgetedEvalSetup, type EvalSetupObservation } from "./budgeted-setup.js";

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
