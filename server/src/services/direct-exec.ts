import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  directExecContextBundles,
  directExecThreads,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import type {
  AssembleDirectExecContextBundle,
  CreateDirectExecThread,
  DirectExecAnswerEvidenceByCategory,
  DirectExecContextBundle,
  DirectExecContextConflict,
  DirectExecContextItem,
  DirectExecContextSourceFreshness,
  DirectExecLifecycle,
  DirectExecLifecycleStatus,
  DirectExecThread,
  DirectExecThresholds,
  UpdateDirectExecLifecycle,
  UpsertDirectExecContextBundle,
} from "@paperclipai/shared";
import {
  DIRECT_EXEC_DEFAULT_THRESHOLDS,
  assembleDirectExecContextBundleSchema,
  upsertDirectExecContextBundleSchema,
  isUuidLike,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";

const DIRECT_EXEC_STATUS_TRANSITIONS: Record<DirectExecLifecycleStatus, readonly DirectExecLifecycleStatus[]> = {
  accepted: ["queued", "failed", "paused"],
  queued: ["pending", "failed", "paused"],
  pending: ["completed", "failed", "paused", "timed-out"],
  completed: [],
  failed: [],
  paused: ["accepted", "queued", "pending", "failed"],
  "timed-out": [],
};

export function buildDirectExecDedupeKey(source: CreateDirectExecThread["source"]) {
  return `${source.channel}:${source.chatId}:${source.messageId}`;
}

export function mergeDirectExecThresholds(
  input: Partial<DirectExecThresholds> | null | undefined,
): DirectExecThresholds {
  return {
    ...DIRECT_EXEC_DEFAULT_THRESHOLDS,
    ...(input ?? {}),
  };
}

export function assertDirectExecStatusTransition(
  from: DirectExecLifecycleStatus,
  to: DirectExecLifecycleStatus,
) {
  if (from === to) return;
  const allowed = DIRECT_EXEC_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`Invalid direct-exec lifecycle transition: ${from} -> ${to}`);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isoNow(now = new Date()) {
  return now.toISOString();
}

export interface DirectExecRetentionScrubResult {
  scrubbedThreadIds: string[];
  scrubbedContextBundleCount: number;
}

function buildInitialLifecycle(input: CreateDirectExecThread, dedupeKey: string, now = new Date()): DirectExecLifecycle {
  return {
    status: "accepted",
    source: {
      ...input.source,
      senderLabel: input.source.senderLabel ?? null,
      threadId: input.source.threadId ?? null,
      replyToMessageId: input.source.replyToMessageId ?? null,
      receivedAt: input.source.receivedAt ?? null,
    },
    dedupeKey,
    target: {
      alias: input.target.alias,
      agentIds: input.target.agentIds ?? [],
    },
    visibility: input.visibility,
    contextBundleId: null,
    wakeReceiptIds: [],
    responseIds: [],
    deliveryReceipts: [],
    timeoutAt: input.timeoutAt ?? null,
    retentionExpiresAt: input.retentionExpiresAt ?? null,
    scrubStatus: input.scrubStatus ?? "not_required",
    thresholds: mergeDirectExecThresholds(input.thresholds),
    statusReason: null,
    createdAt: isoNow(now),
    updatedAt: isoNow(now),
  };
}

function buildIssueExecutionState(
  current: unknown,
  thread: Pick<typeof directExecThreads.$inferSelect, "id" | "lifecycleStatus" | "lifecycle" | "updatedAt">,
) {
  const state = asObject(current);
  const lifecycle = thread.lifecycle as DirectExecLifecycle;
  return {
    ...state,
    directExec: {
      threadId: thread.id,
      status: thread.lifecycleStatus,
      contextBundleId: lifecycle.contextBundleId,
      wakeReceiptIds: lifecycle.wakeReceiptIds,
      responseIds: lifecycle.responseIds,
      deliveryReceiptIds: lifecycle.deliveryReceipts.map((receipt) => receipt.id),
      timeoutAt: lifecycle.timeoutAt,
      retentionExpiresAt: lifecycle.retentionExpiresAt,
      scrubStatus: lifecycle.scrubStatus,
      updatedAt: thread.updatedAt instanceof Date ? thread.updatedAt.toISOString() : String(thread.updatedAt),
    },
  };
}

function normalizeContextSources(
  sources: UpsertDirectExecContextBundle["sources"],
  now = new Date(),
): DirectExecContextSourceFreshness[] {
  const nowMs = now.getTime();
  return sources.map((source) => {
    const fetchedAtMs = Date.parse(source.fetchedAt);
    const computedStale = Number.isFinite(fetchedAtMs)
      ? fetchedAtMs + source.maxAgeSeconds * 1000 < nowMs
      : true;
    return {
      sourceName: source.sourceName,
      sourceId: source.sourceId,
      fetchedAt: source.fetchedAt,
      maxAgeSeconds: source.maxAgeSeconds,
      stale: source.stale ?? computedStale,
      unavailableReason: source.unavailableReason ?? null,
      errorReason: source.errorReason ?? null,
    };
  });
}

function normalizeContextConflicts(conflicts: UpsertDirectExecContextBundle["conflicts"]): DirectExecContextConflict[] {
  return conflicts.map((entry) => ({
    ...entry,
    surfaced: entry.surfaced ?? true,
  }));
}

function freshSource(
  sourceName: string,
  sourceId: string,
  maxAgeSeconds: number,
  now = new Date(),
): DirectExecContextSourceFreshness {
  return {
    sourceName,
    sourceId,
    fetchedAt: now.toISOString(),
    maxAgeSeconds,
    stale: false,
    unavailableReason: null,
    errorReason: null,
  };
}

function unavailableSource(
  sourceName: string,
  sourceId: string,
  maxAgeSeconds: number,
  reason: string,
  now = new Date(),
): DirectExecContextSourceFreshness {
  return {
    sourceName,
    sourceId,
    fetchedAt: now.toISOString(),
    maxAgeSeconds,
    stale: true,
    unavailableReason: reason,
    errorReason: null,
  };
}

function contextItem(
  sourceName: string,
  sourceId: string,
  kind: string,
  data: Record<string, unknown>,
): DirectExecContextItem {
  return { sourceName, sourceId, kind, data };
}

async function updateIssueDirectExecState(
  db: Db,
  thread: typeof directExecThreads.$inferSelect,
) {
  if (!thread.issueId) return;
  const issue = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(eq(issues.id, thread.issueId))
    .then((rows) => rows[0] ?? null);
  if (!issue) return;
  await db
    .update(issues)
    .set({
      executionState: buildIssueExecutionState(issue.executionState, thread),
      updatedAt: new Date(),
    })
    .where(eq(issues.id, thread.issueId));
}

async function getIssueForThread(db: Db, issueId: string | null) {
  if (!issueId) return null;
  return db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

function toContextBundle(row: typeof directExecContextBundles.$inferSelect): DirectExecContextBundle {
  return {
    id: row.id,
    companyId: row.companyId,
    directExecThreadId: row.directExecThreadId,
    issueId: row.issueId,
    sources: row.sources,
    items: row.items,
    conflicts: row.conflicts,
    answerCategory: row.answerCategory as DirectExecContextBundle["answerCategory"],
    answerEvidence: row.answerEvidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getLatestBundle(db: Db, threadId: string) {
  const row = await db
    .select()
    .from(directExecContextBundles)
    .where(eq(directExecContextBundles.directExecThreadId, threadId))
    .orderBy(desc(directExecContextBundles.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? toContextBundle(row) : null;
}

export async function scrubExpiredDirectExecPayloads(
  db: Db,
  options: { now?: Date; limit?: number } = {},
): Promise<DirectExecRetentionScrubResult> {
  const now = options.now ?? new Date();
  const nowIso = isoNow(now);
  const rows = await db
    .select()
    .from(directExecThreads)
    .where(and(
      eq(directExecThreads.originKind, "direct_exec"),
      sql`${directExecThreads.lifecycle} ->> 'scrubStatus' = 'pending'`,
      sql`${directExecThreads.lifecycle} ->> 'retentionExpiresAt' IS NOT NULL`,
      sql`${directExecThreads.lifecycle} ->> 'retentionExpiresAt' <= ${nowIso}`,
    ))
    .limit(options.limit ?? 100);

  const scrubbedThreadIds: string[] = [];
  let scrubbedContextBundleCount = 0;

  for (const row of rows) {
    const lifecycle = row.lifecycle as DirectExecLifecycle;
    if (lifecycle.scrubStatus !== "pending" || !lifecycle.retentionExpiresAt) continue;
    if (Date.parse(lifecycle.retentionExpiresAt) > now.getTime()) continue;

    const scrubbedLifecycle: DirectExecLifecycle = {
      ...lifecycle,
      scrubStatus: "scrubbed",
      updatedAt: nowIso,
    };

    const scrubbedBundles = await db
      .update(directExecContextBundles)
      .set({
        items: [],
        conflicts: [],
        answerEvidence: {} as DirectExecAnswerEvidenceByCategory,
        updatedAt: now,
      })
      .where(eq(directExecContextBundles.directExecThreadId, row.id))
      .returning({ id: directExecContextBundles.id });
    scrubbedContextBundleCount += scrubbedBundles.length;

    const [updated] = await db
      .update(directExecThreads)
      .set({
        lifecycle: scrubbedLifecycle,
        updatedAt: now,
      })
      .where(eq(directExecThreads.id, row.id))
      .returning();
    if (!updated) continue;

    await updateIssueDirectExecState(db, updated);
    scrubbedThreadIds.push(row.id);
  }

  return { scrubbedThreadIds, scrubbedContextBundleCount };
}

async function hydrateThread(
  db: Db,
  row: typeof directExecThreads.$inferSelect,
  options: { includeIssue?: boolean; includeContextBundle?: boolean } = {},
): Promise<DirectExecThread> {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    originKind: "direct_exec",
    originId: row.originId,
    originRunId: row.originRunId,
    lifecycle: row.lifecycle as DirectExecLifecycle,
    issue: options.includeIssue ? await getIssueForThread(db, row.issueId) as DirectExecThread["issue"] : undefined,
    contextBundle: options.includeContextBundle ? await getLatestBundle(db, row.id) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getExistingByDedupe(db: Db, companyId: string, dedupeKey: string) {
  return db
    .select()
    .from(directExecThreads)
    .where(and(eq(directExecThreads.companyId, companyId), eq(directExecThreads.dedupeKey, dedupeKey)))
    .then((rows) => rows[0] ?? null);
}

async function getIssueByDirectExecOrigin(db: Db, companyId: string, originId: string) {
  return db
    .select()
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, "direct_exec"),
      eq(issues.originId, originId),
    ))
    .then((rows) => rows[0] ?? null);
}

async function findReferencedIssue(db: Db, companyId: string, ref: string) {
  const predicates = [eq(issues.identifier, ref)];
  if (isUuidLike(ref)) predicates.push(eq(issues.id, ref));
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), or(...predicates)))
    .then((rows) => rows[0] ?? null);
}

async function assemblePaperclipIssueContext(
  db: Db,
  companyId: string,
  ref: string,
  maxAgeSeconds: number,
) {
  const sourceName = "paperclip.issue";
  const issue = await findReferencedIssue(db, companyId, ref);
  if (!issue) {
    return {
      sources: [unavailableSource(sourceName, ref, maxAgeSeconds, "Referenced issue was not found")],
      items: [],
    };
  }

  const [labelRows, commentRows, documentRows, wakeRows] = await Promise.all([
    db
      .select({ name: labels.name, color: labels.color })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.issueId, issue.id))),
    db
      .select({
        id: issueComments.id,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
        createdByRunId: issueComments.createdByRunId,
        createdAt: issueComments.createdAt,
        updatedAt: issueComments.updatedAt,
      })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issue.id)))
      .orderBy(desc(issueComments.createdAt))
      .limit(20),
    db
      .select({
        documentId: documents.id,
        key: issueDocuments.key,
        title: documents.title,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        updatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issue.id))),
    db
      .select({
        id: agentWakeupRequests.id,
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
      )),
  ]);

  const runIds = [
    issue.checkoutRunId,
    issue.executionRunId,
    ...commentRows.map((comment) => comment.createdByRunId),
    ...wakeRows.map((wake) => wake.runId),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const runRows = runIds.length > 0
    ? await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, [...new Set(runIds)])))
    : [];

  return {
    sources: [freshSource(sourceName, issue.identifier ?? issue.id, maxAgeSeconds)],
    items: [
      contextItem(sourceName, issue.identifier ?? issue.id, "issue", {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        labelNames: labelRows.map((label) => label.name),
        checkoutRunId: issue.checkoutRunId,
        executionRunId: issue.executionRunId,
        updatedAt: issue.updatedAt.toISOString(),
      }),
      contextItem("paperclip.issue.comments", issue.identifier ?? issue.id, "comments", {
        comments: commentRows.map((comment) => ({
          id: comment.id,
          authorAgentId: comment.authorAgentId,
          authorUserId: comment.authorUserId,
          authorType: comment.authorType,
          createdByRunId: comment.createdByRunId,
          createdAt: comment.createdAt.toISOString(),
          updatedAt: comment.updatedAt.toISOString(),
        })),
      }),
      contextItem("paperclip.issue.documents", issue.identifier ?? issue.id, "documents", {
        documents: documentRows.map((document) => ({
          id: document.documentId,
          key: document.key,
          title: document.title,
          latestRevisionId: document.latestRevisionId,
          latestRevisionNumber: document.latestRevisionNumber,
          updatedAt: document.updatedAt.toISOString(),
        })),
      }),
      contextItem("agent_wakeup_requests", issue.identifier ?? issue.id, "wakeups", {
        wakeups: wakeRows.map((wake) => ({
          id: wake.id,
          agentId: wake.agentId,
          status: wake.status,
          runId: wake.runId,
          requestedAt: wake.requestedAt.toISOString(),
        })),
      }),
      contextItem("heartbeat_runs", issue.identifier ?? issue.id, "runs", {
        runs: runRows.map((run) => ({
          id: run.id,
          agentId: run.agentId,
          status: run.status,
          invocationSource: run.invocationSource,
          triggerDetail: run.triggerDetail,
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          createdAt: run.createdAt.toISOString(),
        })),
      }),
    ],
  };
}

