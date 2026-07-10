import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companyMemberships,
  companies,
  heartbeatRuns,
  improvementSuggestions,
  instanceUserRoles,
  issues,
} from "@paperclipai/db";
import type {
  CreateImprovementSuggestion,
  ImprovementSuggestion,
  ImprovementSuggestionOriginKind,
  ImprovementSuggestionStatus,
  ImprovementScope,
  ImprovementTargetLayer,
  ReviewImprovementSuggestion,
} from "@paperclipai/shared";
import {
  ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS,
  improvementScopeForTarget,
  isRootLevelImprovementTarget,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type ImprovementSuggestionRow = typeof improvementSuggestions.$inferSelect;

function toImprovementSuggestion(row: ImprovementSuggestionRow): ImprovementSuggestion {
  return {
    ...row,
    originKind: row.originKind as ImprovementSuggestionOriginKind,
    status: row.status as ImprovementSuggestionStatus,
    targetLayer: row.targetLayer as ImprovementTargetLayer,
    scope: improvementScopeForTarget(row.targetLayer as ImprovementTargetLayer),
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

  async function assertActorRun(
    companyId: string,
    agentId: string,
    runId: string | null | undefined,
  ) {
    if (!runId) return;
    const run = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.id, runId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) throw unprocessable("Actor run does not belong to the authenticated agent in this company");
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

  async function resolveBoardAuthority(
    companyId: string,
    actor: { userId: string; localImplicit?: boolean },
  ): Promise<"instance_admin" | "company_governance"> {
    if (actor.localImplicit) return "instance_admin";
    const [instanceAdmin, membership] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(
          eq(instanceUserRoles.userId, actor.userId),
          eq(instanceUserRoles.role, "instance_admin"),
        ))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: companyMemberships.status,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, actor.userId),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    if (instanceAdmin) return "instance_admin";
    if (
      membership?.status === "active"
      && (membership.membershipRole === "owner" || membership.membershipRole === "admin")
    ) {
      return "company_governance";
    }
    throw forbidden("Company owner or admin authority required for improvement governance");
  }

  async function assertBoardAuthority(
    companyId: string,
    targetLayer: ImprovementTargetLayer,
    actor: { userId: string; localImplicit?: boolean },
  ) {
    const authority = await resolveBoardAuthority(companyId, actor);
    if (isRootLevelImprovementTarget(targetLayer) && authority !== "instance_admin") {
      throw forbidden(`Instance admin authority required for ${targetLayer} improvements`);
    }
    return authority;
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
      scope?: ImprovementScope;
    }) {
      const conditions = [eq(improvementSuggestions.companyId, companyId)];
      if (filters?.status) conditions.push(eq(improvementSuggestions.status, filters.status));
      if (filters?.originKind) conditions.push(eq(improvementSuggestions.originKind, filters.originKind));
      if (filters?.targetLayer) conditions.push(eq(improvementSuggestions.targetLayer, filters.targetLayer));
      if (filters?.scope === "instance") {
        conditions.push(inArray(improvementSuggestions.targetLayer, [...ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS]));
      } else if (filters?.scope === "company") {
        conditions.push(inArray(
          improvementSuggestions.targetLayer,
          ["agent_prompt", "company_skill", "company_sop"],
        ));
      }
      const rows = await db
        .select()
        .from(improvementSuggestions)
        .where(and(...conditions))
        .orderBy(desc(improvementSuggestions.createdAt), desc(improvementSuggestions.id));
      return rows.map(toImprovementSuggestion);
    },

    async listInstance(filters?: {
      status?: ImprovementSuggestionStatus;
      originKind?: ImprovementSuggestionOriginKind;
      targetLayer?: ImprovementTargetLayer;
    }) {
      const conditions = [
        inArray(improvementSuggestions.targetLayer, [...ROOT_LEVEL_IMPROVEMENT_TARGET_LAYERS]),
      ];
      if (filters?.status) conditions.push(eq(improvementSuggestions.status, filters.status));
      if (filters?.originKind) conditions.push(eq(improvementSuggestions.originKind, filters.originKind));
      if (filters?.targetLayer) conditions.push(eq(improvementSuggestions.targetLayer, filters.targetLayer));
      const rows = await db
        .select({
          suggestion: improvementSuggestions,
          companyName: companies.name,
          companyIssuePrefix: companies.issuePrefix,
        })
        .from(improvementSuggestions)
        .innerJoin(companies, eq(improvementSuggestions.companyId, companies.id))
        .where(and(...conditions))
        .orderBy(desc(improvementSuggestions.createdAt), desc(improvementSuggestions.id));
      return rows.map((row) => ({
        ...toImprovementSuggestion(row.suggestion),
        companyName: row.companyName,
        companyIssuePrefix: row.companyIssuePrefix,
      }));
    },

    get,

    async create(
      companyId: string,
      input: CreateImprovementSuggestion,
      actor:
        | { type: "board"; userId: string; localImplicit?: boolean }
        | { type: "agent"; agentId: string; runId?: string | null },
    ) {
      await assertSourceIssue(companyId, input.sourceIssueId);
      if (actor.type === "agent") {
        await assertAgent(companyId, actor.agentId);
        await assertActorRun(companyId, actor.agentId, actor.runId);
      } else {
        await assertBoardAuthority(companyId, input.targetLayer, actor);
      }

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
          sourceRunId: actor.type === "agent" ? actor.runId ?? null : null,
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
      reviewer: { userId: string; localImplicit?: boolean },
    ) {
      const current = await get(companyId, suggestionId);
      await assertBoardAuthority(companyId, current.targetLayer, reviewer);
      const now = new Date();
      const status = input.decision === "accept" ? "accepted" : "rejected";
      const row = await db
        .update(improvementSuggestions)
        .set({
          status,
          reviewedByUserId: reviewer.userId,
          reviewNote: input.note,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(improvementSuggestions.companyId, companyId),
          eq(improvementSuggestions.id, suggestionId),
          inArray(improvementSuggestions.originKind, ["agent_detected", "feedback_detected"]),
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
