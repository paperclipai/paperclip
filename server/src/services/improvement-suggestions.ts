import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
  CreateImprovementImplementationIssue,
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
import { issueService } from "./issues.js";

type ImprovementSuggestionRow = typeof improvementSuggestions.$inferSelect;

type ImplementationIssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "identifier" | "title" | "status" | "assigneeAgentId"
>;

function toImprovementSuggestion(
  row: ImprovementSuggestionRow,
  implementationIssue: ImplementationIssueRow | null = null,
): ImprovementSuggestion {
  return {
    ...row,
    originKind: row.originKind as ImprovementSuggestionOriginKind,
    status: row.status as ImprovementSuggestionStatus,
    targetLayer: row.targetLayer as ImprovementTargetLayer,
    scope: improvementScopeForTarget(row.targetLayer as ImprovementTargetLayer),
    evidence: row.evidence ?? [],
    implementationIssue,
  };
}

function implementationIssueDescription(suggestion: ImprovementSuggestion) {
  const evidence = suggestion.evidence
    .map((entry) => `- ${entry.kind}: ${entry.ref}${entry.note ? ` — ${entry.note}` : ""}`)
    .join("\n");
  const scopeLabel = suggestion.scope === "instance" ? "Paperclip / instance" : "Company";
  return [
    "# Accepted improvement",
    "",
    `Scope: ${scopeLabel}`,
    `Target layer: ${suggestion.targetLayer}`,
    `Suggestion ID: ${suggestion.id}`,
    "",
    "## Problem",
    suggestion.summary,
    "",
    "## Approved direction",
    suggestion.proposedChange,
    "",
    "## Board decision",
    suggestion.reviewNote ?? "Accepted by the board.",
    "",
    "## Evidence",
    evidence || "- No evidence references were recorded.",
    "",
    "## Completion requirements",
    "- Implement the approved change in the named target layer.",
    "- Add or update regression coverage for the original failure class.",
    "- Verify the behavior against the source issue and evidence.",
    "- Summarize the changed artifact and proof before marking this issue done.",
  ].join("\n");
}