export function directExecService(db: Db) {
  const issuesSvc = issueService(db);

  return {
    async createOrGetThread(companyId: string, input: CreateDirectExecThread) {
      const dedupeKey = input.dedupeKey ?? buildDirectExecDedupeKey(input.source);
      const existing = await getExistingByDedupe(db, companyId, dedupeKey);
      if (existing) {
        return {
          created: false,
          duplicate: true,
          thread: await hydrateThread(db, existing, { includeIssue: true, includeContextBundle: true }),
        };
      }

      const lifecycle = buildInitialLifecycle(input, dedupeKey);
      const [inserted] = await db
        .insert(directExecThreads)
        .values({
          companyId,
          issueId: null,
          originKind: "direct_exec",
          originId: dedupeKey,
          originRunId: input.originRunId ?? null,
          dedupeKey,
          sourceChannel: input.source.channel,
          sourceChatId: input.source.chatId,
          sourceMessageId: input.source.messageId,
          senderId: input.source.senderId,
          targetAlias: input.target.alias,
          visibility: input.visibility,
          lifecycleStatus: "accepted",
          lifecycle,
        })
        .onConflictDoNothing({
          target: [directExecThreads.companyId, directExecThreads.dedupeKey],
        })
        .returning();

      if (!inserted) {
        const raced = await getExistingByDedupe(db, companyId, dedupeKey);
        if (!raced) throw conflict("Direct-exec duplicate retry raced but no existing record was readable");
        return {
          created: false,
          duplicate: true,
          thread: await hydrateThread(db, raced, { includeIssue: true, includeContextBundle: true }),
        };
      }

      try {
        const existingIssue = await getIssueByDirectExecOrigin(db, companyId, dedupeKey);
        const issue = existingIssue ?? await issuesSvc.create(companyId, {
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
          title: input.title,
          description: input.description ?? null,
          status: "todo",
          workMode: "standard",
          priority: input.priority ?? "medium",
          originKind: "direct_exec",
          originId: dedupeKey,
          originRunId: input.originRunId ?? null,
          originFingerprint: dedupeKey,
          executionState: {
            directExec: {
              threadId: inserted.id,
              status: "accepted",
              contextBundleId: null,
              wakeReceiptIds: [],
              responseIds: [],
              deliveryReceiptIds: [],
              timeoutAt: lifecycle.timeoutAt,
              retentionExpiresAt: lifecycle.retentionExpiresAt,
              scrubStatus: lifecycle.scrubStatus,
              updatedAt: lifecycle.updatedAt,
            },
          },
        });
        const [linked] = await db
          .update(directExecThreads)
          .set({
            issueId: issue.id,
            updatedAt: new Date(),
          })
          .where(eq(directExecThreads.id, inserted.id))
          .returning();
        if (linked) await updateIssueDirectExecState(db, linked);
        return {
          created: true,
          duplicate: false,
          thread: await hydrateThread(db, linked ?? inserted, { includeIssue: true, includeContextBundle: true }),
        };
      } catch (error) {
        await db.delete(directExecThreads).where(eq(directExecThreads.id, inserted.id));
        throw error;
      }
    },

    async getThread(id: string) {
      const row = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? hydrateThread(db, row, { includeIssue: true, includeContextBundle: true }) : null;
    },

    async getThreadByIssueId(issueId: string) {
      const row = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.issueId, issueId))
        .then((rows) => rows[0] ?? null);
      return row ? hydrateThread(db, row, { includeIssue: true, includeContextBundle: true }) : null;
    },

    async listThreads(companyId: string, filters: { originId?: string; dedupeKey?: string } = {}) {
      const conditions = [eq(directExecThreads.companyId, companyId), eq(directExecThreads.originKind, "direct_exec")];
      if (filters.originId) conditions.push(eq(directExecThreads.originId, filters.originId));
      if (filters.dedupeKey) conditions.push(eq(directExecThreads.dedupeKey, filters.dedupeKey));
      const rows = await db
        .select()
        .from(directExecThreads)
        .where(and(...conditions))
        .orderBy(desc(directExecThreads.createdAt));
      return Promise.all(rows.map((row) => hydrateThread(db, row, { includeIssue: true })));
    },

    async updateLifecycle(id: string, input: UpdateDirectExecLifecycle) {
      const existing = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Direct-exec thread not found");

      const currentLifecycle = existing.lifecycle as DirectExecLifecycle;
      assertDirectExecStatusTransition(currentLifecycle.status, input.status);
      const nextLifecycle: DirectExecLifecycle = {
        ...currentLifecycle,
        status: input.status,
        statusReason: input.statusReason ?? null,
        contextBundleId: input.contextBundleId !== undefined ? input.contextBundleId : currentLifecycle.contextBundleId,
        wakeReceiptIds: input.wakeReceiptIds ?? currentLifecycle.wakeReceiptIds,
        responseIds: input.responseIds ?? currentLifecycle.responseIds,
        deliveryReceipts: input.deliveryReceipts ?? currentLifecycle.deliveryReceipts,
        timeoutAt: input.timeoutAt !== undefined ? input.timeoutAt : currentLifecycle.timeoutAt,
        retentionExpiresAt: input.retentionExpiresAt !== undefined ? input.retentionExpiresAt : currentLifecycle.retentionExpiresAt,
        scrubStatus: input.scrubStatus ?? currentLifecycle.scrubStatus,
        updatedAt: isoNow(),
      };

      const [updated] = await db
        .update(directExecThreads)
        .set({
          lifecycleStatus: nextLifecycle.status,
          lifecycle: nextLifecycle,
          updatedAt: new Date(),
        })
        .where(eq(directExecThreads.id, id))
        .returning();
      if (!updated) throw notFound("Direct-exec thread not found");
      await updateIssueDirectExecState(db, updated);
      return hydrateThread(db, updated, { includeIssue: true, includeContextBundle: true });
    },

    async upsertContextBundle(id: string, input: UpsertDirectExecContextBundle) {
      const parsed = upsertDirectExecContextBundleSchema.parse(input);
      const thread = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Direct-exec thread not found");
      if (!thread.issueId) throw unprocessable("Direct-exec thread is not linked to a Paperclip issue");

      const sources = normalizeContextSources(parsed.sources);
      const conflicts = normalizeContextConflicts(parsed.conflicts);
      const [bundle] = await db
        .insert(directExecContextBundles)
        .values({
          companyId: thread.companyId,
          directExecThreadId: thread.id,
          issueId: thread.issueId,
          sources,
          items: parsed.items,
          conflicts,
          answerCategory: parsed.answerCategory ?? null,
          answerEvidence: parsed.answerEvidence,
        })
        .returning();

      await this.updateLifecycle(thread.id, {
        status: (thread.lifecycle as DirectExecLifecycle).status,
        statusReason: null,
        contextBundleId: bundle.id,
      });

      return toContextBundle(bundle);
    },

    async assembleContextBundle(id: string, input: AssembleDirectExecContextBundle) {
      const parsed = assembleDirectExecContextBundleSchema.parse(input);
      const thread = await db
        .select()
        .from(directExecThreads)
        .where(eq(directExecThreads.id, id))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Direct-exec thread not found");
      if (!thread.issueId) throw unprocessable("Direct-exec thread is not linked to a Paperclip issue");

      const lifecycle = thread.lifecycle as DirectExecLifecycle;
      const thresholds = lifecycle.thresholds;
      const assembledSources: DirectExecContextSourceFreshness[] = [];
      const assembledItems: DirectExecContextItem[] = [];

      for (const issueRef of parsed.issueRefs) {
        const assembled = await assemblePaperclipIssueContext(
          db,
          thread.companyId,
          issueRef,
          thresholds.paperclipReadMaxAgeSeconds,
        );
        assembledSources.push(...assembled.sources);
        assembledItems.push(...assembled.items);
      }

      for (const agentId of parsed.targetAgentIds) {
        const runs = await db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            invocationSource: heartbeatRuns.invocationSource,
            triggerDetail: heartbeatRuns.triggerDetail,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, thread.companyId), eq(heartbeatRuns.agentId, agentId)))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(5);
        assembledSources.push(freshSource("target_agent.heartbeat_runs", agentId, thresholds.heartbeatFreshSeconds));
        assembledItems.push(contextItem("target_agent.heartbeat_runs", agentId, "runs", {
          runs: runs.map((run) => ({
            id: run.id,
            agentId: run.agentId,
            status: run.status,
            invocationSource: run.invocationSource,
            triggerDetail: run.triggerDetail,
            startedAt: run.startedAt?.toISOString() ?? null,
            finishedAt: run.finishedAt?.toISOString() ?? null,
            createdAt: run.createdAt.toISOString(),
          })),
        }));
      }

      for (const runtimeRef of parsed.runtimeRefs) {
        assembledSources.push(unavailableSource(
          runtimeRef.kind,
          runtimeRef.id,
          thresholds.runtimeStatusMaxAgeSeconds,
          "Runtime status is only assembled when a named Paperclip issue or runtime adapter supplies live status evidence",
        ));
      }

      if (assembledSources.length === 0) {
        assembledSources.push(unavailableSource(
          "paperclip.issue",
          thread.issueId,
          thresholds.paperclipReadMaxAgeSeconds,
          "No referenced Paperclip issue, target agent, or runtime id was supplied for assembly",
        ));
      }

      return this.upsertContextBundle(thread.id, {
        sources: assembledSources,
        items: assembledItems,
        conflicts: [],
        answerCategory: parsed.answerCategory,
        answerEvidence: parsed.answerEvidence,
      });
    },
  };
}
