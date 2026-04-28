import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2QualityScores,
  rt2V33ContradictionCandidates,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  rt2V33WikiPages,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
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

function short(text: string | null | undefined, max = 220): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function asMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
    ]);

    return { todos, participants, deliverables, qualityScores, wikiPages, graphNodes };
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
    getTaskAdvice: async (companyId: string, taskIssueId: string) => {
      const task = await getTaskContext(companyId, taskIssueId);
      const evidence = await getTaskEvidence(companyId, task);
      const grounding = await getGrounding(companyId, task);
      const activeParticipants = evidence.participants.filter((participant) => participant.state === "active").length;
      const openTodos = evidence.todos.filter((todo) => !["done", "cancelled"].includes(todo.status));
      const submittedDeliverables = evidence.deliverables.filter((deliverable) => deliverable.status !== "draft");

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
        },
        grounding,
        suggestions,
        insights: [
          `${task.status} 상태의 Task입니다.`,
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
