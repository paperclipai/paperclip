import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
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
type Recorded = { at: number; name: string; fields: Record<string, unknown> };

describeIssueRecovery("stranded-task checks at idle for a staging-shaped company", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1000, until - Date.now()));
      await Promise.allSettled([...state.passes]); await immediate();
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

  async function seed() {
    const f = await state.fixture();
    const population = await seedRecoveryPopulation(state.db, f.companyId, { agents: 50, inReview: 780, inProgress: 40, todo: 30,
      recoveryActions: 12, terminated: 3 });
    const [side] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Finished side task", status: "done" })
      .returning({ id: issues.id });
    const activity = () => state.db.transaction(tx => notifyIssueGraphRecovery(tx, { companyId: f.companyId, issueId: side!.id }));
    return { ...f, population, activity };
  }

  async function boot() {
    const f = await seed();
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    await advance(10 * MINUTE);
    return { ...f, events, boot: summarize(events.splice(0)) };
  }

  async function heldTask(f: Awaited<ReturnType<typeof boot>>) {
    const old = new Date(Date.now() - 2 * 60 * MINUTE);
    const [held] = await state.db.insert(agents).values({ companyId: f.companyId, name: "Held worker", role: "engineer", status: "paused",
      lifecycleHolds: ["manual"], adapterType: "process", reportsTo: f.population.agentIds[1], createdAt: old, updatedAt: old,
      adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true } } }).returning({ id: agents.id });
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
  }, 1_800_000);

  it("recovers a task whose hint was never sent within the backstop bound", async () => {
    const f = await boot();
    const worker = f.population.agentIds[7]!;
    const now = new Date();
    const [missed] = await state.db.insert(issues).values({ companyId: f.companyId, title: "Created without a hint", status: "todo",
      assigneeAgentId: worker, createdAt: now, updatedAt: now }).returning({ id: issues.id });
    const window = await trickle(f, Math.ceil((ISSUE_RECOVERY_BACKSTOP_MS + MINUTE) / MINUTE) + 1);
    const checked = checkedAt(window.raw, missed!.id);
    expect(checked).not.toBeNull();
    expect(checked! - now.getTime()).toBeLessThanOrEqual(ISSUE_RECOVERY_BACKSTOP_MS + 2 * MINUTE);
    const runs = await state.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${missed!.id}`));
    expect(runs.length).toBeGreaterThan(0);
  }, 1_800_000);

  it("re-checks a task whose only change is outside its own rows within the hourly full pass", async () => {
    const f = await boot();
    const { held, waiting } = await heldTask(f);
    await state.db.execute(sql`update agents set status = 'idle', lifecycle_holds = '[]'::jsonb where id = ${held.id}`);
    const changedAt = Date.now();
    const window = await trickle(f, Math.ceil((ISSUE_RECOVERY_FULL_BACKSTOP_MS + 2 * MINUTE) / MINUTE));
    const checks = window.raw.filter(event => event.name === "check" && event.fields.issueId === waiting.id);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]!.at - changedAt).toBeGreaterThan(2 * ISSUE_RECOVERY_BACKSTOP_MS);
    expect(checks[0]!.at - changedAt).toBeLessThanOrEqual(ISSUE_RECOVERY_FULL_BACKSTOP_MS + 2 * MINUTE);
    const runs = await state.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, f.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiting.id}`));
    expect(runs.length).toBeGreaterThan(0);
  }, 1_800_000);

  it("picks up a finished run, a user message, a raised budget and a resumed agent within a minute", async () => {
    const f = await boot();
    await trickle(f, 6);
    const [target, messaged] = f.population.inReview;
    const within = async (issueId: string, act: () => Promise<unknown>) => {
      f.events.length = 0;
      const at = Date.now();
      await act();
      await advance(60_000);
      const checked = checkedAt(f.events, issueId);
      expect(checked, issueId).not.toBeNull();
      expect(checked! - at).toBeLessThanOrEqual(60_000);
    };
    const [run] = await state.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${target!}`).limit(1);
    await within(target!, () => state.db.transaction(tx => notifyNativeStatusReassessment(tx, { companyId: f.companyId, runId: run!.id })));
    await advance(31_000);
    await within(messaged!, () => issueService(state.db).addComment(messaged!, "Please look again", { userId: "recovery-user" }));
    await advance(31_000);
    await within(target!, () => state.db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted" })));
    await advance(31_000);
    const { held, waiting } = await heldTask(f);
    await advance(31_000);
    await within(waiting.id, async () => {
      await state.db.update(agents).set({ status: "idle", lifecycleHolds: [], updatedAt: new Date() }).where(eq(agents.id, held.id));
      await state.db.transaction(tx => promoteDeferredWorkIntents(tx, { companyId: f.companyId, trigger: "pause_lifted" }));
    });
  }, 1_800_000);
});
