import type { Db } from "@paperclipai/db";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./queue.js";
import {
  cappedSandboxProviderForAgent,
  createSandboxRunSlotGate,
  DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS,
  parseMaxConcurrentSandboxRuns,
  rankSandboxSlotEntries,
  type SandboxPlacement,
  type SandboxSlotEntry,
} from "./sandbox-run-slots.js";

function placement(overrides: Partial<SandboxPlacement> = {}): SandboxPlacement {
  return {
    forcedKubernetes: false,
    managedSandboxOnly: false,
    managedSandboxProvider: null,
    instanceDefaultEnvironmentId: null,
    environments: new Map(),
    ...overrides,
  };
}

describe("sandbox run limit configuration", () => {
  it.each([
    [undefined, DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS],
    ["", DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS],
    ["0", 0],
    ["35", 35],
    [" 5 ", 5],
    ["-1", DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS],
    ["2.5", DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS],
    ["many", DEFAULT_MAX_CONCURRENT_SANDBOX_RUNS],
  ])("reads %j as %d", (raw, expected) => {
    expect(parseMaxConcurrentSandboxRuns(raw)).toBe(expected);
  });

  it("counts only runs placed on a capped sandbox provider", () => {
    const environmentsById = new Map([
      ["local-env", { driver: "local", provider: null }],
      ["k8s-env", { driver: "sandbox", provider: "kubernetes" }],
      ["e2b-env", { driver: "sandbox", provider: "e2b" }],
      ["ssh-env", { driver: "ssh", provider: null }],
    ]);
    const base = placement({ environments: environmentsById });
    expect(cappedSandboxProviderForAgent(placement({ forcedKubernetes: true }), { defaultEnvironmentId: null })).toBe("kubernetes");
    expect(cappedSandboxProviderForAgent(base, { defaultEnvironmentId: "k8s-env" })).toBe("kubernetes");
    expect(cappedSandboxProviderForAgent({ ...base, instanceDefaultEnvironmentId: "k8s-env" }, { defaultEnvironmentId: null })).toBe("kubernetes");
    expect(cappedSandboxProviderForAgent({ ...base, instanceDefaultEnvironmentId: "k8s-env" }, { defaultEnvironmentId: "local-env" })).toBeNull();
    expect(cappedSandboxProviderForAgent(base, { defaultEnvironmentId: "e2b-env" })).toBeNull();
    expect(cappedSandboxProviderForAgent(base, { defaultEnvironmentId: "ssh-env" })).toBeNull();
    expect(cappedSandboxProviderForAgent(base, { defaultEnvironmentId: null })).toBeNull();
    expect(cappedSandboxProviderForAgent(base, { defaultEnvironmentId: "archived-env" })).toBeNull();
    const managed = { ...base, managedSandboxOnly: true, managedSandboxProvider: "kubernetes" };
    expect(cappedSandboxProviderForAgent(managed, { defaultEnvironmentId: null })).toBe("kubernetes");
    expect(cappedSandboxProviderForAgent(managed, { defaultEnvironmentId: "local-env" })).toBe("kubernetes");
    expect(cappedSandboxProviderForAgent(managed, { defaultEnvironmentId: "ssh-env" })).toBeNull();
  });
});

