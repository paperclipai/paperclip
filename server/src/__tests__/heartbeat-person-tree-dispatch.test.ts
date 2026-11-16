import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { automaticRunBrake } from "../services/recovery/automatic-run-brake.js";
import { logger } from "../middleware/logger.js";

const gate = vi.hoisted(() => ({ open: false, releases: [] as Array<() => void> }));

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => {
  if (!gate.open) await new Promise<void>(resolve => gate.releases.push(resolve));
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Person tree dispatch test run.",
    provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;

suite("dispatch of work on a task tree a person created, through the heartbeat queue", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  const userId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-person-tree-dispatch-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  afterEach(async () => {
    gate.open = true;
    for (const release of gate.releases.splice(0)) release();
    await heartbeat.drainActiveRunExecutions();
    gate.open = false;
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    automaticRunBrake.reset();
    await db.execute(sql`truncate table ${companies} cascade`);
  }, 180_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); }, 120_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Person tree", status: "active",
      issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active",
      membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation",
      triggerDetail: "system", status: "running", createdAt: new Date(Date.now() - 90 * MINUTE),
      startedAt: new Date(Date.now() - 90 * MINUTE) }).returning();
    const task = async (input: { title: string; parentId?: string; byPerson: boolean; status?: string }) => {
      const [row] = await db.insert(issues).values({ companyId, title: input.title, status: input.status ?? "todo",
        assigneeAgentId: agentId, parentId: input.parentId ?? null, createdByUserId: input.byPerson ? userId : null,
        createdByAgentId: input.byPerson ? null : agentId }).returning({ id: issues.id });
      return row!.id;
    };
    const queue = async (issueId: string, wakeReason: string, ageMinutes: number, byPerson = false) => {
      const createdAt = new Date(Date.now() - ageMinutes * MINUTE);
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, scopeKind: "issue" as const,
        invocationSource: byPerson ? "assignment" : "automation", triggerDetail: byPerson ? "manual" : "system",
        status: "queued", createdAt, contextSnapshot: { wakeReason, issueId, taskId: issueId } }).returning();
      if (byPerson) {
        const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", reason: wakeReason,
          status: "queued", requestedByActorType: "user", requestedByActorId: userId, runId: run!.id, requestedAt: createdAt,
          createdAt }).returning({ id: agentWakeupRequests.id });
        await db.update(heartbeatRuns).set({ wakeupRequestId: wake!.id }).where(eq(heartbeatRuns.id, run!.id));
      }
      return run!.id;
    };
    const freeSlot = async () => {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy!.id));
      await heartbeat.resumeQueuedRunsAfterDrain({ companyId });
    };
    return { companyId, agentId, task, queue, freeSlot };
  }

  const statusOf = async (ids: string[]) => new Map((await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(inArray(heartbeatRuns.id, ids))).map(row => [row.id, row]));

  async function expectStartsFirst(f: Awaited<ReturnType<typeof seed>>, first: string, waiting: string) {
    await heartbeat.resumeQueuedRunsAfterDrain({ companyId: f.companyId });
    expect([...(await statusOf([first, waiting])).values()].every(run => run.status === "queued")).toBe(true);
    await f.freeSlot();
    await vi.waitFor(async () => expect((await statusOf([first])).get(first)?.status).toBe("running"), { timeout: 20_000 });
    const runs = await statusOf([first, waiting]);
    expect(runs.get(first)?.startedAt).toBeInstanceOf(Date);
    expect(runs.get(waiting)).toMatchObject({ status: "queued", startedAt: null });
  }

  it("starts an agent's subtask of a person's task before a newer assignment by a person when a slot frees", async () => {
    const f = await seed();
    const root = await f.task({ title: "Person's task", byPerson: true, status: "blocked" });
    const subtask = await f.task({ title: "Agent's subtask", parentId: root, byPerson: false, status: "blocked" });
    const grandchild = await f.task({ title: "Agent's sub-subtask", parentId: subtask, byPerson: false });
    const subtaskRun = await f.queue(grandchild, "issue_assigned", 40);
    const newAssignment = await f.queue(await f.task({ title: "New task", byPerson: true }), "issue_assigned", 5, true);
    await expectStartsFirst(f, subtaskRun, newAssignment);
  }, 120_000);

  it("starts a person's parent task's resume after its children complete before a newer assignment by a person", async () => {
    const f = await seed();
    const parent = await f.task({ title: "Person's task", byPerson: true });
    await f.task({ title: "Done subtask", parentId: parent, byPerson: false, status: "done" });
    const resume = await f.queue(parent, "issue_children_completed", 30);
    const newAssignment = await f.queue(await f.task({ title: "New task", byPerson: true }), "issue_assigned", 5, true);
    await expectStartsFirst(f, resume, newAssignment);
  }, 120_000);

  it("keeps an agent-started tree's subtask behind a newer assignment by a person", async () => {
    const f = await seed();
    const root = await f.task({ title: "Agent's task", byPerson: false, status: "blocked" });
    const subtaskRun = await f.queue(await f.task({ title: "Agent's subtask", parentId: root, byPerson: false }), "issue_assigned", 40);
    const newAssignment = await f.queue(await f.task({ title: "New task", byPerson: true }), "issue_assigned", 5, true);
    await expectStartsFirst(f, newAssignment, subtaskRun);
  }, 120_000);

  it("backs off a refused run on a person's tree like agent work, and offers it again once the backoff passes", async () => {
    const f = await seed();
    await db.update(companies).set({ defaultResponsibleUserId: null }).where(eq(companies.id, f.companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const root = await f.task({ title: "Person's task", byPerson: true, status: "blocked" });
    const refused = await f.queue(await f.task({ title: "Agent's subtask", parentId: root, byPerson: false }), "issue_assigned", 180);
    await f.queue(await f.task({ title: "Another subtask", parentId: root, byPerson: false }), "issue_assigned", 170);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running")));
    const warn = vi.spyOn(logger, "warn");
    const offers = () => warn.mock.calls.filter(([fields, message]) => typeof message === "string"
      && message.startsWith("long-queued heartbeat run was offered a free slot")
      && (fields as { runId?: string }).runId === refused).length;
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    expect(offers()).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    expect(offers()).toBe(1);
    await vi.waitFor(async () => {
      await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      expect(offers()).toBe(2);
    }, { timeout: 20_000, interval: 1_000 });
    expect((await statusOf([refused])).get(refused)?.status).toBe("queued");
  }, 120_000);
});
