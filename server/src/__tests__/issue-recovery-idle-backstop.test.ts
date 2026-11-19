import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { ISSUE_RECOVERY_BACKSTOP_MS, ISSUE_RECOVERY_FULL_BACKSTOP_MS, notifyIssueGraphRecovery }
  from "../services/issue-recovery-notifications.js";
import { issueService } from "../services/issues.js";
import { notifyNativeStatusReassessment } from "../services/native-status-reassessment-notifications.js";
import { promoteDeferredWorkIntents } from "../services/work-intent-outbox.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { seedRecoveryPopulation } from "./helpers/recovery-population.js";

vi.hoisted(() => { process.env.PAPERCLIP_DEBUG_WORK_SIGNALS = "stranded-assignments:1"; });

const MINUTE = 60_000;
const STEP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
type Recorded = { at: number; name: string; fields: Record<string, unknown> };

/** Fails with a message naming what it waited for instead of hanging. */
function bounded<T>(work: Promise<T>, waitingFor: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`Timed out after ${STEP_TIMEOUT_MS} ms waiting for ${waitingFor()}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => realClearTimeout(timer));
}

describeIssueRecovery("stranded-task checks at idle for a staging-shaped company", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const at = new Date(Date.now()).toISOString();
      await bounded(vi.advanceTimersByTimeAsync(Math.min(1000, until - Date.now())), () => `simulated time to advance past ${at}`);
      await bounded(Promise.allSettled([...state.passes]),
        () => `delivery passes started by simulated ${at} to settle: ${state.pendingPassQueues().join(", ") || "none"}`);
      await immediate();
    }
  }

  function record() {
    const events: Recorded[] = [];
    vi.spyOn(workSignalDebug, "event").mockImplementation((topic, name, fields = {}) => {
      if (topic === "stranded-assignments") events.push({ at: Date.now(), name, fields });
    });
    vi.spyOn(workSignalDebug, "signal").mockImplementation(() => {});
    return events;
  }

  function summarize(events: Recorded[]) {
    const checks: Record<string, number> = {}, loads: Record<string, number> = {};
    for (const event of events) {
      if (event.name === "check") checks[String(event.fields.wake)] = (checks[String(event.fields.wake)] ?? 0) + 1;
      if (event.name === "load") {
        const scope = String(event.fields.scope);
        const kind = scope === "*" ? "reload" : scope.endsWith(",true]") ? "backstop" : /^\["[^"]+",null,null,null,null\]$/.test(scope)
          ? "company" : "hint";
        loads[kind] = (loads[kind] ?? 0) + 1;
      }
    }
    return { checks, loads, totalChecks: Object.values(checks).reduce((sum, count) => sum + count, 0) };
  }

  const checkedAt = (events: Recorded[], issueId: string) =>
    events.find(event => event.name === "check" && event.fields.issueId === issueId)?.at ?? null;

  /** The wakes recovery asked for on a task. No fixture agent takes on-demand
   * wakes, so each is recorded as skipped and no real run starts under the
   * faked clock (a run there could wait forever on a frozen timer). */
  const wakesFor = (companyId: string, issueId: string) => bounded(state.db.select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`)), () => `the wake requests of task ${issueId} to be read`);

  async function seed() {
    const f = await bounded(state.fixture(), () => "the company to be created");
    const population = await seedRecoveryPopulation(state.db, f.companyId, { agents: 50, inReview: 780, inProgress: 40, todo: 30,
      recoveryActions: 12, terminated: 3, wakeOnDemand: false });
    const [side] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Finished side task", status: "done" })
      .returning({ id: issues.id });
    const activity = () => bounded(state.db.transaction(tx => notifyIssueGraphRecovery(tx, { companyId: f.companyId, issueId: side!.id })),
      () => "the unrelated activity hint to commit");
    return { ...f, population, activity };
  }

  async function boot() {
    const f = await bounded(seed(), () => "the staging-shaped population to be seeded");
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await bounded(state.start({}), () => "the recovery workers to start");
    await advance(10 * MINUTE);
    return { ...f, events, boot: summarize(events.splice(0)) };
  }

  async function heldTask(f: Awaited<ReturnType<typeof boot>>) {
    const old = new Date(Date.now() - 2 * 60 * MINUTE);
    const [held] = await state.db.insert(agents).values({ companyId: f.companyId, name: "Held worker", role: "engineer", status: "paused",
      lifecycleHolds: ["manual"], adapterType: "process", reportsTo: f.population.agentIds[1], createdAt: old, updatedAt: old,
      adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } } }).returning({ id: agents.id });
    const [waiting] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Waits for its agent", status: "todo",
      assigneeAgentId: held!.id, createdAt: old, updatedAt: old }).returning({ id: issues.id });
    return { held: held!, waiting: waiting! };
  }

  async function trickle(f: Awaited<ReturnType<typeof boot>>, minutes: number) {
    const before = state.meter.read();
    for (let minute = 0; minute < minutes; minute++) { await f.activity(); await advance(MINUTE); }
    const after = state.meter.read();
    const raw = f.events.splice(0);
    return { ...summarize(raw), raw, statements: after.statements - before.statements,
      bytes: after.bytesReceived - before.bytesReceived };
  }

  it("checks only changed tasks between hourly full passes while unrelated activity continues", async () => {
    const f = await boot();
    const between = await trickle(f, 30);
    const hour = await trickle(f, 30);
    const { raw: _first, ...firstHalfHour } = between, { raw: _second, ...secondHalfHour } = hour;
    console.info(JSON.stringify({ boot: f.boot, firstHalfHour, secondHalfHour,
      perSecond: { checks: (between.totalChecks + hour.totalChecks) / 3600, statements: (between.statements + hour.statements) / 3600 } }));
    expect(f.boot.totalChecks).toBeGreaterThanOrEqual(f.population.inReview.length);
    expect(between.totalChecks).toBe(0);
    expect(between.statements).toBeLessThan(2_000);
    expect(hour.checks.backstop ?? 0).toBeLessThanOrEqual(f.population.inReview.length + 100);
  }, TEST_TIMEOUT_MS);

  it("recovers a task whose hint was never sent within the backstop bound", async () => {
    const f = await boot();
    const worker = f.population.agentIds[7]!;
    const now = new Date();
    const [missed] = await bounded(state.db.insert(issues).values({ companyId: f.companyId, title: "Created without a hint", status: "todo",
      assigneeAgentId: worker, createdAt: now, updatedAt: now }).returning({ id: issues.id }), () => "the task without a hint to be created");
    const window = await trickle(f, Math.ceil((ISSUE_RECOVERY_BACKSTOP_MS + MINUTE) / MINUTE) + 1);
    const checked = checkedAt(window.raw, missed!.id);
    expect(checked).not.toBeNull();
    expect(checked! - now.getTime()).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
    expect(await wakesFor(f.companyId, missed!.id), "recovery did not ask for a wake of the missed task").not.toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("re-checks a task whose only change is outside its own rows within the hourly full pass", async () => {
    const f = await boot();
    const { held, waiting } = await bounded(heldTask(f), () => "the held agent and its waiting task to be seeded");
    await bounded(state.db.execute(sql`update agents set status = 'idle', lifecycle_holds = '[]'::jsonb where id = ${held.id}`),
      () => "the hold release without a hint to commit");
    const changedAt = Date.now();
    const window = await trickle(f, Math.ceil((ISSUE_RECOVERY_FULL_BACKSTOP_MS + 2 * MINUTE) / MINUTE));
    const checks = window.raw.filter(event => event.name === "check" && event.fields.issueId === waiting.id);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]!.at - changedAt).toBeGreaterThan(2 * ISSUE_RECOVERY_BACKSTOP_MS);
    expect(checks[0]!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_FULL_BACKSTOP_MS + 2 * MINUTE);
    expect(await wakesFor(f.companyId, waiting.id), "recovery did not ask for a wake of the waiting task").not.toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("picks up a finished run, a user message, a raised budget and a resumed agent within a minute", async () => {
    const f = await boot();
    await trickle(f, 6);
    const [target, messaged] = f.population.inReview;
    const within = async (issueId: string, act: () => Promise<unknown>) => {
      f.events.length = 0;
      const at = Date.now();
      await bounded(act(), () => `the change to task ${issueId} to commit`);
      await advance(60_000);
      const checked = checkedAt(f.events, issueId);
      expect(checked, issueId).not.toBeNull();
      expect(checked! - at).toBeLessThanOrEqual(60_000);
    };
    const [run] = await bounded(state.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${target!}`).limit(1), () => "the finished run to be read");
    await within(target!, () => state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: run!.id })));
    await advance(31_000);
    await within(messaged!, () => issueService(state.db).addComment(messaged!, "Please look again", { userId: "recovery-user" }));
    await advance(31_000);
    await within(target!, () => state.db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted" })));
    await advance(31_000);
    const { held, waiting } = await bounded(heldTask(f), () => "the held agent and its waiting task to be seeded");
    await advance(31_000);
    await within(waiting.id, async () => {
      await state.db.update(agents).set({ status: "idle", lifecycleHolds: [], updatedAt: new Date() }).where(eq(agents.id, held.id));
      await state.db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted" }));
    });
  }, TEST_TIMEOUT_MS);
});
