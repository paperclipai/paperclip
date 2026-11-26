import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { heartbeatRunWatchdogDecisions, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import {
  canActorReadHeartbeatRun, getHeartbeatRunReadDecisions, redactHeartbeatRunListRow,
} from "../services/heartbeat-run-privacy.js";
import {
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS, ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS, recoveryService,
} from "../services/recovery/service.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import {
  ISSUE_READ_VISIBILITY_ACTORS, seedIssueReadVisibilityFixture, type IssueReadVisibilityActorName,
  type IssueReadVisibilityFixture,
} from "./helpers/issue-read-visibility-fixture.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type RunBinding = { id: string; companyId: string; scopeKind: "company" | "issue"; issueId: string | null };

describeEmbeddedPostgres("live runs read in a bounded number of statements", () => {
  const ctx = useEmbeddedPostgres("paperclip-live-runs-batch-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  let f: IssueReadVisibilityFixture;
  let runs: RunBinding[];
  let foreignRuns: RunBinding[];
  let silenceRunIds: Record<"noOutput" | "snoozed" | "expiredSnooze" | "dismissed" | "recent" | "evaluated" | "doneEvaluation" | "queued", string>;

  let order = 0;
  async function insertRun(input: {
    companyId: string; agentId: string; issueId?: string | null; scopeKind?: "company" | "issue";
    status?: string; lastOutputAt?: Date | null; lastOutputSeq?: number; lastOutputStream?: string | null;
  }) {
    const id = randomUUID();
    order += 1;
    const scopeKind = input.scopeKind ?? (input.issueId ? "issue" : "company");
    await ctx.db.insert(heartbeatRuns).values({
      id, companyId: input.companyId, agentId: input.agentId, scopeKind, issueId: input.issueId ?? null,
      status: input.status ?? "running", startedAt: new Date(NOW.getTime() - 3 * HOUR),
      createdAt: new Date(NOW.getTime() - 3 * HOUR - order * 1000), lastOutputAt: input.lastOutputAt ?? null,
      lastOutputSeq: input.lastOutputSeq ?? 0, lastOutputStream: input.lastOutputStream ?? null,
      usageJson: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 }, resultJson: { costUsd: 0.42, summary: "secret summary" },
      contextSnapshot: input.issueId ? { issueId: input.issueId } : {},
    });
    return { id, companyId: input.companyId, scopeKind, issueId: input.issueId ?? null } satisfies RunBinding;
  }

  async function seedRuns(fixture: IssueReadVisibilityFixture, openTaskRuns: number) {
    const agentIds = [fixture.readerAgentId, fixture.assigneeAgentId, fixture.lowTrustAgentId];
    const taskIds = [
      ...Array.from({ length: openTaskRuns }, (_, index) => fixture.publicIds[index % fixture.publicIds.length]!),
      ...fixture.ownedPrivateIds, ...fixture.grantedPrivateIds, ...fixture.assignedPrivateIds, ...fixture.unreadablePrivateIds,
      ...fixture.privateProjectIssueIds, fixture.hiddenId,
    ];
    const seeded: RunBinding[] = [];
    for (const [index, issueId] of taskIds.entries()) {
      seeded.push(await insertRun({ companyId: fixture.companyId, agentId: agentIds[index % agentIds.length]!, issueId }));
    }
    seeded.push(await insertRun({ companyId: fixture.companyId, agentId: fixture.readerAgentId }));
    const doomedTaskId = randomUUID();
    await ctx.db.insert(issues).values({ id: doomedTaskId, companyId: fixture.companyId, title: "Deleted", status: "todo" });
    const orphan = await insertRun({ companyId: fixture.companyId, agentId: fixture.assigneeAgentId, issueId: doomedTaskId });
    await ctx.db.delete(issues).where(eq(issues.id, doomedTaskId));
    seeded.push({ ...orphan, issueId: null });
    return seeded;
  }

  beforeAll(async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    f = await seedIssueReadVisibilityFixture(ctx.db, { publicCount: 12 });
    runs = await seedRuns(f, 3);
    foreignRuns = [
      await insertRun({ companyId: f.foreignCompanyId, agentId: f.foreignAgentId, issueId: f.foreignIds[0]! }),
      await insertRun({ companyId: f.foreignCompanyId, agentId: f.foreignAgentId, issueId: f.foreignIds[1]! }),
      await insertRun({ companyId: f.foreignCompanyId, agentId: f.foreignAgentId }),
    ];
    const silenceRun = (extra: Partial<Parameters<typeof insertRun>[0]>) =>
      insertRun({ companyId: f.companyId, agentId: f.readerAgentId, ...extra });
    silenceRunIds = {
      noOutput: (await silenceRun({})).id,
      snoozed: (await silenceRun({ lastOutputAt: new Date(NOW.getTime() - 2 * HOUR), lastOutputSeq: 4, lastOutputStream: "stdout" })).id,
      expiredSnooze: (await silenceRun({ lastOutputAt: new Date(NOW.getTime() - 2 * HOUR), lastOutputSeq: 2, lastOutputStream: "stderr" })).id,
      dismissed: (await silenceRun({ lastOutputAt: new Date(NOW.getTime() - 5 * HOUR), lastOutputSeq: 9, lastOutputStream: "other" })).id,
      recent: (await silenceRun({ lastOutputAt: new Date(NOW.getTime() - 10 * 60 * 1000), lastOutputSeq: 1, lastOutputStream: "stdout" })).id,
      evaluated: (await silenceRun({})).id,
      doneEvaluation: (await silenceRun({})).id,
      queued: (await silenceRun({ status: "queued" })).id,
    };
    await ctx.db.insert(heartbeatRunWatchdogDecisions).values([
      { companyId: f.companyId, runId: silenceRunIds.snoozed, decision: "snooze", snoozedUntil: new Date(NOW.getTime() + HOUR), createdAt: new Date(NOW.getTime() - 2 * HOUR) },
      { companyId: f.companyId, runId: silenceRunIds.snoozed, decision: "continue", snoozedUntil: new Date(NOW.getTime() + 2 * HOUR), createdAt: new Date(NOW.getTime() - HOUR) },
      { companyId: f.companyId, runId: silenceRunIds.expiredSnooze, decision: "snooze", snoozedUntil: new Date(NOW.getTime() - HOUR) },
      { companyId: f.companyId, runId: silenceRunIds.dismissed, decision: "dismissed_false_positive" },
      { companyId: f.companyId, runId: silenceRunIds.dismissed, decision: "snooze", snoozedUntil: new Date(NOW.getTime() + HOUR) },
    ]);
    const evaluationId = randomUUID();
    await ctx.db.insert(issues).values([
      { id: evaluationId, companyId: f.companyId, title: "Evaluate", status: "todo", identifier: "EVAL-1",
        assigneeAgentId: f.assigneeAgentId, originKind: "stale_active_run_evaluation", originId: silenceRunIds.evaluated },
      { companyId: f.companyId, title: "Evaluated before", status: "done", originKind: "stale_active_run_evaluation", originId: silenceRunIds.doneEvaluation },
      { companyId: f.foreignCompanyId, title: "Foreign evaluation", status: "todo", originKind: "stale_active_run_evaluation", originId: silenceRunIds.noOutput },
    ]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });
  afterEach(() => { vi.useRealTimers(); });

  function app(actor: AuthorizationActor, db = ctx.db) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = { ...actor } as Express.Request["actor"]; next(); });
    result.use("/api", agentRoutes(db, {} as never));
    result.use(errorHandler);
    return result;
  }
  function recording() {
    const statements: string[] = [];
    const db = drizzle(ctx.db.$client, {
      schema: ctx.db._.fullSchema, logger: { logQuery: (query) => statements.push(query) },
    }) as unknown as typeof ctx.db;
    return { db, statements };
  }
  async function liveRuns(actor: AuthorizationActor, companyId = f.companyId, db = ctx.db) {
    return request(app(actor, db)).get(`/api/companies/${companyId}/live-runs`);
  }
  const readEach = (actor: AuthorizationActor, bindings: RunBinding[]) =>
    Promise.all(bindings.map((run) => canActorReadHeartbeatRun(ctx.db, authorizationService(ctx.db), { ...actor }, run)));

  it.each(ISSUE_READ_VISIBILITY_ACTORS)("decides every run read for %s exactly as one check per run does", async (name) => {
    const actor = f.actors[name];
    const bindings = [...runs, ...foreignRuns, ...foreignRuns.map((run) => ({ ...run, companyId: f.companyId }))];
    const batched = await getHeartbeatRunReadDecisions(ctx.db, authorizationService(ctx.db), { ...actor }, bindings);
    expect(batched).toEqual(await readEach(actor, bindings));
  });

  it("covers readable and unreadable runs in the fixture", async () => {
    const decisions = async (name: IssueReadVisibilityActorName) => readEach(f.actors[name], runs);
    expect((await decisions("instance admin")).filter(Boolean).length).toBeGreaterThan((await decisions("board member")).filter(Boolean).length);
    expect(await decisions("board member")).toContain(false);
    expect(await decisions("board member")).toContain(true);
    expect(await decisions("agent key")).toContain(false);
    expect(runs.at(-1)).toMatchObject({ scopeKind: "issue", issueId: null });
    expect(await readEach(f.actors["instance admin"], [runs.at(-1)!])).toEqual([false]);
  });

  it.each(ISSUE_READ_VISIBILITY_ACTORS)("returns %s the live runs one check per run would, redacting the rest field by field", async (name) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const actor = f.actors[name];
    const res = await liveRuns(actor);
    if (res.status !== 200) {
      expect([401, 403]).toContain(res.status);
      for (const run of runs) expect(JSON.stringify(res.body)).not.toContain(run.id);
      return;
    }
    const full = await liveRuns(f.actors["local implicit board"]);
    expect(full.status).toBe(200);
    const fullById = new Map((full.body as Array<Record<string, unknown> & { id: string }>).map((row) => [row.id, row]));
    const body = res.body as Array<Record<string, unknown> & { id: string; scopeKind?: string }>;
    expect(body.map((row) => row.id)).toEqual([...fullById.keys()]);
    const bindings = body.map((row) => {
      const source = fullById.get(row.id)!;
      return { id: row.id, companyId: f.companyId, scopeKind: source.scopeKind as "company" | "issue", issueId: (source.issueId as string | null) ?? null };
    });
    const expected = await readEach(actor, bindings);
    for (const [index, row] of body.entries()) {
      const source = fullById.get(row.id)!;
      if (expected[index]) {
        expect(row.redacted).toBeUndefined();
        expect(row.outputSilence).toEqual(source.outputSilence);
        expect(row.issueId).toEqual(source.issueId);
      } else {
        expect(row).toEqual(JSON.parse(JSON.stringify(redactHeartbeatRunListRow(source))));
      }
    }
    expect(expected).toContain(true);
  });

  it("builds each run's output silence as the single-run reader does, including runs with no output yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const res = await liveRuns(f.actors["local implicit board"]);
    expect(res.status).toBe(200);
    const byId = new Map((res.body as Array<{ id: string; outputSilence: unknown }>).map((row) => [row.id, row.outputSilence]));
    const recovery = recoveryService(ctx.db, { enqueueWakeup: vi.fn() } as never);
    const rows = await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const single = new Map(await Promise.all(rows.map(async (run) => [run.id, JSON.parse(JSON.stringify(await recovery.buildRunOutputSilence(run, NOW)))] as const)));
    for (const [id, silence] of byId) {
      if (silence !== undefined) expect(silence).toEqual(single.get(id));
    }
    const thresholds = { suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS, criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS };
    const silenceOf = (id: string) => single.get(id) as Record<string, unknown>;
    expect(silenceOf(silenceRunIds.noOutput)).toEqual({
      lastOutputAt: null, lastOutputSeq: 0, lastOutputStream: null,
      silenceStartedAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), silenceAgeMs: 3 * HOUR, level: "critical", ...thresholds,
      snoozedUntil: null, evaluationIssueId: null, evaluationIssueIdentifier: null, evaluationIssueAssigneeAgentId: null,
    });
    expect(silenceOf(silenceRunIds.snoozed)).toMatchObject({
      lastOutputSeq: 4, lastOutputStream: "stdout", level: "snoozed", snoozedUntil: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
    });
    expect(silenceOf(silenceRunIds.expiredSnooze)).toMatchObject({ lastOutputStream: "stderr", level: "critical", snoozedUntil: null });
    expect(silenceOf(silenceRunIds.dismissed)).toMatchObject({ lastOutputStream: null, level: "not_applicable", snoozedUntil: null });
    expect(silenceOf(silenceRunIds.recent)).toMatchObject({ level: "suspicious", silenceAgeMs: 10 * 60 * 1000 });
    expect(silenceOf(silenceRunIds.evaluated)).toMatchObject({ evaluationIssueIdentifier: "EVAL-1", evaluationIssueAssigneeAgentId: f.assigneeAgentId });
    expect(silenceOf(silenceRunIds.doneEvaluation)).toMatchObject({ evaluationIssueId: null });
    expect(silenceOf(silenceRunIds.queued)).toMatchObject({ level: "not_applicable", silenceAgeMs: null });

    const batched = await recovery.buildRunOutputSilences([...rows, ...rows.slice(0, 2)], NOW);
    expect(batched.map((silence) => JSON.parse(JSON.stringify(silence))))
      .toEqual([...rows, ...rows.slice(0, 2)].map((run) => single.get(run.id)));
    expect(await recovery.buildRunOutputSilences([], NOW)).toEqual([]);
    const missing = rows.find((run) => run.id === silenceRunIds.noOutput)!;
    expect(JSON.parse(JSON.stringify(await recovery.buildRunOutputSilence({ ...missing, id: randomUUID() }, NOW))))
      .toEqual(silenceOf(silenceRunIds.noOutput));
  });

  it.each([
    "board owner", "board member", "instance admin", "local implicit board", "agent key", "agent run for operator",
  ] as const)("sends the same number of statements for %s whether 19 or 49 runs are live", async (name) => {
    const small = await seedIssueReadVisibilityFixture(ctx.db, { publicCount: 12 });
    const large = await seedIssueReadVisibilityFixture(ctx.db, { publicCount: 12 });
    const smallRuns = await seedRuns(small, 0);
    const largeRuns = await seedRuns(large, 30);
    const actorFor = (fixture: IssueReadVisibilityFixture) => fixture.actors[name];
    const first = recording();
    const smallRes = await liveRuns(actorFor(small), small.companyId, first.db);
    const second = recording();
    const largeRes = await liveRuns(actorFor(large), large.companyId, second.db);
    expect(smallRes.status).toBe(200);
    expect(largeRes.status).toBe(200);
    expect(smallRes.body).toHaveLength(smallRuns.length + 1);
    expect(largeRes.body).toHaveLength(largeRuns.length + 1);
    expect(second.statements.length).toBe(first.statements.length);
    expect(second.statements.length).toBeLessThanOrEqual(24);
  });
});
