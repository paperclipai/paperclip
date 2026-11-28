import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisions,
  decisionTriage,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { attentionRoutes } from "../routes/attention.js";
import { attentionService } from "../services/attention.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { decisionHistoryService } from "../services/decision-history.js";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";
import { agentService } from "../services/agents.js";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../services/routable-blocked.js";

import {
  createAttentionServiceHarness,
  describeAttentionEmbeddedPostgres,
} from "./helpers/attention-service-harness.js";

describeAttentionEmbeddedPostgres("attention service: failed runs and confirmations", () => {
  const h = createAttentionServiceHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });
  const { seedCompany, insertIssue, pendingUserExecutionState, pendingAgentExecutionState } = h;

  it("orders exhausted runs and reads receipts through the partial index", async () => {
    const { companyId, workerId } = await seedCompany("IDX");
    const [olderId, tiedLowId, tiedHighId] = Array.from({ length: 3 }, () => randomUUID());
    const older = new Date("2026-07-09T11:00:00.000Z");
    const tied = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values([
      { id: olderId, companyId, agentId: workerId, status: "failed", createdAt: older, updatedAt: older },
      { id: tiedLowId, companyId, agentId: workerId, status: "timed_out", createdAt: tied, updatedAt: tied },
      { id: tiedHighId, companyId, agentId: workerId, status: "failed", createdAt: tied, updatedAt: tied },
    ]);
    // Insert order sets event ids: a tie on created_at falls back to the newest receipt.
    const receipts = [
      [tiedHighId, "Bounded retry exhausted first"],
      [olderId, "Bounded retry exhausted older"],
      [tiedLowId, "Bounded retry exhausted tied low"],
      [tiedHighId, "Bounded retry exhausted tied high"],
    ] as const;
    for (const [index, [runId, message]] of receipts.entries()) {
      await db.insert(heartbeatRunEvents).values({
        companyId, agentId: workerId, runId, seq: index + 1, eventType: "lifecycle", message,
      });
    }

    const rows = await listAttentionExhaustedRuns(db, companyId);
    expect(rows.map((row) => [row.id, row.exhaustionMessage])).toEqual([
      [tiedHighId, "Bounded retry exhausted tied high"],
      [tiedLowId, "Bounded retry exhausted tied low"],
      [olderId, "Bounded retry exhausted older"],
    ]);

    // The partial index predicate must stay implied by the query predicate;
    // otherwise the scan silently falls back to reading all company events.
    // Check a forced generic plan too: prepared statements reuse it, and only
    // literal predicates (not bound parameters) let it use a partial index.
    const query = listAttentionExhaustedRuns(db, companyId).toSQL();
    // Shared disposable databases retain statistics from earlier fixtures after
    // TRUNCATE. Plan this fixture's actual rows, including the generic plan.
    await db.$client.unsafe("ANALYZE heartbeat_run_events");
    await db.$client.unsafe("ANALYZE heartbeat_runs");
    await db.$client.unsafe("ANALYZE agents");
    const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
    const plans = await db.$client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL enable_seqscan = off");
      const fresh = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
      await tx.unsafe("SET LOCAL plan_cache_mode = force_generic_plan");
      await tx.unsafe(`PREPARE attention_exhausted_runs AS ${query.sql}`);
      const generic = await tx.unsafe(
        `EXPLAIN (FORMAT JSON) EXECUTE attention_exhausted_runs(${query.params.map(literal).join(", ")})`,
      );
      await tx.unsafe("DEALLOCATE attention_exhausted_runs");
      return { fresh, generic };
    });
    expect(JSON.stringify(plans.fresh)).toContain("heartbeat_run_events_retry_exhausted_idx");
    expect(JSON.stringify(plans.generic)).toContain("heartbeat_run_events_retry_exhausted_idx");
  });

  it("keeps SQL statement text saved by older failed runs out of the attention inbox", async () => {
    const { companyId, workerId } = await seedCompany("ATQ");
    const issueId = await insertIssue({ companyId, identifier: "ATQ-1", title: "Failed with a query", status: "in_progress" });
    const failedRunId = randomUUID();
    const failedAt = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: failedRunId, companyId, agentId: workerId, invocationSource: "automation", status: "failed",
      errorCode: "adapter_failed",
      error: 'Usage write failed: Failed query: update "heartbeat_runs" set "usage_json" = $1\nparams: {"apiKey":"sk-secret"}',
      contextSnapshot: { issueId }, createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: failedRunId, agentId: workerId, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: new Date("2026-07-09T12:00:01.000Z"),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const item = feed.items.find((entry) => entry.sourceKind === "failed_run" && entry.subject.id === failedRunId);
    expect(item?.detail).toMatchObject({ failureReasonExcerpt: "Usage write failed: Database query failed" });
    expect(item?.subject.metadata?.error).toBe("Usage write failed: Database query failed");
    expect(JSON.stringify(item)).not.toMatch(/heartbeat_runs|sk-secret|params/);
  });

  it("suppresses failed-run attention after a newer run for the same issue", async () => {
    const { companyId, workerId } = await seedCompany("ATN");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATN-1",
      title: "Recoverable task",
      status: "in_progress",
    });
    const failedRunId = randomUUID();
    const failedAt = new Date("2026-07-09T12:00:00.000Z");

    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "failed",
        error: "adapter failed",
        contextSnapshot: { issueId },
        createdAt: failedAt,
        updatedAt: failedAt,
        finishedAt: failedAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: workerId,
        invocationSource: "automation",
        status: "succeeded",
        contextSnapshot: { issueId },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
        finishedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: failedRunId,
      agentId: workerId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: new Date("2026-07-09T12:00:01.000Z"),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "failed_run")).toEqual([]);
  });

  it("hides a failed run only after a newer run of the same agent on the same issue or task", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATK");
    const taskIssueId = await insertIssue({ companyId, identifier: "ATK-1", title: "Task-keyed", status: "in_progress" });
    const issueKeyedId = await insertIssue({ companyId, identifier: "ATK-2", title: "Issue-keyed", status: "in_progress" });
    const otherIssueId = await insertIssue({ companyId, identifier: "ATK-3", title: "Other work", status: "in_progress" });
    const failedAt = new Date("2026-07-09T12:00:00.000Z");
    const laterAt = new Date("2026-07-09T12:01:00.000Z");
    const taskKeyedFailureId = randomUUID();
    const issueKeyedFailureId = randomUUID();
    const unkeyedHiddenFailureId = randomUUID();
    const unkeyedKeptFailureId = randomUUID();
    const failureIds = [taskKeyedFailureId, issueKeyedFailureId, unkeyedHiddenFailureId, unkeyedKeptFailureId];
    const sameMillisecondRunId = randomUUID();
    const run = (id: string, agentId: string, status: string, contextSnapshot: Record<string, unknown>, at: Date) => ({
      id, companyId, agentId, invocationSource: "automation", status, contextSnapshot,
      createdAt: at, updatedAt: at, finishedAt: at, ...(status === "failed" ? { error: "adapter failed" } : {}),
    });

    await db.insert(heartbeatRuns).values([
      run(taskKeyedFailureId, workerId, "failed", { taskId: taskIssueId }, failedAt),
      run(issueKeyedFailureId, workerId, "failed", { issueId: issueKeyedId }, failedAt),
      run(unkeyedHiddenFailureId, workerId, "failed", {}, failedAt),
      run(unkeyedKeptFailureId, reviewerId, "failed", {}, failedAt),
      run(randomUUID(), workerId, "succeeded", { taskId: taskIssueId }, laterAt),
      run(randomUUID(), workerId, "succeeded", { wakeReason: "timer" }, laterAt),
      run(randomUUID(), reviewerId, "succeeded", { issueId: issueKeyedId }, laterAt),
      run(randomUUID(), reviewerId, "succeeded", { issueId: otherIssueId }, laterAt),
      run(randomUUID(), workerId, "succeeded", { issueId: otherIssueId }, laterAt),
      run(randomUUID(), workerId, "succeeded", { issueId: otherIssueId, taskId: issueKeyedId }, laterAt),
      run(randomUUID(), workerId, "succeeded", { issueId: "", taskId: issueKeyedId }, laterAt),
      run(sameMillisecondRunId, workerId, "succeeded", { issueId: issueKeyedId }, failedAt),
      run(randomUUID(), workerId, "succeeded", { issueId: issueKeyedId }, new Date("2026-07-09T11:59:00.000Z")),
    ]);
    await db.execute(sql`update heartbeat_runs set created_at = created_at + interval '400 microseconds'
      where id in (${sql.join(failureIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
    await db.execute(sql`update heartbeat_runs set created_at = created_at + interval '600 microseconds'
      where id = ${sameMillisecondRunId}::uuid`);
    await db.insert(heartbeatRunEvents).values(
      failureIds.map((runId) => ({
        companyId,
        runId,
        agentId: runId === unkeyedKeptFailureId ? reviewerId : workerId,
        seq: 1,
        eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: new Date("2026-07-09T12:00:01.000Z"),
      })),
    );

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(feed.items.filter((item) => item.sourceKind === "failed_run").map((item) => item.subject.id).sort())
      .toEqual([issueKeyedFailureId, unkeyedKeptFailureId].sort());
  });

  it("keeps newer-run response size bounded despite unrelated retained history", async () => {
    const { companyId, workerId } = await seedCompany("ATW");
    const issueId = await insertIssue({ companyId, identifier: "ATW-1", title: "Exhausted task", status: "in_progress" });
    const otherIssueId = await insertIssue({ companyId, identifier: "ATW-2", title: "Other task", status: "done" });
    const failedId = randomUUID(), failedAt = new Date("2026-07-09T12:00:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: failedId, companyId, agentId: workerId, status: "failed", contextSnapshot: { issueId },
      createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId, agentId: workerId, runId: failedId, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after scheduled attempts",
    });
    for (let batch = 0; batch < 4; batch += 1) {
      await db.insert(heartbeatRuns).values(Array.from({ length: 500 }, (_, index) => ({
        id: randomUUID(), companyId, agentId: workerId, status: "succeeded",
        contextSnapshot: { issueId: otherIssueId, prompt: "x".repeat(8_000) },
        createdAt: new Date(failedAt.getTime() + batch * 500 + index + 1),
        updatedAt: failedAt, finishedAt: failedAt,
      })));
    }
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const feed = await attentionService(db).list(companyId, { userId: "board-user" });
      expect(feed.items.filter(item => item.sourceKind === "failed_run").map(item => item.subject.id)).toEqual([failedId]);
    } finally { capture.flush(); }
    const reads = events.filter(event => event.event === "paperclip.test_db_response_capture.entry.v1"
      && event.table === "heartbeat_runs" && (event.operation === "select" || event.operation === "execute"));
    expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThan(0);
    expect(reads.reduce((sum, event) => sum + Number(event.rows), 0)).toBeLessThan(64);
    expect(reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0)).toBeLessThan(4096);
    expect(reads.filter(event => event.operation === "execute")
      .reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThan(0);
    const [remaining] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(remaining?.count).toBe(2001);
  });

  it("reads keyless history once per agent despite thousands of failures", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATB");
    const failedAt = new Date("2026-07-09T12:00:00.000Z");
    const laterAt = new Date("2026-07-09T12:01:00.000Z");
    const hiddenIds = Array.from({ length: 16_390 }, () => randomUUID());
    const keptIds = Array.from({ length: 10 }, () => randomUUID());
    const failure = (id: string, agentId: string) => ({
      id, companyId, agentId, invocationSource: "automation", status: "failed", error: "adapter failed",
      contextSnapshot: {}, createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
    });
    const failures = hiddenIds.map((id) => failure(id, workerId));
    keptIds.forEach((id, index) => failures.splice(index * 1_700, 0, failure(id, reviewerId)));
    for (let start = 0; start < failures.length; start += 1_000) {
      const chunk = failures.slice(start, start + 1_000);
      await db.insert(heartbeatRuns).values(chunk);
      await db.insert(heartbeatRunEvents).values(chunk.map((run) => ({
        companyId, runId: run.id, agentId: run.agentId, seq: 1, eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: new Date("2026-07-09T12:00:01.000Z"),
      })));
    }
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId: workerId, invocationSource: "automation", status: "succeeded",
      contextSnapshot: { wakeReason: "timer" }, createdAt: laterAt, updatedAt: laterAt, finishedAt: laterAt,
    });

    // Bulk-loaded fixtures need planner statistics before exercising production queries.
    await db.execute(sql`ANALYZE heartbeat_runs, heartbeat_run_events`);

    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const feed = await attentionService(db).list(companyId, {
        includeDismissed: true, all: true, allowUnscopedAll: true,
      });
      expect(feed.items.filter((item) => item.sourceKind === "failed_run").map((item) => item.subject.id).sort())
        .toEqual([...keptIds].sort());
    } finally { capture.flush(); }
    const reads = events.filter(event => event.event === "paperclip.test_db_response_capture.entry.v1"
      && event.table === "heartbeat_runs" && (event.operation === "select" || event.operation === "execute"));
    expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThan(0);
    expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeLessThan(4);
  }, 180_000);

  it("checks more failed runs for a newer run than one statement can bind", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATQ");
    const issueId = await insertIssue({ companyId, identifier: "ATQ-1", title: "Keyed retained failures", status: "in_progress" });
    const failedAt = new Date("2026-07-09T12:00:00.000Z");
    const laterAt = new Date("2026-07-09T12:01:00.000Z");
    const hiddenIds = Array.from({ length: 16_390 }, () => randomUUID());
    const keptIds = Array.from({ length: 10 }, () => randomUUID());
    const failure = (id: string, agentId: string) => ({
      id, companyId, agentId, invocationSource: "automation", status: "failed", error: "adapter failed",
      contextSnapshot: { issueId }, createdAt: failedAt, updatedAt: failedAt, finishedAt: failedAt,
    });
    const failures = hiddenIds.map((id) => failure(id, workerId));
    keptIds.forEach((id, index) => failures.splice(index * 1_700, 0, failure(id, reviewerId)));
    for (let start = 0; start < failures.length; start += 1_000) {
      const chunk = failures.slice(start, start + 1_000);
      await db.insert(heartbeatRuns).values(chunk);
      await db.insert(heartbeatRunEvents).values(chunk.map((run) => ({
        companyId, runId: run.id, agentId: run.agentId, seq: 1, eventType: "lifecycle",
        message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
        createdAt: new Date("2026-07-09T12:00:01.000Z"),
      })));
    }
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId: workerId, invocationSource: "automation", status: "succeeded",
      contextSnapshot: { issueId }, createdAt: laterAt, updatedAt: laterAt, finishedAt: laterAt,
    });

    // Do not race autovacuum to collect statistics for the 16,400 new rows.
    await db.execute(sql`ANALYZE heartbeat_runs, heartbeat_run_events`);

    const feed = await attentionService(db).list(companyId, {
      includeDismissed: true, all: true, allowUnscopedAll: true,
    });
    expect(feed.items.filter(item => item.sourceKind === "failed_run").map(item => item.subject.id).sort())
      .toEqual([...keptIds].sort());
  }, 180_000);

  it("enriches interaction details with project, workspace, plan metadata, and images", async () => {
    const { companyId, workerId } = await seedCompany("ATE");
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const planDocumentId = randomUUID();
    const planRevisionId = randomUUID();
    const imageAssetIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Attention Project",
      status: "in_progress",
      color: "#0f766e",
      icon: "rocket",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Preview workspace",
      sourceType: "local_path",
      isPrimary: true,
    });
    await insertIssue({
      id: issueId,
      companyId,
      identifier: "ATE-1",
      title: "Approve launch plan",
      status: "in_progress",
      assigneeAgentId: workerId,
      projectId,
      projectWorkspaceId: workspaceId,
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Launch Plan",
      format: "markdown",
      latestBody: "# Summary\n\nThis plan explains the launch checklist, rollout owner, QA gates, and risk controls for the homepage release.",
      latestRevisionId: planRevisionId,
      latestRevisionNumber: 2,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId: planDocumentId,
      key: "plan",
    });
    await db.insert(assets).values([
      { id: imageAssetIds[0], companyId, provider: "local_disk", objectKey: "img-1", contentType: "image/png", byteSize: 10, sha256: "a".repeat(64), originalFilename: "one.png" },
      { id: imageAssetIds[1], companyId, provider: "local_disk", objectKey: "img-2", contentType: "image/jpeg", byteSize: 10, sha256: "b".repeat(64), originalFilename: "two.jpg" },
      { id: imageAssetIds[2], companyId, provider: "local_disk", objectKey: "img-3", contentType: "image/gif", byteSize: 10, sha256: "c".repeat(64), originalFilename: "three.gif" },
      { id: imageAssetIds[3], companyId, provider: "local_disk", objectKey: "img-4", contentType: "image/png", byteSize: 10, sha256: "d".repeat(64), originalFilename: "four.png" },
    ]);
    await db.insert(issueAttachments).values(imageAssetIds.map((assetId, index) => ({
      companyId,
      issueId,
      assetId,
      createdAt: new Date(`2026-07-09T12:0${index}:30.000Z`),
      updatedAt: new Date(`2026-07-09T12:0${index}:30.000Z`),
    })));

    const planInteractionId = randomUUID();
    const questionsInteractionId = randomUUID();
    const tasksInteractionId = randomUUID();
    const checkboxInteractionId = randomUUID();
    const verdictInteractionId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: planInteractionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Approve the plan",
        payload: {
          version: 1,
          prompt: "Approve plan?",
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          target: { type: "issue_document", issueId, key: "plan", revisionId: planRevisionId },
        },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
      {
        id: questionsInteractionId,
        companyId,
        issueId,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Questions",
        payload: {
          version: 1,
          questions: [
            { id: "q1", prompt: "Which auth provider should we use?", selectionMode: "single", options: [] },
            { id: "q2", prompt: "Should we add a fallback?", selectionMode: "single", options: [] },
          ],
        },
        createdAt: new Date("2026-07-09T12:02:00.000Z"),
        updatedAt: new Date("2026-07-09T12:02:00.000Z"),
      },
      {
        id: tasksInteractionId,
        companyId,
        issueId,
        kind: "suggest_tasks",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Tasks",
        payload: { version: 1, tasks: [{ clientKey: "t1", title: "Build API" }, { clientKey: "t2", title: "Wire UI" }] },
        createdAt: new Date("2026-07-09T12:03:00.000Z"),
        updatedAt: new Date("2026-07-09T12:03:00.000Z"),
      },
      {
        id: checkboxInteractionId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Checkbox",
        payload: { version: 1, prompt: "Select rollout regions", options: [{ id: "us", label: "US" }, { id: "eu", label: "EU" }] },
        createdAt: new Date("2026-07-09T12:04:00.000Z"),
        updatedAt: new Date("2026-07-09T12:04:00.000Z"),
      },
      {
        id: verdictInteractionId,
        companyId,
        issueId,
        kind: "request_item_verdicts",
        status: "pending",
        continuationPolicy: "wake_assignee",
        title: "Verdicts",
        payload: { version: 1, prompt: "Approve these screenshots", items: [{ id: "one", label: "One" }, { id: "two", label: "Two" }] },
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactionItems = feed.items.filter((item) => item.sourceKind === "issue_thread_interaction");
    const detailsByKind = new Map(interactionItems.map((item) => [item.detail?.kind, item]));
    const summaryEvents: Array<Record<string, unknown>> = [], captureNow = Date.now();
    const summaryCapture = createFullDatabaseResponseCapture({ start: captureNow - 100, end: captureNow + 59_000 }, event => summaryEvents.push(event));
    installDatabaseResponseCapture(db, { documents, assets, issueAttachments }, summaryCapture);
    try {
      const summary = await attentionService(db).summary(companyId, { userId: "board-user" });
      expect(summary.countsBySourceKind).toEqual(feed.countsBySourceKind);
      expect(summary.totalCount).toBe(feed.totalCount);
      const index = await attentionService(db).taskIndex(companyId, { userId: "board-user" });
      expect(index.taskIds).toEqual([...new Set(feed.items.flatMap(item => item.relatedIssue ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []))]);
      expect(index.totalCount).toBe(feed.totalCount);

    } finally { summaryCapture.flush(); }
    const cardReads = summaryEvents.filter(event => event.event === "paperclip.test_db_response_capture.entry.v1"
      && ["documents", "assets", "issue_attachments"].includes(String(event.table)));
    expect(cardReads).toEqual([]);


    const planItem = detailsByKind.get("plan_approval");
    expect(planItem?.subject.title).toBe("Plan approval - Approve launch plan");
    expect(planItem?.subject.metadata).toMatchObject({ isPlanTarget: true, targetDocumentKey: "plan" });
    expect(planItem?.decisionVerbs).toEqual([
      expect.objectContaining({ id: "accept", label: "Approve plan" }),
      expect.objectContaining({ id: "reject", label: "Request changes" }),
    ]);
    expect(planItem?.project).toMatchObject({
      id: projectId,
      name: "Attention Project",
      color: "#0f766e",
      icon: "rocket",
    });
    expect(planItem?.project?.urlKey).toEqual(expect.any(String));
    expect(planItem?.workspace).toEqual({ id: workspaceId, name: "Preview workspace" });
    expect(planItem?.detail).toMatchObject({
      kind: "plan_approval",
      issueTitle: "Approve launch plan",
      planTitle: "Launch Plan",
      summaryExcerpt: expect.stringContaining("launch checklist"),
      images: imageAssetIds.slice(0, 3).map((assetId) => ({ assetId, alt: expect.any(String) })),
    });
    expect(detailsByKind.get("questions")?.detail).toMatchObject({
      kind: "questions",
      questionCount: 2,
      firstQuestionText: "Which auth provider should we use?",
    });
    expect(detailsByKind.get("suggested_tasks")?.detail).toMatchObject({
      kind: "suggested_tasks",
      taskCount: 2,
      firstTaskTitle: "Build API",
    });
    expect(detailsByKind.get("checkbox_confirmation")?.detail).toMatchObject({
      kind: "checkbox_confirmation",
      optionCount: 2,
      promptExcerpt: "Select rollout regions",
    });
    expect(detailsByKind.get("item_verdicts")?.detail).toMatchObject({
      kind: "item_verdicts",
      itemCount: 2,
      promptExcerpt: "Approve these screenshots",
    });
  });

  it("shows only the newest pending confirmation per issue and kind", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATC");
    const issueId = await insertIssue({
      companyId,
      identifier: "ATC-1",
      title: "Repeated sign-offs",
      status: "in_review",
      assigneeAgentId: workerId,
    });
    const olderConfirmationId = randomUUID();
    const newerConfirmationId = randomUUID();
    const checkboxId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: olderConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: workerId,
        title: "Approve V1",
        payload: { version: 1, prompt: "Approve V1?" },
        createdAt: new Date("2026-07-09T12:00:00.000Z"),
        updatedAt: new Date("2026-07-09T12:10:00.000Z"),
      },
      {
        id: newerConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: reviewerId,
        title: "Approve V2",
        payload: { version: 1, prompt: "Approve V2?" },
        createdAt: new Date("2026-07-09T12:05:00.000Z"),
        updatedAt: new Date("2026-07-09T12:05:00.000Z"),
      },
      {
        id: checkboxId,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdByAgentId: workerId,
        title: "Select rollout",
        payload: { version: 1, prompt: "Select rollout", options: [{ id: "one", label: "One" }] },
        createdAt: new Date("2026-07-09T12:01:00.000Z"),
        updatedAt: new Date("2026-07-09T12:01:00.000Z"),
      },
    ]);

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactionIds = feed.items
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.id);

    expect(interactionIds).toContain(newerConfirmationId);
    expect(interactionIds).toContain(checkboxId);
    expect(interactionIds).not.toContain(olderConfirmationId);
  });

  it.each([
    ["approved from chat", "accept", "ATR"],
    ["rejected from chat", "reject", "ATJ"],
    ["expired", "expire", "ATX"],
  ] as const)("does not resurface an older confirmation once the newest one is %s", async (_label, outcome, prefix) => {
    // Same-agent re-asks are expired at creation; a second agent (for example
    // the chat agent) asking on the same task leaves the older card pending.
    const { companyId, workerId, reviewerId } = await seedCompany(prefix);
    const issueId = await insertIssue({
      companyId,
      identifier: `${prefix}-1`,
      title: "Re-asked sign-off",
      status: "in_review",
      assigneeAgentId: workerId,
    });
    const olderConfirmationId = randomUUID();
    const newerConfirmationId = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: olderConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: workerId,
        title: "Approve the plan",
        payload: { version: 1, prompt: "Approve the plan?" },
        createdAt: new Date("2026-11-05T12:00:00.000Z"),
        updatedAt: new Date("2026-11-05T12:00:00.000Z"),
      },
      {
        id: newerConfirmationId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: reviewerId,
        title: "Approve the plan (again)",
        payload: { version: 1, prompt: "Approve the plan?" },
        createdAt: new Date("2026-11-05T12:05:00.000Z"),
        updatedAt: new Date("2026-11-05T12:05:00.000Z"),
      },
    ]);

    const pendingIds = async () => (await attentionService(db).list(companyId, { userId: "board-user" })).items
      .filter((item) => item.sourceKind === "issue_thread_interaction")
      .map((item) => item.subject.id);
    expect(await pendingIds()).toEqual([newerConfirmationId]);

    if (outcome === "accept") {
      // The chat card resolves the same canonical record through the same service.
      await issueThreadInteractionService(db).acceptInteraction(
        { id: issueId, companyId, projectId: null, goalId: null, status: "in_review" },
        newerConfirmationId,
        {},
        { userId: "board-user" },
      );
    } else if (outcome === "reject") {
      await issueThreadInteractionService(db).rejectInteraction(
        { id: issueId, companyId, status: "in_review" },
        newerConfirmationId,
        { reason: "Not this plan" },
        { userId: "board-user" },
      );
    } else {
      await db.update(issueThreadInteractions).set({
        status: "expired",
        result: { version: 1, outcome: "stale_target" },
        resolvedAt: new Date("2026-11-05T12:10:00.000Z"),
        updatedAt: new Date("2026-11-05T12:10:00.000Z"),
      }).where(eq(issueThreadInteractions.id, newerConfirmationId));
    }

    expect(await pendingIds()).toEqual([]);
  });

  it("keeps a pending tool-action approval visible after a newer tool action is settled", async () => {
    const { companyId, workerId } = await seedCompany("ATT");
    const issueId = await insertIssue({ companyId, identifier: "ATT-1", title: "Two tool calls", status: "in_progress", assigneeAgentId: workerId });
    const olderId = randomUUID();
    const base = { companyId, issueId, kind: "request_confirmation", continuationPolicy: "none", createdByAgentId: workerId, title: "Approve tool action" };
    await db.insert(issueThreadInteractions).values([
      { ...base, id: olderId, status: "pending", payload: { version: 1, prompt: "Run A?", toolAction: { actionRequestId: randomUUID() } },
        createdAt: new Date("2026-11-05T12:00:00.000Z"), updatedAt: new Date("2026-11-05T12:00:00.000Z") },
      { ...base, id: randomUUID(), status: "accepted", payload: { version: 1, prompt: "Run B?", toolAction: { actionRequestId: randomUUID() } },
        createdAt: new Date("2026-11-05T12:05:00.000Z"), updatedAt: new Date("2026-11-05T12:06:00.000Z"), resolvedAt: new Date("2026-11-05T12:06:00.000Z") },
    ] as typeof issueThreadInteractions.$inferInsert[]);
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual([olderId]);
  });

  it("shows a genuine re-ask created after the newest confirmation was settled", async () => {
    const { companyId, workerId, reviewerId } = await seedCompany("ATN");
    const issueId = await insertIssue({ companyId, identifier: "ATN-1", title: "Follow-up sign-off", status: "in_review", assigneeAgentId: workerId });
    const reAskId = randomUUID();
    const base = { companyId, issueId, kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Approve?" } };
    await db.insert(issueThreadInteractions).values([
      { ...base, id: randomUUID(), status: "accepted", createdByAgentId: reviewerId, title: "First sign-off",
        createdAt: new Date("2026-11-05T12:00:00.000Z"), updatedAt: new Date("2026-11-05T12:01:00.000Z"), resolvedAt: new Date("2026-11-05T12:01:00.000Z") },
      { ...base, id: reAskId, status: "pending", createdByAgentId: workerId, title: "Second sign-off",
        createdAt: new Date("2026-11-05T12:05:00.000Z"), updatedAt: new Date("2026-11-05T12:05:00.000Z") },
    ] as typeof issueThreadInteractions.$inferInsert[]);
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual([reAskId]);
  });

  it.each([
    ["secret proposal", "ATS", { secretProposal: { proposalId: "11111111-1111-4111-8111-111111111111" } }],
    ["app connection", "ATK", { connectionAuthorization: { connectionId: "22222222-2222-4222-8222-222222222222" } }],
  ] as const)("does not let a settled %s hide an older ordinary confirmation", async (_label, prefix, governed) => {
    const { companyId, workerId, reviewerId } = await seedCompany(prefix);
    const issueId = await insertIssue({ companyId, identifier: `${prefix}-1`, title: "Governed card then sign-off", status: "in_review", assigneeAgentId: workerId });
    const ordinaryId = randomUUID();
    const base = { companyId, issueId, kind: "request_confirmation", continuationPolicy: "none" };
    await db.insert(issueThreadInteractions).values([
      { ...base, id: ordinaryId, status: "pending", createdByAgentId: workerId, title: "Approve the plan", payload: { version: 1, prompt: "Approve the plan?" },
        createdAt: new Date("2026-11-05T12:00:00.000Z"), updatedAt: new Date("2026-11-05T12:00:00.000Z") },
      { ...base, id: randomUUID(), status: "accepted", createdByAgentId: reviewerId, title: "Governed action",
        payload: { version: 1, prompt: "Allow this?", ...governed },
        createdAt: new Date("2026-11-05T12:05:00.000Z"), updatedAt: new Date("2026-11-05T12:06:00.000Z"), resolvedAt: new Date("2026-11-05T12:06:00.000Z") },
    ] as typeof issueThreadInteractions.$inferInsert[]);
    const service = attentionService(db);
    const feed = await service.list(companyId, { userId: "board-user" });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual([ordinaryId]);
    expect((await service.taskIndex(companyId, { userId: "board-user" })).taskIds).toContain(issueId);
  });

  it("keeps a pending tool-action approval in the summary and task index after a newer ordinary confirmation is settled", async () => {
    const { companyId, workerId } = await seedCompany("ATU");
    const issueId = await insertIssue({ companyId, identifier: "ATU-1", title: "Tool call then sign-off", status: "in_progress", assigneeAgentId: workerId });
    const toolApprovalId = randomUUID();
    const base = { companyId, issueId, kind: "request_confirmation", continuationPolicy: "none", createdByAgentId: workerId };
    await db.insert(issueThreadInteractions).values([
      { ...base, id: toolApprovalId, status: "pending", title: "Approve tool action",
        payload: { version: 1, prompt: "Run A?", toolAction: { actionRequestId: randomUUID() } },
        createdAt: new Date("2026-11-05T12:00:00.000Z"), updatedAt: new Date("2026-11-05T12:00:00.000Z") },
      { ...base, id: randomUUID(), status: "accepted", title: "Approve the plan", payload: { version: 1, prompt: "Approve the plan?" },
        createdAt: new Date("2026-11-05T12:05:00.000Z"), updatedAt: new Date("2026-11-05T12:06:00.000Z"), resolvedAt: new Date("2026-11-05T12:06:00.000Z") },
    ] as typeof issueThreadInteractions.$inferInsert[]);
    const service = attentionService(db);
    const feed = await service.list(companyId, { userId: "board-user" });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual([toolApprovalId]);
    const [summary, index] = await Promise.all([service.summary(companyId, { userId: "board-user" }), service.taskIndex(companyId, { userId: "board-user" })]);
    expect(index.taskIds).toContain(issueId);
    expect(summary.totalCount).toBe(feed.totalCount);
  });

  it("does not let another recipient's settled confirmation hide this recipient's pending one", async () => {
    const { companyId, workerId } = await seedCompany("ATV");
    const issueId = await insertIssue({ companyId, identifier: "ATV-1", title: "Two reviewers", status: "in_review", assigneeAgentId: workerId });
    const mineId = randomUUID();
    const base = { companyId, issueId, kind: "request_confirmation", continuationPolicy: "none", createdByAgentId: workerId, payload: { version: 1, prompt: "Approve?" } };
    await db.insert(issueThreadInteractions).values([
      { ...base, id: mineId, status: "pending", title: "Board user sign-off", addresseeUserId: "board-user",
        createdAt: new Date("2026-11-05T12:00:00.000Z"), updatedAt: new Date("2026-11-05T12:00:00.000Z") },
      { ...base, id: randomUUID(), status: "accepted", title: "Other user sign-off", addresseeUserId: "other-user",
        createdAt: new Date("2026-11-05T12:05:00.000Z"), updatedAt: new Date("2026-11-05T12:06:00.000Z"), resolvedAt: new Date("2026-11-05T12:06:00.000Z") },
    ] as typeof issueThreadInteractions.$inferInsert[]);
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.filter((item) => item.sourceKind === "issue_thread_interaction").map((item) => item.subject.id)).toEqual([mineId]);
  });

  it("retains every independently bound quality approval alongside the newest ordinary confirmation", async () => {
    const { companyId, workerId } = await seedCompany("ATQ");
    const issueId = await insertIssue({ companyId, identifier: "ATQ-1", title: "Review copy and visual", status: "in_review", assigneeAgentId: workerId });
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issueThreadInteractions).values(ids.map((id, index) => ({
      id, companyId, issueId, kind: "request_confirmation" as const, status: "pending" as const, continuationPolicy: "wake_assignee" as const, createdByAgentId: workerId,
      payload: { version: 1 as const, prompt: "Approve output?", ...(index < 2 ? { qualityReview: { key: index === 0 ? "copy" : "visual", requirementHash: "a".repeat(64) } } : {}) },
      createdAt: new Date(Date.UTC(2026, 6, 9, 12, index)),
    })));
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    const interactions = feed.items.filter(item => item.sourceKind === "issue_thread_interaction");
    expect(interactions.map(item => item.subject.id).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
    const summary = await attentionService(db).summary(companyId, { userId: "board-user" });
    expect(summary.countsBySourceKind).toEqual(feed.countsBySourceKind);

    // Resolving one output removes only that decision, leaving the other output
    // and the ordinary confirmation independently actionable.
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, ids[0]));
    const remaining = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(remaining.items.filter(item => item.sourceKind === "issue_thread_interaction").map(item => item.subject.id).sort()).toEqual([ids[1], ids[3]].sort());
  });

  it("uses inbox_dismissals with attention-prefixed dedup keys and resurfaces newer activity", async () => {
    const { companyId } = await seedCompany("ATD");
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      status: "pending",
      payload: { title: "Hire Writer" },
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
      updatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:approval:${approvalId}`,
      dismissedAt: new Date("2026-07-09T13:00:00.000Z"),
    });

    await expect(attentionService(db).list(companyId, { userId: "board-user" }))
      .resolves.toMatchObject({ totalCount: 1 }); // agent_error_alert from seed
    const includeDismissedFeed = await attentionService(db).list(companyId, { userId: "board-user", includeDismissed: true });
    expect(includeDismissedFeed.totalCount).toBe(2);
    expect(includeDismissedFeed.items.find((item) => item.dedupKey === `approval:${approvalId}`)?.dismissal)
      .toMatchObject({ kind: "dismiss", isActive: true, snoozedUntil: null });

    await db
      .update(approvals)
      .set({ updatedAt: new Date("2026-07-09T14:00:00.000Z") })
      .where(eq(approvals.id, approvalId));

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(feed.items.some((item) => item.dedupKey === `approval:${approvalId}`)).toBe(true);
  });
});