export function improvementSuggestionService(db: Db) {
  async function hydrate(rows: ImprovementSuggestionRow[]) {
    const ids = [...new Set(rows.map((row) => row.implementationIssueId).filter((id): id is string => Boolean(id)))];
    const issueRows = ids.length === 0
      ? []
      : await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(inArray(issues.id, ids));
    const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
    return rows.map((row) => toImprovementSuggestion(
      row,
      row.implementationIssueId ? issueById.get(row.implementationIssueId) ?? null : null,
    ));
  }

  async function resolveImplementationAssignee(
    companyId: string,
    targetLayer: ImprovementTargetLayer,
    requestedAgentId?: string | null,
  ) {
    const candidates = await db
      .select({
        id: agents.id,
        role: agents.role,
        name: agents.name,
        title: agents.title,
        capabilities: agents.capabilities,
        reportsTo: agents.reportsTo,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const assignable = candidates.filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval");
    if (requestedAgentId) {
      const requested = assignable.find((agent) => agent.id === requestedAgentId);
      if (!requested) throw unprocessable("Implementation assignee must be an assignable agent in this company");
      return requested.id;
    }
    const instanceTarget = isRootLevelImprovementTarget(targetLayer);
    const preferredRoles = instanceTarget
      ? targetLayer === "qa_gate"
        ? ["qa", "engineer", "devops", "cto", "ceo"]
        : ["engineer", "devops", "qa", "cto", "ceo"]
      : ["ceo", "cto", "pm", "engineer", "general"];
    const statusRank = (status: string) =>
      status === "idle" || status === "active" ? 0 : status === "running" ? 1 : status === "error" ? 4 : 5;
    return assignable
      .sort((left, right) => {
        const leftText = `${left.name} ${left.title ?? ""} ${left.capabilities ?? ""}`.toLowerCase();
        const rightText = `${right.name} ${right.title ?? ""} ${right.capabilities ?? ""}`.toLowerCase();
        const leftMaintainer = instanceTarget && /paperclip|maintainer/.test(leftText) ? -10 : 0;
        const rightMaintainer = instanceTarget && /paperclip|maintainer/.test(rightText) ? -10 : 0;
        const leftRole = preferredRoles.indexOf(left.role);
        const rightRole = preferredRoles.indexOf(right.role);
        const leftScore = leftMaintainer + statusRank(left.status) * 10 + (leftRole < 0 ? 20 : leftRole);
        const rightScore = rightMaintainer + statusRank(right.status) * 10 + (rightRole < 0 ? 20 : rightRole);
        return leftScore - rightScore;
      })[0]?.id ?? null;
  }

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
    return (await hydrate([row]))[0]!;
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
      return hydrate(rows);
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
      const hydrated = await hydrate(rows.map((row) => row.suggestion));
      const companyBySuggestionId = new Map(rows.map((row) => [row.suggestion.id, row]));
      return hydrated.map((suggestion) => ({
        ...suggestion,
        ...(() => {
          const company = companyBySuggestionId.get(suggestion.id)!;
          return {
            companyName: company.companyName,
            companyIssuePrefix: company.companyIssuePrefix,
          };
        })(),
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
      return (await hydrate([row]))[0]!;
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
      if (row) return (await hydrate([row]))[0]!;

      const existing = await get(companyId, suggestionId);
      if (existing.originKind === "board_directed") {
        throw conflict("Board-directed changes are accepted when recorded and are not reviewable suggestions");
      }
      throw conflict(`Improvement suggestion has already been ${existing.status}`);
    },

    async createImplementationIssue(
      companyId: string,
      suggestionId: string,
      input: CreateImprovementImplementationIssue,
      actor: { userId: string; localImplicit?: boolean },
    ) {
      const suggestion = await get(companyId, suggestionId);
      await assertBoardAuthority(companyId, suggestion.targetLayer, actor);
      if (suggestion.status !== "accepted") {
        throw conflict("Only accepted improvement suggestions can create implementation issues");
      }
      if (suggestion.implementationIssue) {
        return { suggestion, issue: suggestion.implementationIssue, created: false };
      }

      const existingIssue = await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "improvement_suggestion"),
          eq(issues.originId, suggestion.id),
          isNull(issues.hiddenAt),
        ))
        .then((rows) => rows[0] ?? null);
      let issue = existingIssue;
      let created = false;
      if (!issue) {
        const sourceIssue = suggestion.sourceIssueId
          ? await db
            .select({ projectId: issues.projectId, goalId: issues.goalId })
            .from(issues)
            .where(and(eq(issues.id, suggestion.sourceIssueId), eq(issues.companyId, companyId)))
            .then((rows) => rows[0] ?? null)
          : null;
        const assigneeAgentId = await resolveImplementationAssignee(
          companyId,
          suggestion.targetLayer,
          input.assigneeAgentId,
        );
        try {
          issue = await issueService(db).create(companyId, {
            title: `[Improvement] ${suggestion.title}`,
            description: implementationIssueDescription(suggestion),
            status: assigneeAgentId ? "todo" : "backlog",
            priority: "high",
            workMode: "standard",
            workItemType: "ai_task",
            assigneeAgentId,
            createdByUserId: actor.userId,
            projectId: sourceIssue?.projectId ?? null,
            goalId: sourceIssue?.goalId ?? null,
            originKind: "improvement_suggestion",
            originId: suggestion.id,
            originFingerprint: "implementation",
            visibility: "company",
          });
          created = true;
        } catch (error) {
          issue = await db
            .select()
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              eq(issues.originKind, "improvement_suggestion"),
              eq(issues.originId, suggestion.id),
              isNull(issues.hiddenAt),
            ))
            .then((rows) => rows[0] ?? null);
          if (!issue) throw error;
        }
      }

      await db
        .update(improvementSuggestions)
        .set({ implementationIssueId: issue.id, updatedAt: new Date() })
        .where(and(
          eq(improvementSuggestions.companyId, companyId),
          eq(improvementSuggestions.id, suggestion.id),
        ));
      return {
        suggestion: await get(companyId, suggestion.id),
        issue,
        created,
      };
    },
  };
}
