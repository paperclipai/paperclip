import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issues,
  projects,
  rt2V33DailyWikiPages,
  rt2V33ExecutionAttempts,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  rt2QualityScores,
  issueWorkProducts,
} from "@paperclipai/db";
import type {
  Rt2GraphConfidence,
  Rt2GraphEdge,
  Rt2GraphEdgeEvidence,
  Rt2GraphEdgeType,
  Rt2GraphNode,
  Rt2GraphNodeType,
  Rt2GraphReport,
  Rt2TaskMeshNodeEvidence,
  Rt2ProjectGraph,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

type TaskRow = {
  issueId: string;
  title: string;
  status: string;
  parentId: string | null;
};

// ===== M2.5: Knowledge Enhancement - Graph Algorithms =====

/**
 * Simple label propagation algorithm for community detection
 * Simplified Leiden-like approach: iteratively assign communities based on neighbor majority
 */
export function detectCommunities(nodes: Rt2GraphNode[], edges: Rt2GraphEdge[]): Map<string, string> {
  if (nodes.length === 0) return new Map();

  // Build adjacency list
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const edge of edges) {
    adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  // Initialize: each node gets its own community
  const community = new Map<string, number>();
  nodes.forEach((node, idx) => community.set(node.id, idx));

  // Label propagation iterations
  const maxIterations = 10;
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    // Shuffle nodes for randomness
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const neighbors = adjacency.get(node.id) || new Set();
      if (neighbors.size === 0) continue;

      // Count community labels among neighbors
      const labelCounts = new Map<number, number>();
      for (const neighborId of neighbors) {
        const neighborCommunity = community.get(neighborId);
        if (neighborCommunity !== undefined) {
          labelCounts.set(neighborCommunity, (labelCounts.get(neighborCommunity) || 0) + 1);
        }
      }

      // Find most common community
      let maxCount = 0;
      let maxLabel = community.get(node.id)!;
      for (const [label, count] of labelCounts) {
        if (count > maxCount) {
          maxCount = count;
          maxLabel = label;
        }
      }

      if (maxLabel !== community.get(node.id)) {
        community.set(node.id, maxLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Convert numeric communities to string keys
  const uniqueCommunities = [...new Set(community.values())];
  const communityMap = new Map<number, string>();
  uniqueCommunities.forEach((c, idx) => communityMap.set(c, `community_${idx}`));

  const result = new Map<string, string>();
  for (const [nodeId, c] of community) {
    result.set(nodeId, communityMap.get(c)!);
  }
  return result;
}

/**
 * Calculate degree centrality for all nodes
 * Returns map of nodeId -> centrality score (0-1 normalized)
 */
function calculateDegreeCentrality(nodes: Rt2GraphNode[], edges: Rt2GraphEdge[]): Map<string, number> {
  if (nodes.length === 0) return new Map();

  const degree = new Map<string, number>();
  for (const node of nodes) {
    degree.set(node.id, 0);
  }
  for (const edge of edges) {
    degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) || 0) + 1);
    degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) || 0) + 1);
  }

  // Normalize by max possible degree (n-1)
  const maxDegree = nodes.length - 1;
  const normalized = new Map<string, number>();
  for (const [nodeId, deg] of degree) {
    normalized.set(nodeId, maxDegree > 0 ? deg / maxDegree : 0);
  }
  return normalized;
}

/**
 * Detect surprising/unexpected connections based on edge confidence and type patterns
 */
function detectSurprisingConnections(edges: Rt2GraphEdge[]): Rt2GraphEdge[] {
  const surprising: Rt2GraphEdge[] = [];

  for (const edge of edges) {
    // Low confidence edges
    if (edge.confidenceScore !== null && edge.confidenceScore < 0.7) {
      surprising.push(edge);
      continue;
    }

    // INFERRED confidence edges with low score
    if (edge.confidence === "INFERRED" && edge.confidenceScore !== null && edge.confidenceScore < 0.85) {
      surprising.push(edge);
      continue;
    }

    // AMBIGUOUS edges are inherently surprising
    if (edge.confidence === "AMBIGUOUS") {
      surprising.push(edge);
    }
  }

  return surprising;
}

