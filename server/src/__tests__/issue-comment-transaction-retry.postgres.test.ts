import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { postgresErrorCode } from "../services/transient-lock-contention.js";
import { startRecoveryPostgres } from "./helpers/recovery-postgres-fixture.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl(
  "comment transaction retry", process.env.PAPERCLIP_COMMENT_RETRY_TEST_DATABASE_URL,
);
if (process.env.PAPERCLIP_EXPECT_PG === "1" && !external) {
  throw new Error("Explicit comment retry database URL is required");
}

describe("run-authored comment transaction retry", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startRecoveryPostgres("comment-retry-", external ? { dedicatedDatabaseUrl: external } : {});
    db = createDb(database.connectionString, { maxConnections: 2 });
  }, 30_000);
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await db?.$client.end({ timeout: 5 }); } catch (error) { failures.push(error); }
    try { await database?.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Comment retry fixture cleanup failed");
  }, 30_000);

  it("retries a server-aborted run-authored reply only after rollback and preserves both replies", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const sequence = `comment_retry_sequence_${suffix}`;
    const marker = `comment_retry_marker_${suffix}`;
    const fn = `comment_retry_abort_${suffix}`;
    const trigger = `comment_retry_trigger_${suffix}`;
    let primary: unknown;
    const cleanup: unknown[] = [];
    try {
      await db.insert(companies).values({ id: companyId, name: "Comment retry", issuePrefix: `CRT${suffix.slice(0, 8)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Process reply", adapterType: "process" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Concurrent first replies", status: "in_progress",
        assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "local-board",
        conversationState: "active", conversationSessionGeneration: 0 });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running",
        runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 0 } });
      await db.$client.unsafe(`CREATE SEQUENCE "${sequence}"`);
      await db.$client.unsafe(`CREATE TABLE "${marker}" (attempt bigint NOT NULL)`);
      // This controlled server abort proves transaction recovery, not the unknown CI lock cycle.
      // Sequence increments survive rollback; marker/comment writes must not.
      await db.$client.unsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE attempt bigint;
        BEGIN
          IF NEW.issue_id = '${issueId}'::uuid THEN
            attempt := nextval('"${sequence}"');
            INSERT INTO "${marker}" VALUES (attempt);
            IF attempt = 1 THEN
              RAISE EXCEPTION 'controlled comment transaction abort' USING ERRCODE = '40P01';
            END IF;
          END IF;
          RETURN NEW;
        END $$`);
      await db.$client.unsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON issue_comments
        FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
      const svc = issueService(db);
      const actor = { agentId, runId };
      const first = await svc.addComment(issueId, "First authorized reply", actor, { authorizationReason: "allow_self" });
      expect(first.createdByRunId).toBe(runId);
      expect(await db.$client.unsafe(`SELECT attempt::int FROM "${marker}" ORDER BY attempt`)).toEqual([{ attempt: 2 }]);
      expect((await db.$client.unsafe(`SELECT last_value::int FROM "${sequence}"`))[0].last_value).toBe(2);
      const second = await svc.addComment(issueId, "Second authorized reply", actor, { authorizationReason: "allow_self" });
      expect(second.id).not.toBe(first.id);
      // Keep the two-reply business requirement; do not accept eventual single-reply recovery.
      const replies = await db.select().from(issueComments).where(and(
        eq(issueComments.issueId, issueId), eq(issueComments.authorAgentId, agentId),
      ));
      expect(replies).toHaveLength(2);
      expect(replies.map(reply => reply.body).sort()).toEqual(["First authorized reply", "Second authorized reply"]);
      expect(await db.$client.unsafe(`SELECT attempt::int FROM "${marker}" ORDER BY attempt`)).toEqual([{ attempt: 2 }, { attempt: 3 }]);
    } catch (error) { primary = error; }
    finally {
      for (const statement of [
        `DROP TRIGGER IF EXISTS "${trigger}" ON issue_comments`,
        `DROP FUNCTION IF EXISTS "${fn}"()`,
        `DROP TABLE IF EXISTS "${marker}"`,
        `DROP SEQUENCE IF EXISTS "${sequence}"`,
      ]) {
        try { await db.$client.unsafe(statement); } catch (error) { cleanup.push(error); }
      }
    }
    if (primary && cleanup.length) throw new AggregateError([primary, ...cleanup], "Comment retry assertion and cleanup failed");
    if (primary) throw primary;
    if (cleanup.length) throw new AggregateError(cleanup, "Comment retry cleanup failed");
  }, 30_000);

  // These are actual service/transaction boundaries, not a simulated competing CI lock owner.
  async function withRepeatedServerAbort(
    body: (fixture: { issueId: string; agentId: string; runId: string; sequence: string;
      marker: string; errors: unknown[]; armGenerationChange: () => void }) => Promise<void>,
  ) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const sequence = `comment_boundary_seq_${suffix}`, marker = `comment_boundary_rows_${suffix}`;
    const fn = `comment_boundary_abort_${suffix}`, trigger = `comment_boundary_trigger_${suffix}`;
    const control = createDb(database.connectionString, { maxConnections: 1 });
    const transaction = db.transaction.bind(db);
    const errors: unknown[] = [];
    let changeGeneration = false, primary: unknown;
    const cleanup: unknown[] = [];
    let restore: (() => void) | undefined;
    try {
      await db.insert(companies).values({ id: companyId, name: "Comment retry boundary", issuePrefix: `CB${suffix.slice(0, 8)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Boundary process", adapterType: "process" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Reply authority", status: "in_progress",
        assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "local-board",
        conversationState: "active", conversationSessionGeneration: 0 });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running",
        runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 0 } });
      await db.$client.unsafe(`CREATE SEQUENCE "${sequence}"`);
      await db.$client.unsafe(`CREATE TABLE "${marker}" (attempt bigint NOT NULL)`);
      await db.$client.unsafe(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE attempt bigint;
        BEGIN
          IF NEW.issue_id = '${issueId}'::uuid THEN
            attempt := nextval('"${sequence}"');
            INSERT INTO "${marker}" VALUES (attempt);
            RAISE EXCEPTION 'controlled comment abort attempt %', attempt USING ERRCODE = '40P01';
          END IF;
          RETURN NEW;
        END $$`);
      await db.$client.unsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON issue_comments
        FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
      // Call through to the genuine transaction. Capture only AFTER PostgreSQL rollback.
      // The optional independent SQL write is a controlled inter-attempt authority change.
      const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, ...options) => {
        try { return await transaction(callback, ...options); }
        catch (error) {
          errors.push(error);
          if (changeGeneration && postgresErrorCode(error) === "40P01") {
            changeGeneration = false;
            await control.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, issueId));
          }
          throw error;
        }
      });
      restore = () => spy.mockRestore();
      await body({ issueId, agentId, runId, sequence, marker, errors,
        armGenerationChange: () => { changeGeneration = true; } });
    } catch (error) { primary = error; }
    finally {
      try { restore?.(); } catch (error) { cleanup.push(error); }
      for (const statement of [
        `DROP TRIGGER IF EXISTS "${trigger}" ON issue_comments`, `DROP FUNCTION IF EXISTS "${fn}"()`,
        `DROP TABLE IF EXISTS "${marker}"`, `DROP SEQUENCE IF EXISTS "${sequence}"`,
      ]) { try { await db.$client.unsafe(statement); } catch (error) { cleanup.push(error); } }
      try { await control.$client.end({ timeout: 5 }); } catch (error) { cleanup.push(error); }
    }
    if (primary && cleanup.length) throw new AggregateError([primary, ...cleanup], "Comment boundary assertion and cleanup failed");
    if (primary) throw primary;
    if (cleanup.length) throw new AggregateError(cleanup, "Comment boundary cleanup failed");
  }

  it("propagates the exact final server error after five rolled-back run-comment attempts", async () => {
    await withRepeatedServerAbort(async f => {
      const error = await issueService(db).addComment(f.issueId, "Never committed", { agentId: f.agentId, runId: f.runId },
        { authorizationReason: "allow_self" }).then(() => undefined, error => error);
      expect(f.errors).toHaveLength(5);
      expect(error).toBe(f.errors[4]);
      expect(f.errors.map(postgresErrorCode)).toEqual(Array(5).fill("40P01"));
      expect((await db.$client.unsafe(`SELECT last_value::int FROM "${f.sequence}"`))[0].last_value).toBe(5);
      expect(await db.$client.unsafe(`SELECT * FROM "${f.marker}"`)).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    });
  }, 30_000);

  it("leaves a caller-owned comment transaction to propagate its original server error without retry", async () => {
    await withRepeatedServerAbort(async f => {
      const error = await db.transaction(tx => issueService(db).addComment(f.issueId, "Caller transaction", {
        agentId: f.agentId, runId: f.runId,
      }, { authorizationReason: "allow_self" }, tx)).then(() => undefined, error => error);
      expect(f.errors).toHaveLength(1);
      expect(error).toBe(f.errors[0]);
      expect(postgresErrorCode(error)).toBe("40P01");
      expect((await db.$client.unsafe(`SELECT last_value::int FROM "${f.sequence}"`))[0].last_value).toBe(1);
      expect(await db.$client.unsafe(`SELECT * FROM "${f.marker}"`)).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    });
  }, 30_000);

  it("revalidates the current conversation generation before retrying an aborted reply", async () => {
    await withRepeatedServerAbort(async f => {
      f.armGenerationChange();
      const error = await issueService(db).addComment(f.issueId, "Old conversation reply", { agentId: f.agentId, runId: f.runId },
        { authorizationReason: "allow_self" }).then(() => undefined, error => error);
      expect(f.errors).toHaveLength(2);
      expect(postgresErrorCode(f.errors[0])).toBe("40P01");
      expect(error).toBe(f.errors[1]);
      expect(error).toMatchObject({ status: 409 });
      expect(String(error)).toContain("earlier session");
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].conversationSessionGeneration).toBe(1);
      expect((await db.$client.unsafe(`SELECT last_value::int FROM "${f.sequence}"`))[0].last_value).toBe(1);
      expect(await db.$client.unsafe(`SELECT * FROM "${f.marker}"`)).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    });
  }, 30_000);
});