describe("sandbox slot order", () => {
  const entry = (runId: string, companyId: string, queuedAtMs: number, conversation = false): SandboxSlotEntry =>
    ({ runId, companyId, agentId: `${companyId}-agent`, queuedAtMs, conversation });

  it("is FIFO within one company", () => {
    const ranked = rankSandboxSlotEntries([entry("c", "a", 3), entry("a", "a", 1), entry("b", "a", 2)], new Map());
    expect(ranked.map((e) => e.runId)).toEqual(["a", "b", "c"]);
  });

  it("interleaves companies so one burst cannot starve another", () => {
    const burst = Array.from({ length: 5 }, (_, i) => entry(`a${i}`, "a", i));
    const ranked = rankSandboxSlotEntries([...burst, entry("b0", "b", 10), entry("b1", "b", 11)], new Map());
    expect(ranked.map((e) => e.runId)).toEqual(["a0", "b0", "a1", "b1", "a2", "a3", "a4"]);
  });

  it("puts a company with fewer running sandbox runs first", () => {
    const ranked = rankSandboxSlotEntries([entry("a0", "a", 1), entry("b0", "b", 2)], new Map([["a", 3]]));
    expect(ranked.map((e) => e.runId)).toEqual(["b0", "a0"]);
  });

  it("puts conversation turns ahead of background runs", () => {
    const ranked = rankSandboxSlotEntries([entry("task", "a", 1), entry("chat", "b", 2, true)], new Map([["b", 5]]));
    expect(ranked.map((e) => e.runId)).toEqual(["chat", "task"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping sandbox run slot database tests: ${support.reason}`);
describe.skipIf(!support.supported)("server-wide sandbox run limit in the run queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let limit = 20;
  let clock = Date.now();
  let currentPlacement = placement({ forcedKubernetes: true });
  let agentsById = new Map<string, typeof agents.$inferSelect>();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-sandbox-run-slots");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    limit = 20;
    clock = Date.now();
    currentPlacement = placement({ forcedKubernetes: true });
    agentsById = new Map();
  });

  /** One gate is one server process; a new gate is a restarted process. */
  function newGate() {
    return createSandboxRunSlotGate({ limit: () => limit, now: () => clock, loadPlacement: async () => currentPlacement });
  }

  function queueFor(gate: ReturnType<typeof newGate>) {
    const deps = callbacks(db);
    deps.getAgent.mockImplementation(async (id: string) => (agentsById.get(id) ?? null) as never);
    const queue = createHeartbeatQueue(db, { ...deps, sandboxRunSlots: gate });
    return { deps, queue };
  }

  async function company(name: string) {
    const [row] = await db.insert(companies).values({ name, issuePrefix: name.toUpperCase().slice(0, 3) }).returning();
    return row;
  }

  async function agent(companyId: string, name: string, defaultEnvironmentId: string | null = null) {
    const [row] = await db.insert(agents).values({
      companyId, name, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 50 } }, defaultEnvironmentId,
    }).returning();
    agentsById.set(row.id, row);
    return row;
  }

  let createdSeq = 0;
  async function runs(owner: typeof agents.$inferSelect, count: number, status = "queued", contextSnapshot: Record<string, unknown> = {}) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const createdAt = new Date(Date.UTC(2026, 10, 18, 12, 0, 0) + createdSeq++ * 1000);
      const [row] = await db.insert(heartbeatRuns).values({
        companyId: owner.companyId, agentId: owner.id, status, invocationSource: "assignment",
        responsibleUserId: "sandbox-slot-user", contextSnapshot, createdAt,
        startedAt: status === "running" ? new Date() : null,
      }).returning();
      rows.push(row);
    }
    return rows;
  }

  async function statusOf(ids: string[]) {
    const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, ids));
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  async function countByStatus(status: string) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns).where(eq(heartbeatRuns.status, status));
    return row.n;
  }

  function waitEvents(deps: ReturnType<typeof callbacks>, reason: string) {
    return deps.appendRunEvent.mock.calls.filter(([, event]) => (event.payload as { reason?: string } | undefined)?.reason === reason);
  }

  it("holds a burst of 40 to 20 running; the rest stay queued without failing", async () => {
    const owners = [];
    for (const name of ["Alpha", "Beta"]) {
      const c = await company(name);
      owners.push(await agent(c.id, `${name} one`), await agent(c.id, `${name} two`));
    }
    for (const owner of owners) await runs(owner, 10);
    const gate = newGate();
    const { deps, queue } = queueFor(gate);

    await Promise.all(owners.map((owner) => queue.startNextQueuedRunForAgent(owner.id)));

    expect(await countByStatus("running")).toBe(20);
    expect(await countByStatus("queued")).toBe(20);
    expect(deps.executeRun).toHaveBeenCalledTimes(20);
    expect(deps.cancelRunInternal).not.toHaveBeenCalled();
    expect(deps.setRunStatus).not.toHaveBeenCalled();
    const waits = waitEvents(deps, "sandbox_slot_wait");
    expect(waits).toHaveLength(20);
    expect(waits[0][1].message).toContain("Waiting for a sandbox slot: 20 of 20");
    expect(gate.snapshot().reserved).toEqual([]);

    // A second pass (the periodic queue tick) neither admits more nor repeats the event.
    await Promise.all(owners.map((owner) => queue.startNextQueuedRunForAgent(owner.id)));
    expect(await countByStatus("running")).toBe(20);
    expect(waitEvents(deps, "sandbox_slot_wait")).toHaveLength(20);
  });

  it("serves waiters FIFO within a company and lets a smaller company go first", async () => {
    limit = 4;
    const big = await agent((await company("Big")).id, "Big agent");
    const small = await agent((await company("Small")).id, "Small agent");
    const bigRuns = await runs(big, 10);
    const smallRuns = await runs(small, 2);
    const gate = newGate();
    const { queue } = queueFor(gate);

    await queue.startNextQueuedRunForAgent(big.id);
    await queue.startNextQueuedRunForAgent(small.id);
    let status = await statusOf([...bigRuns, ...smallRuns].map((r) => r.id));
    expect(bigRuns.map((r) => status.get(r.id))).toEqual([...Array(4).fill("running"), ...Array(6).fill("queued")]);
    expect(smallRuns.map((r) => status.get(r.id))).toEqual(["queued", "queued"]);

    // Two big runs finish: the small company's runs go next, though they queued later.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(inArray(heartbeatRuns.id, [bigRuns[0].id, bigRuns[1].id]));
    await queue.promoteSandboxSlotWaiters();
    status = await statusOf([...bigRuns, ...smallRuns].map((r) => r.id));
    expect(smallRuns.map((r) => status.get(r.id))).toEqual(["running", "running"]);
    expect(bigRuns.slice(4).every((r) => status.get(r.id) === "queued")).toBe(true);

    // The next free slot goes to the oldest waiting big run.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, smallRuns[0].id));
    await queue.promoteSandboxSlotWaiters();
    status = await statusOf(bigRuns.map((r) => r.id));
    expect(bigRuns.slice(4).map((r) => status.get(r.id))).toEqual(["running", ...Array(5).fill("queued")]);
  });

  it("does not let a burst from one company take slots ahead of another company's waiter", async () => {
    limit = 2;
    const busy = await agent((await company("Busy")).id, "Busy agent");
    const other = await agent((await company("Other")).id, "Other agent");
    await runs(busy, 2, "running");
    const [otherRun] = await runs(other, 1);
    const gate = newGate();
    const { queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(other.id);
    // A later burst from the busy company arrives while the other company waits.
    const burst = await runs(busy, 5);
    await queue.startNextQueuedRunForAgent(busy.id);
    // One slot frees. Even when the busy agent's queue pass runs first, the slot goes to the other company.
    const [firstRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running")).limit(1);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, firstRunning.id));
    await queue.startNextQueuedRunForAgent(busy.id);
    await queue.startNextQueuedRunForAgent(other.id);
    const status = await statusOf([otherRun.id, ...burst.map((r) => r.id)]);
    expect(status.get(otherRun.id)).toBe("running");
    expect(burst.every((r) => status.get(r.id) === "queued")).toBe(true);
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"])("frees the slot when a running run ends as %s", async (terminal) => {
    limit = 1;
    const owner = await agent((await company("Slots")).id, "Slot agent");
    const [holder] = await runs(owner, 1, "running");
    const [waiter] = await runs(owner, 1);
    const gate = newGate();
    const { deps, queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(owner.id);
    expect((await statusOf([waiter.id])).get(waiter.id)).toBe("queued");

    clock += 42_000;
    await db.update(heartbeatRuns).set({ status: terminal, finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder.id));
    await queue.promoteSandboxSlotWaiters();
    expect((await statusOf([waiter.id])).get(waiter.id)).toBe("running");
    const acquired = waitEvents(deps, "sandbox_slot_acquired");
    expect(acquired).toHaveLength(1);
    expect(acquired[0][1].payload).toMatchObject({ waitedMs: 42_000, provider: "kubernetes" });
  });

  it("forgets a waiter whose queued run is cancelled", async () => {
    limit = 1;
    const owner = await agent((await company("Cancel")).id, "Cancel agent");
    await runs(owner, 1, "running");
    const [cancelled, next] = await runs(owner, 2);
    const gate = newGate();
    const { queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(owner.id);
    expect(gate.snapshot().waiting.sort()).toEqual([cancelled.id, next.id].sort());
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, cancelled.id));
    await queue.startNextQueuedRunForAgent(owner.id);
    expect(gate.snapshot().waiting).toEqual([next.id]);
  });

  it("rebuilds the count from persisted runs after a restart and never leaks a reservation", async () => {
    limit = 2;
    const owner = await agent((await company("Restart")).id, "Restart agent");
    const survivors = await runs(owner, 2, "running");
    const [queued] = await runs(owner, 1);

    // New process: the runs still running from before the restart hold their slots.
    let { queue } = queueFor(newGate());
    await queue.startNextQueuedRunForAgent(owner.id);
    expect((await statusOf([queued.id])).get(queued.id)).toBe("queued");

    // The orphan reaper settles one of them; the next pass admits the waiter.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, survivors[0].id));
    await queue.startNextQueuedRunForAgent(owner.id);
    expect((await statusOf([queued.id])).get(queued.id)).toBe("running");

    // A process that crashed mid-claim leaves only an in-memory reservation: gone after a restart.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, [survivors[1].id, queued.id]));
    const crashed = newGate();
    const [a, b] = await runs(owner, 2);
    for (const run of [a, b]) {
      expect(await crashed.admit(db, { runId: run.id, companyId: run.companyId, agentId: run.agentId, provider: "kubernetes", conversation: false, queuedAtMs: run.createdAt.getTime() }))
        .toMatchObject({ admitted: true });
    }
    expect(await crashed.freeSlots(db)).toBe(0);
    ({ queue } = queueFor(newGate()));
    await queue.startNextQueuedRunForAgent(owner.id);
    expect((await statusOf([a.id, b.id]))).toEqual(new Map([[a.id, "running"], [b.id, "running"]]));
    // Even without a restart, a reservation whose claim never returned expires.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, [a.id, b.id]));
    const stalled = newGate();
    const [c] = await runs(owner, 1);
    await stalled.admit(db, { runId: c.id, companyId: c.companyId, agentId: c.agentId, provider: "kubernetes", conversation: false, queuedAtMs: c.createdAt.getTime() });
    expect(await stalled.freeSlots(db)).toBe(1);
    clock += 3 * 60_000;
    expect(await stalled.freeSlots(db)).toBe(2);
  });

  it("releases the claim reservation when the claim does not start the run", async () => {
    limit = 1;
    const owner = await agent((await company("Budget")).id, "Budget agent");
    const [blocked] = await runs(owner, 1);
    const gate = newGate();
    const { deps, queue } = queueFor(gate);
    deps.budgets.getInvocationBlock.mockResolvedValueOnce({ reason: "budget exhausted" } as Awaited<ReturnType<typeof deps.budgets.getInvocationBlock>>);
    await queue.startNextQueuedRunForAgent(owner.id);
    expect(deps.cancelRunInternal).toHaveBeenCalledWith(blocked.id, "budget exhausted");
    expect(gate.snapshot().reserved).toEqual([]);
    expect(await gate.freeSlots(db)).toBe(1);
  });

  it("parks a waiter whose agent cannot start it so it does not hold a freed slot", async () => {
    limit = 1;
    const paused = await agent((await company("Paused")).id, "Paused agent");
    const other = await agent((await company("Other")).id, "Other agent");
    const [holder] = await runs(other, 1, "running");
    const [stuck] = await runs(paused, 1);
    const [ready] = await runs(other, 1);
    const gate = newGate();
    const { deps, queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(paused.id);
    await queue.startNextQueuedRunForAgent(other.id);
    // The paused company holds no slot, so its older run ranks first; then its agent is paused.
    deps.getAgentInvokability.mockImplementation(async (a) => a?.id === paused.id ? { invokable: false, reason: "paused" } as never : { invokable: true });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, holder.id));
    await queue.promoteSandboxSlotWaiters();
    const status = await statusOf([stuck.id, ready.id]);
    expect(status.get(stuck.id)).toBe("queued");
    expect(status.get(ready.id)).toBe("running");
    expect(gate.snapshot().parked).toEqual([stuck.id]);
  });

  it("runs a conversation turn before an older background run", async () => {
    limit = 1;
    const c = await company("Chat");
    const owner = await agent(c.id, "Chat agent");
    await runs(owner, 1, "running");
    const [task] = await runs(owner, 1);
    const [issue] = await db.insert(issues).values({
      companyId: c.id, title: "Chat", status: "in_progress", assigneeAgentId: owner.id,
      conversationAgentId: owner.id, conversationUserId: "chat-user", conversationState: "active",
    }).returning();
    const [chat] = await runs(owner, 1, "queued", { issueId: issue.id });
    const gate = newGate();
    const { queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(owner.id);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.status, "running"));
    await queue.promoteSandboxSlotWaiters();
    const status = await statusOf([task.id, chat.id]);
    expect(status.get(chat.id)).toBe("running");
    expect(status.get(task.id)).toBe("queued");
  });

  it("does nothing when the limit is 0", async () => {
    limit = 0;
    const owner = await agent((await company("Off")).id, "Off agent");
    await runs(owner, 30);
    const gate = newGate();
    const { deps, queue } = queueFor(gate);
    expect(await gate.providerForAgent(db, owner)).toBeNull();
    await queue.startNextQueuedRunForAgent(owner.id);
    expect(await countByStatus("running")).toBe(30);
    expect(waitEvents(deps, "sandbox_slot_wait")).toHaveLength(0);
  });

  it("does not count or hold local runs", async () => {
    limit = 2;
    // Real placement: environment rows and instance settings from the database.
    const [localEnv] = (await db.select().from(environments).where(eq(environments.driver, "local")).limit(1)).length
      ? await db.select().from(environments).where(eq(environments.driver, "local")).limit(1)
      : await db.insert(environments).values({ name: "Local", driver: "local" }).returning();
    const [k8sEnv] = await db.insert(environments).values({ name: `Kubernetes ${Date.now()}`, driver: "sandbox", config: { provider: "kubernetes" } }).returning();
    const c = await company("Mixed");
    const local = await agent(c.id, "Local agent", localEnv.id);
    const sandboxed = await agent(c.id, "Sandbox agent", k8sEnv.id);
    await runs(local, 5, "running");
    await runs(local, 10);
    const sandboxRuns = await runs(sandboxed, 3);
    const gate = createSandboxRunSlotGate({ limit: () => limit, now: () => clock });
    const { deps, queue } = queueFor(gate);
    await queue.startNextQueuedRunForAgent(local.id);
    await queue.startNextQueuedRunForAgent(sandboxed.id);
    expect(await gate.providerForAgent(db, local)).toBeNull();
    const status = await statusOf(sandboxRuns.map((r) => r.id));
    expect(sandboxRuns.map((r) => status.get(r.id))).toEqual(["running", "running", "queued"]);
    expect(await countByStatus("running")).toBe(5 + 10 + 2);
    expect(waitEvents(deps, "sandbox_slot_wait")).toHaveLength(1);
  });
});
