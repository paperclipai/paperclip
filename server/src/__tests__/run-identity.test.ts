import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { acceptSteeredIdentity, captureRunIdentity, initializeRunIdentity, listRunIdentityContexts, rejectSteeredIdentity, reserveSteeredIdentity } from "../services/run-identity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable execution identity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity tests", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared agent", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Shared task", responsibleUserId: "owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const messageIds: string[] = [];
    for (const author of ["A", "B", "A"]) {
      const id = randomUUID();
      await db.insert(issueComments).values({ id, companyId, issueId, authorUserId: author, body: "Instruction" });
      messageIds.push(id);
    }
    return { companyId, agentId, issueId, runId, messageIds };
  }
  it("retains mixed-author delivery order without rewriting task ownership", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, responsibleUserId: "owner", cause: "queued" });
    const history = await listRunIdentityContexts(db, input.companyId, input.runId);
    expect(history.map((row) => row.responsibleUserId)).toEqual(["owner", "A", "B", "A"]);
    expect(history.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(issue.responsibleUserId).toBe("owner");
    await initializeRunIdentity(db, { ...input, responsibleUserId: "B", cause: "restart" });
    expect(await listRunIdentityContexts(db, input.companyId, input.runId)).toHaveLength(4);
  });
  async function seedInterrupt() {
    const input = await seed();
    const queueId = randomUUID(), wakeupRequestId = randomUUID();
    const contextSnapshot = { issueId: input.issueId, wakeCommentIds: input.messageIds };
    await db.insert(agentWakeupRequests).values([
      { id: queueId, companyId: input.companyId, agentId: input.agentId, source: "automation",
        status: "coalesced", runId: input.runId, requestedByActorType: "system",
        payload: { issueId: input.issueId, _paperclipWakeContext: { wakeCommentIds: input.messageIds },
          queuedCommentInterrupt: { actorId: "operator", requestedAt: new Date().toISOString() } } },
      { id: wakeupRequestId, companyId: input.companyId, agentId: input.agentId, source: "on_demand",
        status: "queued", runId: input.runId, requestedByActorType: "user", requestedByActorId: "operator",
        idempotencyKey: `queued-comment-interrupt:${queueId}` },
    ]);
    await db.update(heartbeatRuns).set({ wakeupRequestId, contextSnapshot }).where(eq(heartbeatRuns.id, input.runId));
    return { ...input, queueId, wakeupRequestId, contextSnapshot };
  }

  it("uses the clicking operator through startup and restart without changing message authors", async () => {
    const input = await seedInterrupt();
    // A stale originating context cannot replace the explicit click's identity.
    const identity = await initializeRunIdentity(db, {
      ...input, responsibleUserId: "A", parentContextId: randomUUID(), cause: "dispatch",
    });
    expect(identity).toMatchObject({ responsibleUserId: "operator", cause: "queued_comment_interrupt" });
    const history = await listRunIdentityContexts(db, input.companyId, input.runId);
    expect(history.map(row => row.responsibleUserId)).toEqual(["operator", "operator", "operator", "operator"]);
    expect(await initializeRunIdentity(db, { ...input, responsibleUserId: "B", cause: "restart" })).toEqual(identity);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId));
    expect(input.messageIds.map(id => comments.find(c => c.id === id)?.authorUserId)).toEqual(["A", "B", "A"]);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("operator");
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: input.companyId,
      agentId: input.agentId, contextSnapshot: input.contextSnapshot, status: "queued", retryOfRunId: input.runId });
    const retried = await initializeRunIdentity(db, { companyId: input.companyId, runId: retryRunId,
      issueId: input.issueId, parentRunId: input.runId, responsibleUserId: "A", cause: "retry" });
    expect(retried.responsibleUserId).toBe("operator");
  });

  it.each(["malformed", "missing", "unconsumed", "other-run", "other-task", "other-agent", "other-actor", "other-message"])(
    "rejects %s interrupt authority before creating any execution identity", async (fault) => {
      const input = await seedInterrupt();
      if (fault === "malformed" || fault === "missing") {
        await db.update(agentWakeupRequests).set({
          idempotencyKey: `queued-comment-interrupt:${fault === "malformed" ? "not-an-id" : randomUUID()}`,
        }).where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      } else if (fault === "other-actor") {
        await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" }).where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      } else {
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.queueId));
        if (fault === "other-agent") {
          const agentId = randomUUID();
          await db.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Other", role: "engineer" });
          await db.update(agentWakeupRequests).set({ agentId }).where(eq(agentWakeupRequests.id, input.queueId));
        } else await db.update(agentWakeupRequests).set(
          fault === "unconsumed" ? { status: "deferred_issue_execution" } :
          fault === "other-run" ? { runId: null } :
          { payload: { ...receipt.payload, ...(fault === "other-task" ? { issueId: randomUUID() } :
            { _paperclipWakeContext: { wakeCommentIds: [randomUUID()] } }) } },
        ).where(eq(agentWakeupRequests.id, input.queueId));
      }
      await expect(initializeRunIdentity(db, { ...input, responsibleUserId: "A", cause: "dispatch" })).rejects.toThrow("interrupt authority");
      expect(await listRunIdentityContexts(db, input.companyId, input.runId)).toHaveLength(0);
    },
  );

  it("holds acquisition during uncertain steering, preserves snapshots, and never rewinds on replay", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [input.messageIds[0]], responsibleUserId: "A", cause: "instruction" });
    const startedUnderA = await captureRunIdentity(db, input);
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    expect(b).not.toBeNull();
    await expect(captureRunIdentity(db, input)).rejects.toThrow(/reconciled/);
    await expect(reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] })).rejects.toThrow(/reconciled/);
    await db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
      await acceptSteeredIdentity(tx, b!);
    });
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("B");
    expect(startedUnderA.context?.responsibleUserId).toBe("A");
    const a = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] });
    await acceptSteeredIdentity(db, a!);
    await acceptSteeredIdentity(db, b!);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
  });
  it("keeps rejected steering unchanged and preserves the originating identity on retry", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await rejectSteeredIdentity(db, b!);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const retry = await initializeRunIdentity(db, { companyId: input.companyId, runId, parentRunId: input.runId, responsibleUserId: "B", cause: "retry" });
    expect(retry.responsibleUserId).toBe("A");
    expect(retry.parentContextId).toBe((await captureRunIdentity(db, input)).context?.id);
    await expect(captureRunIdentity(db, { ...input, companyId: randomUUID() })).rejects.toThrow();
    await expect(captureRunIdentity(db, { ...input, agentId: randomUUID() })).rejects.toThrow();
  });
  it("preserves an explicitly absent identity through a continuation initiated by another person", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, {
      ...input, messageIds: [], responsibleUserId: null, cause: "routine",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: input.companyId, agentId: input.agentId,
      status: "running", responsibleUserId: "B",
    });
    const continued = await initializeRunIdentity(db, {
      companyId: input.companyId, runId, parentContextId: origin.id,
      responsibleUserId: "B", cause: "retry",
    });
    expect(continued.responsibleUserId).toBeNull();
    const captured = await captureRunIdentity(db, { ...input, runId });
    expect(captured.run.responsibleUserId).toBeNull();
    expect(captured.context?.parentContextId).toBe(origin.id);
  });
  it("recovers an uncertain acknowledgement from the authenticated native event journal", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const pending = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await expect(captureRunIdentity(db, input)).rejects.toThrow(/reconciled/);
    await db.insert(heartbeatRunEvents).values({ companyId: input.companyId, runId: input.runId,
      agentId: input.agentId, seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: `turn-1:steer:${pending!.messageId}`, payload: {kind: "steering_acknowledgement"} } },
    });
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("B");
    await db.update(heartbeatRuns).set({status: "succeeded"}).where(eq(heartbeatRuns.id, input.runId));
    expect((await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] }))?.status).toBe("accepted");
  });
  it("preserves an operation's origin through approval and delegation after another person steers", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: input.companyId,
      issueId: input.issueId, kind: "request_confirmation", sourceRunId: input.runId,
      sourceIdentityContextId: origin.id, payload: { prompt: "Continue?" } as never,
    });
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await acceptSteeredIdentity(db, b!);
    for (const approval of [true, false]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
      const continued = await initializeRunIdentity(db, { companyId: input.companyId, runId, issueId: input.issueId,
        ...(approval ? { interactionId } : { parentContextId: origin.id }),
        responsibleUserId: "B", cause: approval ? "approval" : "delegation",
      });
      expect(continued.responsibleUserId).toBe("A");
      expect(continued.parentContextId).toBe(origin.id);
    }
  });
  it("retains continuation and approval attribution after deleting the originating agent and runs", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: input.companyId,
      issueId: input.issueId, kind: "request_confirmation", sourceRunId: input.runId,
      sourceIdentityContextId: origin.id, payload: { prompt: "Continue?" } as never,
    });
    await db.update(issues).set({ originIdentityContextId: origin.id }).where(eq(issues.id, input.issueId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
    await db.delete(agents).where(eq(agents.id, input.agentId));
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Replacement", role: "engineer", adapterType: "codex_local" });
    const [task] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(task.continuationIdentityContextId).toBe(origin.id);
    for (const source of [{ parentContextId: task.originIdentityContextId }, { parentContextId: task.continuationIdentityContextId }, { interactionId }]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId, status: "running" });
      const continued = await initializeRunIdentity(db, { companyId: input.companyId, runId,
        issueId: input.issueId, ...source, responsibleUserId: "B", cause: "continuation" });
      expect(continued.responsibleUserId).toBe("A");
      expect(continued.parentContextId).toBe(origin.id);
    }
  });

  it("does not deadlock identity initialization against a task mutation that also updates the run", async () => {
    const input = await seed();
    let initialization!: ReturnType<typeof initializeRunIdentity>;
    await db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for("update");
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
      initialization = initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
      // Wait until initialization is blocked by this task mutation, rather than
      // relying on timing to decide whether it has acquired its first lock.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where ${backend.pid} = any(pg_blocking_pids(pid))
        ) as waiting`) as unknown as Array<{ waiting: boolean }>;
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    });
    await expect(initialization).resolves.toMatchObject({ responsibleUserId: "A" });
  });

  it("does not turn a company-default fallback into personal consent on continuation", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "company_default" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const retry = await initializeRunIdentity(db, { companyId: input.companyId, runId, parentRunId: input.runId, responsibleUserId: "A", cause: "retry" });
    expect(retry.cause).toBe("company_default");
  });

});