/**
 * Find "God Nodes" - highly central task nodes
 * Returns top 10% most central task nodes
 */
function findGodNodes(nodes: Rt2GraphNode[], centrality: Map<string, number>): string[] {
  const taskNodes = nodes.filter(n => n.nodeType === "task");
  if (taskNodes.length === 0) return [];

  // Sort by centrality
  const sorted = taskNodes
    .map(n => ({ id: n.id, centrality: centrality.get(n.id) || 0 }))
    .sort((a, b) => b.centrality - a.centrality);

  // Return top 10% (min 1)
  const count = Math.max(1, Math.ceil(sorted.length * 0.1));
  return sorted.slice(0, count).map(n => n.id);
}

function buildTaskNode(row: TaskRow, projectId: string, evidence?: Rt2TaskMeshNodeEvidence): Rt2GraphNode {
  return {
    id: `task:${row.issueId}`,
    nodeKey: `task:${row.issueId}`,
    nodeType: "task",
    label: row.title,
    sourceId: row.issueId,
    reportDate: null,
    metadata: {
      status: row.status,
      projectId,
    },
    evidence,
  };
}

function buildTodoNode(row: TaskRow): Rt2GraphNode {
  return {
    id: `todo:${row.issueId}`,
    nodeKey: `todo:${row.issueId}`,
    nodeType: "todo",
    label: row.title,
    sourceId: row.issueId,
    reportDate: null,
    metadata: {
      status: row.status,
      parentTaskId: row.parentId,
    },
  };
}

function buildProjectNode(row: { id: string; name: string }): Rt2GraphNode {
  return {
    id: `project:${row.id}`,
    nodeKey: `project:${row.id}`,
    nodeType: "project",
    label: row.name,
    sourceId: row.id,
    reportDate: null,
    metadata: {},
  };
}

function buildDailyWikiNode(
  row: typeof rt2V33DailyWikiPages.$inferSelect,
): Rt2GraphNode {
  return {
    id: `daily_wiki_page:${row.id}`,
    nodeKey: `daily_wiki_page:${row.pageKey}`,
    nodeType: "daily_wiki_page",
    label: `Daily Wiki: ${row.reportDate}`,
    sourceId: row.id,
    reportDate: row.reportDate,
    metadata: {
      userId: row.userId,
      shortSummary: row.shortSummary,
    },
  };
}

function buildDeliverableNode(
  row: typeof issueWorkProducts.$inferSelect,
): Rt2GraphNode {
  return {
    id: `deliverable:${row.id}`,
    nodeKey: `deliverable:${row.id}`,
    nodeType: "deliverable",
    label: row.title,
    sourceId: row.id,
    reportDate: row.createdAt ? new Date(row.createdAt).toISOString().split("T")[0] : null,
    metadata: {
      type: row.type,
      status: row.status,
      reviewState: row.reviewState,
      url: row.url,
      summary: row.summary,
      provider: row.provider,
      basePrice: readBasePrice(row.metadata),
    },
  };
}

