import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  approvals,
  heartbeatRunEvents,
  issueWorkProducts,
  issues,
  rt2JarvisRewriteEvals,
  rt2JarvisRewriteProposals,
  rt2QualityScores,
  rt2V33ContradictionCandidates,
  rt2V33ExecutionAttempts,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  rt2V33DailyWikiPages,
  rt2V33WikiPages,
} from "@paperclipai/db";
import type {
  Rt2JarvisRewriteCitationEvidence,
  Rt2JarvisRewriteEvalComparison,
  Rt2JarvisRewriteEvalProviderStatus,
  Rt2JarvisRewriteEvalRecommendation,
  Rt2JarvisRewriteEvalRubric,
  Rt2JarvisRewriteProposal,
  Rt2JarvisRewriteProposalInput,
  Rt2JarvisRewriteProposalList,
  Rt2JarvisRewriteRiskLevel,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { rt2HybridSearchService, type SearchResult } from "./rt2-hybrid-search.js";

type TaskContext = {
  issueId: string;
  companyId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  capacity: number;
};

type GroundedCitation = {
  id: string;
  label: string;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  projectId: string | null;
  snippet: string;
  confidence: string;
  freshness: "fresh" | "stale" | "unknown";
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  score: number;
  target: {
    kind: "task" | "work_object" | "wiki_page" | "daily_wiki_page" | "graph_node" | "graph_edge" | "contradiction_item" | "document";
    path: string;
    params: Record<string, string>;
  };
};

type GroundingWarning = {
  type: "stale_evidence" | "unresolved_contradiction";
  severity: "warning" | "blocker";
  message: string;
  citationId: string;
};

type RewriteEvalRow = typeof rt2JarvisRewriteEvals.$inferInsert;
type RewriteProposalInsert = typeof rt2JarvisRewriteProposals.$inferInsert;
type RewriteProposalRow = typeof rt2JarvisRewriteProposals.$inferSelect;

function short(text: string | null | undefined, max = 220): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function asMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function summarizeWikiRewrite(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3);
}

