import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, applyPendingMigrations, createDb, closeRegisteredClients, heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues, runIdentityContexts, secretAccessEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { acceptSteeredIdentity, reconcileSteeredIdentity, captureRunIdentity, initializeRunIdentity, listRunIdentityContexts, rejectSteeredIdentity, reserveSteeredIdentity } from "../services/run-identity.js";

const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable execution identity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) { await applyPendingMigrations(externalDatabaseUrl); db = createDb(externalDatabaseUrl); }
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-");
      db = createDb(database.connectionString);
    }
  }, 30_000);
  afterAll(async () => { if (externalDatabaseUrl) await closeRegisteredClients(externalDatabaseUrl); await database?.cleanup(); }, 60_000);

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
  it.each(["github_credentials", "request_authentication"] as const)("retains typed trust bindings for %s and keeps other identity reads complete", async (readScope) => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, responsibleUserId: "owner", cause: "queued" });
    for (const value of [null, true, 42, " padded ", [], {}, { future: { opaque: true } }]) {
      const contextSnapshot = { issueId: input.issueId, projectId: value, executionPolicy: value, savedInput: { retained: true } };
      const runnerProfileJson = { nativeExecutionInput: { opaque: value }, savedInput: "retained" };
      await db.update(heartbeatRuns).set({ contextSnapshot, runnerProfileJson }).where(eq(heartbeatRuns.id, input.runId));
      const narrow = await captureRunIdentity(db, input, { readScope });
      expect(narrow.run.contextSnapshot).toEqual({ issueId: input.issueId, taskId: null, projectId: value, executionPolicy: value });
      expect(narrow.run.runnerProfileJson).toBeNull();
      const full = await captureRunIdentity(db, input);
      expect(full.run.contextSnapshot).toEqual(contextSnapshot);
      expect(full.run.runnerProfileJson).toEqual(runnerProfileJson);
      expect(narrow.context).toEqual(full.context);
    }
  });

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

  it.each([undefined, "github_credentials", "request_authentication", "identity", "task_authorization", "token_broker", "project_execution"] as const)("holds acquisition during uncertain steering and never rewinds on replay with %s", async (readScope) => {
    const options = readScope ? { readScope } : undefined;
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [input.messageIds[0]], responsibleUserId: "A", cause: "instruction" });
    const startedUnderA = await captureRunIdentity(db, input, options);
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    expect(b).not.toBeNull();
    await expect(captureRunIdentity(db, input, options)).rejects.toThrow(/reconciled/);
    await expect(reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] })).rejects.toThrow(/reconciled/);
    await db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
      await acceptSteeredIdentity(tx, b!);
    });
    expect((await captureRunIdentity(db, input, options)).context?.responsibleUserId).toBe("B");
    expect(startedUnderA.context?.responsibleUserId).toBe("A");
    const a = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] });
    await reconcileSteeredIdentity(db, a!);
    await reconcileSteeredIdentity(db, b!);
    expect((await captureRunIdentity(db, input, options)).context?.responsibleUserId).toBe("A");
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
  it.each([undefined, "github_credentials", "request_authentication", "identity", "task_authorization", "token_broker", "project_execution"] as const)("recovers an uncertain native acknowledgement with %s", async (readScope) => {
    const options = readScope ? { readScope } : undefined;
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const pending = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await expect(captureRunIdentity(db, input, options)).rejects.toThrow(/reconciled/);
    await db.insert(heartbeatRunEvents).values({ companyId: input.companyId, runId: input.runId,
      agentId: input.agentId, seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: `turn-1:steer:${pending!.messageId}`, payload: {kind: "steering_acknowledgement"} } },
    });
    expect((await captureRunIdentity(db, input, options)).context?.responsibleUserId).toBe("B");
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
    await reconcileSteeredIdentity(db, b!);
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

  it.each(["durable", "snapshot"])("continues a connected handoff and retains the latest identity on a %s retry", async (retryKind) => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, {
      ...input, messageIds: [], responsibleUserId: "A", cause: "company_default",
    });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: input.companyId, issueId: input.issueId,
      kind: "connection_intent", status: "accepted", sourceRunId: input.runId,
      sourceIdentityContextId: origin.id, addresseeUserId: "B", resolvedByUserId: "B",
      payload: { version: 1, serviceSlug: "openai", serviceName: "OpenAI", purpose: "ai", requestingAgentId: input.agentId, requestingAgentName: "Shared agent", phase: "requested" },
      result: { version: 1, outcome: "connected", connectionId: randomUUID() }, resolvedAt: new Date(),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: input.companyId, agentId: input.agentId,
      status: "running", contextSnapshot: { issueId: input.issueId, interactionId },
    });
    const continued = await initializeRunIdentity(db, {
      ...input, runId, interactionId, messageIds: [], responsibleUserId: "A", cause: "issue_commented",
    });
    expect(continued).toMatchObject({
      responsibleUserId: "B", parentContextId: origin.id, cause: "connection_handoff",
    });
    expect((await captureRunIdentity(db, { ...input, runId })).run.responsibleUserId).toBe("B");
    const [task] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(task).toMatchObject({ responsibleUserId: "owner", continuationIdentityContextId: continued.id });
    const [request] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(request.sourceIdentityContextId).toBe(origin.id);
    expect((await listRunIdentityContexts(db, input.companyId, input.runId))[0].responsibleUserId).toBe("A");
    const retryRunId = randomUUID();
    const retryFields = retryKind === "durable" ? { retryOfRunId: runId }
      : { contextSnapshot: { issueId: input.issueId, interactionId, retryOfRunId: runId } };
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: input.companyId, agentId: input.agentId, status: "running", ...retryFields });
    expect(await initializeRunIdentity(db, {
      ...input, runId: retryRunId, interactionId, messageIds: [], parentRunId: runId, responsibleUserId: "A", cause: "retry",
    })).toMatchObject({ responsibleUserId: "B", parentContextId: continued.id });
    const later = await reserveSteeredIdentity(db, { ...input, runId, messageId: input.messageIds[0] });
    await db.transaction(tx => acceptSteeredIdentity(tx, later!));
    const steeredRetryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: steeredRetryRunId, companyId: input.companyId, agentId: input.agentId, status: "running", ...retryFields });
    expect(await initializeRunIdentity(db, {
      ...input, runId: steeredRetryRunId, interactionId, messageIds: [], parentRunId: runId, responsibleUserId: "B", cause: "retry",
    })).toMatchObject({ responsibleUserId: "A", parentContextId: later!.id });
  });

  it.each(["durable", "snapshot"].flatMap(retryKind => ["A", null].map(person => ({ retryKind, person }))))(
    "preserves an approval's saved identity $person after pre-initialization failure ($retryKind)", async ({ retryKind, person }) => {
      const input = await seed();
      const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: person, cause: "instruction" });
      const interactionId = randomUUID(), failedRunId = randomUUID(), runId = randomUUID();
      await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: input.companyId, issueId: input.issueId,
        kind: "request_confirmation", status: "accepted", sourceIdentityContextId: origin.id,
        addresseeUserId: "B", resolvedByUserId: "B", payload: { prompt: "Continue?" } as never,
      });
      // Admission selected the task owner B, but preparation failed before the
      // approval's originating identity could be restored on that run.
      await db.insert(heartbeatRuns).values({ id: failedRunId, companyId: input.companyId, agentId: input.agentId,
        status: "failed", responsibleUserId: "B", contextSnapshot: { issueId: input.issueId, interactionId } });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running",
        ...(retryKind === "durable" ? { retryOfRunId: failedRunId } : {}),
        contextSnapshot: { issueId: input.issueId, interactionId, retryOfRunId: failedRunId },
      });
      expect(await initializeRunIdentity(db, { ...input, runId, interactionId, messageIds: [],
        responsibleUserId: "B", cause: "retry" })).toMatchObject({ responsibleUserId: person, parentContextId: origin.id });
    },
  );

  it.each(["durable", "snapshot"])("retries a pre-initialization failure as the stored source person (%s)", async (retryKind) => {
    const input = await seed();
    await db.update(heartbeatRuns).set({ status: "failed", responsibleUserId: "A" }).where(eq(heartbeatRuns.id, input.runId));
    // The task's continuation and the caller's fallback can name another person.
    // Neither replaces the persisted person on this uninitialized source run.
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: input.agentId, status: "succeeded" }).returning();
    const other = await initializeRunIdentity(db, { companyId: input.companyId, runId: otherRun.id, responsibleUserId: "B", cause: "instruction" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running",
      ...(retryKind === "durable" ? { retryOfRunId: input.runId } : {}),
      contextSnapshot: { issueId: input.issueId, retryOfRunId: input.runId },
    });
    expect(await initializeRunIdentity(db, { ...input, runId, messageIds: [], parentContextId: other.id,
      responsibleUserId: "B", cause: "retry" })).toMatchObject({ responsibleUserId: "A", parentContextId: null });
  });

  it.each(["durable", "snapshot"].flatMap(retryKind =>
    ["missing-context", "pending-context", "missing-parent"].map(fault => ({ retryKind, fault })),
  ))("refuses a $retryKind retry with $fault instead of replaying a connection handoff", async ({ retryKind, fault }) => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID(), previousRunId = randomUUID(), runId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: input.companyId, issueId: input.issueId,
      kind: "connection_intent", status: "accepted", addresseeUserId: "B", resolvedByUserId: "B",
      sourceIdentityContextId: origin.id, payload: {} as never,
      result: { version: 1, outcome: "connected", connectionId: randomUUID() },
    });
    if (fault !== "missing-parent") {
      await db.insert(heartbeatRuns).values({ id: previousRunId, companyId: input.companyId, agentId: input.agentId, status: "failed" });
      if (fault === "pending-context") {
        const [pending] = await db.insert(runIdentityContexts).values({
          companyId: input.companyId, runId: previousRunId, revision: 1, responsibleUserId: "C",
          cause: "instruction", correlationId: "dispatch", status: "pending",
        }).returning();
        await db.update(heartbeatRuns).set({ activeIdentityContextId: pending.id }).where(eq(heartbeatRuns.id, previousRunId));
      }
    }
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: input.companyId, agentId: input.agentId, status: "running",
      // The durable FK is cleared if the previous run was deleted; the saved
      // snapshot must still identify this as a retry rather than a new handoff.
      ...(retryKind === "durable" && fault !== "missing-parent" ? { retryOfRunId: previousRunId } : {}),
      contextSnapshot: { issueId: input.issueId, interactionId, retryOfRunId: previousRunId },
    });
    await expect(initializeRunIdentity(db, {
      ...input, runId, interactionId, messageIds: [], parentRunId: previousRunId, responsibleUserId: "B", cause: "retry",
    })).rejects.toThrow(/execution identity is unavailable/);
    expect(await listRunIdentityContexts(db, input.companyId, runId)).toEqual([]);
  });

  it.each(["", "  ", true])("ignores an invalid legacy retry marker %j on a new accepted handoff", async (retryOfRunId) => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID(), runId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId: input.companyId, issueId: input.issueId,
      kind: "connection_intent", status: "accepted", addresseeUserId: "B", resolvedByUserId: "B",
      sourceIdentityContextId: origin.id, payload: {} as never,
      result: { version: 1, outcome: "connected", connectionId: randomUUID() },
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId,
      status: "running", contextSnapshot: { issueId: input.issueId, interactionId, retryOfRunId } });
    expect(await initializeRunIdentity(db, { ...input, runId, interactionId, parentRunId: input.runId,
      messageIds: [], responsibleUserId: "A", cause: "continuation" })).toMatchObject({
      responsibleUserId: "B", parentContextId: origin.id, cause: "connection_handoff",
    });
  });

  it.each(["approval", "pending", "other-resolver", "unaddressed", "declined", "satisfied", "administrative-expiry", "agent-resolved", "unconnected", "missing-connection"])("retains source identity for a %s request without an accepted connection handoff", async (fault) => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID(), runId = randomUUID();
    const interaction: typeof issueThreadInteractions.$inferInsert = {
      id: interactionId, companyId: input.companyId, issueId: input.issueId,
      kind: "connection_intent", status: "accepted", addresseeUserId: "B", resolvedByUserId: "B",
      sourceIdentityContextId: origin.id, payload: {} as never,
      result: { version: 1, outcome: "connected", connectionId: randomUUID() },
    };
    if (fault === "approval") { interaction.kind = "request_confirmation"; interaction.result = { version: 1, outcome: "accepted" }; }
    if (fault === "pending") { interaction.status = "pending"; interaction.resolvedByUserId = null; interaction.result = null; }
    if (fault === "other-resolver") interaction.resolvedByUserId = "C";
    if (fault === "unaddressed") interaction.addresseeUserId = null;
    if (fault === "declined") { interaction.status = "rejected"; interaction.result = { version: 1, outcome: "declined" }; }
    if (fault === "satisfied" || fault === "administrative-expiry") {
      interaction.status = "expired"; interaction.resolvedByUserId = null;
      interaction.result = { version: 1, outcome: "expired", ...(fault === "satisfied" ? { connectionId: randomUUID() } : { reason: "Request withdrawn" }) };
    }
    if (fault === "agent-resolved") interaction.resolvedByAgentId = input.agentId;
    if (fault === "unconnected") interaction.result = { version: 1, outcome: "declined" };
    if (fault === "missing-connection") interaction.result = { version: 1, outcome: "connected", connectionId: null };
    await db.insert(issueThreadInteractions).values(interaction);
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    expect(await initializeRunIdentity(db, {
      ...input, runId, interactionId, messageIds: [], responsibleUserId: "B", cause: "continuation",
    })).toMatchObject({ responsibleUserId: "A", parentContextId: origin.id });
  });

  it.each(["update", "no key update"] as const)("serializes identity initialization behind a task's %s lock", async (lockMode) => {
    const input = await seed();
    let initialization!: ReturnType<typeof initializeRunIdentity>;
    await db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for(lockMode);
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

  it.each((["initialize", "capture"] as const).flatMap(operation => [false, true].map(withQuery => ({ operation, withQuery }))))(
    "can $operation identity while an audit append holds foreign-key locks (query: $withQuery)",
    async ({ operation, withQuery }) => {
      const input = await seed();
      if (operation === "capture") {
        await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
      }
      // A real append holds KEY SHARE on both parent rows until it commits.
      // Bound the other connection's wait so a conflicting lock fails this
      // regression instead of leaving both transactions waiting for each other.
      const identityUrl = new URL(externalDatabaseUrl ?? database.connectionString);
      if (withQuery) {
        identityUrl.searchParams.set("application_name", "identity-query-test");
        identityUrl.searchParams.set("options", [identityUrl.searchParams.get("options"), "-c statement_timeout=5000"].filter(Boolean).join(" "));
      }
      identityUrl.searchParams.set("options", [identityUrl.searchParams.get("options"), "-c lock_timeout=1000"].filter(Boolean).join(" "));
      const identityDb = createDb(identityUrl.toString(), {
        maxConnections: 1,
      });
      const [settings] = await identityDb.execute(sql`show lock_timeout`);
      expect(settings?.lock_timeout).toBe("1s");
      if (withQuery) {
        expect(identityUrl.searchParams.get("application_name")).toBe("identity-query-test");
        const [timeouts] = await identityDb.execute(sql`show statement_timeout`);
        expect(timeouts?.statement_timeout).toBe("5s");
      }
      await db.transaction(async (audit) => {
        await audit.insert(secretAccessEvents).values({
          companyId: input.companyId,
          heartbeatRunId: input.runId,
          issueId: input.issueId,
          provider: "local_encrypted",
          actorType: "agent",
          actorId: input.agentId,
          consumerType: "agent",
          consumerId: input.agentId,
          outcome: "granted",
        });
        if (operation === "initialize") {
          await expect(initializeRunIdentity(identityDb, {
            ...input, messageIds: [], responsibleUserId: "A", cause: "instruction",
          })).resolves.toMatchObject({ responsibleUserId: "A" });
        } else {
          await expect(captureRunIdentity(identityDb, input)).resolves.toMatchObject({
            run: { responsibleUserId: "A" },
            context: { responsibleUserId: "A" },
          });
        }
      });
    },
  );

  it("does not turn a company-default fallback into personal consent on continuation", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "company_default" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const retry = await initializeRunIdentity(db, { companyId: input.companyId, runId, parentRunId: input.runId, responsibleUserId: "A", cause: "retry" });
    expect(retry.cause).toBe("company_default");
  });

});
