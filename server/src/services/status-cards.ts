import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  agents,
  documentRevisions,
  documents,
  issues,
  statusCards,
  statusCardUpdates,
  type Db,
} from "@paperclipai/db";
import type {
  CreateStatusCard,
  PatchStatusCard,
  WriteStatusCardQuery,
  WriteStatusCardSummary,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { builtInAgentService } from "./built-in-agents.js";
import { companySearchService } from "./company-search.js";
import { issueService } from "./issues.js";
import { SUMMARIZER_BUILT_IN_KEY } from "./summary-slots.js";

type StatusCardActor = { agentId: string | null; userId: string | null };
type StatusCardWriter = { agentId: string | null; runId: string | null };
type StatusCardRow = typeof statusCards.$inferSelect;

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

function promptHash(prompt: string) {
  return createHash("sha256").update(prompt).digest("hex");
}

function compilePayload(card: StatusCardRow, generationIssueId: string | null, hash: string) {
  return {
    statusCardId: card.id,
    companyId: card.companyId,
    generationIssueId,
    promptHash: hash,
  };
}

function compileDescription(card: StatusCardRow, generationIssueId: string | null, hash: string) {
  const payload = compilePayload(card, generationIssueId, hash);
  return `Compile this status-card interest prompt into structured Paperclip company-search queries, then continue in the same run and write the first full summary.

Use the bundled \`status-card-query\` skill. Resolve named projects and labels to ids. Keep queries narrow, cap limits, and preserve union semantics across the query array.

## Interest prompt

${card.interestPrompt}

## Required write-back sequence

1. \`PUT /api/status-cards/${card.id}/query\` with \`queries\`, an auto-title, a non-empty \`changeSummary\`, and \`generationIssueId\`.
2. Execute the compiled scope and write the first full Markdown summary with \`PUT /api/status-cards/${card.id}/summary\` using the same \`generationIssueId\`. Do not create or wait for a second task.

Both writes must happen from this assigned issue run.

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;
}

function parseCompilePayload(description: string | null) {
  const match = description?.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function statusCardService(db: Db) {
  const builtIns = builtInAgentService(db);
  const issuesSvc = issueService(db);
  const searchSvc = companySearchService(db);

  async function list(companyId: string, archived: boolean) {
    return db
      .select()
      .from(statusCards)
      .where(and(eq(statusCards.companyId, companyId), archived ? isNotNull(statusCards.archivedAt) : isNull(statusCards.archivedAt)))
      .orderBy(desc(statusCards.updatedAt));
  }

  async function getById(id: string) {
    return db.select().from(statusCards).where(eq(statusCards.id, id)).then((rows) => rows[0] ?? null);
  }

  async function create(companyId: string, input: CreateStatusCard, actor: StatusCardActor) {
    return db
      .insert(statusCards)
      .values({
        companyId,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.userId,
        title: input.title ?? null,
        titlePinned: input.titlePinned,
        interestPrompt: input.interestPrompt,
        instructionsMode: input.instructionsMode,
        instructions: input.instructions ?? null,
        refreshPolicy: input.refreshPolicy,
        state: "compiling",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function update(card: StatusCardRow, input: PatchStatusCard, actor: StatusCardActor) {
    const now = new Date();
    const archiveChanged = input.archived !== undefined && input.archived !== Boolean(card.archivedAt);
    const values: Partial<typeof statusCards.$inferInsert> = {
      updatedAt: now,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.titlePinned !== undefined ? { titlePinned: input.titlePinned } : {}),
      ...(input.interestPrompt !== undefined
        ? { interestPrompt: input.interestPrompt, state: "compiling", failureReason: null }
        : {}),
      ...(input.instructionsMode !== undefined ? { instructionsMode: input.instructionsMode } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.refreshPolicy !== undefined ? { refreshPolicy: input.refreshPolicy } : {}),
      ...(archiveChanged && input.archived
        ? { archivedAt: now, archivedByAgentId: actor.agentId, archivedByUserId: actor.userId, nextEvalAt: null }
        : {}),
      ...(archiveChanged && !input.archived
        ? { archivedAt: null, archivedByAgentId: null, archivedByUserId: null, lastChangeAt: now }
        : {}),
    };
    return db.update(statusCards).set(values).where(eq(statusCards.id, card.id)).returning().then((rows) => rows[0]!);
  }

  async function remove(id: string) {
    return db.delete(statusCards).where(eq(statusCards.id, id)).returning().then((rows) => rows[0] ?? null);
  }

  async function listUpdates(cardId: string) {
    return db.select().from(statusCardUpdates).where(eq(statusCardUpdates.cardId, cardId)).orderBy(desc(statusCardUpdates.startedAt));
  }

  async function requestCompile(cardId: string, actor: StatusCardActor) {
    const card = await getById(cardId);
    if (!card) throw notFound("Status card not found");
    if (card.archivedAt) throw unprocessable("Archived status cards cannot be compiled");
    const builtIn = await builtIns.get(card.companyId, SUMMARIZER_BUILT_IN_KEY);
    if (builtIn.status !== "ready" || !builtIn.agentId) {
      throw unprocessable("Summarizer built-in agent is not configured", {
        code: "summarizer_not_configured",
        status: builtIn.status,
      });
    }

    const hash = promptHash(card.interestPrompt);
    if (card.generatingIssueId) {
      const active = await db.select().from(issues).where(eq(issues.id, card.generatingIssueId)).then((rows) => rows[0] ?? null);
      const payload = parseCompilePayload(active?.description ?? null);
      if (active && !TERMINAL_ISSUE_STATUSES.has(active.status) && payload?.promptHash === hash) {
        return { card, generatingIssue: active, alreadyGenerating: true };
      }
    }

    let deduplicated = false;
    const createdAt = new Date();
    const created = await issuesSvc.create(card.companyId, {
      title: `Compile status card: ${card.title ?? card.interestPrompt.slice(0, 80)}`,
      description: compileDescription(card, null, hash),
      status: "todo",
      priority: "medium",
      assigneeAgentId: builtIn.agentId,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.userId,
      hiddenAt: createdAt,
      idempotencyKey: `status-card-compile:${card.id}:${hash}`,
      onDeduplicated: (reason) => {
        deduplicated = reason === "idempotency_key";
      },
    });
    const reopened = deduplicated && TERMINAL_ISSUE_STATUSES.has(created.status)
      ? await issuesSvc.update(created.id, { status: "todo", assigneeAgentId: builtIn.agentId })
      : created;
    const generationIssue = await issuesSvc.update(reopened!.id, {
      description: compileDescription(card, reopened!.id, hash),
    });
    const [nextCard] = await db
      .update(statusCards)
      .set({ generatingIssueId: generationIssue!.id, state: "compiling", failureReason: null, updatedAt: createdAt })
      .where(eq(statusCards.id, card.id))
      .returning();
    return {
      card: nextCard!,
      generatingIssue: generationIssue!,
      alreadyGenerating: deduplicated && !TERMINAL_ISSUE_STATUSES.has(created.status),
    };
  }

  async function assertSummarizerWriter(card: StatusCardRow, generationIssueId: string, actor: StatusCardWriter) {
    if (!actor.agentId) throw forbidden("Only the Summarizer built-in agent may write status cards");
    const agent = await db.select().from(agents).where(eq(agents.id, actor.agentId)).then((rows) => rows[0] ?? null);
    if (!agent || agent.companyId !== card.companyId || readBuiltInAgentMarker(agent.metadata)?.key !== SUMMARIZER_BUILT_IN_KEY) {
      throw forbidden("Only the Summarizer built-in agent may write status cards");
    }
    if (!card.generatingIssueId || card.generatingIssueId !== generationIssueId) {
      throw forbidden("Status-card write does not match the active generation task");
    }
    const issue = await db.select().from(issues).where(eq(issues.id, generationIssueId)).then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== card.companyId || issue.assigneeAgentId !== actor.agentId) {
      throw forbidden("Generation task is not assigned to this agent");
    }
    if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
      throw forbidden("Generation task is no longer active");
    }
    const payload = parseCompilePayload(issue.description);
    if (payload?.statusCardId !== card.id || payload?.companyId !== card.companyId || payload?.generationIssueId !== generationIssueId) {
      throw forbidden("Generation task does not target this status card");
    }
    if (!actor.runId || (issue.checkoutRunId !== actor.runId && issue.executionRunId !== actor.runId)) {
      throw forbidden("Status-card write must run from the linked generation task");
    }
  }

  async function writeQuery(cardId: string, input: WriteStatusCardQuery, actor: StatusCardWriter) {
    const card = await getById(cardId);
    if (!card) throw notFound("Status card not found");
    await assertSummarizerWriter(card, input.generationIssueId, actor);
    const now = new Date();
    return db.transaction(async (tx) => {
      const current = await tx.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0] ?? null);
      if (!current || current.generatingIssueId !== input.generationIssueId) {
        throw conflict("Status-card compilation was superseded by a newer task");
      }
      const generationIssue = await tx.select().from(issues).where(eq(issues.id, input.generationIssueId)).then((rows) => rows[0] ?? null);
      if (!generationIssue || TERMINAL_ISSUE_STATUSES.has(generationIssue.status)) {
        throw forbidden("Generation task is no longer active");
      }
      const queryVersion = current.queryVersion + 1;
      const [next] = await tx
        .update(statusCards)
        .set({
          queries: input.queries,
          queryVersion,
          queryCompiledAt: now,
          queryCompiledByAgentId: actor.agentId,
          title: current.titlePinned ? current.title : input.title,
          state: "compiling",
          failureReason: null,
          updatedAt: now,
        })
        .where(and(eq(statusCards.id, current.id), eq(statusCards.generatingIssueId, input.generationIssueId)))
        .returning();
      if (!next) throw conflict("Status-card compilation was superseded by a newer task");
      await tx.insert(statusCardUpdates).values({
        cardId: current.id,
        kind: "compile",
        trigger: "manual",
        generationIssueId: input.generationIssueId,
        runId: actor.runId,
        status: "ok",
        finishedAt: now,
        queryVersion,
        changeSummary: input.changeSummary,
      });
      return next;
    });
  }

  async function writeSummary(cardId: string, input: WriteStatusCardSummary, actor: StatusCardWriter) {
    const card = await getById(cardId);
    if (!card) throw notFound("Status card not found");
    await assertSummarizerWriter(card, input.generationIssueId, actor);
    if (card.queries.length === 0) throw conflict("Compile the status-card query before writing its summary");
    const now = new Date();
    return db.transaction(async (tx) => {
      const current = await tx.select().from(statusCards).where(eq(statusCards.id, card.id)).then((rows) => rows[0] ?? null);
      if (!current || current.generatingIssueId !== input.generationIssueId) {
        throw conflict("Status-card generation was superseded by a newer task");
      }
      const generationIssue = await tx.select().from(issues).where(eq(issues.id, input.generationIssueId)).then((rows) => rows[0] ?? null);
      if (!generationIssue || TERMINAL_ISSUE_STATUSES.has(generationIssue.status)) {
        throw forbidden("Generation task is no longer active");
      }
      const existing = current.documentId
        ? await tx.select().from(documents).where(and(eq(documents.id, current.documentId), eq(documents.companyId, current.companyId))).then((rows) => rows[0] ?? null)
        : null;
      let document = existing;
      const revisionNumber = (existing?.latestRevisionNumber ?? 0) + 1;
      if (!document) {
        [document] = await tx.insert(documents).values({
          companyId: current.companyId,
          title: input.title ?? current.title,
          format: "markdown",
          latestBody: input.markdown,
          latestRevisionNumber: revisionNumber,
          createdByAgentId: actor.agentId,
          updatedByAgentId: actor.agentId,
          createdAt: now,
          updatedAt: now,
        }).returning();
      }
      const [revision] = await tx.insert(documentRevisions).values({
        companyId: current.companyId,
        documentId: document!.id,
        revisionNumber,
        title: input.title ?? current.title,
        format: "markdown",
        body: input.markdown,
        changeSummary: input.changeSummary,
        createdByAgentId: actor.agentId,
        createdByRunId: actor.runId,
        createdAt: now,
      }).returning();
      [document] = await tx.update(documents).set({
        title: input.title ?? current.title,
        latestBody: input.markdown,
        latestRevisionId: revision.id,
        latestRevisionNumber: revisionNumber,
        updatedByAgentId: actor.agentId,
        updatedAt: now,
      }).where(eq(documents.id, document!.id)).returning();
      const [next] = await tx.update(statusCards).set({
        documentId: document!.id,
        state: "active",
        generatingIssueId: null,
        failureReason: null,
        lastUpdateRunKind: "full",
        lastGeneratedAt: now,
        lastModel: input.model ?? null,
        updatedAt: now,
      }).where(and(eq(statusCards.id, current.id), eq(statusCards.generatingIssueId, input.generationIssueId))).returning();
      if (!next) throw conflict("Status-card generation was superseded by a newer task");
      await tx.insert(statusCardUpdates).values({
        cardId: current.id,
        kind: "full",
        trigger: "manual",
        generationIssueId: input.generationIssueId,
        runId: actor.runId,
        status: "ok",
        finishedAt: now,
        model: input.model ?? null,
        queryVersion: current.queryVersion,
        changeSummary: input.changeSummary,
      });
      return { card: next, document, revision };
    });
  }

  async function dryRun(card: StatusCardRow) {
    return Promise.all(card.queries.map(async (query) => ({ query, result: await searchSvc.search(card.companyId, query) })));
  }

  return { list, getById, create, update, remove, listUpdates, requestCompile, writeQuery, writeSummary, dryRun };
}
