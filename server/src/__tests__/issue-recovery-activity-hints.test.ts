import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { setImmediate as immediate } from "node:timers/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { trimWorkSignalStack, workSignalDebug } from "@paperclipai/db/work-signal-debug";
import { issueService } from "../services/issues.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { seedRecoveryPopulation } from "./helpers/recovery-population.js";

vi.hoisted(() => { process.env.PAPERCLIP_DEBUG_WORK_SIGNALS = "stranded-assignments:1,assigned-work-invariant:1"; });

const MINUTE = 60_000;
const measuring = Boolean(process.env.RECOVERY_ACTIVITY_REPORT);
const report = (label: string, summary: unknown) => {
  if (process.env.RECOVERY_ACTIVITY_REPORT) appendFileSync(process.env.RECOVERY_ACTIVITY_REPORT, `${label} ${JSON.stringify(summary, null, 1)}\n`);
};
const TASK_QUEUES = new Set(["stranded-assignments", "assigned-work-invariant", "resolved-dependencies", "stale-issue-locks"]);
type Recorded = { at: number; topic: string; name: string; fields: Record<string, unknown> };

describeIssueRecovery("recovery checks while runs are active in a staging-shaped company", () => {
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
      if (name === "check") events.push({ at: Date.now(), topic, name, fields });
    });
    vi.spyOn(workSignalDebug, "signal").mockImplementation((topic, hint) => {
      if (!TASK_QUEUES.has(topic)) return;
      const holder: { stack?: string } = {};
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      Error.captureStackTrace(holder);
      Error.stackTraceLimit = limit;
      const frames = trimWorkSignalStack(holder.stack, 30).filter(line => !/issue-recovery-notifications|run-dispatch-notifications|external-conversation-settlement-notifications|native-status-reassessment-notifications|execution-control-notifications|issue-review-state-notifications|mockImplementation|spy|vitest/.test(line));
      const short = (line: string) => line.replace(/^at (async )?/, "").replace(/\(?\/.*\/server\/src\//, "(").replace(/:\d+\)?$/, ")");
      const app = frames.filter(line => /services|modules|routes/.test(line));
      const caller = app.length ? app.slice(0, process.env.RECOVERY_ACTIVITY_FRAMES ? Number(process.env.RECOVERY_ACTIVITY_FRAMES) : 1).map(short).join(" < ")
        : short(frames[0] ?? "unknown");
      const kind = hint === undefined || hint === "*" ? "all" : (() => {
        const scope = JSON.parse(hint) as Record<string, unknown>;
        return scope.issueId ? "task" : scope.graphRunId || scope.graphIssueId ? "graph" : scope.backstop ? "backstop" : "company";
      })();
      events.push({ at: Date.now(), topic, name: "signal", fields: { kind, caller } });
    });
    return events;
  }

  function summarize(events: Recorded[], seconds: number) {
    const checks: Record<string, Record<string, number>> = {}, signals: Record<string, number> = {}, scoped: Record<string, number> = {};
    for (const event of events) {
      if (event.name === "check") {
        const byQueue = checks[event.topic] ??= {};
        byQueue[String(event.fields.wake)] = (byQueue[String(event.fields.wake)] ?? 0) + 1;
      } else if (event.topic === "stranded-assignments" && (event.fields.kind === "task" || event.fields.kind === "graph")) {
        const key = `${event.fields.kind} ${event.fields.caller}`;
        scoped[key] = (scoped[key] ?? 0) + 1;
      } else if (event.fields.kind !== "task" && event.fields.kind !== "graph") {
        const key = `${event.topic} ${event.fields.kind} ${event.fields.caller}`;
        signals[key] = (signals[key] ?? 0) + 1;
      }
    }
    const perSecond = Object.fromEntries(Object.entries(checks).map(([queue, byReason]) => [queue, Object.fromEntries(
      Object.entries(byReason).map(([reason, count]) => [reason, Number((count / seconds).toFixed(2))]))]));
    const total = (queue: string) => Object.values(checks[queue] ?? {}).reduce((sum, count) => sum + count, 0);
    return { checks, perSecond, signals, scoped, stranded: total("stranded-assignments"), assigned: total("assigned-work-invariant") };
  }

  async function provider(companyId: string, workerIds: string[]) {
    const failures: unknown[] = [];
    const listener = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await state.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
        if (!run!.contextSnapshot?.issueId) { response.end("ok"); return; }
        const issueId = String(run!.contextSnapshot?.issueId);
        const deadlocked = (error: unknown): boolean => typeof error === "object" && error !== null
          && ((error as { code?: string }).code === "40P01" || deadlocked((error as { cause?: unknown }).cause));
        const retryDeadlock = async (write: () => Promise<unknown>) => {
          for (let attempt = 1; ; attempt++) {
            try { return await write(); } catch (error) { if (attempt >= 3 || !deadlocked(error)) throw error; }
          }
        };
        await retryDeadlock(() => issueService(state.db).addComment(issueId, "Progress: done with this step", { agentId: run!.agentId, runId }));
        await retryDeadlock(() => issueService(state.db).update(issueId, { status: "in_review" }));
        response.end("ok");
      } catch (error) { failures.push(error); response.statusCode = 500; response.end("failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/progress",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(r=>{if(!r.ok)process.exitCode=1;console.log("ok")})`;
    await state.db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
      .where(inArray(agents.id, workerIds));
    return { failures, close: async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); } };
  }

  async function measure(runsPerMinute: number, minutes: number, timerRunsPerMinute = 0) {
    const f = await state.fixture();
    const population = await seedRecoveryPopulation(state.db, f.companyId, { agents: 50, inReview: 780, inProgress: 40, todo: 30,
      recoveryActions: 12, terminated: 3 });
    const workers = population.agentIds.slice(7, 7 + 41);
    const fake = await provider(f.companyId, workers);
    const events = record();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await state.start({});
    await advance(10 * MINUTE);
    events.length = 0;
    const counts = async () => {
      const [runs] = await state.db.select({ finished: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`, all: sql<number>`count(*)::int` })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.runtimeMode, "legacy")));
      const [events] = await state.db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.companyId, f.companyId));
      const [comments] = await state.db.select({ n: sql<number>`count(*)::int` }).from(issueComments)
        .where(and(eq(issueComments.companyId, f.companyId), sql`${issueComments.authorAgentId} is not null`));
      return { ...runs!, events: events!.n, agentComments: comments!.n };
    };
    const workBefore = await counts();
    const before = state.meter.read();
    const startedAt = Date.now();
    const byCheck: Record<string, number> = {}, settingsCallers: Record<string, number> = {};
    const tally = (log: ReturnType<typeof state.meter.stopLog>) => {
      for (const entry of log) {
        const stack = entry.stack ?? "";
        const owner = stack.includes("reconcileStrandedAssignedIssues") ? "stranded-assignments"
          : /assigned-work-sweep|checkIssue/.test(stack) ? "assigned-work-invariant"
            : stack.includes("sweepStaleIssueLocks") ? "stale-issue-locks" : stack.includes("recovery/work.ts") ? "recovery-loads" : "other";
        byCheck[owner] = (byCheck[owner] ?? 0) + 1;
        if (/from "instance_settings"/.test(entry.sql)) {
          const frame = stack.split("\n").map(line => line.trim()).find(line => /server\/src\/services\//.test(line) && !/instance-settings/.test(line)) ?? "unknown";
          const key = `${owner} ${frame.replace(/^at (async )?/, "").replace(/\(?\/.*\/server\/src\//, "(").replace(/:\d+\)?$/, ")")}`;
          settingsCallers[key] = (settingsCallers[key] ?? 0) + 1;
        }
      }
    };
    if (measuring) state.meter.startLog({ stacks: true });
    let next = 12;
    for (let minute = 0; minute < minutes; minute++) {
      const minuteEnds = startedAt + (minute + 1) * MINUTE;
      for (let started = 0; started < runsPerMinute; started++) {
        const issueId = population.inReview[next++ % population.inReview.length]!;
        const comment = await issueService(state.db).addComment(issueId, "Please take another pass", { userId: "recovery-user" });
        const [task] = await state.db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
        await state.heartbeat.wakeup(task!.assigneeAgentId!, { source: "automation", triggerDetail: "system", reason: "issue_commented",
          payload: { issueId, commentId: comment.id, mutation: "comment" }, requestedByActorType: "user", requestedByActorId: "recovery-user",
          contextSnapshot: { issueId, taskId: issueId, commentId: comment.id, wakeCommentId: comment.id, source: "issue.comment",
            wakeReason: "issue_commented" } });
        await vi.advanceTimersByTimeAsync(Math.floor(MINUTE / runsPerMinute / 4));
      }
      for (let timer = 0; timer < timerRunsPerMinute; timer++) {
        await state.heartbeat.wakeup(workers[(minute * timerRunsPerMinute + timer) % workers.length]!, { source: "on_demand", triggerDetail: "manual",
          reason: "manual", requestedByActorType: "user", requestedByActorId: "recovery-user",
          contextSnapshot: { source: "scheduler", reason: "interval_elapsed", now: new Date().toISOString() } });
      }
      await advance(minuteEnds - Date.now());
      await state.heartbeat.drainActiveRunExecutions();
      if (measuring) tally(state.meter.stopLog());
      if (measuring) state.meter.startLog({ stacks: true });
    }
    const seconds = (Date.now() - startedAt) / 1000;
    const after = state.meter.read();
    if (measuring) tally(state.meter.stopLog());
    const workAfter = await counts();
    const work = { started: workAfter.all - workBefore.all, finished: workAfter.finished - workBefore.finished,
      failed: workAfter.failed - workBefore.failed, events: workAfter.events - workBefore.events,
      agentComments: workAfter.agentComments - workBefore.agentComments };
    const summary = { ...summarize(events, seconds), seconds, work,
      statementsPerSecond: Number(((after.statements - before.statements) / seconds).toFixed(1)),
      agentWriteFailures: fake.failures.length,
      statementsPerSecondBy: Object.fromEntries(Object.entries(byCheck).map(([owner, count]) => [owner, Number((count / seconds).toFixed(1))])),
      instanceSettingsReads: settingsCallers };
    await fake.close();
    return summary;
  }

  function expectWorkload(summary: Awaited<ReturnType<typeof measure>>, taskRuns: number, tasklessRuns: number) {
    expect(summary.agentWriteFailures).toBe(0);
    expect(summary.work.started).toBeGreaterThanOrEqual(taskRuns + tasklessRuns);
    expect(summary.work.finished).toBeGreaterThanOrEqual(taskRuns + tasklessRuns);
    expect(summary.work.failed).toBeLessThanOrEqual(Math.ceil(0.1 * summary.work.started));
    expect(summary.work.agentComments).toBeGreaterThanOrEqual(taskRuns);
    expect(summary.work.events).toBeGreaterThan(summary.work.finished);
  }

  it("re-checks only the tasks seven runs a minute touch, among 850 open tasks", async () => {
    const minutes = measuring ? 10 : 4;
    const summary = await measure(7, minutes, 1);
    report("7 runs/min", summary);
    expectWorkload(summary, 7 * minutes, minutes);
    expect(summary.checks["stranded-assignments"]?.company ?? 0).toBe(0);
    expect(summary.signals).toEqual({});
    expect(summary.stranded / summary.seconds).toBeLessThan(2);
  }, 1_800_000);

  it.runIf(measuring)("re-checks only the tasks fifty runs a minute touch, among 850 open tasks", async () => {
    const summary = await measure(50, 6, 5);
    report("50 runs/min", summary);
    expectWorkload(summary, 300, 30);
    expect(summary.checks["stranded-assignments"]?.company ?? 0).toBe(0);
    expect(summary.signals).toEqual({});
    expect(summary.stranded / summary.seconds).toBeLessThan(3);
  }, 1_800_000);
});
