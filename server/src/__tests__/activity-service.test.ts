import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";
import { issueReadSqlCondition } from "../services/authorization.ts";
import { issueService } from "../services/issues.ts";
import { documentService } from "../services/documents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type ActivityService = ReturnType<typeof activityService>;
type IssueRun = Awaited<ReturnType<ActivityService["runsForIssue"]>>[number];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIssueRun(
  service: ActivityService,
  companyId: string,
  issueId: string,
  predicate: (run: IssueRun) => boolean,
) {
  const deadline = Date.now() + 2_000;
  let latestRuns: IssueRun[] = [];
  while (Date.now() < deadline) {
    latestRuns = await service.runsForIssue(companyId, issueId);
    const run = latestRuns.find(predicate);
    if (run) return { run, runs: latestRuns };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for issue run. Latest run count: ${latestRuns.length}`);
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(["standard", "planning", "ask"] as const)("LCA-05 persists explicit %s mode across wording edits and uses it in ledger backfill", async (workMode) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Mode fixture", issuePrefix: `M${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "codex_local" });
    const service = issueService(db);
    const task = await service.create(companyId, { title: "Making a plan", description: "Create a report and research proposal.", status: "in_progress", assigneeAgentId: agentId, ...(workMode === "standard" ? {} : { workMode }) });
    expect(task.workMode).toBe(workMode);
    for (const prose of [
      { title: "Implement exporter", description: "Change the code now." },
      { title: "Making a plan", description: "Create a plan for the report exporter." },
    ]) {
      await service.update(task.id, prose);
      expect((await service.getById(task.id))?.workMode).toBe(workMode);
    }
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: task.id }, resultJson: { summary: "I will inspect the repository next." } });
    const expected = workMode === "planning" ? "advanced" : "plan_only";
    await waitForIssueRun(activityService(db), companyId, task.id, run => run.runId === runId && run.livenessState === expected);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].livenessState).toBe(expected);
    if (workMode === "standard") {
      await documentService(db).upsertIssueDocument({ issueId: task.id, key: "plan", title: "Requested plan", format: "markdown", body: "1. Inspect files.\n2. Implement the exporter.", createdByAgentId: agentId });
      expect((await service.getById(task.id))?.workMode).toBe("standard");
      expect(await documentService(db).getIssueDocumentByKey(task.id, "plan")).toBeTruthy();
    }
    const nextMode = workMode === "planning" ? "standard" : "planning";
    await service.update(task.id, { workMode: nextMode });
    expect((await service.getById(task.id))?.workMode).toBe(nextMode);
  });

  it("limits company activity lists", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.oldest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.middle",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.newest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T12:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).list({ companyId, limit: 2 });

    expect(result.map((event) => event.action)).toEqual(["test.newest", "test.middle"]);
  });

  it("filters company activity rows whose entity is a private issue", async () => {
    const companyId = randomUUID();
    const privateIssueId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Private activity",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values([
      {
        id: privateIssueId,
        companyId,
        title: "Confidential activity",
        status: "todo",
        priority: "medium",
        visibility: "private",
        privacyRootIssueId: privateIssueId,
        responsibleUserId: "private-owner",
      },
      {
        id: openIssueId,
        companyId,
        title: "Open activity",
        status: "todo",
        priority: "medium",
      },
    ]);
    await db.insert(activityLog).values([
      { companyId, actorType: "system", actorId: "system", action: "private.changed", entityType: "issue", entityId: privateIssueId },
      { companyId, actorType: "system", actorId: "system", action: "open.changed", entityType: "issue", entityId: openIssueId },
    ]);
    const actor = {
      type: "board" as const,
      userId: "non-member",
      companyIds: [companyId],
      source: "session" as const,
      isInstanceAdmin: false,
    };

    const rows = await activityService(db).list({
      companyId,
      readCondition: await issueReadSqlCondition(db, actor),
    });
    expect(rows.map((row) => row.action)).toContain("open.changed");
    expect(rows.map((row) => row.action)).not.toContain("private.changed");
  });

  it.each([null, "native_provider_model_rejected", "adapter_failed"])("returns compact issue runs with bounded model rejection details: %s", async (errorCode) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Summarize a completed run",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "issue", status: "claimed",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      wakeupRequestId,
      companyId,
      agentId,
      scopeKind: "issue",
      issueId,
      invocationSource: "assignment",
      status: errorCode ? "failed" : "succeeded",
      errorCode,
      error: "provider-error".repeat(200),
      contextSnapshot: { issueId, queuedCommentSourceWakeIds: ["coalesced-queue"] },
      usageJson: {
        inputTokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        billingType: "metered",
        costUsd: 0.42,
        enormousBlob: "x".repeat(256_000),
      },
      resultJson: {
        conversationReset: true,
        configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main", fetchError: "private diagnostic" },
        billing_type: "metered",
        total_cost_usd: 0.42,
        stopReason: "timeout",
        effectiveTimeoutSec: 30,
        timeoutFired: true,
        summary: "done",
        nestedHuge: { payload: "y".repeat(256_000) },
      },
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });

    const runs = await activityService(db).runsForIssue(companyId, issueId);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      wakeupRequestId,
      agentId,
      queuedCommentSourceWakeIds: ["coalesced-queue"],
      invocationSource: "assignment",
      contextIssueId: issueId,
      error: errorCode === "native_provider_model_rejected" ? "provider-error".repeat(200).slice(0, 2000) : null,
    });
    expect(runs[0]?.usageJson).toEqual({
      inputTokens: 11,
      input_tokens: 11,
      outputTokens: 7,
      output_tokens: 7,
      cachedInputTokens: 3,
      cached_input_tokens: 3,
      cache_read_input_tokens: 3,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
    });
    expect(runs[0]?.resultJson).toEqual({
      conversationReset: true,
      configurationIncomplete: { reason: "workspace_base_ref_unresolved" },
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutFired: true,
    });
    expect(runs[0]).toMatchObject({
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });
    expect(runs[0]).not.toHaveProperty("contextSnapshot");
  });

  it.each(["requested", "acknowledged", "pending_native", "missing_native", "wrong_run", "wrong_company",
    "malformed_execution", "null_execution", "malformed_native"] as const)(
    "projects only bounded, owner-matched Stop evidence in issue history: %s", async proof => {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Stop history", issuePrefix: `S${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Stopped runner", adapterType: "process" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Stop the current run", assigneeAgentId: agentId });
      const native = { schema: "paperclip.native-cancellation.v1", runId, companyId,
        dispatchState: proof === "pending_native" ? "pending" : "acknowledged",
        intentAuditId: "private-stop-proof", effects: ["private-stop-proof"], secret: "private-stop-proof" };
      const result: Record<string, unknown> = {
        executionCancellation: { state: proof === "requested" ? "requested" : "acknowledged",
          proof: "private-stop-proof", secret: "private-stop-proof" },
        nativeCancellation: native, unrelated: "private-stop-proof",
      };
      if (proof === "missing_native") delete result.nativeCancellation;
      if (proof === "wrong_run") native.runId = randomUUID();
      if (proof === "wrong_company") native.companyId = randomUUID();
      if (proof === "malformed_native") result.nativeCancellation = { ...native, dispatchState: { secret: "private-stop-proof" } };
      if (proof === "malformed_execution") result.executionCancellation = { state: { secret: "private-stop-proof" } };
      if (proof === "null_execution") result.executionCancellation = null;
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue",
        nativeIssueId: issueId, runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
        contextSnapshot: { issueId }, livenessState: "advanced", resultJson: result });

      const rows = await activityService(db).runsForIssue(companyId, issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runId, runtimeMode: "native", status: "cancelled" });
      expect(rows[0]!.resultJson).toEqual({
        executionCancellation: { state: proof === "requested" ? "requested"
          : proof === "malformed_execution" || proof === "null_execution" ? "unknown" : "acknowledged" },
        ...(["missing_native", "wrong_run", "wrong_company", "malformed_native"].includes(proof) ? {} : {
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId,
            dispatchState: proof === "pending_native" ? "pending" : "acknowledged" },
        }),
      });
      expect(JSON.stringify(rows)).not.toContain("private-stop-proof");
    },
  );

  it.each([
    ["recorded", "40001", "40001"],
    ["legacy row without the field", undefined, null],
    ["malformed", 'Failed query: select "secret" from x', null],
    ["overlong", "X".repeat(81), null],
    ["boolean", true, null],
    ["number", 40001, null],
  ] as const)("projects only a closed-shape failure cause in issue history: %s", async (_case, stored, expected) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Failure cause", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Failing runner", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fail with a cause", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "failed",
      errorCode: "adapter_failed", finishedAt: new Date(), contextSnapshot: { issueId }, livenessState: "failed",
      resultJson: { stopReason: "adapter_failed", ...(stored === undefined ? {} : { failureCause: stored }) } });

    const [row] = await activityService(db).runsForIssue(companyId, issueId);
    expect(row).toMatchObject({ runId, errorCode: "adapter_failed", failureCause: expected });
    expect(row!.resultJson).toEqual({ stopReason: "adapter_failed" });
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("backfills missing liveness for completed issue runs before returning the ledger", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const completedAt = new Date("2026-04-18T20:04:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      scopeKind: "issue",
      issueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:00:00.000Z"),
      finishedAt: completedAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Finished the implementation.",
      },
      livenessState: null,
      livenessReason: null,
      lastUsefulActionAt: null,
      nextAction: null,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Done",
      createdAt: completedAt,
    });

    const service = activityService(db);
    const { run, runs } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "completed",
    );

    expect(runs).toHaveLength(1);
    expect(run).toMatchObject({
      runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });

    const [persisted] = await db.select().from(heartbeatRuns);
    expect(persisted).toMatchObject({
      id: runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });
  });

  it("does not backfill document evidence from a different run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:08:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        scopeKind: "issue",
        issueId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:00:00.000Z"),
        finishedAt: new Date("2026-04-18T20:02:00.000Z"),
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Next steps:\n- inspect files",
        },
        livenessState: null,
        livenessReason: null,
      },
      {
        id: otherRunId,
        companyId,
        agentId,
        scopeKind: "issue",
        issueId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:05:00.000Z"),
        finishedAt: createdAt,
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Updated the plan document.",
        },
        livenessState: "advanced",
        livenessReason: "Run produced concrete action evidence: 1 document revision(s)",
      },
    ]);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan\n\n- Inspect files",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n- Inspect files",
      createdByAgentId: agentId,
      createdByRunId: otherRunId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("does not treat continuation summary revisions as concrete backfill evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:12:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      scopeKind: "issue",
      issueId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:10:00.000Z"),
      finishedAt: createdAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Next steps:\n- inspect files",
      },
      livenessState: null,
      livenessReason: null,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Continuation Summary",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Continuation Summary",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  describe("run liveness backfill", () => {
    async function seedIssue() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Backfill", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "codex_local" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Backfill target", status: "done", assigneeAgentId: agentId });
      return { companyId, agentId, issueId };
    }

    async function insertMissingRun(companyId: string, agentId: string, contextSnapshot: Record<string, unknown>, status = "succeeded") {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status, contextSnapshot, livenessState: null });
      return runId;
    }

    async function livenessOf(runIds: string[]) {
      const rows = await db.select({ id: heartbeatRuns.id, livenessState: heartbeatRuns.livenessState }).from(heartbeatRuns);
      return runIds.map((id) => rows.find((row) => row.id === id)?.livenessState ?? null);
    }

    async function waitForLiveness(service: ActivityService, companyId: string, issueId: string, runIds: string[]) {
      const deadline = performance.now() + 3_000;
      while (performance.now() < deadline) {
        await service.runsForIssue(companyId, issueId);
        if ((await livenessOf(runIds)).every((state) => state !== null)) {
          // Let the pass finish its bookkeeping after the last update.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for liveness: ${JSON.stringify(await livenessOf(runIds))}`);
    }

    it("backfills only this issue's runs, found by context or by issue activity", async () => {
      const { companyId, agentId, issueId } = await seedIssue();
      const viaContext = await insertMissingRun(companyId, agentId, { issueId });
      const viaActivity = await insertMissingRun(companyId, agentId, {}, "failed");
      await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated",
        entityType: "issue", entityId: issueId, runId: viaActivity });
      const running = await insertMissingRun(companyId, agentId, { issueId }, "running");
      const otherIssueRun = await insertMissingRun(companyId, agentId, { issueId: randomUUID() });
      const other = await seedIssue();
      const otherCompanyRun = await insertMissingRun(other.companyId, other.agentId, { issueId });

      await waitForLiveness(activityService(db), companyId, issueId, [viaContext, viaActivity]);

      expect(await livenessOf([running, otherIssueRun, otherCompanyRun])).toEqual([null, null, null]);
    });

    it("does not repeat the lookup for a clean issue until the skip window ends", async () => {
      const { companyId, agentId, issueId } = await seedIssue();
      const first = await insertMissingRun(companyId, agentId, { issueId });
      const service = activityService(db);
      await waitForLiveness(service, companyId, issueId, [first]);

      const late = await insertMissingRun(companyId, agentId, { issueId });
      for (let read = 0; read < 3; read++) {
        await service.runsForIssue(companyId, issueId);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(await livenessOf([late])).toEqual([null]);

      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
      try {
        await waitForLiveness(service, companyId, issueId, [late]);
      } finally {
        clock.mockRestore();
      }
    });

    it("keeps backfilling on later reads while an issue has more than one batch", async () => {
      const { companyId, agentId, issueId } = await seedIssue();
      const runIds: string[] = [];
      for (let index = 0; index < 25; index++) runIds.push(await insertMissingRun(companyId, agentId, { issueId }));

      await waitForLiveness(activityService(db), companyId, issueId, runIds);
    });

    it("leaves the backfill to the task page when a read skips it", async () => {
      const { companyId, agentId, issueId } = await seedIssue();
      const runId = await insertMissingRun(companyId, agentId, { issueId });
      const service = activityService(db);
      await service.runsForIssue(companyId, issueId, null, 2, undefined, { skipLivenessBackfill: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await livenessOf([runId])).toEqual([null]);

      await waitForLiveness(service, companyId, issueId, [runId]);
    });
  });
});
