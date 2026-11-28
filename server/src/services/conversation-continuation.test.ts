import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { CONVERSATION_CONTINUATION_POLICY, conversationRecoveryActionPredicate, getConversationOwnershipBlocker, isConversationAdapter, runUsedConversationAdapter } from "./conversation-continuation.js";
import { deliverExecutionStatuses } from "./execution-status-delivery.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping execution identity regressions: ${support.reason}`);

describePostgres("execution identity query contracts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("execution-identity-"); db = createDb(database.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
    await db.insert(issues).values([{ id: issueId, companyId, title: "Target" }, { id: otherIssueId, companyId, title: "Other" }]);
    return { companyId, agentId, issueId, otherIssueId };
  }
  async function run(f: Awaited<ReturnType<typeof fixture>>, context: Record<string, unknown> | null, nativeIssueId: string | null = null, pid: number | null = null) {
    const [row] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId,
      status: "interrupted", runtimeMode: "legacy", contextSnapshot: context, processPid: pid,
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).returning();
    return row;
  }
  it("matches only canonical evidence IDs and keeps source issue and company scope", async () => {
    const f = await fixture(), foreign = await fixture();
    const ours = await run(f, { issueId: f.issueId });
    const elsewhere = await run(f, { issueId: f.otherIssueId });
    const foreignRun = await run(foreign, { issueId: f.issueId });
    const ids: unknown[] = [ours.id, ours.id.toUpperCase(), ours.id.replaceAll("-", ""), `{${ours.id}}`, "bad", "", null, 42, {}, [ours.id], elsewhere.id, foreignRun.id];
    const actions = await db.insert(issueRecoveryActions).values(ids.map((runId, index) => ({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `fixture-${index}`, evidence: { runId }, nextAction: "Fixture",
    }))).returning();
    const matches = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, f.companyId), conversationRecoveryActionPredicate()));
    expect(matches).toEqual([{ id: actions[0].id }]);
  });
  it("preserves native issue precedence and does not broaden legacy spellings", async () => {
    const f = await fixture();
    await run(f, { issueId: f.issueId }, f.otherIssueId, process.pid);
    const uppercase = await run(f, { issueId: f.issueId.toUpperCase() }, null, process.pid);
    const malformed = await run(f, { issueId: "bad" }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: native.id, cause: "execution_owner_active" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId.toUpperCase())).toMatchObject({ runId: uppercase.id });
    expect(await getConversationOwnershipBlocker(db, f.companyId, "bad")).toMatchObject({ runId: malformed.id });
  });
  it("retains legacy ownership holds and releases only after ownership ends", async () => {
    const f = await fixture();
    const legacy = await run(f, { issueId: f.issueId }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: legacy.id });
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, legacy.id));
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
  it("delivers canonical same-company task IDs and keeps malformed IDs private", async () => {
    const f = await fixture(), foreign = await fixture();
    const contexts: unknown[] = [f.issueId, f.issueId.toUpperCase(), "bad", `{${f.issueId}}`, f.issueId.replaceAll("-", ""), null, 42, {}, [f.issueId], foreign.issueId];
    const expected = new Map<string, string | null>();
    for (const [index, issueId] of contexts.entries()) {
      const row = await run(f, { issueId });
      await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, row.id));
      expected.set(row.id, index === 0 ? f.issueId : null);
    }
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId);
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, native.id));
    expected.set(native.id, f.issueId);
    const seen = new Map<string, string | null>();
    const result = await deliverExecutionStatuses(db, { publish: event => { seen.set(event.payload!.runId as string, event.payload!.issueId as string | null); return { ...event, id: 0, payload: event.payload ?? {}, createdAt: new Date().toISOString() }; } });
    expect(result.delivered).toBe(expected.size);
    expect(seen).toEqual(expected);
    expect(await deliverExecutionStatuses(db, { publish: () => { throw new Error("duplicate delivery"); } })).toEqual({ scanned: 0, delivered: 0 });
  });

  it("treats hermes_gateway as a conversation adapter and lets Retry and board comments clear timed-out or cancelled holds", async () => {
    expect(isConversationAdapter("hermes_gateway")).toBe(true);

    const f = await fixture();
    await db.update(agents).set({ adapterType: "hermes_gateway" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ status: "blocked", assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));

    const timedOutRunId = randomUUID();
    const finishedAt = new Date("2026-09-11T10:00:00Z");
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      status: "timed_out",
      errorCode: "hermes_gateway_timeout",
      runtimeMode: "legacy",
      processPid: null,
      processGroupId: null,
      finishedAt,
      contextSnapshot: { issueId: f.issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } },
      resultJson: { run_id: "hermes-remote-1", status: "cancelled" },
    });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId,
      sourceIssueId: f.issueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${timedOutRunId}`,
      evidence: { runId: timedOutRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Inspect the stopped run before continuing.",
    }).returning();

    // Hold is currently blocking until user Retry or board comment arrives.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: hold!.id });

    // (a) Board Retry clears the timed-out hermes_gateway hold (no local PID exists for gateway runs).
    const retryBlocked: string[] = [];
    const retryAdmitted = await admitExplicitNativeContinuation({
      db,
      companyId: f.companyId,
      issueId: f.issueId,
      agentId: f.agentId,
      actorType: "user",
      actorId: "board",
      reason: "retry_failed_run",
      commentId: null,
      failedRunId: timedOutRunId,
      successorRunId: randomUUID(),
      dryRun: true,
      onBlocked: reason => retryBlocked.push(reason),
    });
    expect(retryBlocked).toEqual([]);
    expect(retryAdmitted).toMatchObject({ previousRunId: timedOutRunId, failedRunId: timedOutRunId });

    // (b) Board comment also clears the timed-out hermes_gateway hold.
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: f.companyId,
      issueId: f.issueId,
      authorType: "user",
      authorUserId: "board",
      body: "Please continue with the remaining steps.",
      createdAt: new Date("2026-09-11T10:05:00Z"),
    });
    const commentBlocked: string[] = [];
    const commentAdmitted = await admitExplicitNativeContinuation({
      db,
      companyId: f.companyId,
      issueId: f.issueId,
      agentId: f.agentId,
      actorType: "user",
      actorId: "board",
      reason: "issue_commented",
      commentId,
      successorRunId: randomUUID(),
      onBlocked: reason => commentBlocked.push(reason),
    });
    expect(commentBlocked).toEqual([]);
    expect(commentAdmitted).toMatchObject({ previousRunId: timedOutRunId, commentId });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    // (c) New hermes_gateway runs with conversationContinuation policy are retired by conversationRecoveryActionPredicate.
    const policyRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: policyRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.otherIssueId,
      status: "timed_out",
      errorCode: "hermes_gateway_timeout",
      runtimeMode: "legacy",
      finishedAt,
      contextSnapshot: { issueId: f.otherIssueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } },
      resultJson: { status: "cancelled", conversationContinuation: CONVERSATION_CONTINUATION_POLICY },
    });
    const [policyHold] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId,
      sourceIssueId: f.otherIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${policyRunId}`,
      evidence: { runId: policyRunId },
      nextAction: "Fixture",
    }).returning();
    const matched = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, policyHold!.id), conversationRecoveryActionPredicate()));
    expect(matched).toEqual([{ id: policyHold!.id }]);

    // (d) A cancelled hermes_gateway run (e.g. issue_reassigned) also unblocks on a new board comment.
    const cancelledIssueId = randomUUID();
    const cancelledRunId = randomUUID();
    await db.insert(issues).values({ id: cancelledIssueId, companyId: f.companyId, title: "Cancelled Hermes", status: "blocked", assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({
      id: cancelledRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: cancelledIssueId,
      status: "cancelled",
      errorCode: "issue_reassigned",
      runtimeMode: "legacy",
      processPid: null,
      processGroupId: null,
      finishedAt,
      contextSnapshot: { issueId: cancelledIssueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } },
      resultJson: { run_id: "hermes-remote-2", status: "cancelled" },
    });
    await db.insert(issueRecoveryActions).values({
      companyId: f.companyId,
      sourceIssueId: cancelledIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${cancelledRunId}`,
      evidence: { runId: cancelledRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Inspect the stopped run before continuing.",
    });
    const followUpCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: followUpCommentId,
      companyId: f.companyId,
      issueId: cancelledIssueId,
      authorType: "user",
      authorUserId: "board",
      body: "Reassigned back to you, please continue.",
      createdAt: new Date("2026-09-11T10:10:00Z"),
    });
    const cancelledBlocked: string[] = [];
    const cancelledAdmitted = await admitExplicitNativeContinuation({
      db,
      companyId: f.companyId,
      issueId: cancelledIssueId,
      agentId: f.agentId,
      actorType: "user",
      actorId: "board",
      reason: "issue_commented",
      commentId: followUpCommentId,
      successorRunId: randomUUID(),
      onBlocked: reason => cancelledBlocked.push(reason),
    });
    expect(cancelledBlocked).toEqual([]);
    expect(cancelledAdmitted).toMatchObject({ previousRunId: cancelledRunId, commentId: followUpCommentId });
    expect(await getExecutionBlocker(db, f.companyId, cancelledIssueId)).toBeNull();

    // (e) A timed-out hermes_gateway run whose remote stop was never confirmed (status: "timeout") fails closed
    // across reconciliation classification, conversation hold retirement, execution blocking, and explicit Retry.
    const unconfirmedIssueId = randomUUID();
    const unconfirmedRunId = randomUUID();
    await db.insert(issues).values({ id: unconfirmedIssueId, companyId: f.companyId, title: "Unconfirmed Hermes timeout", status: "blocked", assigneeAgentId: f.agentId });
    const [unconfirmedRun] = await db.insert(heartbeatRuns).values({
      id: unconfirmedRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: unconfirmedIssueId,
      status: "timed_out",
      errorCode: "execution_reconciliation_required",
      runtimeMode: "legacy",
      processPid: null,
      processGroupId: null,
      finishedAt,
      contextSnapshot: { issueId: unconfirmedIssueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "hermes_gateway" } },
      resultJson: { run_id: "hermes-remote-3", status: "timeout" },
    }).returning();
    expect(legacyExecutionNeedsReconciliation(unconfirmedRun!)).toBe(true);
    expect(await runUsedConversationAdapter(db, unconfirmedRun!)).toBe(false);
    const [unconfirmedHold] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId,
      sourceIssueId: unconfirmedIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${unconfirmedRunId}`,
      evidence: { runId: unconfirmedRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      nextAction: "Inspect the stopped run before continuing.",
    }).returning();
    const unconfirmedRetired = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, unconfirmedHold!.id), conversationRecoveryActionPredicate()));
    expect(unconfirmedRetired).toEqual([]);
    const unconfirmedBlocked: string[] = [];
    const unconfirmedAdmitted = await admitExplicitNativeContinuation({
      db,
      companyId: f.companyId,
      issueId: unconfirmedIssueId,
      agentId: f.agentId,
      actorType: "user",
      actorId: "board",
      reason: "retry_failed_run",
      commentId: null,
      failedRunId: unconfirmedRunId,
      successorRunId: randomUUID(),
      dryRun: true,
      onBlocked: reason => unconfirmedBlocked.push(reason),
    });
    expect(unconfirmedAdmitted).toBeNull();
    expect(unconfirmedBlocked).toEqual(["process_identity_missing"]);
    expect(await getExecutionBlocker(db, f.companyId, unconfirmedIssueId)).toMatchObject({ recoveryActionId: unconfirmedHold!.id });
  });
});
