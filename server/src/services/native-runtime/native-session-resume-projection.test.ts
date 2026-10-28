import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TEST_DATABASE_URL");
const supported = Boolean(externalUrl) || (await getEmbeddedPostgresTestSupport()).supported;

(supported ? describe : describe.skip)("native session resume SQL projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), normalizedSessionId = randomUUID();
  const currentRunId = randomUUID();
  const at = (second: number) => new Date(Date.UTC(2026, 8, 8, 0, 0, second));
  const input = { companyId, agentId, issueId, normalizedSessionId, currentRunId, beforeCreatedAt: at(30) };
  const checkpoint = { sessionId: "provider-session", identity: { runId: "prior" }, complete: [false, 0, "", null] };
  const nativeExecutionInput = { binding: { issueId }, task: { prompt: "Complete native input", description: "Description" }, runtimeContext: { nested: [1, 2] } };
  const paperclipWake = { externalChatProvider: "slack", githubReviewConfigurations: [{ key: "configuration", nested: { retained: true } }], other: ["preserved"] };
  const paperclipIssue = { id: issueId, title: "Saved canonical title", description: "Saved canonical description" };
  const profile = { nativeExecutionInput, sessionCheckpoint: checkpoint, nativeToolContractFingerprint: "fingerprint", unrelated: "Omit" };
  const run = (second: number, overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) => ({
    id: randomUUID(), companyId, agentId, nativeIssueId: issueId, nativeSessionId: normalizedSessionId,
    runtimeMode: "native", status: "failed", createdAt: at(second), runnerProfileJson: {}, ...overrides,
  });
  const select = () => findNativeSessionResumeRun(db, input);
  const source = () => run(0, { runnerInstanceId: randomUUID(), processPid: 17, processGroupId: 19, processStartedAt: at(0),
    runnerProfileJson: profile, contextSnapshot: { paperclipWake, paperclipIssue: { ...paperclipIssue, unrelated: "Omit" }, prompt: "Omit" } });
  const writeProfile = (id: string, value: unknown) => db.execute(sql`update ${heartbeatRuns}
    set runner_profile_json = ${JSON.stringify(value)}::jsonb where ${heartbeatRuns.id} = ${id}`);

  beforeAll(async () => {
    database = externalUrl ? { connectionString: externalUrl, cleanup: async () => {} } : await startEmbeddedPostgresTestDatabase("native-resume-projection-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Resume projection", issuePrefix: `N${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Resume task" });
  });
  afterEach(async () => {
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  });
  afterAll(async () => {
    if (!db) return;
    try {
      await db.delete(issues).where(eq(issues.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    } finally {
      try { await db.$client.end({ timeout: 0 }); }
      finally { await database.cleanup(); }
    }
  });

  it("retains full required input, checkpoint, wake, canonical brief and process identity only for the selected source", async () => {
    const saved = source();
    await db.insert(heartbeatRuns).values([saved, run(1), run(2)]);
    const result = await select();
    expect(result).toEqual({ ...saved, runnerProfileJson: { nativeExecutionInput, sessionCheckpoint: checkpoint, nativeToolContractFingerprint: "fingerprint" },
      contextSnapshot: { paperclipWake, paperclipIssue } });
    const stored = await db.select({ profile: heartbeatRuns.runnerProfileJson, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, saved.id));
    expect(stored[0].profile).toEqual(profile);
    expect(stored[0].context).toEqual(saved.contextSnapshot);
    for (const status of ["succeeded", "interrupted", "cancelled", "timed_out"]) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, saved.id));
      expect((await select())?.id).toBe(saved.id);
    }
  });

  it("treats every non-null checkpoint as a barrier, including invalid false, zero, empty string, array and object values", async () => {
    const saved = source(), newer = run(1);
    await db.insert(heartbeatRuns).values([saved, newer]);
    for (const value of [false, 0, "", "invalid", [], {}]) {
      await writeProfile(newer.id, { sessionCheckpoint: value });
      const selected = await select();
      expect(selected?.id).toBe(newer.id);
      expect(selected?.runnerProfileJson.sessionCheckpoint).toEqual(value);
    }
  });

  it("skips only unused SQL-null, JSON-null, scalar, array and checkpoint-null profiles", async () => {
    const saved = source(), newer = run(1, { runnerProfileJson: null });
    await db.insert(heartbeatRuns).values([saved, newer]);
    expect((await select())?.id).toBe(saved.id);
    for (const value of [null, false, 0, "sessionCheckpoint", [], ["sessionCheckpoint"], {}, { sessionCheckpoint: null }]) {
      await writeProfile(newer.id, value);
      expect((await select())?.id).toBe(saved.id);
    }
  });

  it("preserves malformed selected context values and missing brief fields", async () => {
    const saved = source();
    await db.insert(heartbeatRuns).values(saved);
    for (const value of [null, false, 0, "invalid", [], {}, { paperclipWake: [], paperclipIssue: { id: issueId, title: false } },
      { paperclipIssue: { id: issueId, title: "Valid title without description" } },
      { paperclipIssue: { id: issueId, title: "Valid title", description: null } }]) {
      await db.execute(sql`update ${heartbeatRuns} set context_snapshot = ${JSON.stringify(value)}::jsonb where ${heartbeatRuns.id} = ${saved.id}`);
      const result = await select();
      const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
      expect(result?.contextSnapshot.paperclipWake).toEqual("paperclipWake" in object ? object.paperclipWake : null);
      expect(result?.contextSnapshot.paperclipIssue).toEqual("paperclipIssue" in object ? object.paperclipIssue : null);
    }
  });

  it("stops at wrong runtime, nonterminal status and each process authority field", async () => {
    await db.insert(heartbeatRuns).values(source());
    for (const override of [{ runtimeMode: "legacy" }, { status: "running" }, { processPid: 0 }, { processGroupId: 0 }, { processStartedAt: at(0) }]) {
      const newer = run(1, override);
      await db.insert(heartbeatRuns).values(newer);
      expect(await select()).toBeNull();
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, newer.id));
    }
  });

  it("checks every provider evidence event and ignores unrelated event kinds", async () => {
    const saved = source(), newer = run(1);
    await db.insert(heartbeatRuns).values([saved, newer]);
    for (const eventType of ["harness.ready", "session.started", "session.resumed", "session.updated", "turn.started", "provider.event", "provider.rpc_result", "log"]) {
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: newer.id, seq: 1, eventType });
      if (eventType === "log") expect((await select())?.id).toBe(saved.id);
      else expect(await select()).toBeNull();
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, newer.id));
    }
  });

  it("excludes current and mismatched agent, company, task and session rows before applying barriers", async () => {
    const saved = source(), otherCompany = randomUUID(), otherAgent = randomUUID(), otherIssue = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: `D${otherCompany.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: otherAgent, companyId: otherCompany, name: "Other" });
    await db.insert(issues).values({ id: otherIssue, companyId, title: "Other" });
    try {
      await db.insert(heartbeatRuns).values([saved, run(1, { id: currentRunId, status: "running" }),
        run(2, { companyId: otherCompany, status: "running" }), run(3, { agentId: otherAgent, status: "running" }),
        run(4, { nativeIssueId: otherIssue, status: "running" }), run(5, { nativeSessionId: randomUUID(), status: "running" })]);
      expect((await select())?.id).toBe(saved.id);
    } finally {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, otherCompany));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, otherAgent));
      await db.delete(issues).where(eq(issues.id, otherIssue));
      await db.delete(agents).where(eq(agents.id, otherAgent));
      await db.delete(companies).where(eq(companies.id, otherCompany));
    }
    expect(await findNativeSessionResumeRun(db, { ...input, normalizedSessionId: "invalid" })).toBeNull();
    for (const key of ["companyId", "agentId", "issueId", "normalizedSessionId"] as const) {
      expect(await findNativeSessionResumeRun(db, { ...input, [key]: input[key].toUpperCase() })).toBeNull();
    }
  });

  it("retains the 32-row bound and deterministic created-at/id ordering", async () => {
    const saved = source(), unused = Array.from({ length: 32 }, () => run(1));
    await db.insert(heartbeatRuns).values([saved, ...unused]);
    expect(await select()).toBeNull();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, unused[0].id));
    expect((await select())?.id).toBe(saved.id);
    const tied = [run(2, { runnerProfileJson: { sessionCheckpoint: false } }), run(2, { status: "running" })].sort((a, b) => b.id.localeCompare(a.id));
    await db.insert(heartbeatRuns).values(tied);
    if (tied[0].status === "running") expect(await select()).toBeNull();
    else expect((await select())?.id).toBe(tied[0].id);
  });

  it("does not skip future checkpoint barriers and preserves Date millisecond comparison", async () => {
    const saved = source(), future = run(31);
    await db.insert(heartbeatRuns).values([saved, future]);
    expect((await select())?.id).toBe(saved.id);
    await writeProfile(future.id, { sessionCheckpoint: false });
    expect(await select()).toBeNull();
    await db.execute(sql`update ${heartbeatRuns} set created_at = '2026-09-08T00:00:30.000999Z'::timestamptz where ${heartbeatRuns.id} = ${future.id}`);
    expect((await select())?.id).toBe(future.id);
  });

  it("sees a newly committed barrier and changed source binding in its single selection snapshot", async () => {
    const saved = source();
    await db.insert(heartbeatRuns).values(saved);
    let reads = 0;
    const changing = new Proxy(db, { get(target, key) {
      if (key !== "with") return Reflect.get(target, key);
      return (...ctes: Parameters<Db["with"]>) => {
        const builder = target.with(...ctes), original = builder.select.bind(builder);
        builder.select = ((...fields: Parameters<typeof original>) => {
          const selection = original(...fields), from = selection.from.bind(selection);
          selection.from = ((...args: Parameters<typeof from>) => {
            const query = from(...args), execute = query.execute.bind(query);
            query.execute = async (...executeArgs: Parameters<typeof execute>) => {
              reads++;
              await db.insert(heartbeatRuns).values(run(1, { runnerProfileJson: { sessionCheckpoint: 0 } }));
              await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(and(eq(heartbeatRuns.id, saved.id), eq(heartbeatRuns.companyId, companyId)));
              return execute(...executeArgs);
            };
            return query;
          }) as typeof selection.from;
          return selection;
        }) as typeof builder.select;
        return builder;
      };
    }});
    const selected = await findNativeSessionResumeRun(changing, input);
    expect(reads).toBe(1);
    expect(selected?.id).not.toBe(saved.id);
    expect(selected?.runnerProfileJson.sessionCheckpoint).toBe(0);
  });
});
