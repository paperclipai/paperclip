import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  briefingViewStates,
  goals,
  heartbeatRuns,
  issues,
  projects,
  recordAttachments,
  recordLinks,
  records,
} from "@paperclipai/db";
import type {
  AnyRecord,
  BriefingRecord,
  CreateBriefingRecord,
  CreatePlanRecord,
  CreateRecordAttachment,
  CreateRecordLink,
  CreateResultRecord,
  ExecutiveBoardSummary,
  ExecutiveCostAnomaly,
  ExecutiveProjectHealth,
  GenerateRecord,
  PlanRecord,
  PromoteToResult,
  RecordAttachment,
  RecordCategory,
  RecordLink,
  RecordLinkTargetType,
  RecordScopeType,
  ResultRecord,
  UpdateRecord,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

export interface RecordFilters {
  category?: RecordCategory;
  status?: string;
  kind?: string;
  scopeType?: RecordScopeType;
  scopeRefId?: string;
  ownerAgentId?: string;
  projectId?: string;
  q?: string;
}

interface RecordActor {
  agentId?: string | null;
  userId?: string | null;
}

type RecordRow = typeof records.$inferSelect;
type RecordLinkRow = typeof recordLinks.$inferSelect;
type BriefingViewStateRow = typeof briefingViewStates.$inferSelect;
type HydratedRecordRow = RecordRow & { links: RecordLink[]; attachments: RecordAttachment[] };
type RunUsage = Record<string, unknown> | null;

function coerceDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function usageNumber(usage: RunUsage, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function usageString(usage: RunUsage, ...keys: string[]) {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toSharedRecord(row: HydratedRecordRow): AnyRecord {
  return row as unknown as AnyRecord;
}

function getRecordHeadline(record: Pick<RecordRow, "title" | "summary">) {
  return record.summary?.trim() || record.title;
}

// Scope matching deliberately considers both the explicit scope and durable links,
// so project and executive boards can roll up shared outputs without duplicating records.
function matchesScope(
  record: Pick<AnyRecord, "companyId" | "scopeType" | "scopeRefId" | "ownerAgentId" | "links">,
  scopeType: RecordScopeType,
  scopeRefId: string,
) {
  if (scopeType === "company") return record.companyId === scopeRefId;
  if (record.scopeType === scopeType && record.scopeRefId === scopeRefId) return true;
  if (scopeType === "agent" && record.ownerAgentId === scopeRefId) return true;
  const targetType: RecordLinkTargetType =
    scopeType === "project" ? "project" : scopeType === "agent" ? "agent" : "record";
  return (record.links ?? []).some((link) => link.targetType === targetType && link.targetId === scopeRefId);
}

function linkedToProject(record: Pick<AnyRecord, "scopeType" | "scopeRefId" | "links">, projectId: string) {
  if (record.scopeType === "project" && record.scopeRefId === projectId) return true;
  return (record.links ?? []).some((link) => link.targetType === "project" && link.targetId === projectId);
}

function truncateText(value: string | null | undefined, max = 280) {
  const text = value?.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function deriveProjectHealth(projectStatus: string, blocker: string | null, nextDecision: PlanRecord | null) {
  if (blocker) return "red" as const;
  if (nextDecision) return "yellow" as const;
  if (projectStatus === "completed") return "green" as const;
  if (projectStatus === "cancelled") return "red" as const;
  if (projectStatus === "in_progress") return "yellow" as const;
  return "unknown" as const;
}

function deriveProjectDelta(blocker: string | null, hasRecentResult: boolean) {
  if (blocker) return "down" as const;
  if (hasRecentResult) return "up" as const;
  return "unknown" as const;
}

export function summarizeProjectHealth(
  scopedProjects: Array<Pick<typeof projects.$inferSelect, "id" | "name" | "status">>,
  scopedResults: ResultRecord[],
  blockerRecords: Array<PlanRecord | ResultRecord>,
  decisionRecords: PlanRecord[],
): ExecutiveProjectHealth[] {
  return scopedProjects.map((project) => {
    const linkedResults = scopedResults.filter((record) => linkedToProject(record, project.id));
    const linkedBlockers = blockerRecords.filter((record) => linkedToProject(record, project.id));
    const linkedDecisions = decisionRecords.filter((record) => linkedToProject(record, project.id));
    const lastMeaningfulResult = [...linkedResults]
      .filter((record) => record.status === "published")
      .sort((left, right) => (right.publishedAt ?? right.updatedAt).getTime() - (left.publishedAt ?? left.updatedAt).getTime())[0] ?? null;
    const currentBlocker = linkedBlockers[0] ? getRecordHeadline(linkedBlockers[0]) : null;
    const nextDecision = linkedDecisions[0] ?? null;
    return {
      projectId: project.id,
      projectName: project.name,
      projectStatus: project.status,
      healthStatus: lastMeaningfulResult?.healthStatus ?? deriveProjectHealth(project.status, currentBlocker, nextDecision),
      healthDelta: lastMeaningfulResult?.healthDelta ?? deriveProjectDelta(currentBlocker, Boolean(lastMeaningfulResult)),
      confidence: lastMeaningfulResult?.confidence ?? null,
      lastMeaningfulResult,
      currentBlocker,
      nextDecision,
    };
  });
}

function buildBriefingSummary(board: ExecutiveBoardSummary) {
  return `${board.outcomesLanded.length} outcomes, ${board.risksAndBlocks.length} risks, ${board.decisionsNeeded.length} decisions needed`;
}

function buildBriefingBody(board: ExecutiveBoardSummary) {
  const lines: string[] = [];
  lines.push(`# Executive Briefing`);
  lines.push("");
  lines.push(`Scope: ${board.scopeType}`);
  lines.push("");
  lines.push(`## Outcomes Landed`);
  if (board.outcomesLanded.length === 0) {
    lines.push(`- No newly published outcomes in this window.`);
  } else {
    for (const outcome of board.outcomesLanded.slice(0, 8)) {
      lines.push(`- ${outcome.title}: ${outcome.summary ?? "No summary provided."}`);
    }
  }
  lines.push("");
  lines.push(`## Risks And Blocks`);
  if (board.risksAndBlocks.length === 0) {
    lines.push(`- No active risks or blockers.`);
  } else {
    for (const risk of board.risksAndBlocks.slice(0, 8)) {
      lines.push(`- ${risk.title}: ${risk.summary ?? "No summary provided."}`);
    }
  }
  lines.push("");
  lines.push(`## Decisions Needed`);
  if (board.decisionsNeeded.length === 0) {
    lines.push(`- No active decision requests.`);
  } else {
    for (const decision of board.decisionsNeeded.slice(0, 8)) {
      lines.push(`- ${decision.title}: ${decision.summary ?? "No summary provided."}`);
    }
  }
  lines.push("");
  lines.push(`## Project Health`);
  if (board.projectHealth.length === 0) {
    lines.push(`- No matching projects in scope.`);
  } else {
    for (const project of board.projectHealth.slice(0, 8)) {
      lines.push(`- ${project.projectName}: ${project.healthStatus} (${project.healthDelta})${project.currentBlocker ? ` - blocker: ${project.currentBlocker}` : ""}`);
    }
  }
  lines.push("");
  lines.push(`## Cost Anomalies`);
  if (board.costAnomalies.length === 0) {
    lines.push(`- No anomalous run usage detected.`);
  } else {
    for (const anomaly of board.costAnomalies.slice(0, 8)) {
      lines.push(`- ${anomaly.agentName ?? anomaly.runId}: ${anomaly.reason} (${anomaly.pricingState})`);
    }
  }
  lines.push("");
  lines.push(`## Executive Rollups`);
  if (board.executiveRollups.length === 0) {
    lines.push(`- No published executive rollups yet.`);
  } else {
    for (const rollup of board.executiveRollups.slice(0, 8)) {
      lines.push(`- ${rollup.title}: ${rollup.summary ?? "No summary provided."}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function listLinksForRecordIds(dbOrTx: any, companyId: string, recordIds: string[]) {
  if (recordIds.length === 0) return new Map<string, RecordLink[]>();
  const rows = await dbOrTx
    .select()
    .from(recordLinks)
    .where(
      and(
        eq(recordLinks.companyId, companyId),
        inArray(recordLinks.recordId, recordIds),
      ),
    )
    .orderBy(asc(recordLinks.createdAt), asc(recordLinks.id));

  const map = new Map<string, RecordLink[]>();
  for (const row of rows as RecordLinkRow[]) {
    const existing = map.get(row.recordId);
    const entry = row as unknown as RecordLink;
    if (existing) existing.push(entry);
    else map.set(row.recordId, [entry]);
  }
  return map;
}

async function listAttachmentsForRecordIds(dbOrTx: any, companyId: string, recordIds: string[]) {
  if (recordIds.length === 0) return new Map<string, RecordAttachment[]>();
  const rows = await dbOrTx
    .select({
      attachment: recordAttachments,
      assetId: assets.id,
      assetCompanyId: assets.companyId,
      provider: assets.provider,
      objectKey: assets.objectKey,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      originalFilename: assets.originalFilename,
      createdByAgentId: assets.createdByAgentId,
      createdByUserId: assets.createdByUserId,
      assetCreatedAt: assets.createdAt,
      assetUpdatedAt: assets.updatedAt,
    })
    .from(recordAttachments)
    .innerJoin(assets, eq(recordAttachments.assetId, assets.id))
    .where(
      and(
        eq(recordAttachments.companyId, companyId),
        inArray(recordAttachments.recordId, recordIds),
      ),
    )
    .orderBy(asc(recordAttachments.createdAt), asc(recordAttachments.id));

  const map = new Map<string, RecordAttachment[]>();
  for (const row of rows) {
    const entry: RecordAttachment = {
      id: row.attachment.id,
      companyId: row.attachment.companyId,
      recordId: row.attachment.recordId,
      assetId: row.attachment.assetId,
      createdAt: row.attachment.createdAt,
      updatedAt: row.attachment.updatedAt,
      asset: {
        assetId: row.assetId,
        companyId: row.assetCompanyId,
        provider: row.provider,
        objectKey: row.objectKey,
        contentType: row.contentType,
        byteSize: row.byteSize,
        sha256: row.sha256,
        originalFilename: row.originalFilename,
        createdByAgentId: row.createdByAgentId,
        createdByUserId: row.createdByUserId,
        createdAt: row.assetCreatedAt,
        updatedAt: row.assetUpdatedAt,
        contentPath: `/api/assets/${row.assetId}/content`,
      },
    };
    const existing = map.get(row.attachment.recordId);
    if (existing) existing.push(entry);
    else map.set(row.attachment.recordId, [entry]);
  }
  return map;
}

async function hydrateRecords(dbOrTx: any, companyId: string, rows: RecordRow[]): Promise<HydratedRecordRow[]> {
  if (rows.length === 0) return [];
  const recordIds = rows.map((row) => row.id);
  const [linksByRecordId, attachmentsByRecordId] = await Promise.all([
    listLinksForRecordIds(dbOrTx, companyId, recordIds),
    listAttachmentsForRecordIds(dbOrTx, companyId, recordIds),
  ]);
  return rows.map((row) => ({
    ...row,
    links: linksByRecordId.get(row.id) ?? [],
    attachments: attachmentsByRecordId.get(row.id) ?? [],
  }));
}

export function recordService(db: Db) {
  async function assertScopeRef(companyId: string, scopeType: RecordScopeType, scopeRefId: string) {
    if (scopeType === "company") {
      if (scopeRefId !== companyId) {
        throw unprocessable("Company-scoped records must use the company id as scopeRefId");
      }
      return;
    }
    if (scopeType === "project") {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, scopeRefId)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project scope not found");
      return;
    }
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, scopeRefId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent scope not found");
  }

  async function assertOwnerAgent(companyId: string, ownerAgentId: string | null | undefined) {
    if (!ownerAgentId) return;
    const owner = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, ownerAgentId)))
      .then((rows) => rows[0] ?? null);
    if (!owner) throw notFound("Owner agent not found");
  }

  async function assertTarget(companyId: string, targetType: RecordLinkTargetType, targetId: string) {
    if (targetType === "project") {
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Linked project not found");
      return;
    }
    if (targetType === "issue") {
      const issue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Linked issue not found");
      return;
    }
    if (targetType === "goal") {
      const goal = await db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.companyId, companyId), eq(goals.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!goal) throw notFound("Linked goal not found");
      return;
    }
    if (targetType === "approval") {
      const approval = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!approval) throw notFound("Linked approval not found");
      return;
    }
    if (targetType === "heartbeat_run") {
      const run = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!run) throw notFound("Linked run not found");
      return;
    }
    if (targetType === "agent") {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, targetId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Linked agent not found");
      return;
    }
    const record = await db
      .select({ id: records.id })
      .from(records)
      .where(and(eq(records.companyId, companyId), eq(records.id, targetId)))
      .then((rows) => rows[0] ?? null);
    if (!record) throw notFound("Linked record not found");
  }

  async function getRecordRow(id: string) {
    return db
      .select()
      .from(records)
      .where(eq(records.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getHydratedRecord(id: string) {
    const row = await getRecordRow(id);
    if (!row) return null;
    const [hydrated] = await hydrateRecords(db, row.companyId, [row]);
    return hydrated ? toSharedRecord(hydrated) : null;
  }

  async function getViewState(companyId: string, userId: string, scopeType: RecordScopeType, scopeRefId: string) {
    return db
      .select()
      .from(briefingViewStates)
      .where(
        and(
          eq(briefingViewStates.companyId, companyId),
          eq(briefingViewStates.userId, userId),
          eq(briefingViewStates.scopeType, scopeType),
          eq(briefingViewStates.scopeRefId, scopeRefId),
        ),
      )
      .then((rows) => (rows[0] ?? null) as BriefingViewStateRow | null);
  }

  async function markViewed(companyId: string, userId: string, scopeType: RecordScopeType, scopeRefId: string, viewedAt = new Date()) {
    const now = new Date();
    const [row] = await db
      .insert(briefingViewStates)
      .values({
        companyId,
        userId,
        scopeType,
        scopeRefId,
        lastViewedAt: viewedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          briefingViewStates.companyId,
          briefingViewStates.userId,
          briefingViewStates.scopeType,
          briefingViewStates.scopeRefId,
        ],
        set: {
          lastViewedAt: viewedAt,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  async function resolveSinceDate(
    companyId: string,
    scopeType: RecordScopeType,
    scopeRefId: string,
    sinceInput?: string,
    userId?: string | null,
  ) {
    if (sinceInput && sinceInput !== "last_visit") {
      return { since: coerceDate(sinceInput), lastViewedAt: null };
    }
    if (!userId) return { since: null, lastViewedAt: null };
    const viewState = await getViewState(companyId, userId, scopeType, scopeRefId);
    return { since: viewState?.lastViewedAt ?? null, lastViewedAt: viewState?.lastViewedAt ?? null };
  }

  async function createBaseRecord(
    companyId: string,
    category: RecordCategory,
    data: CreatePlanRecord | CreateResultRecord | CreateBriefingRecord,
    actor?: RecordActor,
  ) {
    await assertScopeRef(companyId, data.scopeType, data.scopeRefId);
    await assertOwnerAgent(companyId, data.ownerAgentId);
    const now = new Date();
    const [row] = await db
      .insert(records)
      .values({
        companyId,
        category,
        kind: data.kind,
        scopeType: data.scopeType,
        scopeRefId: data.scopeRefId,
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        bodyMd: data.bodyMd?.trim() || null,
        status: data.status ?? "draft",
        ownerAgentId: data.ownerAgentId ?? null,
        decisionNeeded: data.decisionNeeded ?? false,
        decisionDueAt: coerceDate(data.decisionDueAt ?? null),
        healthStatus: data.healthStatus ?? null,
        healthDelta: data.healthDelta ?? null,
        confidence: data.confidence ?? null,
        metadata: data.metadata ?? null,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
        updatedByAgentId: actor?.agentId ?? null,
        updatedByUserId: actor?.userId ?? null,
        updatedAt: now,
      })
      .returning();
    const [hydrated] = await hydrateRecords(db, companyId, [row]);
    return toSharedRecord(hydrated);
  }

  async function listByCategory(companyId: string, category: RecordCategory, filters: Omit<RecordFilters, "category"> = {}) {
    const conditions = [eq(records.companyId, companyId), eq(records.category, category)];
    if (filters.status) conditions.push(eq(records.status, filters.status));
    if (filters.kind) conditions.push(eq(records.kind, filters.kind));
    if (filters.scopeType) conditions.push(eq(records.scopeType, filters.scopeType));
    if (filters.scopeRefId) conditions.push(eq(records.scopeRefId, filters.scopeRefId));
    if (filters.ownerAgentId) conditions.push(eq(records.ownerAgentId, filters.ownerAgentId));
    if (filters.q) {
      const pattern = `%${filters.q.trim()}%`;
      conditions.push(or(ilike(records.title, pattern), ilike(records.summary, pattern), ilike(records.bodyMd, pattern))!);
    }
    if (filters.projectId) {
      conditions.push(
        or(
          and(eq(records.scopeType, "project"), eq(records.scopeRefId, filters.projectId)),
          sql`exists (
            select 1 from ${recordLinks}
            where ${recordLinks.companyId} = ${companyId}
              and ${recordLinks.recordId} = ${records.id}
              and ${recordLinks.targetType} = 'project'
              and ${recordLinks.targetId} = ${filters.projectId}
          )`,
        )!,
      );
    }
    const rows = await db
      .select()
      .from(records)
      .where(and(...conditions))
      .orderBy(desc(records.updatedAt), desc(records.createdAt));
    const hydrated = await hydrateRecords(db, companyId, rows);
    return hydrated.map(toSharedRecord).filter((record) => record.category === category) as Array<
      PlanRecord | ResultRecord | BriefingRecord
    >;
  }

  async function buildBoardSummary(
    companyId: string,
    scopeType: RecordScopeType,
    scopeRefId: string,
    options?: { since?: string; userId?: string | null; markViewed?: boolean },
  ): Promise<ExecutiveBoardSummary> {
    await assertScopeRef(companyId, scopeType, scopeRefId);
    const { since, lastViewedAt } = await resolveSinceDate(companyId, scopeType, scopeRefId, options?.since, options?.userId);
    const [planRecords, resultRecords, briefingRecords, companyProjects, runRows, issueRows] = await Promise.all([
      listByCategory(companyId, "plan"),
      listByCategory(companyId, "result"),
      listByCategory(companyId, "briefing"),
      db.select().from(projects).where(eq(projects.companyId, companyId)),
      db
        .select({
          run: heartbeatRuns,
          agentName: agents.name,
        })
        .from(heartbeatRuns)
        .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(and(eq(heartbeatRuns.companyId, companyId), isNotNull(heartbeatRuns.usageJson)))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(120),
      db
        .select({ id: issues.id, projectId: issues.projectId, title: issues.title })
        .from(issues)
        .where(eq(issues.companyId, companyId)),
    ]);

    const scopedPlans = planRecords.filter((record) => matchesScope(record, scopeType, scopeRefId)) as PlanRecord[];
    const scopedResults = resultRecords.filter((record) => matchesScope(record, scopeType, scopeRefId)) as ResultRecord[];
    const scopedBriefings = briefingRecords.filter((record) => matchesScope(record, scopeType, scopeRefId)) as BriefingRecord[];
    const scopedProjects = companyProjects.filter((project) => {
      if (scopeType === "company") return true;
      if (scopeType === "project") return project.id === scopeRefId;
      if (project.leadAgentId === scopeRefId) return true;
      return [...scopedPlans, ...scopedResults, ...scopedBriefings].some((record) => linkedToProject(record, project.id));
    });

    const outcomesLanded = scopedResults
      .filter((record) => record.status === "published")
      .filter((record) => !since || ((record.publishedAt ?? record.updatedAt).getTime() > since.getTime()))
      .sort((left, right) => (right.publishedAt ?? right.updatedAt).getTime() - (left.publishedAt ?? left.updatedAt).getTime())
      .slice(0, 8);

    const allRisksAndBlocks = [
      ...scopedPlans.filter((record) => record.kind === "risk_register" && record.status === "active"),
      ...scopedResults.filter((record) => record.kind === "blocker" && record.status === "published"),
    ]
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());

    const allDecisionsNeeded = scopedPlans
      .filter((record) => record.kind === "decision_record" && record.status === "active" && record.decisionNeeded)
      .sort((left, right) => {
        const leftDue = left.decisionDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const rightDue = right.decisionDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (leftDue !== rightDue) return leftDue - rightDue;
        return right.updatedAt.getTime() - left.updatedAt.getTime();
      });

    // Project health must look at the full blocker and decision sets, even when the
    // board UI only shows a truncated list of top exceptions.
    const projectHealth = summarizeProjectHealth(scopedProjects, scopedResults, allRisksAndBlocks, allDecisionsNeeded);
    const risksAndBlocks = allRisksAndBlocks.slice(0, 8);
    const decisionsNeeded = allDecisionsNeeded.slice(0, 8);

    const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
    const projectById = new Map(companyProjects.map((project) => [project.id, project]));
    const costAnomalies: ExecutiveCostAnomaly[] = [];
    for (const row of runRows) {
      const usage = (row.run.usageJson as RunUsage) ?? null;
      const inputTokens = usageNumber(usage, "inputTokens", "input_tokens");
      const outputTokens = usageNumber(usage, "outputTokens", "output_tokens");
      const totalTokens = inputTokens + outputTokens;
      if (totalTokens < 500_000) continue;
      const pricingState = usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") > 0 ? "exact" as const : "unpriced" as const;
      const issueId = usageString(row.run.contextSnapshot as RunUsage, "issueId");
      const projectId = issueId ? issueById.get(issueId)?.projectId ?? null : null;
      if (scopeType === "project" && projectId !== scopeRefId) continue;
      if (scopeType === "agent" && row.run.agentId !== scopeRefId) continue;
      costAnomalies.push({
        runId: row.run.id,
        agentId: row.run.agentId,
        agentName: row.agentName ?? null,
        projectId: projectId ?? null,
        projectName: projectId ? projectById.get(projectId)?.name ?? null : null,
        reason:
          pricingState === "unpriced"
            ? `High token usage without priceable cost (${totalTokens.toLocaleString()} tokens)`
            : `High token usage (${totalTokens.toLocaleString()} tokens)`,
        pricingState,
        inputTokens,
        outputTokens,
        pricedCostCents:
          pricingState === "exact"
            ? Math.round(usageNumber(usage, "costUsd", "cost_usd", "total_cost_usd") * 100)
            : null,
        occurredAt: row.run.finishedAt ?? row.run.startedAt ?? row.run.createdAt,
      });
      if (costAnomalies.length >= 8) break;
    }

    // Executive rollups should reflect the latest published rollup per executive scope
    // instead of a flat list with duplicates for the same agent.
    const executiveRollupsByScope = new Map<string, BriefingRecord>();
    for (const record of [...scopedBriefings]
      .filter((item) => item.kind === "executive_rollup" && item.status === "published")
      .sort((left, right) => (right.publishedAt ?? right.updatedAt).getTime() - (left.publishedAt ?? left.updatedAt).getTime())) {
      const scopeKey = `${record.scopeType}:${record.scopeRefId}`;
      if (!executiveRollupsByScope.has(scopeKey)) {
        executiveRollupsByScope.set(scopeKey, record);
      }
    }
    const executiveRollups = [...executiveRollupsByScope.values()].slice(0, 8);

    if (options?.markViewed && options.userId) {
      await markViewed(companyId, options.userId, scopeType, scopeRefId);
    }

    return {
      companyId,
      scopeType,
      scopeRefId,
      since,
      lastViewedAt,
      outcomesLanded,
      risksAndBlocks,
      decisionsNeeded,
      projectHealth,
      costAnomalies,
      executiveRollups,
    };
  }

  return {
    listPlans: (companyId: string, filters?: Omit<RecordFilters, "category">) => listByCategory(companyId, "plan", filters),
    listResults: (companyId: string, filters?: Omit<RecordFilters, "category">) => listByCategory(companyId, "result", filters),
    listBriefings: (companyId: string, filters?: Omit<RecordFilters, "category">) => listByCategory(companyId, "briefing", filters),

    createPlan: (companyId: string, data: CreatePlanRecord, actor?: RecordActor) =>
      createBaseRecord(companyId, "plan", data, actor) as Promise<PlanRecord>,
    createResult: (companyId: string, data: CreateResultRecord, actor?: RecordActor) =>
      createBaseRecord(companyId, "result", data, actor) as Promise<ResultRecord>,
    createBriefing: (companyId: string, data: CreateBriefingRecord, actor?: RecordActor) =>
      createBaseRecord(companyId, "briefing", data, actor) as Promise<BriefingRecord>,

    getById: async (id: string) => {
      return getHydratedRecord(id);
    },

    update: async (id: string, data: UpdateRecord, actor?: RecordActor) => {
      const existing = await getRecordRow(id);
      if (!existing) return null;
      if (data.scopeType || data.scopeRefId) {
        await assertScopeRef(
          existing.companyId,
          (data.scopeType ?? existing.scopeType) as RecordScopeType,
          data.scopeRefId ?? existing.scopeRefId,
        );
      }
      await assertOwnerAgent(existing.companyId, data.ownerAgentId ?? existing.ownerAgentId);
      const [row] = await db
        .update(records)
        .set({
          category: data.category ?? existing.category,
          kind: data.kind ?? existing.kind,
          scopeType: data.scopeType ?? existing.scopeType,
          scopeRefId: data.scopeRefId ?? existing.scopeRefId,
          title: data.title?.trim() ?? existing.title,
          summary: data.summary === undefined ? existing.summary : data.summary?.trim() || null,
          bodyMd: data.bodyMd === undefined ? existing.bodyMd : data.bodyMd?.trim() || null,
          status: data.status ?? existing.status,
          ownerAgentId: data.ownerAgentId === undefined ? existing.ownerAgentId : data.ownerAgentId,
          decisionNeeded: data.decisionNeeded ?? existing.decisionNeeded,
          decisionDueAt:
            data.decisionDueAt === undefined ? existing.decisionDueAt : coerceDate(data.decisionDueAt ?? null),
          healthStatus: data.healthStatus === undefined ? existing.healthStatus : data.healthStatus,
          healthDelta: data.healthDelta === undefined ? existing.healthDelta : data.healthDelta,
          confidence: data.confidence === undefined ? existing.confidence : data.confidence,
          metadata: data.metadata === undefined ? existing.metadata : data.metadata,
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(records.id, id))
        .returning();
      const [hydrated] = await hydrateRecords(db, existing.companyId, [row]);
      return toSharedRecord(hydrated);
    },

    addLink: async (recordId: string, input: CreateRecordLink) => {
      const existing = await getRecordRow(recordId);
      if (!existing) throw notFound("Record not found");
      await assertTarget(existing.companyId, input.targetType, input.targetId);
      const duplicate = await db
        .select({ id: recordLinks.id })
        .from(recordLinks)
        .where(
          and(
            eq(recordLinks.recordId, recordId),
            eq(recordLinks.targetType, input.targetType),
            eq(recordLinks.targetId, input.targetId),
            eq(recordLinks.relation, input.relation ?? "related"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (duplicate) {
        const row = await db.select().from(recordLinks).where(eq(recordLinks.id, duplicate.id)).then((rows) => rows[0]!);
        return row as unknown as RecordLink;
      }
      const [row] = await db
        .insert(recordLinks)
        .values({
          companyId: existing.companyId,
          recordId,
          targetType: input.targetType,
          targetId: input.targetId,
          relation: input.relation ?? "related",
        })
        .returning();
      return row as unknown as RecordLink;
    },

    addAttachment: async (recordId: string, input: CreateRecordAttachment) => {
      const existing = await getRecordRow(recordId);
      if (!existing) throw notFound("Record not found");
      const asset = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, input.assetId), eq(assets.companyId, existing.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!asset) throw notFound("Asset not found");
      const duplicate = await db
        .select({ id: recordAttachments.id })
        .from(recordAttachments)
        .where(and(eq(recordAttachments.recordId, recordId), eq(recordAttachments.assetId, input.assetId)))
        .then((rows) => rows[0] ?? null);
      if (duplicate) {
        const [hydrated] = await listAttachmentsForRecordIds(db, existing.companyId, [recordId]).then((map) => [
          (map.get(recordId) ?? []).find((item) => item.assetId === input.assetId) ?? null,
        ]);
        if (!hydrated) throw conflict("Attachment already linked but could not be hydrated");
        return hydrated;
      }
      const [row] = await db
        .insert(recordAttachments)
        .values({
          companyId: existing.companyId,
          recordId,
          assetId: input.assetId,
        })
        .returning();
      const attachment: RecordAttachment = {
        id: row.id,
        companyId: row.companyId,
        recordId: row.recordId,
        assetId: row.assetId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        asset: {
          assetId: asset.id,
          companyId: asset.companyId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
          contentPath: `/api/assets/${asset.id}/content`,
        },
      };
      return attachment;
    },

    boardSummary: (
      companyId: string,
      scopeType: RecordScopeType,
      scopeRefId: string,
      options?: { since?: string; userId?: string | null; markViewed?: boolean },
    ) => buildBoardSummary(companyId, scopeType, scopeRefId, options),

    generate: async (recordId: string, input: GenerateRecord | undefined, actor?: RecordActor) => {
      const existing = await getRecordRow(recordId);
      if (!existing) throw notFound("Record not found");
      if (existing.category !== "briefing") {
        throw unprocessable("Only briefing records can be generated");
      }
      const board = await buildBoardSummary(existing.companyId, existing.scopeType as RecordScopeType, existing.scopeRefId, {
        since: input?.since,
        userId: actor?.userId ?? null,
        markViewed: false,
      });
      const [row] = await db
        .update(records)
        .set({
          summary: buildBriefingSummary(board),
          bodyMd: buildBriefingBody(board),
          generatedAt: new Date(),
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(records.id, recordId))
        .returning();
      const [hydrated] = await hydrateRecords(db, existing.companyId, [row]);
      return toSharedRecord(hydrated) as BriefingRecord;
    },

    publish: async (recordId: string, actor?: RecordActor) => {
      const existing = await getRecordRow(recordId);
      if (!existing) throw notFound("Record not found");
      const nextStatus = existing.category === "plan" ? "active" : "published";
      const now = new Date();
      const [row] = await db
        .update(records)
        .set({
          status: nextStatus,
          publishedAt: now,
          updatedByAgentId: actor?.agentId ?? null,
          updatedByUserId: actor?.userId ?? null,
          updatedAt: now,
        })
        .where(eq(records.id, recordId))
        .returning();
      const [hydrated] = await hydrateRecords(db, existing.companyId, [row]);
      return toSharedRecord(hydrated);
    },

    promoteToResult: async (companyId: string, input: PromoteToResult, actor?: RecordActor) => {
      if (input.sourceType === "issue") {
        const issue = await db
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, input.sourceId)))
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");
        const result = await createBaseRecord(
          companyId,
          "result",
          {
            kind: input.kind,
            scopeType: issue.projectId ? "project" : "company",
            scopeRefId: issue.projectId ?? companyId,
            title: input.title?.trim() || issue.title,
            summary: input.summary ?? truncateText(issue.description),
            bodyMd: issue.description,
            ownerAgentId: issue.assigneeAgentId ?? null,
            status: "draft",
          },
          actor,
        );
        await db.insert(recordLinks).values({
          companyId,
          recordId: result.id,
          targetType: "issue",
          targetId: issue.id,
          relation: "source",
        });
        if (issue.projectId) {
          await db.insert(recordLinks).values({
            companyId,
            recordId: result.id,
            targetType: "project",
            targetId: issue.projectId,
            relation: "rollup",
          });
        }
        const created = await getHydratedRecord(result.id);
        if (!created || created.category !== "result") throw conflict("Failed to load promoted result");
        return created;
      }

      if (input.sourceType === "heartbeat_run") {
        const run = await db
          .select({ run: heartbeatRuns, agentName: agents.name })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.sourceId)))
          .then((rows) => rows[0] ?? null);
        if (!run) throw notFound("Run not found");
        const issueId = usageString(run.run.contextSnapshot as RunUsage, "issueId");
        const issue = issueId
          ? await db
            .select()
            .from(issues)
            .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
            .then((rows) => rows[0] ?? null)
          : null;
        const resultSummary = truncateText(
          usageString(run.run.resultJson as RunUsage, "summary", "result") ?? run.run.error ?? null,
        );
        const result = await createBaseRecord(
          companyId,
          "result",
          {
            kind: input.kind,
            scopeType: issue?.projectId ? "project" : "agent",
            scopeRefId: issue?.projectId ?? run.run.agentId,
            title: input.title?.trim() || `Run result: ${run.agentName ?? run.run.agentId}`,
            summary: input.summary ?? resultSummary,
            bodyMd: resultSummary,
            ownerAgentId: run.run.agentId,
            status: "draft",
          },
          actor,
        );
        await db.insert(recordLinks).values({
          companyId,
          recordId: result.id,
          targetType: "heartbeat_run",
          targetId: run.run.id,
          relation: "source",
        });
        if (issue?.projectId) {
          await db.insert(recordLinks).values({
            companyId,
            recordId: result.id,
            targetType: "project",
            targetId: issue.projectId,
            relation: "rollup",
          });
        }
        const created = await getHydratedRecord(result.id);
        if (!created || created.category !== "result") throw conflict("Failed to load promoted result");
        return created;
      }

      const approval = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.id, input.sourceId)))
        .then((rows) => rows[0] ?? null);
      if (!approval) throw notFound("Approval not found");
      const result = await createBaseRecord(
        companyId,
        "result",
        {
          kind: input.kind,
          scopeType: approval.requestedByAgentId ? "agent" : "company",
          scopeRefId: approval.requestedByAgentId ?? companyId,
          title: input.title?.trim() || `Approval ${approval.type}`,
          summary: input.summary ?? truncateText(approval.decisionNote),
          bodyMd: approval.decisionNote,
          ownerAgentId: approval.requestedByAgentId ?? null,
          status: "draft",
        },
        actor,
      );
      await db.insert(recordLinks).values({
        companyId,
        recordId: result.id,
        targetType: "approval",
        targetId: approval.id,
        relation: "source",
      });
      const created = await getHydratedRecord(result.id);
      if (!created || created.category !== "result") throw conflict("Failed to load promoted result");
      return created;
    },

    markViewed,
  };
}
