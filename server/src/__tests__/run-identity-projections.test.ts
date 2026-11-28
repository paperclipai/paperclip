import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureIdentityQueries, seedIdentityProjection, type IdentityQuery } from "./helpers/run-identity-projection-fixture.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { boundRunIssueId } from "../services/run-task-binding.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const scopes = ["identity", "task_authorization", "token_broker"] as const;
(support.supported ? describe : describe.skip)("operation identity read projections", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("identity-projection-");
      db = createDb(temporary.connectionString);
    }
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it.each(scopes)("bounds %s SQL results and preserves the stored execution", async readScope => {
    const f = await seedIdentityProjection(db), queries: IdentityQuery[] = [];
    const full = await captureRunIdentity(db, f);
    const narrow = await captureRunIdentity(captureIdentityQueries(db, queries), f, { readScope });
    expect(narrow.context).toEqual(full.context);
    expect(narrow.run).toMatchObject({ id: f.runId, companyId: f.companyId, agentId: f.agentId,
      status: "running", responsibleUserId: "operator", activeIdentityContextId: full.run.activeIdentityContextId });
    expect(narrow.run).not.toHaveProperty("runnerProfileJson");
    expect(narrow.run).not.toHaveProperty("resultJson");
    const query = queries.find(query => query.sql.includes('from "heartbeat_runs"') && query.sql.includes("for no key update"))!;
    const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reduce((bytes, value) => bytes + (value?.byteLength ?? 0), 0)).toBeLessThan(2_048);
    expect((await captureRunIdentity(db, f)).run).toEqual(full.run);
  });

  it("preserves task binding types and legacy non-object contexts", async () => {
    const f = await seedIdentityProjection(db);
    for (const snapshot of [null, false, 42, "text", [], ["value"], {}, ...[null, false, 42, " 3 ", [], {}, { nested: true }]
      .map(value => ({ issueId: f.issueId, conversationSessionGeneration: value, paperclipSkillTest: value }))]) {
      await db.$client.unsafe("UPDATE heartbeat_runs SET context_snapshot = $1::jsonb WHERE id = $2", [JSON.stringify(snapshot), f.runId]);
      const full = await captureRunIdentity(db, f), narrow = await captureRunIdentity(db, f, { readScope: "task_authorization" });
      expect(boundRunIssueId(narrow.run)).toBe(boundRunIssueId(full.run));
      expect(Number(narrow.run.contextSnapshot?.conversationSessionGeneration ?? 0)).toBe(Number(full.run.contextSnapshot?.conversationSessionGeneration ?? 0));
      expect(Boolean(narrow.run.contextSnapshot?.paperclipSkillTest)).toBe(Boolean(full.run.contextSnapshot?.paperclipSkillTest));
    }
    for (const issueId of [true, 123, [], {}, "malformed"]) {
      await db.$client.unsafe("UPDATE heartbeat_runs SET context_snapshot = $1::jsonb WHERE id = $2", [JSON.stringify({ issueId }), f.runId]);
      await expect(captureRunIdentity(db, f)).rejects.toThrow("task identity is invalid");
      await expect(captureRunIdentity(db, f, { readScope: "task_authorization" })).rejects.toThrow("task identity is invalid");
    }
  });

  it("retains broker fields and nested attribution without document payloads", async () => {
    const f = await seedIdentityProjection(db);
    for (const value of [null, true, 42, " padded ", [], {}, { retained: true }]) {
      const snapshot = { issueId: f.issueId, projectId: value, routineId: value, responsibleUserId: value,
        responsible_user_id: value, paperclipIssue: { id: value, projectId: value, responsibleUserId: value,
          responsible_user_id: value, savedDocument: f.payloads.contextSnapshot.savedInput } };
      await db.update(heartbeatRuns).set({ contextSnapshot: snapshot }).where(eq(heartbeatRuns.id, f.runId));
      const narrow = await captureRunIdentity(db, f, { readScope: "token_broker" });
      expect(narrow.run.invocationSource).toBe("automation");
      expect(narrow.run.contextSnapshot).toEqual({ ...snapshot, paperclipIssue: { id: value,
        projectId: value, responsibleUserId: value, responsible_user_id: value } });
    }
    for (const paperclipIssue of [null, true, 42, "legacy", []]) {
      await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipIssue } }).where(eq(heartbeatRuns.id, f.runId));
      expect((await captureRunIdentity(db, f, { readScope: "token_broker" })).run.contextSnapshot?.paperclipIssue).toBeNull();
    }
  });

  it.each(scopes.flatMap(readScope => (["company", "agent", "run", "finished"] as const).map(fault => ({ readScope, fault }))))(
    "denies $fault mismatches for $readScope", async ({ readScope, fault }) => {
      const f = await seedIdentityProjection(db);
      if (fault === "finished") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      await expect(captureRunIdentity(db, { ...f, ...(fault === "company" ? { companyId: randomUUID() } :
        fault === "agent" ? { agentId: randomUUID() } : fault === "run" ? { runId: randomUUID() } : {}) }, { readScope })).rejects.toThrow("active run");
    },
  );

  it("preserves every saved native input shape without unrelated profile fields", async () => {
    const f = await seedIdentityProjection(db);
    for (const nativeExecutionInput of [null, true, 42, "legacy", [], {}, { opaque: { retained: true } }]) {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput, unrelated: "drop" } }).where(eq(heartbeatRuns.id, f.runId));
      expect((await captureRunIdentity(db, f, { readScope: "project_execution" })).run.runnerProfileJson).toEqual({ nativeExecutionInput });
    }
    await db.update(heartbeatRuns).set({ runnerProfileJson: { unrelated: "drop" } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await captureRunIdentity(db, f, { readScope: "project_execution" })).run.runnerProfileJson).toEqual({});
    for (const profile of [null, true, 42, "legacy", []]) {
      await db.$client.unsafe("UPDATE heartbeat_runs SET runner_profile_json = $1::jsonb WHERE id = $2", [JSON.stringify(profile), f.runId]);
      expect((await captureRunIdentity(db, f, { readScope: "project_execution" })).run.runnerProfileJson).toBeNull();
    }
  });

  it("keeps the complete execution input for the project admission consumer", async () => {
    const f = await seedIdentityProjection(db);
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId: f.companyId, agentId: f.agentId, runId: f.runId };
    const narrow = await projectToolContext(db, actor);
    expect(narrow.run).not.toHaveProperty("runnerProfileJson");
    const full = await projectToolContext(db, actor, true, "Project", { includeExecutionInput: true });
    expect(full.run.runnerProfileJson).toEqual({ nativeExecutionInput: f.payloads.runnerProfileJson.nativeExecutionInput });
    expect(full.run.contextSnapshot).toEqual(narrow.run.contextSnapshot);
    expect(full.run).not.toHaveProperty("resultJson");
    expect(full.run.contextSnapshot).not.toHaveProperty("savedInput");
    await db.update(issues).set({ conversationSessionGeneration: 4 }).where(eq(issues.id, f.issueId));
    await expect(projectToolContext(db, actor)).rejects.toThrow("session has changed");
    await expect(projectToolContext(db, actor, true, "Project", { includeExecutionInput: true })).rejects.toThrow("session has changed");
  });
});
