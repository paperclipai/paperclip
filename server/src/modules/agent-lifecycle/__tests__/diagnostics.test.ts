import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleAgent, LifecycleStore, LifecycleDriver } from "../application/ports.js";
import { startAgentLifecycle } from "../index.js";
import { createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { logger } from "../../../middleware/logger.js";

const agent: LifecycleAgent = { id: "agent", companyId: "company", lifecycleState: "verifying", lifecycleVersion: 3,
  lifecycleRequiredPluginIds: null, lifecycleError: null,
  lifecycleOperation: { id: "operation", hostComplete: false, completedPluginIds: [], attempts: 1 } };
function fixture() {
  const store = { get: vi.fn(), claim: vi.fn().mockResolvedValue(agent), renew: vi.fn().mockResolvedValue(true),
    setRequiredPlugins: vi.fn().mockResolvedValue(true), completeHost: vi.fn().mockResolvedValue(true),
    completePlugin: vi.fn().mockResolvedValue(true), defer: vi.fn().mockResolvedValue(true),
    change: vi.fn().mockResolvedValue({ ...agent, lifecycleState: "ready", lifecycleVersion: 4, lifecycleOperation: null }), pending: vi.fn().mockResolvedValue([agent.id]) } satisfies LifecycleStore;
  const driver = { requiredPluginIds: vi.fn().mockResolvedValue(["plugin"]), runHost: vi.fn().mockResolvedValue("complete"),
    runPlugin: vi.fn().mockResolvedValue("complete"), onReady: vi.fn().mockResolvedValue(undefined) } satisfies LifecycleDriver;
  const report = vi.fn();
  return { store, driver, report, worker: createLifecycleWorker(store, driver, report) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("lifecycle readiness handoff", () => {
  it("notifies the scheduler only after host, plugins, and readiness have committed", async () => {
    const { store, driver, worker } = fixture();
    let commit!: (ready: LifecycleAgent) => void;
    store.change.mockReturnValue(new Promise(resolve => { commit = resolve; }));
    driver.onReady.mockImplementation(async ready => {
      expect(store.completeHost).toHaveBeenCalledOnce();
      expect(store.completePlugin).toHaveBeenCalledOnce();
      expect(store.change).toHaveBeenCalledOnce();
      expect(ready).toMatchObject({ lifecycleState: "ready", lifecycleVersion: 4, lifecycleOperation: null });
    });
    const work = worker.process(agent.id);
    await vi.waitFor(() => expect(store.change).toHaveBeenCalledOnce());
    expect(driver.onReady).not.toHaveBeenCalled();
    commit({ ...agent, lifecycleState: "ready", lifecycleVersion: 4, lifecycleOperation: null });
    await work;
    expect(driver.onReady).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it.each(["host", "plugin", "transition", "hold"])("does not dispatch when %s prevents readiness", async stage => {
    const { store, driver, worker } = fixture();
    if (stage === "host") driver.runHost.mockResolvedValue("pending");
    if (stage === "plugin") driver.runPlugin.mockResolvedValue("pending");
    if (stage === "transition") store.change.mockResolvedValue(null);
    if (stage === "hold") store.change.mockResolvedValue({ ...agent, lifecycleState: "paused" });
    await worker.process(agent.id);
    expect(driver.onReady).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("preserves committed readiness after a dispatch failure for the queue sweep to recover", async () => {
    const { store, driver, report, worker } = fixture();
    const error = new Error("queue unavailable");
    driver.onReady.mockRejectedValue(error);
    await worker.process(agent.id);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: "ready", phase: "ready", version: 4 }), error);
    expect(store.defer).not.toHaveBeenCalled();
    expect(driver.runHost).toHaveBeenCalledOnce();
    expect(store.change).toHaveBeenCalledOnce();
    await worker.stop();
  });
});

describe("lifecycle failure diagnostics", () => {
  it.each(["host", "plugin", "claim", "renew", "scan", "defer"] as const)("reports %s failures with the available context", async stage => {
    const { store, driver, report, worker } = fixture();
    const error = new Error("private provider detail");
    if (stage === "host") driver.runHost.mockRejectedValue(error);
    else if (stage === "plugin") driver.runPlugin.mockRejectedValue(error);
    else if (stage === "scan") store.pending.mockRejectedValue(error);
    else if (stage === "defer") { driver.runHost.mockResolvedValue("pending"); store.defer.mockRejectedValue(error); }
    else store[stage].mockRejectedValue(error);
    const work = stage === "scan" ? worker.sweep() : worker.process(agent.id);
    if (["claim", "scan", "defer"].includes(stage)) await expect(work).rejects.toThrow(error);
    else await work;
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage }), error);
    if (!["claim", "scan"].includes(stage)) expect(report).toHaveBeenCalledWith(expect.objectContaining({
      agentId: agent.id, companyId: agent.companyId, phase: "verifying", operationId: "operation", version: 3,
      ...(stage === "plugin" ? { pluginId: "plugin" } : {}),
    }), error);
    await worker.stop();
  });

  it("reports periodic policy scan failures", async () => {
    vi.useFakeTimers();
    const error = new Error("private database detail");
    const db = { select: () => { throw error; } } as unknown as Db;
    const effects = { ...createAgentLifecycleEffects(), reportFailure: vi.fn() };
    const work = startAgentLifecycle(db, effects, fixture().driver, () => true);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(effects.reportFailure).toHaveBeenCalledWith({ stage: "policy_scan" }, error);
    } finally { await work.stop(); }
  });

  it.each([
    [{ code: "required_plugin_unavailable" }, "required_plugin_unavailable"],
    [{ code: "harness_test_failed" }, "harness_test_failed"],
    [{ cause: { code: "40P01", message: "private query" } }, "40P01"],
    [{ code: "private credential value" }, "unclassified"],
  ])("logs known codes without provider error contents", (details, failureCode) => {
    const log = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const context = { stage: "host" as const, agentId: "agent", phase: "verifying" as const, operationId: "operation", version: 3 };
    createAgentLifecycleEffects().reportFailure(context, Object.assign(new Error("private provider detail"), details));
    expect(log).toHaveBeenCalledExactlyOnceWith({ ...context, failureCode }, "Agent lifecycle operation failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
});