function readBasePrice(metadata: Record<string, unknown> | null): number {
  const value = metadata?.rt2BasePrice;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isSubmittedDeliverable(row: typeof issueWorkProducts.$inferSelect): boolean {
  const metadata = row.metadata ?? {};
  return row.status === "submitted" || row.reviewState !== "none" || metadata.rt2State === "submitted";
}

function resolveQualityStatus(rows: typeof issueWorkProducts.$inferSelect[]): Rt2TaskMeshNodeEvidence["qualityStatus"] {
  if (rows.some((row) => row.reviewState !== "none")) return "reviewed";
  if (rows.some(isSubmittedDeliverable)) return "pending_review";
  return "none";
}

function buildEdge(
  sourceNodeId: string,
  targetNodeId: string,
  edgeType: Rt2GraphEdgeType,
  rationale: string,
  evidence: Rt2GraphEdgeEvidence[],
): Rt2GraphEdge {
  return {
    id: `${sourceNodeId}->${targetNodeId}`,
    edgeType,
    sourceNodeId,
    targetNodeId,
    confidence: "EXTRACTED" as Rt2GraphConfidence,
    confidenceScore: 1.0,
    rationale,
    evidence,
  };
}

export function rt2TaskMeshService(db: Db) {
  async function getProjectGraph(
    companyId: string,
    projectId: string,
  ): Promise<Rt2ProjectGraph> {
    // Verify project exists and belongs to company
    const project = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!project) {
      throw notFound("Project not found");
    }

    // Fetch all task profiles for this project
    const taskProfiles = await db
      .select({ issueId: rt2V33TaskProfiles.issueId })
      .from(rt2V33TaskProfiles)
      .where(
        and(
          eq(rt2V33TaskProfiles.companyId, companyId),
          eq(rt2V33TaskProfiles.projectId, projectId),
        ),
      );

    const taskIssueIds = taskProfiles.map((p) => p.issueId);

    // Fetch all tasks (issues that have rt2 task profiles)
    const tasks = taskIssueIds.length > 0
      ? await db
          .select({
            issueId: issues.id,
            title: issues.title,
            status: issues.status,
            parentId: issues.parentId,
          })
          .from(issues)
          .where(inArray(issues.id, taskIssueIds))
      : [];

    // Fetch all todos (issues that are children of task issues)
    const todoRows = taskIssueIds.length > 0
      ? await db
          .select({
            issueId: issues.id,
            title: issues.title,
            status: issues.status,
            parentId: issues.parentId,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              inArray(issues.parentId, taskIssueIds),
            ),
          )
          .orderBy(desc(issues.createdAt))
      : [];
    const todoIssueIds = todoRows.map((todo) => todo.issueId);
    const graphIssueIds = [...taskIssueIds, ...todoIssueIds];

    // Fetch daily wiki pages for this project
    const dailyWikiPages = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(
        and(
          eq(rt2V33DailyWikiPages.companyId, companyId),
          eq(rt2V33DailyWikiPages.projectId, projectId),
        ),
      )
      .orderBy(desc(rt2V33DailyWikiPages.updatedAt));

    // Fetch work products (deliverables) for task issues
    const workProducts = graphIssueIds.length > 0
      ? await db
          .select()
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, companyId),
              inArray(issueWorkProducts.issueId, graphIssueIds),
            ),
          )
          .orderBy(desc(issueWorkProducts.createdAt))
      : [];

    const participants = taskIssueIds.length > 0
      ? await db
          .select()
          .from(rt2V33TaskParticipants)
          .where(
            and(
              eq(rt2V33TaskParticipants.companyId, companyId),
              inArray(rt2V33TaskParticipants.taskIssueId, taskIssueIds),
            ),
          )
      : [];

    const executionAttempts = taskIssueIds.length > 0
      ? await db
          .select()
          .from(rt2V33ExecutionAttempts)
          .where(
            and(
              eq(rt2V33ExecutionAttempts.companyId, companyId),
              inArray(rt2V33ExecutionAttempts.taskIssueId, taskIssueIds),
            ),
          )
          .orderBy(desc(rt2V33ExecutionAttempts.updatedAt))
      : [];

    const qualityScores = taskIssueIds.length > 0
      ? await db
          .select()
          .from(rt2QualityScores)
          .where(
            and(
              eq(rt2QualityScores.companyId, companyId),
              inArray(rt2QualityScores.taskIssueId, taskIssueIds),
            ),
          )
      : [];

    const todoParentById = new Map(todoRows.map((todo) => [todo.issueId, todo.parentId]));
    const deliverablesByTask = new Map<string, typeof workProducts>();
    for (const workProduct of workProducts) {
      const taskId = taskIssueIds.includes(workProduct.issueId)
        ? workProduct.issueId
        : todoParentById.get(workProduct.issueId);
      if (!taskId) continue;
      const current = deliverablesByTask.get(taskId) ?? [];
      current.push(workProduct);
      deliverablesByTask.set(taskId, current);
    }

    const participantsByTask = new Map<string, typeof participants>();
    for (const participant of participants) {
      const current = participantsByTask.get(participant.taskIssueId) ?? [];
      current.push(participant);
      participantsByTask.set(participant.taskIssueId, current);
    }

    const executionsByTask = new Map<string, typeof executionAttempts>();
    for (const attempt of executionAttempts) {
      const current = executionsByTask.get(attempt.taskIssueId) ?? [];
      current.push(attempt);
      executionsByTask.set(attempt.taskIssueId, current);
    }

    const qualityByTask = new Map<string, typeof qualityScores>();
    for (const score of qualityScores) {
      const current = qualityByTask.get(score.taskIssueId) ?? [];
      current.push(score);
      qualityByTask.set(score.taskIssueId, current);
    }

    const knowledgeRefsByTask = new Map<string, string[]>();
    for (const wikiPage of dailyWikiPages) {
      const history = Array.isArray(wikiPage.history) ? wikiPage.history : [];
      for (const item of history) {
        if (!item || typeof item !== "object") continue;
        const taskIssueId = "taskIssueId" in item && typeof item.taskIssueId === "string" ? item.taskIssueId : null;
        if (!taskIssueId) continue;
        const current = knowledgeRefsByTask.get(taskIssueId) ?? [];
        current.push(`daily_wiki_page:${wikiPage.pageKey}`);
        knowledgeRefsByTask.set(taskIssueId, [...new Set(current)]);
      }
    }

    function taskEvidence(taskId: string): Rt2TaskMeshNodeEvidence {
      const deliverables = deliverablesByTask.get(taskId) ?? [];
      const taskParticipants = participantsByTask.get(taskId) ?? [];
      const attempts = executionsByTask.get(taskId) ?? [];
      const taskQuality = qualityByTask.get(taskId) ?? [];
      const knowledgeRefs = knowledgeRefsByTask.get(taskId) ?? [];
      const qualityStatus = taskQuality.some((score) => score.isFinalized === 1 || score.managerDecision === "approved")
        ? "reviewed"
        : resolveQualityStatus(deliverables);
      const status: Rt2TaskMeshNodeEvidence["status"] =
        deliverables.length === 0 || knowledgeRefs.length === 0
          ? "missing"
          : qualityStatus === "pending_review"
            ? "ambiguous"
            : "present";
      return {
        deliverableCount: deliverables.length,
        ownerCount: taskParticipants.filter((participant) => participant.state === "active").length,
        latestExecutionState: attempts[0]?.state ?? null,
        qualityStatus,
        goldEstimate: Math.round(deliverables.reduce((sum, row) => sum + readBasePrice(row.metadata), 0) / 100),
        knowledgeRefs,
        status,
      };
    }

    // Build nodes
    const nodes: Rt2GraphNode[] = [];

    // Add project node
    nodes.push(buildProjectNode(project));

    // Add task nodes
    for (const task of tasks) {
      nodes.push(buildTaskNode(task, projectId, taskEvidence(task.issueId)));
    }

    // Add todo nodes
    for (const todo of todoRows) {
      nodes.push(buildTodoNode(todo));
    }

    // Add daily wiki page nodes
    for (const wikiPage of dailyWikiPages) {
      nodes.push(buildDailyWikiNode(wikiPage));
    }

    // Add deliverable nodes
    for (const workProduct of workProducts) {
      nodes.push(buildDeliverableNode(workProduct));
    }

    // Build edges
    const edges: Rt2GraphEdge[] = [];

    // Project -> Task edges
    for (const task of tasks) {
      edges.push(
        buildEdge(
          `project:${projectId}`,
          `task:${task.issueId}`,
          "project_task",
          `Task "${task.title}" belongs to project`,
          [
            {
              source: "task_profile",
              message: `Task profile links issue ${task.issueId} to project ${projectId}`,
            },
          ],
        ),
      );
    }

    // Task -> Todo edges
    for (const todo of todoRows) {
      if (todo.parentId && taskIssueIds.includes(todo.parentId)) {
        edges.push(
          buildEdge(
            `task:${todo.parentId}`,
            `todo:${todo.issueId}`,
            "task_todo",
            `Todo "${todo.title}" is a child of task`,
            [
              {
                source: "issue_relation",
                message: `Issue ${todo.issueId} has parent_id ${todo.parentId}`,
              },
            ],
          ),
        );
      }
    }

    // Task -> Deliverable edges
    for (const workProduct of workProducts) {
      const taskIssueId = taskIssueIds.includes(workProduct.issueId)
        ? workProduct.issueId
        : todoParentById.get(workProduct.issueId);
      if (!taskIssueId) continue;
      edges.push(
        buildEdge(
          `task:${taskIssueId}`,
          `deliverable:${workProduct.id}`,
          "task_deliverable",
          `Deliverable "${workProduct.title}" is produced by task`,
          [
            {
              source: "work_product",
              message: `Work product ${workProduct.id} is linked to issue ${workProduct.issueId}`,
            },
          ],
        ),
      );
    }

    for (const wikiPage of dailyWikiPages) {
      edges.push(
        buildEdge(
          `project:${projectId}`,
          `daily_wiki_page:${wikiPage.id}`,
          "project_daily_wiki_page",
          `Daily wiki page ${wikiPage.pageKey} belongs to project`,
          [{ source: "daily_wiki", message: `Daily wiki page ${wikiPage.pageKey} is scoped to project ${projectId}` }],
        ),
      );

      const history = Array.isArray(wikiPage.history) ? wikiPage.history : [];
      for (const item of history) {
        if (!item || typeof item !== "object") continue;
        const taskIssueId = "taskIssueId" in item && typeof item.taskIssueId === "string" ? item.taskIssueId : null;
        if (!taskIssueId || !taskIssueIds.includes(taskIssueId)) continue;
        edges.push(
          buildEdge(
            `daily_wiki_page:${wikiPage.id}`,
            `task:${taskIssueId}`,
            "daily_wiki_task",
            `Daily wiki page ${wikiPage.pageKey} contains evidence for task`,
            [{ source: "daily_wiki", message: `History row links page ${wikiPage.pageKey} to task ${taskIssueId}` }],
          ),
        );
      }
    }

    // M2.5: Calculate communities using Leiden-like algorithm
    const communityAssignment = detectCommunities(nodes, edges);

    // Build community summaries
    const communityKeys = [...new Set(communityAssignment.values())];
    for (const node of nodes) {
      node.metadata = {
        ...node.metadata,
        communityKey: communityAssignment.get(node.id) ?? null,
      };
    }
    const communities = communityKeys.map((key, idx) => {
      const memberNodes = nodes.filter(n => communityAssignment.get(n.id) === key);
      return {
        communityKey: key,
        label: `Community ${idx + 1}`,
        algorithm: "label_propagation",
        memberNodeCount: memberNodes.length,
      };
    });
    const warnings = tasks.flatMap((task) => {
      const evidence = taskEvidence(task.issueId);
      const result: string[] = [];
      if (evidence.deliverableCount === 0) result.push(`Task "${task.title}" has no deliverable evidence.`);
      if (evidence.knowledgeRefs.length === 0) result.push(`Task "${task.title}" has no wiki/knowledge evidence.`);
      return result;
    });

    return {
      companyId,
      projectId,
      updatedAt: new Date().toISOString(),
      nodes,
      edges,
      communities,
      meshViews: ["hierarchy", "dependency", "timeline", "collaborator", "deliverable", "knowledge", "economy"],
      warnings,
    };
  }

  /**
   * M2.5: Get full graph report with God Nodes and Surprising Connections
   */
  async function getProjectGraphReport(
    companyId: string,
    projectId: string,
  ): Promise<Rt2GraphReport> {
    const graph = await getProjectGraph(companyId, projectId);

    // Calculate degree centrality
    const centrality = calculateDegreeCentrality(graph.nodes, graph.edges);

    // Find God Nodes (top 10% most central task nodes)
    const godNodeIds = findGodNodes(graph.nodes, centrality);

    // Detect Surprising Connections
    const surprisingEdges = detectSurprisingConnections(graph.edges);
    const godNodes = graph.nodes.filter((node) => godNodeIds.includes(node.id));

    // Build confidence summary
    const confidenceSummary: Record<Rt2GraphConfidence, number> = {
      EXTRACTED: 0,
      INFERRED: 0,
      AMBIGUOUS: 0,
    };
    for (const edge of graph.edges) {
      confidenceSummary[edge.confidence]++;
    }

    // Generate markdown summary
    const markdown = generateGraphMarkdown(graph, godNodeIds, surprisingEdges);

    return {
      companyId,
      projectId,
      updatedAt: graph.updatedAt,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      confidenceSummary,
      centralTaskNodeIds: godNodeIds,
      ambiguousEdges: surprisingEdges,
      godNodes,
      surprisingConnections: surprisingEdges,
      staleWarnings: graph.warnings,
      markdown,
    };
  }

  return {
    getProjectGraph,
    getProjectGraphReport,
  };
}