export function rt2JarvisService(db: Db) {
  const hybridSearch = rt2HybridSearchService(db);

  async function getTaskContext(companyId: string, taskIssueId: string): Promise<TaskContext> {
    const row = await db
      .select({
        issueId: issues.id,
        companyId: issues.companyId,
        projectId: rt2V33TaskProfiles.projectId,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        capacity: rt2V33TaskProfiles.capacity,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
      .where(and(eq(rt2V33TaskProfiles.issueId, taskIssueId), eq(rt2V33TaskProfiles.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!row) throw notFound("RT2 task not found");
    return row;
  }

  async function getTaskEvidence(companyId: string, task: TaskContext) {
    const [
      todos,
      participants,
      deliverables,
      qualityScores,
      wikiPages,
      graphNodes,
      executions,
    ] = await Promise.all([
      db
        .select({
          id: issues.id,
          title: issues.title,
          status: issues.status,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.parentId, task.issueId)))
        .orderBy(desc(issues.updatedAt)),
      db
        .select()
        .from(rt2V33TaskParticipants)
        .where(and(eq(rt2V33TaskParticipants.companyId, companyId), eq(rt2V33TaskParticipants.taskIssueId, task.issueId))),
      db
        .select()
        .from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.issueId, task.issueId))),
      db
        .select()
        .from(rt2QualityScores)
        .where(and(eq(rt2QualityScores.companyId, companyId), eq(rt2QualityScores.taskIssueId, task.issueId)))
        .orderBy(desc(rt2QualityScores.createdAt))
        .limit(5),
      db
        .select()
        .from(rt2V33WikiPages)
        .where(and(eq(rt2V33WikiPages.companyId, companyId), sql`${rt2V33WikiPages.sourceEventIds}::text ILIKE ${`%${task.issueId}%`}`))
        .orderBy(desc(rt2V33WikiPages.updatedAt))
        .limit(5),
      db
        .select()
        .from(rt2V33GraphNodes)
        .where(and(eq(rt2V33GraphNodes.companyId, companyId), eq(rt2V33GraphNodes.sourceId, task.issueId)))
        .limit(5),
      db
        .select()
        .from(rt2V33ExecutionAttempts)
        .where(and(eq(rt2V33ExecutionAttempts.companyId, companyId), eq(rt2V33ExecutionAttempts.taskIssueId, task.issueId)))
        .orderBy(desc(rt2V33ExecutionAttempts.updatedAt), desc(rt2V33ExecutionAttempts.createdAt))
        .limit(5),
    ]);

    const heartbeatRunIds = executions
      .map((execution) => execution.heartbeatRunId)
      .filter((runId): runId is string => Boolean(runId));
    const heartbeatEvents = heartbeatRunIds.length > 0
      ? await db
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.companyId, companyId),
          inArray(heartbeatRunEvents.runId, heartbeatRunIds),
        ))
        .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.seq))
        .limit(5)
      : [];

    return { todos, participants, deliverables, qualityScores, wikiPages, graphNodes, executions, heartbeatEvents };
  }

  async function getGrounding(companyId: string, task: TaskContext) {
    const query = [task.title, task.description].filter(Boolean).join(" ");
    const semantic = query.trim()
      ? await hybridSearch.search(companyId, query, {
        projectId: task.projectId,
        limit: 6,
        contradictionStatus: "all",
      })
      : { results: [] as SearchResult[] };

    const openContradictions = await db
      .select()
      .from(rt2V33ContradictionCandidates)
      .where(and(
        eq(rt2V33ContradictionCandidates.companyId, companyId),
        eq(rt2V33ContradictionCandidates.projectId, task.projectId),
        eq(rt2V33ContradictionCandidates.status, "open"),
      ))
      .orderBy(desc(rt2V33ContradictionCandidates.updatedAt))
      .limit(5);

    const semanticCitations = semantic.results.map(citationFromSearchResult);
    const contradictionCitations = openContradictions.map((candidate) => ({
      id: `contradiction:${candidate.id}`,
      label: candidate.title,
      sourceType: "contradiction_item",
      sourceId: candidate.id,
      sourceKey: candidate.id,
      projectId: candidate.projectId,
      snippet: short(candidate.explanation, 240),
      confidence: candidate.confidence,
      freshness: "unknown" as const,
      contradictionStatus: "unresolved" as const,
      score: 100,
      target: {
        kind: "contradiction_item" as const,
        path: `/rt2/knowledge?tab=bridge&contradiction=${encodeURIComponent(candidate.id)}`,
        params: { contradictionId: candidate.id },
      },
    }));

    const citations = dedupeCitations([...semanticCitations, ...contradictionCitations]);
    const warnings: GroundingWarning[] = [
      ...semanticCitations
        .filter((citation) => citation.freshness === "stale")
        .map((citation) => ({
          type: "stale_evidence" as const,
          severity: "warning" as const,
          message: `근거 ${citation.label}가 stale 상태입니다. 최신 지식 인덱스나 contradiction resolution을 확인해야 합니다.`,
          citationId: citation.id,
        })),
      ...contradictionCitations.map((citation) => ({
        type: "unresolved_contradiction" as const,
        severity: "blocker" as const,
        message: `미해결 contradiction이 있습니다: ${citation.label}`,
        citationId: citation.id,
      })),
    ];

    return {
      query,
      citations,
      warnings,
      retrieval: {
        searchType: "hybrid-semantic",
        resultCount: semantic.results.length,
        projectScoped: true,
      },
    };
  }

  return {
    createRewriteProposal: async (
      companyId: string,
      input: Rt2JarvisRewriteProposalInput,
      actorId = "system",
    ): Promise<Rt2JarvisRewriteProposal> => {
      const citations = input.citations ?? [];
      const contradictionIds = input.contradictionIds ?? [];
      const fallbackRubric = buildFallbackRewriteEval(input, citations, contradictionIds);
      const providerStatus = input.providerEval?.status ?? "not_run";
      const providerRubric = buildProviderRubric(input.providerEval, providerStatus);
      const comparison = compareRewriteEvals(providerStatus, providerRubric, fallbackRubric);
      const riskLevel = riskFromEvidence(citations, contradictionIds, comparison);
      const status = riskLevel === "high" || comparison.finalRecommendation === "block" ? "blocked" : "proposed";

      const proposalInsert: RewriteProposalInsert = {
        companyId,
        projectId: input.projectId ?? null,
        targetType: input.targetType,
        targetId: input.targetId,
        targetKey: input.targetKey,
        title: input.title,
        status,
        riskLevel,
        proposedDiff: {
          before: input.before,
          after: input.after,
          summary: summarizeDiff(input.before, input.after),
        },
        rationale: input.rationale ?? null,
        citations: citations as unknown as Array<Record<string, unknown>>,
        contradictionIds,
        latestEval: comparison as unknown as Record<string, unknown>,
        createdBy: actorId,
      };
      const [proposal] = await db.insert(rt2JarvisRewriteProposals).values(proposalInsert).returning();

      const evalInsert: RewriteEvalRow = {
        proposalId: proposal.id,
        companyId,
        providerStatus,
        fallbackStatus: "completed",
        providerRubric: providerRubric as unknown as Record<string, unknown> | null,
        fallbackRubric: fallbackRubric as unknown as Record<string, unknown>,
        comparison: comparison as unknown as Record<string, unknown>,
      };
      await db.insert(rt2JarvisRewriteEvals).values(evalInsert);

      await db.insert(activityLog).values({
        companyId,
        actorType: actorId === "system" ? "system" : "user",
        actorId,
        action: "rt2.jarvis.rewrite_proposal_created",
        entityType: "jarvis_rewrite_proposal",
        entityId: proposal.id,
        details: {
          targetType: input.targetType,
          targetKey: input.targetKey,
          riskLevel,
          status,
          providerStatus,
          reasonCodes: comparison.reasonCodes,
          contradictionIds,
          citationIds: citations.map((citation) => citation.id),
        },
      });

      return mapRewriteProposal(proposal);
    },

    listRewriteProposals: async (companyId: string): Promise<Rt2JarvisRewriteProposalList> => {
      const rows = await db.select()
        .from(rt2JarvisRewriteProposals)
        .where(eq(rt2JarvisRewriteProposals.companyId, companyId))
        .orderBy(desc(rt2JarvisRewriteProposals.createdAt))
        .limit(100);
      const proposals = rows.map(mapRewriteProposal);
      return {
        companyId,
        proposals,
        stats: summarizeRewriteProposals(proposals),
      };
    },

    requestRewriteApproval: async (companyId: string, proposalId: string, requestedByUserId = "system") => {
      const proposal = await getRewriteProposal(companyId, proposalId);
      const [approval] = await db.insert(approvals).values({
        companyId,
        type: "jarvis_auto_action",
        requestedByUserId,
        payload: {
          title: proposal.title,
          proposalId: proposal.id,
          targetType: proposal.targetType,
          targetKey: proposal.targetKey,
          riskLevel: proposal.riskLevel,
          eval: proposal.latestEval,
          citationIds: proposal.citations.map((citation) => citation.id),
          contradictionIds: proposal.contradictionIds,
        },
      }).returning();

      const approvalRoute = `/approvals/${approval.id}`;
      const [updated] = await db.update(rt2JarvisRewriteProposals).set({
        status: "approval_requested",
        approvalId: approval.id,
        approvalRoute,
        updatedAt: new Date(),
      }).where(and(
        eq(rt2JarvisRewriteProposals.companyId, companyId),
        eq(rt2JarvisRewriteProposals.id, proposalId),
      )).returning();

      await db.insert(activityLog).values({
        companyId,
        actorType: requestedByUserId === "system" ? "system" : "user",
        actorId: requestedByUserId,
        action: "rt2.jarvis.rewrite_approval_requested",
        entityType: "jarvis_rewrite_proposal",
        entityId: proposalId,
        details: { approvalId: approval.id, approvalRoute, riskLevel: proposal.riskLevel },
      });

      return mapRewriteProposal(updated);
    },

    decideRewriteProposal: async (
      companyId: string,
      proposalId: string,
      decision: "approved" | "rejected",
      actorId = "system",
      reason?: string,
    ) => {
      const proposal = await getRewriteProposal(companyId, proposalId);
      const [updated] = await db.update(rt2JarvisRewriteProposals).set({
        status: decision,
        updatedAt: new Date(),
      }).where(and(
        eq(rt2JarvisRewriteProposals.companyId, companyId),
        eq(rt2JarvisRewriteProposals.id, proposalId),
      )).returning();

      await db.insert(activityLog).values({
        companyId,
        actorType: actorId === "system" ? "system" : "user",
        actorId,
        action: decision === "approved" ? "rt2.jarvis.rewrite_proposal_approved" : "rt2.jarvis.rewrite_proposal_rejected",
        entityType: "jarvis_rewrite_proposal",
        entityId: proposalId,
        details: {
          approvalId: proposal.approvalId,
          reason: reason ?? null,
          targetType: proposal.targetType,
          targetKey: proposal.targetKey,
          riskLevel: proposal.riskLevel,
        },
      });

      return mapRewriteProposal(updated);
    },

    applyApprovedWikiRewrite: async (
      companyId: string,
      proposalId: string,
      actorId = "system",
      reason?: string,
    ) => {
      const proposal = await getRewriteProposal(companyId, proposalId);
      if (proposal.targetType !== "wiki_page" && proposal.targetType !== "daily_wiki_page") {
        throw conflict("Only wiki rewrite proposals can be applied to living memory pages");
      }
      if (proposal.status !== "approved") {
        throw conflict("Only approved Jarvis wiki rewrite proposals can be applied");
      }

      const now = new Date();
      const appliedAt = now.toISOString();
      const before = proposal.proposedDiff.before.trim();
      const after = proposal.proposedDiff.after;
      const citationIds = proposal.citations.map((citation) => citation.id);

      if (proposal.targetType === "wiki_page") {
        const row = await db.select()
          .from(rt2V33WikiPages)
          .where(and(eq(rt2V33WikiPages.companyId, companyId), eq(rt2V33WikiPages.pageKey, proposal.targetKey)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("RT2 wiki page not found for Jarvis rewrite proposal");
        if (row.markdown.trim() !== before) {
          throw conflict("RT2 wiki page changed since the Jarvis rewrite proposal was created");
        }
        const metadata = asMetadata(row.metadata);
        const relatedPageKeys = Array.isArray(metadata.relatedPageKeys)
          ? metadata.relatedPageKeys.filter((item): item is string => typeof item === "string")
          : [];
        await db.update(rt2V33WikiPages).set({
          markdown: after,
          summary: summarizeWikiRewrite(after),
          metadata: {
            ...metadata,
            wikillmCompatible: true,
            provenance: {
              source: "jarvis_rewrite",
              sourceEventIds: row.sourceEventIds ?? [],
              sourceEventTypes: [],
              entityRefs: [],
              generatedAt: appliedAt,
            },
            updateEvidence: {
              reason: reason ?? "jarvis_approved_wiki_rewrite",
              touchedPageKeys: [proposal.targetKey, ...relatedPageKeys],
              sourceEventIds: row.sourceEventIds ?? [],
              sourceEventCount: row.sourceEventIds?.length ?? 0,
              relatedPageKeys,
              generatedAt: appliedAt,
              actorId,
              proposalId,
              citationIds,
            },
            jarvisRewrite: {
              proposalId,
              appliedBy: actorId,
              appliedAt,
              reason: reason ?? null,
            },
          },
          updatedAt: now,
        }).where(and(eq(rt2V33WikiPages.companyId, companyId), eq(rt2V33WikiPages.pageKey, proposal.targetKey)));
      } else {
        const row = await db.select()
          .from(rt2V33DailyWikiPages)
          .where(and(eq(rt2V33DailyWikiPages.companyId, companyId), eq(rt2V33DailyWikiPages.pageKey, proposal.targetKey)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("RT2 daily wiki page not found for Jarvis rewrite proposal");
        if (row.markdown.trim() !== before) {
          throw conflict("RT2 daily wiki page changed since the Jarvis rewrite proposal was created");
        }
        await db.update(rt2V33DailyWikiPages).set({
          markdown: after,
          shortSummary: summarizeWikiRewrite(after),
          updatedAt: now,
        }).where(and(eq(rt2V33DailyWikiPages.companyId, companyId), eq(rt2V33DailyWikiPages.pageKey, proposal.targetKey)));
      }

      const [updated] = await db.update(rt2JarvisRewriteProposals).set({
        status: "applied",
        updatedAt: new Date(),
      }).where(and(
        eq(rt2JarvisRewriteProposals.companyId, companyId),
        eq(rt2JarvisRewriteProposals.id, proposalId),
      )).returning();

      await db.insert(activityLog).values({
        companyId,
        actorType: actorId === "system" ? "system" : "user",
        actorId,
        action: "rt2.jarvis.wiki_rewrite_applied",
        entityType: proposal.targetType,
        entityId: proposal.targetKey,
        details: {
          proposalId,
          targetType: proposal.targetType,
          targetKey: proposal.targetKey,
          citationIds,
          contradictionIds: proposal.contradictionIds,
          reason: reason ?? null,
          appliedAt,
        },
      });

      return mapRewriteProposal(updated);
    },

    getTaskAdvice: async (companyId: string, taskIssueId: string) => {
      const task = await getTaskContext(companyId, taskIssueId);
      const evidence = await getTaskEvidence(companyId, task);
      const grounding = await getGrounding(companyId, task);
      const activeParticipants = evidence.participants.filter((participant) => participant.state === "active").length;
      const openTodos = evidence.todos.filter((todo) => !["done", "cancelled"].includes(todo.status));
      const submittedDeliverables = evidence.deliverables.filter((deliverable) => deliverable.status !== "draft");
      const latestExecution = evidence.executions[0] ?? null;
      const latestHeartbeat = evidence.heartbeatEvents[0] ?? null;

      const suggestions: string[] = [];
      if (openTodos.length === 0) {
        suggestions.push("To-Do가 비어 있습니다. 산출물 기준으로 다음 실행 단위를 먼저 쪼개야 합니다.");
      }
      if (evidence.deliverables.length === 0) {
        suggestions.push("이 Task에는 산출물이 없습니다. RT2 작업 단위로 완료하려면 산출물 정의가 필요합니다.");
      }
      if (activeParticipants < task.capacity) {
        suggestions.push(`협업 정원이 ${task.capacity - activeParticipants}명 남아 있습니다. 병렬 진행 가능한 역할을 배정할 수 있습니다.`);
      }
      if (evidence.qualityScores.some((score) => score.managerDecision === "pending")) {
        suggestions.push("대기 중인 품질평가가 있습니다. 완료 처리 전에 승인 경계를 먼저 정리해야 합니다.");
      }
      if (latestExecution?.state === "failed" || latestExecution?.state === "cancelled") {
        suggestions.push(`최근 실행이 ${latestExecution.state} 상태입니다. failureReason과 runtime evidence를 보고 재시도 여부를 결정하세요.`);
      }
      if (
        latestExecution &&
        ["dispatched", "claimed", "running"].includes(latestExecution.state) &&
        !latestHeartbeat
      ) {
        suggestions.push("활성 실행이 있지만 heartbeat progress 신호가 없습니다. runtime 연결 또는 cleanup 후보 여부를 확인해야 합니다.");
      }
      if (grounding.warnings.some((warning) => warning.type === "unresolved_contradiction")) {
        suggestions.push("Jarvis 답변 근거에 미해결 contradiction이 있습니다. 실행 결정을 내리기 전에 Bridge 검토가 필요합니다.");
      }
      if (grounding.warnings.some((warning) => warning.type === "stale_evidence")) {
        suggestions.push("일부 semantic 근거가 stale 상태입니다. 답변을 확정하기 전에 재색인 또는 resolution 상태를 확인하세요.");
      }

      return {
        taskIssueId,
        companyId,
        projectId: task.projectId,
        evidence: {
          taskTitle: task.title,
          todoCount: evidence.todos.length,
          openTodoCount: openTodos.length,
          deliverableCount: evidence.deliverables.length,
          submittedDeliverableCount: submittedDeliverables.length,
          activeParticipantCount: activeParticipants,
          wikiPageKeys: evidence.wikiPages.map((page) => page.pageKey),
          graphNodeKeys: evidence.graphNodes.map((node) => node.nodeKey),
          executionState: latestExecution?.state === "claimed" ? "dispatched" : latestExecution?.state ?? null,
          executionRuntimeServiceId: latestExecution?.runtimeServiceId ?? null,
          executionHeartbeatRunId: latestExecution?.heartbeatRunId ?? null,
          executionLatestSignal: latestHeartbeat
            ? {
              type: latestHeartbeat.eventType,
              message: latestHeartbeat.message,
              seq: latestHeartbeat.seq,
              createdAt: latestHeartbeat.createdAt,
            }
            : null,
        },
        grounding,
        suggestions,
        insights: [
          `${task.status} 상태의 Task입니다.`,
          ...(latestExecution
            ? [`최근 실행: ${latestExecution.state === "claimed" ? "dispatched" : latestExecution.state}${latestExecution.executorId ? ` by ${latestExecution.executorId}` : ""}`]
            : []),
          ...(latestHeartbeat?.message ? [`최근 runtime 신호: ${latestHeartbeat.message}`] : []),
          ...evidence.wikiPages.slice(0, 2).map((page) => `관련 wiki: ${page.pageKey} - ${short(page.summary.join(" "))}`),
        ],
        nextSteps: openTodos.slice(0, 5).map((todo) => ({
          todoIssueId: todo.id,
          title: todo.title,
          status: todo.status,
          assigneeUserId: todo.assigneeUserId ?? null,
        })),
      };
    },

    getTaskBreakdown: async (companyId: string, taskIssueId: string) => {
      const task = await getTaskContext(companyId, taskIssueId);
      const evidence = await getTaskEvidence(companyId, task);
      const deliverableHints = evidence.deliverables.map((deliverable) => {
        const metadata = asMetadata(deliverable.metadata);
        return {
          title: deliverable.title,
          type: String(metadata.rt2Type ?? deliverable.type),
          basePrice: typeof metadata.rt2BasePrice === "number" ? metadata.rt2BasePrice : null,
          status: deliverable.status,
        };
      });

      return {
        taskIssueId,
        companyId,
        projectId: task.projectId,
        subtasks: evidence.todos.map((todo) => ({
          todoIssueId: todo.id,
          title: todo.title,
          status: todo.status,
          assigneeUserId: todo.assigneeUserId ?? null,
        })),
        estimatedDuration: evidence.todos.length > 0 ? `${Math.max(1, evidence.todos.length)} work blocks` : null,
        priorityHints: [
          ...(deliverableHints.length > 0 ? [`산출물 ${deliverableHints.length}개 기준으로 검수 순서를 잡으세요.`] : ["산출물 정의가 우선입니다."]),
          ...(task.description ? [`Task 설명 근거: ${short(task.description, 120)}`] : []),
        ],
        deliverableHints,
      };
    },

    getProjectInsights: async (companyId: string, projectId: string) => {
      const [taskRows, deliverableRows, qualityRows, wikiRows, graphCounts] = await Promise.all([
        db
          .select({
            issueId: issues.id,
            title: issues.title,
            status: issues.status,
          })
          .from(rt2V33TaskProfiles)
          .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
          .where(and(eq(rt2V33TaskProfiles.companyId, companyId), eq(rt2V33TaskProfiles.projectId, projectId))),
        db
          .select()
          .from(issueWorkProducts)
          .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.projectId, projectId))),
        db
          .select()
          .from(rt2QualityScores)
          .where(eq(rt2QualityScores.companyId, companyId))
          .orderBy(desc(rt2QualityScores.createdAt))
          .limit(20),
        db
          .select()
          .from(rt2V33WikiPages)
          .where(and(eq(rt2V33WikiPages.companyId, companyId), sql`${rt2V33WikiPages.pageKey} ILIKE ${`%${projectId}%`}`))
          .orderBy(desc(rt2V33WikiPages.updatedAt))
          .limit(5),
        db
          .select({
            nodes: sql<number>`count(distinct ${rt2V33GraphNodes.id})::int`,
            edges: sql<number>`count(distinct ${rt2V33GraphEdges.id})::int`,
          })
          .from(rt2V33GraphNodes)
          .leftJoin(rt2V33GraphEdges, eq(rt2V33GraphEdges.projectId, rt2V33GraphNodes.projectId))
          .where(and(eq(rt2V33GraphNodes.companyId, companyId), eq(rt2V33GraphNodes.projectId, projectId))),
      ]);

      const taskIds = taskRows.map((task) => task.issueId);
      const projectQualityRows = qualityRows.filter((row) => taskIds.includes(row.taskIssueId));
      const doneTasks = taskRows.filter((task) => task.status === "done").length;
      const pendingQuality = projectQualityRows.filter((row) => row.managerDecision === "pending").length;
      const healthScore = taskRows.length === 0
        ? 0
        : Math.max(0, Math.min(100, Math.round((doneTasks / taskRows.length) * 70 + (deliverableRows.length / Math.max(1, taskRows.length)) * 20 - pendingQuality * 5)));

      return {
        companyId,
        projectId,
        healthScore,
        riskFactors: [
          ...(taskRows.length === 0 ? ["프로젝트에 RT2 Task가 아직 없습니다."] : []),
          ...(deliverableRows.length < taskRows.length ? ["일부 Task에 산출물 근거가 부족합니다."] : []),
          ...(pendingQuality > 0 ? [`품질평가 ${pendingQuality}건이 승인 대기 중입니다.`] : []),
        ],
        opportunities: [
          ...(wikiRows.length > 0 ? [`누적 wiki ${wikiRows.length}개를 Jarvis 응답 근거로 사용할 수 있습니다.`] : []),
          `Graph 근거: node ${graphCounts[0]?.nodes ?? 0}, edge ${graphCounts[0]?.edges ?? 0}`,
        ],
        summary: `${taskRows.length} tasks, ${deliverableRows.length} deliverables, ${projectQualityRows.length} quality evaluations`,
      };
    },
  };

  async function getRewriteProposal(companyId: string, proposalId: string): Promise<Rt2JarvisRewriteProposal> {
    const row = await db.select()
      .from(rt2JarvisRewriteProposals)
      .where(and(eq(rt2JarvisRewriteProposals.companyId, companyId), eq(rt2JarvisRewriteProposals.id, proposalId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Jarvis rewrite proposal not found");
    return mapRewriteProposal(row);
  }
}

function buildFallbackRewriteEval(
  input: Rt2JarvisRewriteProposalInput,
  citations: Rt2JarvisRewriteCitationEvidence[],
  contradictionIds: string[],
): Rt2JarvisRewriteEvalRubric {
  const hasCitations = citations.length > 0;
  const staleCount = citations.filter((citation) => citation.freshness === "stale").length;
  const unresolvedCount = citations.filter((citation) => citation.contradictionStatus === "unresolved").length + contradictionIds.length;
  const diffChars = Math.abs(input.after.length - input.before.length) + input.after.length;
  const citationDensity = citations.length / Math.max(1, Math.ceil(diffChars / 500));

  const dimensions = [
    {
      key: "citation_coverage" as const,
      score: hasCitations ? Math.min(100, 55 + citations.length * 15) : 0,
      rationale: hasCitations ? `${citations.length} citation(s) attached to the rewrite proposal.` : "No citations attached to the rewrite proposal.",
    },
    {
      key: "freshness" as const,
      score: staleCount > 0 ? 40 : hasCitations ? 95 : 60,
      rationale: staleCount > 0 ? `${staleCount} stale citation(s) require review.` : "No stale citations detected by deterministic fallback.",
    },
    {
      key: "contradiction_safety" as const,
      score: unresolvedCount > 0 ? 20 : 95,
      rationale: unresolvedCount > 0 ? `${unresolvedCount} unresolved contradiction signal(s) block direct trust.` : "No unresolved contradiction signal detected.",
    },
    {
      key: "diff_scope" as const,
      score: diffChars <= 1000 ? 95 : diffChars <= 4000 ? 70 : 45,
      rationale: `Rewrite diff scope is ${diffChars} character units.`,
    },
    {
      key: "evidence_density" as const,
      score: Math.min(100, Math.round(citationDensity * 50)),
      rationale: `Citation density is ${citationDensity.toFixed(2)} citation(s) per 500 changed characters.`,
    },
  ];
  const overallScore = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
  const confidence = Math.max(0.1, Math.min(0.95, overallScore / 100));
  const recommendation: Rt2JarvisRewriteEvalRecommendation = unresolvedCount > 0 || staleCount > 0 || !hasCitations
    ? "block"
    : overallScore >= 80
      ? "approve"
      : overallScore >= 60
        ? "revise"
        : "reject";

  return {
    rubricVersion: "rt2-jarvis-rewrite-rubric-v1",
    dimensions,
    overallScore,
    confidence,
    recommendation,
    rationale: "Deterministic fallback eval based on citation coverage, freshness, contradiction safety, diff scope, and evidence density.",
  };
}

function buildProviderRubric(
  providerEval: Rt2JarvisRewriteProposalInput["providerEval"],
  status: Rt2JarvisRewriteEvalProviderStatus,
): Rt2JarvisRewriteEvalRubric | null {
  if (!providerEval || status !== "completed") return null;
  return {
    rubricVersion: providerEval.rubricVersion ?? "provider-rubric-v1",
    dimensions: providerEval.dimensions ?? [],
    overallScore: providerEval.overallScore ?? 0,
    confidence: providerEval.confidence ?? 0,
    recommendation: providerEval.recommendation ?? "revise",
    rationale: providerEval.rationale ?? "Provider eval completed without detailed rationale.",
  };
}

function compareRewriteEvals(
  providerStatus: Rt2JarvisRewriteEvalProviderStatus,
  providerRubric: Rt2JarvisRewriteEvalRubric | null,
  fallbackRubric: Rt2JarvisRewriteEvalRubric,
): Rt2JarvisRewriteEvalComparison {
  const disagreement = Boolean(providerRubric && providerRubric.recommendation !== fallbackRubric.recommendation);
  const finalConfidence = providerRubric
    ? Math.min(providerRubric.confidence, fallbackRubric.confidence)
    : fallbackRubric.confidence;
  const lowConfidence = finalConfidence < 0.65;
  const reasonCodes = [
    ...(providerStatus === "unavailable" || providerStatus === "error" ? ["provider_unavailable"] : []),
    ...(disagreement ? ["provider_fallback_disagreement"] : []),
    ...(lowConfidence ? ["low_confidence"] : []),
    ...(fallbackRubric.recommendation === "block" ? ["fallback_blocked"] : []),
  ];
  const finalRecommendation: Rt2JarvisRewriteEvalRecommendation = fallbackRubric.recommendation === "block" || disagreement || lowConfidence
    ? "block"
    : providerRubric?.recommendation ?? fallbackRubric.recommendation;

  return {
    providerStatus,
    fallbackStatus: "completed",
    disagreement,
    lowConfidence,
    finalRecommendation,
    finalConfidence,
    reasonCodes,
  };
}

function riskFromEvidence(
  citations: Rt2JarvisRewriteCitationEvidence[],
  contradictionIds: string[],
  comparison: Rt2JarvisRewriteEvalComparison,
): Rt2JarvisRewriteRiskLevel {
  if (
    citations.length === 0 ||
    citations.some((citation) => citation.freshness === "stale" || citation.contradictionStatus === "unresolved") ||
    contradictionIds.length > 0 ||
    comparison.reasonCodes.length > 0 ||
    comparison.finalRecommendation === "block"
  ) {
    return "high";
  }
  return comparison.finalConfidence >= 0.8 ? "low" : "medium";
}

function summarizeDiff(before: string, after: string): string {
  if (before === after) return "No textual change proposed.";
  return `Rewrite proposal changes ${before.length} chars to ${after.length} chars.`;
}

function mapRewriteProposal(row: RewriteProposalRow): Rt2JarvisRewriteProposal {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    targetType: row.targetType as Rt2JarvisRewriteProposal["targetType"],
    targetId: row.targetId,
    targetKey: row.targetKey,
    title: row.title,
    status: row.status as Rt2JarvisRewriteProposal["status"],
    riskLevel: row.riskLevel as Rt2JarvisRewriteRiskLevel,
    proposedDiff: row.proposedDiff as unknown as Rt2JarvisRewriteProposal["proposedDiff"],
    rationale: row.rationale,
    citations: row.citations as unknown as Rt2JarvisRewriteCitationEvidence[],
    contradictionIds: row.contradictionIds,
    approvalId: row.approvalId,
    approvalRoute: row.approvalRoute,
    latestEval: row.latestEval as Rt2JarvisRewriteEvalComparison | null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function summarizeRewriteProposals(proposals: Rt2JarvisRewriteProposalList["proposals"]): Rt2JarvisRewriteProposalList["stats"] {
  return {
    total: proposals.length,
    proposed: proposals.filter((proposal) => proposal.status === "proposed").length,
    approvalRequested: proposals.filter((proposal) => proposal.status === "approval_requested").length,
    approved: proposals.filter((proposal) => proposal.status === "approved").length,
    applied: proposals.filter((proposal) => proposal.status === "applied").length,
    rejected: proposals.filter((proposal) => proposal.status === "rejected").length,
    blocked: proposals.filter((proposal) => proposal.status === "blocked").length,
    highRisk: proposals.filter((proposal) => proposal.riskLevel === "high").length,
    providerUnavailable: proposals.filter((proposal) => proposal.latestEval?.reasonCodes.includes("provider_unavailable")).length,
    disagreement: proposals.filter((proposal) => proposal.latestEval?.disagreement).length,
    lowConfidence: proposals.filter((proposal) => proposal.latestEval?.lowConfidence).length,
  };
}

function citationFromSearchResult(result: SearchResult): GroundedCitation {
  return {
    id: `${result.sourceType}:${result.sourceId}`,
    label: result.title || result.sourceKey,
    sourceType: result.sourceType,
    sourceId: result.sourceId,
    sourceKey: result.sourceKey,
    projectId: result.projectId,
    snippet: result.snippet,
    confidence: result.confidence,
    freshness: result.freshness,
    contradictionStatus: result.contradictionStatus,
    score: result.score,
    target: targetForSearchResult(result),
  };
}

function targetForSearchResult(result: SearchResult): GroundedCitation["target"] {
  switch (result.type) {
    case "task":
      return {
        kind: "task",
        path: `/issues/${encodeURIComponent(result.sourceId)}`,
        params: { issueId: result.sourceId },
      };
    case "deliverable":
    case "work_artifact": {
      const issueId = typeof result.provenance.issueId === "string" ? result.provenance.issueId : "";
      return {
        kind: "work_object",
        path: issueId ? `/issues/${encodeURIComponent(issueId)}?workProduct=${encodeURIComponent(result.sourceId)}` : `/rt2/knowledge?source=${encodeURIComponent(result.sourceId)}`,
        params: { workProductId: result.sourceId, ...(issueId ? { issueId } : {}) },
      };
    }
    case "wiki_page":
      return {
        kind: "wiki_page",
        path: `/rt2/knowledge?tab=wiki&page=${encodeURIComponent(result.sourceKey)}`,
        params: { pageKey: result.sourceKey },
      };
    case "daily_wiki_page":
      return {
        kind: "daily_wiki_page",
        path: `/rt2/knowledge?tab=wiki&page=${encodeURIComponent(result.sourceKey)}`,
        params: { pageKey: result.sourceKey },
      };
    case "graph_node":
      return {
        kind: "graph_node",
        path: `/rt2/knowledge?tab=graph&node=${encodeURIComponent(result.sourceId)}`,
        params: { nodeId: result.sourceId, nodeKey: result.sourceKey },
      };
    case "graph_edge":
      return {
        kind: "graph_edge",
        path: `/rt2/knowledge?tab=graph&edge=${encodeURIComponent(result.sourceId)}`,
        params: { edgeId: result.sourceId },
      };
    case "document":
      return {
        kind: "document",
        path: `/documents/${encodeURIComponent(result.sourceId)}`,
        params: { documentId: result.sourceId },
      };
  }
}

function dedupeCitations(citations: GroundedCitation[]): GroundedCitation[] {
  const seen = new Set<string>();
  const deduped: GroundedCitation[] = [];
  for (const citation of citations) {
    if (seen.has(citation.id)) continue;
    seen.add(citation.id);
    deduped.push(citation);
  }
  return deduped;
}
