import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentRevisions,
  documents,
  issues,
  projectWorkspaces,
  projects,
  summarySlots,
} from "@paperclipai/db";
import {
  type GenerateSummarySlotResponse,
  type GetSummarySlotResponse,
  type IssueStatus,
  type ListSummarySlotRevisionsResponse,
  type SummarySlot,
  type SummarySlotDocument,
  type SummarySlotIssueRef,
  type SummarySlotRevision,
  type SummarySlotScopeKind,
  type SummarySlotScopeSelector,
  summarySlotScopeSelectorSchema,
  type WriteSummarySlotResponse,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { builtInAgentService } from "./built-in-agents.js";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";

/** Built-in agent key for the Summarizer bundle (see PAP-13920). */
export const SUMMARIZER_BUILT_IN_KEY = "summarizer";

/** Generation issues in these statuses are no longer active and can be superseded. */
const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

const DEFAULT_SUMMARY_FORMAT = "markdown";
const SUMMARY_SLOT_REVISION_LIMIT = 20;
const SUMMARY_SNAPSHOT_GROUP_LIMIT = 12;
const SUMMARY_SNAPSHOT_INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SummarySlotSelectorInput {
  companyId: string;
  scopeKind: string;
  slotKey: string;
  scopeId?: string | null;
}

export interface SummaryGenerateActor {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

export interface SummaryWriteActor {
  agentId?: string | null;
  runId?: string | null;
}

type ResolvedSelector = SummarySlotScopeSelector & {
  companyId: string;
  scopeId: string | null;
};

type SummarySlotRow = typeof summarySlots.$inferSelect;

function mapSlot(row: SummarySlotRow): SummarySlot {
  return {
    id: row.id,
    companyId: row.companyId,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId ?? null,
    slotKey: row.slotKey,
    documentId: row.documentId ?? null,
    status: row.status,
    failureReason: row.failureReason ?? null,
    generatingIssueId: row.generatingIssueId ?? null,
    lastGeneratedAt: row.lastGeneratedAt ?? null,
    lastGeneratedByAgentId: row.lastGeneratedByAgentId ?? null,
    lastModel: row.lastModel ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapDocument(row: typeof documents.$inferSelect): SummarySlotDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title ?? null,
    format: row.format as SummarySlotDocument["format"],
    body: row.latestBody,
    latestRevisionId: row.latestRevisionId ?? null,
    latestRevisionNumber: row.latestRevisionNumber,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRevision(row: typeof documentRevisions.$inferSelect): SummarySlotRevision {
  return {
    id: row.id,
    companyId: row.companyId,
    documentId: row.documentId,
    revisionNumber: row.revisionNumber,
    title: row.title ?? null,
    format: row.format as SummarySlotRevision["format"],
    body: row.body,
    changeSummary: row.changeSummary ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
  };
}

function scopeLabel(scopeKind: SummarySlotScopeKind): string {
  switch (scopeKind) {
    case "project":
      return "project";
    case "project_workspace":
      return "workspace";
    case "workspaces_overview":
      return "workspaces overview";
    default:
      return "target";
  }
}

export function summarySlotService(db: Db) {
  const builtIns = builtInAgentService(db);
  const agents = agentService(db);
  const issuesSvc = issueService(db);

  function resolveSelector(input: SummarySlotSelectorInput): ResolvedSelector {
    const parsed = summarySlotScopeSelectorSchema.safeParse({
      scopeKind: input.scopeKind,
      slotKey: input.slotKey,
      scopeId: input.scopeId ?? undefined,
    });
    if (!parsed.success) {
      throw unprocessable("Invalid summary slot selector", parsed.error.issues);
    }
    return {
      ...parsed.data,
      companyId: input.companyId,
      scopeId: parsed.data.scopeId ?? null,
    };
  }

  /** Enforce that the scope target exists inside the company boundary. */
  async function assertTargetVisible(sel: ResolvedSelector): Promise<void> {
    if (sel.scopeKind === "workspaces_overview") return;
    if (!sel.scopeId) {
      // Guaranteed by the selector schema, but keep the invariant explicit.
      throw unprocessable(`${sel.scopeKind} summary slots require scopeId`);
    }
    if (sel.scopeKind === "project") {
      const row = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, sel.scopeId), eq(projects.companyId, sel.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Summary target not found");
      return;
    }
    if (sel.scopeKind === "project_workspace") {
      const row = await db
        .select({ id: projectWorkspaces.id })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, sel.scopeId), eq(projectWorkspaces.companyId, sel.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Summary target not found");
    }
  }

  function findSlotRow(sel: ResolvedSelector) {
    return db
      .select()
      .from(summarySlots)
      .where(
        and(
          eq(summarySlots.companyId, sel.companyId),
          eq(summarySlots.scopeKind, sel.scopeKind),
          eq(summarySlots.slotKey, sel.slotKey),
          sel.scopeId === null ? isNull(summarySlots.scopeId) : eq(summarySlots.scopeId, sel.scopeId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function loadDocument(companyId: string, documentId: string | null) {
    if (!documentId) return null;
    return db
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssueRef(companyId: string, issueId: string | null): Promise<{
    ref: SummarySlotIssueRef | null;
    row: typeof issues.$inferSelect | null;
  }> {
    if (!issueId) return { ref: null, row: null };
    const row = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return { ref: null, row: null };
    return {
      row,
      ref: {
        id: row.id,
        identifier: row.identifier ?? null,
        title: row.title,
        status: row.status as IssueStatus,
        assigneeAgentId: row.assigneeAgentId ?? null,
      },
    };
  }

  function isIssueActive(row: typeof issues.$inferSelect | null): boolean {
    return !!row && !TERMINAL_ISSUE_STATUSES.has(row.status as IssueStatus);
  }

  async function getSlot(input: SummarySlotSelectorInput): Promise<GetSummarySlotResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);
    const slotRow = await findSlotRow(sel);
    if (!slotRow) return { slot: null, document: null, generatingIssue: null };
    const [documentRow, issueRef] = await Promise.all([
      loadDocument(sel.companyId, slotRow.documentId ?? null),
      loadIssueRef(sel.companyId, slotRow.generatingIssueId ?? null),
    ]);
    return {
      slot: mapSlot(slotRow),
      document: documentRow ? mapDocument(documentRow) : null,
      generatingIssue: issueRef.ref,
    };
  }

  async function listRevisions(input: SummarySlotSelectorInput): Promise<ListSummarySlotRevisionsResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);
    const slotRow = await findSlotRow(sel);
    if (!slotRow || !slotRow.documentId) {
      return { slot: slotRow ? mapSlot(slotRow) : null, revisions: [] };
    }
    const revisions = await db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, slotRow.documentId),
          eq(documentRevisions.companyId, sel.companyId),
        ),
      )
      .orderBy(desc(documentRevisions.revisionNumber))
      .limit(SUMMARY_SLOT_REVISION_LIMIT);
    return { slot: mapSlot(slotRow), revisions: revisions.map(mapRevision) };
  }

  async function upsertSlot(
    sel: ResolvedSelector,
    patch: Partial<typeof summarySlots.$inferInsert>,
  ): Promise<SummarySlotRow> {
    const now = new Date();
    const [slot] = await db
      .insert(summarySlots)
      .values({
        companyId: sel.companyId,
        scopeKind: sel.scopeKind,
        scopeId: sel.scopeId,
        slotKey: sel.slotKey,
        status: "idle",
        createdAt: now,
        updatedAt: now,
        ...patch,
      })
      .onConflictDoUpdate({
        target: [
          summarySlots.companyId,
          summarySlots.scopeKind,
          summarySlots.scopeId,
          summarySlots.slotKey,
        ],
        set: { ...patch, updatedAt: now },
      })
      .returning();
    return slot;
  }

  async function resolveGenerationTargetProject(sel: ResolvedSelector): Promise<{
    projectId: string | null;
    projectWorkspaceId: string | null;
  }> {
    if (sel.scopeKind === "project") {
      return { projectId: sel.scopeId, projectWorkspaceId: null };
    }
    if (sel.scopeKind === "project_workspace" && sel.scopeId) {
      const row = await db
        .select({ projectId: projectWorkspaces.projectId })
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, sel.scopeId), eq(projectWorkspaces.companyId, sel.companyId)))
        .then((rows) => rows[0] ?? null);
      return { projectId: row?.projectId ?? null, projectWorkspaceId: sel.scopeId };
    }
    return { projectId: null, projectWorkspaceId: null };
  }

  function scopeIssueConditions(sel: ResolvedSelector) {
    if (sel.scopeKind === "project") return [eq(issues.projectId, sel.scopeId!)];
    if (sel.scopeKind === "project_workspace") return [eq(issues.projectWorkspaceId, sel.scopeId!)];
    return [];
  }

  async function buildScopeSnapshot(sel: ResolvedSelector, previousGeneratedAt: Date | null): Promise<string> {
    const commonConditions = [
      eq(issues.companyId, sel.companyId),
      isNull(issues.hiddenAt),
      ...scopeIssueConditions(sel),
    ];
    const recentlyDoneSince = previousGeneratedAt
      ?? new Date(Date.now() - SUMMARY_SNAPSHOT_INITIAL_LOOKBACK_MS);
    const selectFields = {
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      updatedAt: issues.updatedAt,
    };

    const [blocked, inReview, inProgress, recentlyDone] = await Promise.all([
      db.select(selectFields).from(issues)
        .where(and(...commonConditions, eq(issues.status, "blocked")))
        .orderBy(desc(issues.updatedAt)).limit(SUMMARY_SNAPSHOT_GROUP_LIMIT),
      db.select(selectFields).from(issues)
        .where(and(...commonConditions, eq(issues.status, "in_review")))
        .orderBy(desc(issues.updatedAt)).limit(SUMMARY_SNAPSHOT_GROUP_LIMIT),
      db.select(selectFields).from(issues)
        .where(and(...commonConditions, eq(issues.status, "in_progress")))
        .orderBy(desc(issues.updatedAt)).limit(SUMMARY_SNAPSHOT_GROUP_LIMIT),
      db.select(selectFields).from(issues)
        .where(and(
          ...commonConditions,
          inArray(issues.status, ["done"]),
          gte(issues.updatedAt, recentlyDoneSince),
        ))
        .orderBy(desc(issues.updatedAt)).limit(SUMMARY_SNAPSHOT_GROUP_LIMIT),
    ]);

    const formatGroup = (
      heading: string,
      rows: Array<typeof blocked[number]>,
    ) => [
      `### ${heading}`,
      ...(rows.length > 0
        ? rows.map((row) => {
            const identifier = row.identifier ?? "Unnumbered issue";
            const companyPrefix = row.identifier?.split("-", 1)[0];
            const issueLink = companyPrefix
              ? `[${identifier}](/${companyPrefix}/issues/${identifier})`
              : identifier;
            return `- ${issueLink} — ${row.title} (${row.priority}; updated ${row.updatedAt.toISOString()})`;
          })
        : ["- None."]),
    ];

    return [
      "## Prebuilt scope snapshot",
      "",
      `Snapshot generated at ${new Date().toISOString()}. Recently done means updated since ${recentlyDoneSince.toISOString()}.`,
      "Use this bounded, company-scoped snapshot as the issue source of truth for this run. Do not call issue-list endpoints.",
      "",
      ...formatGroup("Blocked", blocked),
      "",
      ...formatGroup("In review", inReview),
      "",
      ...formatGroup("In progress", inProgress),
      "",
      ...formatGroup("Recently done", recentlyDone),
    ].join("\n");
  }

  function generationIssueDescription(
    sel: ResolvedSelector,
    scopeSnapshot: string,
    generationIssueId: string | null = null,
  ): string {
    const target = sel.scopeId ? `\`${sel.scopeId}\`` : "the workspaces overview";
    const summarySlotPath = `/api/companies/${encodeURIComponent(sel.companyId)}/summary-slots/${encodeURIComponent(sel.scopeKind)}/${encodeURIComponent(sel.slotKey)}`;
    const scopeQuery = sel.scopeId ? `?scopeId=${encodeURIComponent(sel.scopeId)}` : "";
    return [
      `Generate the ${scopeLabel(sel.scopeKind)} summary for ${target}.`,
      "",
      "Call `/summarize-status`. Its API quick reference has the full request shapes; use these resolved routes for this generation:",
      "",
      `- Read current slot: \`GET ${summarySlotPath}${scopeQuery}\``,
      `- Write revision: \`PUT ${summarySlotPath}\``,
      "",
      "Use this write payload:",
      "",
      "```json",
      JSON.stringify(
        {
          scopeKind: sel.scopeKind,
          scopeId: sel.scopeId,
          slotKey: sel.slotKey,
          generationIssueId,
        },
        null,
        2,
      ),
      "```",
      "",
      "Write one short, colloquial Markdown summary that opens with a `**Decide:**` block: at most two bullets, each giving the decision's context, a link, and an `**I suggest:**` recommendation, then one or two plain-prose paragraphs on the (max two) things that matter most. If nothing needs a decision, open with one `**Nothing to decide right now.**` line followed by a `**Review:**` block (at most two bullets) that triages what is waiting on review — what the reader can approve on a skim vs what needs their eyes — each with a link and an `**I suggest:**` recommendation; if nothing is in review either, one clause naming the next event worth watching. End the summary with a `**Recent work:**` block: at most two bullets, one line each, naming a recent piece of work and where it stands in plain language. Reference at most three or four issues inline; never a trailing list of issue links or any link dump. Not a task list.",
      "The current-slot response includes the latest document body and `latestRevisionId`; do not call the revisions or issues-list endpoints.",
      "Follow the skill's streaming protocol: emit the first plain-text `STATUS:` line immediately — named from the first task in the snapshot, before any analysis — keep emitting `STATUS:` lines as you think, and emit the sentinel-wrapped summary draft before the authoritative summary-slot write.",
      "Pass the `generationIssueId` from the payload, the previous revision id when present, and the model actually used to the summary-slot write API.",
      "",
      scopeSnapshot,
      "",
      "Close this task with a short comment once the summary revision is written.",
    ].join("\n");
  }

  function generationIssueTitle(sel: ResolvedSelector, createdAt = new Date()): string {
    const timestamp = createdAt.toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");
    return `Summarize ${scopeLabel(sel.scopeKind)} on ${timestamp}`;
  }

  async function generate(
    input: SummarySlotSelectorInput,
    actor: SummaryGenerateActor,
  ): Promise<GenerateSummarySlotResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);

    const builtIn = await builtIns.get(sel.companyId, SUMMARIZER_BUILT_IN_KEY);
    if (builtIn.status !== "ready" || !builtIn.agentId) {
      throw unprocessable("Summarizer built-in agent is not configured", {
        code: "summarizer_not_configured",
        status: builtIn.status,
      });
    }
    const summarizerAgentId = builtIn.agentId;

    // Dedupe: if a generation is already active, return the in-flight state.
    const existing = await findSlotRow(sel);
    if (existing && existing.status === "generating" && existing.generatingIssueId) {
      const active = await loadIssueRef(sel.companyId, existing.generatingIssueId);
      if (isIssueActive(active.row)) {
        return {
          slot: mapSlot(existing),
          generatingIssue: active.ref!,
          alreadyGenerating: true,
        };
      }
    }

    const { projectId, projectWorkspaceId } = await resolveGenerationTargetProject(sel);
    const scopeSnapshot = await buildScopeSnapshot(sel, existing?.lastGeneratedAt ?? null);
    const createdAt = new Date();
    const generationVersion = existing?.generatingIssueId ?? existing?.updatedAt.toISOString() ?? "initial";
    let issueDeduplicated = false;
    const created = await issuesSvc.create(sel.companyId, {
      projectId,
      projectWorkspaceId,
      title: generationIssueTitle(sel, createdAt),
      description: generationIssueDescription(sel, scopeSnapshot),
      status: "todo",
      priority: "medium",
      assigneeAgentId: summarizerAgentId,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.userId ?? null,
      hiddenAt: createdAt,
      idempotencyKey: [
        "summary-slot-generation",
        sel.scopeKind,
        sel.scopeId ?? "global",
        sel.slotKey,
        generationVersion,
      ].join(":"),
      onDeduplicated: (reason) => {
        issueDeduplicated = reason === "idempotency_key";
      },
    });
    const generationIssue = (
      await issuesSvc.update(created.id, {
        description: generationIssueDescription(sel, scopeSnapshot, created.id),
      })
    ) ?? created;

    const slotRow = await upsertSlot(sel, {
      status: "generating",
      failureReason: null,
      generatingIssueId: generationIssue.id,
    });

    return {
      slot: mapSlot(slotRow),
      generatingIssue: {
        id: generationIssue.id,
        identifier: generationIssue.identifier ?? null,
        title: generationIssue.title,
        status: generationIssue.status as IssueStatus,
        assigneeAgentId: generationIssue.assigneeAgentId ?? null,
      },
      alreadyGenerating: issueDeduplicated,
    };
  }

  async function assertSummarizerWriter(
    sel: ResolvedSelector,
    slotRow: SummarySlotRow | null,
    input: { generationIssueId?: string | null },
    actor: SummaryWriteActor,
  ): Promise<void> {
    if (!actor.agentId) {
      throw forbidden("Only the Summarizer built-in agent may write summaries");
    }
    const agent = await agents.getById(actor.agentId);
    if (!agent || agent.companyId !== sel.companyId) {
      throw forbidden("Only the Summarizer built-in agent may write summaries");
    }
    const marker = readBuiltInAgentMarker(agent.metadata);
    if (marker?.key !== SUMMARIZER_BUILT_IN_KEY) {
      throw forbidden("Only the Summarizer built-in agent may write summaries");
    }

    // The write must originate from the linked, in-flight generation task.
    const generationIssueId = input.generationIssueId ?? null;
    if (!generationIssueId) {
      throw forbidden("Summary writes must identify the active generation task");
    }
    if (!slotRow?.generatingIssueId || slotRow.generatingIssueId !== generationIssueId) {
      throw forbidden("Summary write does not match the active generation task");
    }
    const issueRef = await loadIssueRef(sel.companyId, generationIssueId);
    if (!issueRef.row) {
      throw forbidden("Linked generation task not found");
    }
    const payloadMatch = issueRef.row.description?.match(/```json\n([\s\S]*?)\n```/);
    let payload: Record<string, unknown> | null = null;
    try {
      payload = payloadMatch ? (JSON.parse(payloadMatch[1]) as Record<string, unknown>) : null;
    } catch {
      payload = null;
    }
    if (
      payload?.generationIssueId !== generationIssueId ||
      payload.scopeKind !== sel.scopeKind ||
      (payload.scopeId ?? null) !== sel.scopeId ||
      payload.slotKey !== sel.slotKey
    ) {
      throw forbidden("Generation task does not target this summary slot");
    }
    if (issueRef.row.assigneeAgentId !== actor.agentId) {
      throw forbidden("Generation task is not assigned to this agent");
    }
    const runId = actor.runId ?? null;
    const runMatches =
      !!runId && (issueRef.row.checkoutRunId === runId || issueRef.row.executionRunId === runId);
    if (!runMatches) {
      throw forbidden("Summary write must run from the linked generation task");
    }
  }

  async function write(
    input: SummarySlotSelectorInput & {
      markdown: string;
      title?: string | null;
      changeSummary?: string | null;
      baseRevisionId?: string | null;
      generationIssueId?: string | null;
      model?: string | null;
    },
    actor: SummaryWriteActor,
  ): Promise<WriteSummarySlotResponse> {
    const sel = resolveSelector(input);
    await assertTargetVisible(sel);
    const slotRow = await findSlotRow(sel);
    await assertSummarizerWriter(sel, slotRow, input, actor);

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const currentSlot = slotRow
        ? await tx
            .select()
            .from(summarySlots)
            .where(eq(summarySlots.id, slotRow.id))
            .then((rows) => rows[0] ?? null)
        : null;
      if (!currentSlot || currentSlot.generatingIssueId !== input.generationIssueId) {
        throw conflict("Summary generation was superseded by a newer task");
      }

      let documentRow: typeof documents.$inferSelect;
      let revisionRow: typeof documentRevisions.$inferSelect;

      const existingDocument = currentSlot?.documentId
        ? await tx
            .select()
            .from(documents)
            .where(and(eq(documents.id, currentSlot.documentId), eq(documents.companyId, sel.companyId)))
            .then((rows) => rows[0] ?? null)
        : null;

      if (existingDocument) {
        if (input.baseRevisionId && input.baseRevisionId !== existingDocument.latestRevisionId) {
          throw conflict("Summary was updated by someone else", {
            currentRevisionId: existingDocument.latestRevisionId,
          });
        }
        const nextRevisionNumber = existingDocument.latestRevisionNumber + 1;
        [revisionRow] = await tx
          .insert(documentRevisions)
          .values({
            companyId: sel.companyId,
            documentId: existingDocument.id,
            revisionNumber: nextRevisionNumber,
            title: input.title ?? null,
            format: DEFAULT_SUMMARY_FORMAT,
            body: input.markdown,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByRunId: actor.runId ?? null,
            createdAt: now,
          })
          .returning();
        [documentRow] = await tx
          .update(documents)
          .set({
            title: input.title ?? null,
            format: DEFAULT_SUMMARY_FORMAT,
            latestBody: input.markdown,
            latestRevisionId: revisionRow.id,
            latestRevisionNumber: nextRevisionNumber,
            updatedByAgentId: actor.agentId ?? null,
            updatedAt: now,
          })
          .where(eq(documents.id, existingDocument.id))
          .returning();
      } else {
        [documentRow] = await tx
          .insert(documents)
          .values({
            companyId: sel.companyId,
            title: input.title ?? null,
            format: DEFAULT_SUMMARY_FORMAT,
            latestBody: input.markdown,
            latestRevisionId: null,
            latestRevisionNumber: 1,
            createdByAgentId: actor.agentId ?? null,
            updatedByAgentId: actor.agentId ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        [revisionRow] = await tx
          .insert(documentRevisions)
          .values({
            companyId: sel.companyId,
            documentId: documentRow.id,
            revisionNumber: 1,
            title: input.title ?? null,
            format: DEFAULT_SUMMARY_FORMAT,
            body: input.markdown,
            changeSummary: input.changeSummary ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByRunId: actor.runId ?? null,
            createdAt: now,
          })
          .returning();
        [documentRow] = await tx
          .update(documents)
          .set({ latestRevisionId: revisionRow.id })
          .where(eq(documents.id, documentRow.id))
          .returning();
      }

      const slotPatch = {
        documentId: documentRow.id,
        status: "idle" as const,
        failureReason: null,
        generatingIssueId: null,
        lastGeneratedAt: now,
        lastGeneratedByAgentId: actor.agentId ?? null,
        lastModel: input.model ?? null,
        updatedAt: now,
      };

      const [nextSlot] = await tx
        .update(summarySlots)
        .set(slotPatch)
        .where(
          and(
            eq(summarySlots.id, currentSlot.id),
            eq(summarySlots.generatingIssueId, input.generationIssueId!),
          ),
        )
        .returning();
      if (!nextSlot) {
        throw conflict("Summary generation was superseded by a newer task");
      }

      return { slot: nextSlot, document: documentRow, revision: revisionRow };
    });

    return {
      slot: mapSlot(result.slot),
      document: mapDocument(result.document),
      revision: mapRevision(result.revision),
    };
  }

  return {
    getSlot,
    listRevisions,
    generate,
    write,
  };
}
