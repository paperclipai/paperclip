import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  improvementSuggestions,
  issues,
} from "@paperclipai/db";
import type {
  CreateImprovementSuggestion,
  ImprovementSuggestion,
  ImprovementSuggestionOriginKind,
  ImprovementSuggestionStatus,
  ImprovementTargetLayer,
  ReviewImprovementSuggestion,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type ImprovementSuggestionRow = typeof improvementSuggestions.$inferSelect;

function toImprovementSuggestion(row: ImprovementSuggestionRow): ImprovementSuggestion {
  return {
    ...row,
    originKind: row.originKind as ImprovementSuggestionOriginKind,
    status: row.status as ImprovementSuggestionStatus,
    targetLayer: row.targetLayer as ImprovementTargetLayer,
    evidence: row.evidence ?? [],
  };
}

export function improvementSuggestionService(db: Db) {
  async function assertSourceIssue(companyId: string, issueId: string | null | undefined) {
    if (!issueId) return;
    const issue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw unprocessable("Source issue does not belong to this company");
  }

  async function assertActorRun(companyId: string, runId: string | null | undefined) {
    if (!runId) return;
    const run = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
      .then((rows) => rows[0] ?? null);
    if (!run) throw unprocessable("Actor run does not belong to this company");
  }

  async function assertAgent(companyId: string, agentId: string | null | undefined) {
    if (!agentId) throw forbidden("Agent authentication required");
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw forbidden("Agent key cannot access another company");
  }

  async function get(companyId: string, suggestionId: string) {
    const row = await db
      .select()
      .from(improvementSuggestions)
      .where(and(
        eq(improvementSuggestions.companyId, companyId),
        eq(improvementSuggestions.id, suggestionId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Improvement suggestion not found");
    return toImprovementSuggestion(row);
  }

  return {
    async list(companyId: string, filters?: {
      status?: ImprovementSuggestionStatus;
      originKind?: ImprovementSuggestionOriginKind;
      targetLayer?: ImprovementTargetLayer;
    }) {
      const conditions = [eq(improvementSuggestions.companyId, companyId)];
      if (filters?.status) conditions.push(eq(improvementSuggestions.status, filters.status));
      if (filters?.originKind) conditions.push(eq(improvementSuggestions.originKind, filters.originKind));
      if (filters?.targetLayer) conditions.push(eq(improvementSuggestions.targetLayer, filters.targetLayer));
      const rows = await db
        .select()
        .from(improvementSuggestions)
        .where(and(...conditions))
        .orderBy(desc(improvementSuggestions.createdAt), desc(improvementSuggestions.id));
      return rows.map(toImprovementSuggestion);
    },

    get,

    async create(
      companyId: string,
      input: CreateImprovementSuggestion,
      actor:
        | { type: "board"; userId: string; runId?: string | null }
        | { type: "agent"; agentId: string; runId?: string | null },
    ) {
      await assertSourceIssue(companyId, input.sourceIssueId);
      await assertActorRun(companyId, actor.runId);
      if (actor.type === "agent") await assertAgent(companyId, actor.agentId);

      const now = new Date();
      const boardDirected = actor.type === "board";
      const row = await db
        .insert(improvementSuggestions)
        .values({
          companyId,
          originKind: boardDirected ? "board_directed" : "agent_detected",
          status: boardDirected ? "accepted" : "pending_review",
          targetLayer: input.targetLayer,
          title: input.title,
          summary: input.summary,
          proposedChange: input.proposedChange,
          evidence: input.evidence.map((entry) => ({ ...entry, note: entry.note ?? null })),
          sourceIssueId: input.sourceIssueId ?? null,
          sourceRunId: actor.runId ?? null,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "board" ? actor.userId : null,
          reviewedByUserId: boardDirected ? actor.userId : null,
          reviewNote: boardDirected ? "Recorded as a board-directed change." : null,
          reviewedAt: boardDirected ? now : null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Failed to persist improvement suggestion");
      return toImprovementSuggestion(row);
    },

    async review(
      companyId: string,
      suggestionId: string,
      input: ReviewImprovementSuggestion,
      reviewerUserId: string,
    ) {
      const now = new Date();
      const status = input.decision === "accept" ? "accepted" : "rejected";
      const row = await db
        .update(improvementSuggestions)
        .set({
          status,
          reviewedByUserId: reviewerUserId,
          reviewNote: input.note,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(improvementSuggestions.companyId, companyId),
          eq(improvementSuggestions.id, suggestionId),
          eq(improvementSuggestions.originKind, "agent_detected"),
          eq(improvementSuggestions.status, "pending_review"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (row) return toImprovementSuggestion(row);

      const existing = await get(companyId, suggestionId);
      if (existing.originKind === "board_directed") {
        throw conflict("Board-directed changes are accepted when recorded and are not reviewable suggestions");
      }
      throw conflict(`Improvement suggestion has already been ${existing.status}`);
    },
  };
}