/**
 * Generate markdown summary of graph analysis
 */
function generateGraphMarkdown(
  graph: Rt2ProjectGraph,
  godNodeIds: string[],
  surprisingEdges: Rt2GraphEdge[],
): string {
  const lines: string[] = [
    `# Graph Analysis Report`,
    ``,
    `## Summary`,
    `- **Nodes**: ${graph.nodes.length}`,
    `- **Edges**: ${graph.edges.length}`,
    `- **Communities**: ${graph.communities.length}`,
    ``,
  ];

  if (godNodeIds.length > 0) {
    const godNodes = graph.nodes.filter(n => godNodeIds.includes(n.id));
    lines.push(`## God Nodes (Central Tasks)`, ``);
    for (const node of godNodes) {
      lines.push(`- **${node.label}** (${node.nodeType})`);
    }
    lines.push(``);
  }

  if (surprisingEdges.length > 0) {
    lines.push(`## Surprising Connections`, ``);
    lines.push(`*Edges with low confidence or unexpected patterns*`, ``);
    for (const edge of surprisingEdges.slice(0, 10)) {
      const sourceNode = graph.nodes.find(n => n.id === edge.sourceNodeId);
      const targetNode = graph.nodes.find(n => n.id === edge.targetNodeId);
      lines.push(`- ${sourceNode?.label || edge.sourceNodeId} → ${targetNode?.label || edge.targetNodeId} (${edge.confidence}${edge.confidenceScore !== null ? ` ${Math.round(edge.confidenceScore * 100)}%` : ""})`);
    }
    if (surprisingEdges.length > 10) {
      lines.push(`- *...and ${surprisingEdges.length - 10} more*`);
    }
    lines.push(``);
  }

  if (graph.communities.length > 0) {
    lines.push(`## Communities`, ``);
    for (const community of graph.communities) {
      lines.push(`- **${community.label}**: ${community.memberNodeCount} nodes`);
    }
  }

  return lines.join("\n");
}
