import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2V33DomainEvents,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33GraphReports,
  rt2V33GraphCache,
  rt2V33GraphCommunities,
  rt2V33KnowledgeBridgePairings,
  rt2V33KnowledgeBridgeQueue,
  rt2V33KnowledgeSyncDecisions,
  rt2V33KnowledgeVaultSettings,
  rt2V33ProjectorEvents,
  rt2V33WikiPages,
  rt2V33DailyWikiPages,
} from "@paperclipai/db";
import type {
  Rt2DomainEvent,
  Rt2KnowledgeEvidenceStatus,
  Rt2KnowledgeImportCandidate,
  Rt2LocalBridgeHealth,
  Rt2LocalBridgeHeartbeatInput,
  Rt2LocalBridgePairing,
  Rt2LocalBridgePairingRequest,
  Rt2LocalBridgePairingResult,
  Rt2LocalBridgeQueueApplyInput,
  Rt2LocalBridgeQueueInput,
  Rt2LocalBridgeQueueItem,
  Rt2LocalBridgeStatus,
  Rt2ObsidianVaultExport,
  Rt2ObsidianVaultConflictResolutionInput,
  Rt2ObsidianVaultConflictResolutionResult,
  Rt2ObsidianVaultDryRunFile,
  Rt2ObsidianVaultDryRunResult,
  Rt2ObsidianVaultImportApplyInput,
  Rt2ObsidianVaultImportApplyResult,
  Rt2ObsidianVaultImportPreview,
  Rt2ObsidianVaultImportPreviewInput,
  Rt2ObsidianVaultWriterSettings,
  Rt2ObsidianVaultWriterSettingsInput,
  Rt2WikiPage,
  Rt2WikiPageType,
} from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { rt2DomainEventService } from "./rt2-domain-events.js";
import { detectCommunities } from "./rt2-task-mesh.js";

const PROJECTOR_NAME = "rt2.knowledge_core";

type DomainEventRow = typeof rt2V33DomainEvents.$inferSelect;
type WikiPageRow = typeof rt2V33WikiPages.$inferSelect;
type GraphNodeRow = typeof rt2V33GraphNodes.$inferSelect;
type VaultSettingsRow = typeof rt2V33KnowledgeVaultSettings.$inferSelect;
type LocalBridgeRow = typeof rt2V33KnowledgeBridgePairings.$inferSelect;
type LocalBridgeQueueRow = typeof rt2V33KnowledgeBridgeQueue.$inferSelect;
type DailyWikiPageRow = typeof rt2V33DailyWikiPages.$inferSelect;

const LOCAL_BRIDGE_STALE_MS = 5 * 60 * 1000;

function toIso(value: Date): string {
  return value.toISOString();
}

function toWikiPage(row: WikiPageRow): Rt2WikiPage {
  return {
    id: row.id,
    companyId: row.companyId,
    pageKey: row.pageKey,
    pageType: row.pageType as Rt2WikiPageType,
    title: row.title,
    markdown: row.markdown,
    summary: row.summary,
    sourceEventIds: row.sourceEventIds,
    metadata: row.metadata,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toLocalBridge(row: LocalBridgeRow): Rt2LocalBridgePairing {
  return {
    id: row.id,
    companyId: row.companyId,
    bridgeName: row.bridgeName,
    vaultName: row.vaultName,
    status: row.status as Rt2LocalBridgeStatus,
    blockedReason: row.blockedReason ?? null,
    conflictCount: Number(row.conflictCount ?? 0),
    lastSeenAt: row.lastSeenAt ? toIso(row.lastSeenAt) : null,
    lastAppliedAt: row.lastAppliedAt ? toIso(row.lastAppliedAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toLocalBridgeQueueItem(row: LocalBridgeQueueRow): Rt2LocalBridgeQueueItem {
  return {
    id: row.id,
    companyId: row.companyId,
    bridgeId: row.bridgeId ?? null,
    operation: row.operation as Rt2LocalBridgeQueueItem["operation"],
    status: row.status as Rt2LocalBridgeQueueItem["status"],
    pageKey: row.pageKey ?? null,
    vaultPath: row.vaultPath ?? null,
    candidateIds: row.candidateIds ?? [],
    blockedReason: row.blockedReason ?? null,
    result: row.result ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    appliedAt: row.appliedAt ? toIso(row.appliedAt) : null,
  };
}

function toDomainEvent(row: DomainEventRow): Rt2DomainEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    eventType: row.eventType as Rt2DomainEvent["eventType"],
    eventVersion: row.eventVersion,
    actorType: row.actorType as Rt2DomainEvent["actorType"],
    actorId: row.actorId,
    entityType: row.entityType as Rt2DomainEvent["entityType"],
    entityId: row.entityId,
    commandId: row.commandId ?? null,
    correlationId: row.correlationId ?? null,
    causationId: row.causationId ?? null,
    idempotencyKey: row.idempotencyKey ?? null,
    payload: row.payload ?? {},
    metadata: row.metadata ?? {},
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectIdFor(event: Rt2DomainEvent): string | null {
  return asString(event.payload.projectId);
}

function eventLine(event: Rt2DomainEvent): string {
  const projectId = projectIdFor(event);
  const parts = [
    `- ${event.occurredAt.toISOString()} ${event.eventType}`,
    `entity=${event.entityType}:${event.entityId}`,
    `actor=${event.actorType}:${event.actorId}`,
  ];
  if (projectId) parts.push(`project=${projectId}`);
  return parts.join(" ");
}

function topicKeysFor(event: Rt2DomainEvent): Array<{ pageKey: string; title: string; metadata: Record<string, unknown> }> {
  const keys: Array<{ pageKey: string; title: string; metadata: Record<string, unknown> }> = [
    {
      pageKey: `topics/${event.entityType}/${event.entityId}.md`,
      title: `${event.entityType}: ${event.entityId}`,
      metadata: { entityType: event.entityType, entityId: event.entityId },
    },
    {
      pageKey: `topics/actors/${event.actorType}/${event.actorId}.md`,
      title: `${event.actorType}: ${event.actorId}`,
      metadata: { actorType: event.actorType, actorId: event.actorId },
    },
  ];
  const projectId = projectIdFor(event);
  if (projectId) {
    keys.push({
      pageKey: `topics/projects/${projectId}.md`,
      title: `project: ${projectId}`,
      metadata: { projectId },
    });
  }
  return keys;
}

function renderIndex(events: Rt2DomainEvent[]): { markdown: string; summary: string[] } {
  const projectIds = [...new Set(events.map(projectIdFor).filter((value): value is string => Boolean(value)))];
  const entityTypes = [...new Set(events.map((event) => event.entityType))];
  const lines = [
    "# RT2 운영 지식 Index",
    "",
    "## Projects",
    ...(projectIds.length > 0 ? projectIds.map((id) => `- [[topics/projects/${id}.md|${id}]]`) : ["- 아직 project event가 없습니다"]),
    "",
    "## Entity Types",
    ...(entityTypes.length > 0 ? entityTypes.map((type) => `- ${type}`) : ["- 아직 entity가 없습니다"]),
    "",
    "## Recent Events",
    ...events.slice(-10).reverse().map(eventLine),
  ];
  return {
    markdown: lines.join("\n"),
    summary: [`${events.length} RT2 events indexed`, `${projectIds.length} projects linked`],
  };
}

function renderLog(events: Rt2DomainEvent[]): { markdown: string; summary: string[] } {
  return {
    markdown: ["# RT2 운영 지식 Log", "", ...events.map(eventLine)].join("\n"),
    summary: events.slice(-3).map((event) => `${event.eventType} ${event.entityType}:${event.entityId}`),
  };
}

function renderTopic(pageKey: string, title: string, events: Rt2DomainEvent[]): { markdown: string; summary: string[] } {
  return {
    markdown: [`# ${title}`, "", ...events.map(eventLine)].join("\n"),
    summary: events.slice(-3).map((event) => `${event.eventType} at ${event.occurredAt.toISOString()}`),
  };
}

function vaultPathFor(pageKey: string): string {
  const safe = pageKey
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .join("/");
  return safe.endsWith(".md") ? safe : `${safe}.md`;
}

function renderVaultFile(page: Rt2WikiPage): string {
  const eventList = page.sourceEventIds.map((id) => `  - ${id}`).join("\n");
  return [
    "---",
    `rt2_page_key: ${page.pageKey}`,
    `rt2_page_type: ${page.pageType}`,
    `rt2_company_id: ${page.companyId}`,
    `rt2_updated_at: ${page.updatedAt}`,
    "rt2_source_event_ids:",
    eventList || "  - none",
    "---",
    "",
    page.markdown,
  ].join("\n");
}

function frontmatterValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function frontmatterList(content: string, key: string): string[] {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  if (startIndex === -1) return [];
  const values: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (!line.startsWith("  - ")) break;
    const value = line.slice(4).trim();
    if (value && value !== "none") values.push(value);
  }
  return values;
}

function inferPageType(value: string | null): Rt2WikiPageType | null {
  if (value === "index" || value === "log" || value === "topic") return value;
  return null;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content.trim();
  const lines = content.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex === -1 ? content.trim() : lines.slice(endIndex + 1).join("\n").trim();
}

function titleFromMarkdown(markdown: string, fallback: string): string {
  const heading = markdown.split(/\r?\n/).find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() : fallback;
}

function normalizePageKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function joinVaultPath(rootPath: string, subdirectory: string): string {
  const root = rootPath.replace(/[\\/]+$/, "");
  const child = subdirectory.replace(/^[\\/]+|[\\/]+$/g, "");
  return child ? `${root}/${child}` : root;
}

function summarizeMarkdown(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3);
}

function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target) links.add(normalizePageKey(target.endsWith(".md") ? target : `${target}.md`));
  }
  return [...links];
}

function candidateId(parts: string[]): string {
  return parts.join(":").replace(/[^a-zA-Z0-9:_./-]/g, "_");
}

function toVaultSettings(row: VaultSettingsRow): Rt2ObsidianVaultWriterSettings {
  const exportSubdirectory = row.exportSubdirectory || "rt2-export";
  return {
    companyId: row.companyId,
    vaultName: row.vaultName,
    rootPath: row.rootPath,
    exportSubdirectory,
    exportPath: joinVaultPath(row.rootPath, exportSubdirectory),
    writerMode: row.writerMode === "local_path" ? "local_path" : "dry_run",
    lastDryRun: row.lastDryRun as Rt2ObsidianVaultDryRunResult | null,
    updatedAt: toIso(row.updatedAt),
  };
}

function importedEvidenceStatus(input: {
  warnings: string[];
  sourceEventIds: string[];
  matchedEventIds: Set<string>;
}): Rt2KnowledgeEvidenceStatus {
  if (input.warnings.length > 0) return "ambiguous";
  if (input.sourceEventIds.length === 0) return "missing";
  const allMatched = input.sourceEventIds.every((id) => input.matchedEventIds.has(id));
  return allMatched ? "ready" : "stale";
}

function matchesTopic(event: Rt2DomainEvent, pageKey: string): boolean {
  if (pageKey === `topics/${event.entityType}/${event.entityId}.md`) return true;
  if (pageKey === `topics/actors/${event.actorType}/${event.actorId}.md`) return true;
  const projectId = projectIdFor(event);
  return Boolean(projectId && pageKey === `topics/projects/${projectId}.md`);
}

function toDailyWikiPage(row: DailyWikiPageRow) {
  const reportDateVal = row.reportDate as unknown;
  const reportDateStr = typeof reportDateVal === "string"
    ? reportDateVal.slice(0, 10)
    : (reportDateVal instanceof Date ? reportDateVal.toISOString().slice(0, 10) : String(reportDateVal).slice(0, 10));
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    userId: row.userId,
    reportDate: reportDateStr,
    pageKey: row.pageKey,
    shortSummary: row.shortSummary,
    markdown: row.markdown,
    history: row.history,
    sourceEventIds: row.sourceEventIds,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function dateFromEvent(event: Rt2DomainEvent): string {
  return event.occurredAt.toISOString().slice(0, 10);
}

function dailyPageKeyFor(date: string, userId?: string): string {
  if (userId) return `daily/${date}/user/${userId}.md`;
  return `daily/${date}.md`;
}

function renderDailyMarkdown(eventLines: string[]): string {
  const lines = ["# Daily Wiki", ""];
  if (eventLines.length === 0) {
    lines.push("_No events recorded this day._");
  } else {
    lines.push(...eventLines);
  }
  return lines.join("\n");
}

function summarizeMarkdownForDaily(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3);
}

function nodeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function nodeLabel(type: string, id: string): string {
  return `${type}: ${id}`;
}

export function rt2KnowledgeProjectorService(db: Db) {
  const domainEvents = rt2DomainEventService(db);

  async function listEvents(companyId: string): Promise<Rt2DomainEvent[]> {
    const rows = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.companyId, companyId))
      .orderBy(asc(rt2V33DomainEvents.occurredAt), asc(rt2V33DomainEvents.createdAt));
    return rows.map(toDomainEvent);
  }

  async function upsertWikiPage(input: {
    companyId: string;
    pageKey: string;
    pageType: Rt2WikiPageType;
    title: string;
    markdown: string;
    summary: string[];
    sourceEventIds: string[];
    metadata?: Record<string, unknown>;
  }) {
    await db
      .insert(rt2V33WikiPages)
      .values({
        companyId: input.companyId,
        pageKey: input.pageKey,
        pageType: input.pageType,
        title: input.title,
        markdown: input.markdown,
        summary: input.summary,
        sourceEventIds: input.sourceEventIds,
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33WikiPages.companyId, rt2V33WikiPages.pageKey],
        set: {
          pageType: input.pageType,
          title: input.title,
          markdown: input.markdown,
          summary: input.summary,
          sourceEventIds: input.sourceEventIds,
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      });
  }

  async function upsertNode(input: {
    companyId: string;
    projectId: string;
    key: string;
    type: string;
    sourceId: string;
    label: string;
    metadata?: Record<string, unknown>;
  }): Promise<GraphNodeRow> {
    const [row] = await db
      .insert(rt2V33GraphNodes)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        nodeKey: input.key,
        nodeType: input.type,
        sourceId: input.sourceId,
        label: input.label,
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33GraphNodes.companyId, rt2V33GraphNodes.nodeKey],
        set: {
          nodeType: input.type,
          sourceId: input.sourceId,
          label: input.label,
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async function upsertEdge(input: {
    companyId: string;
    projectId: string;
    sourceNodeId: string;
    targetNodeId: string;
    edgeType: string;
    rationale: string;
    evidence: Array<Record<string, unknown>>;
  }) {
    await db
      .insert(rt2V33GraphEdges)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        edgeType: input.edgeType,
        confidence: "EXTRACTED",
        confidenceScore: "1.00",
        rationale: input.rationale,
        evidence: input.evidence,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          rt2V33GraphEdges.companyId,
          rt2V33GraphEdges.projectId,
          rt2V33GraphEdges.sourceNodeId,
          rt2V33GraphEdges.targetNodeId,
          rt2V33GraphEdges.edgeType,
        ],
        set: {
          confidence: "EXTRACTED",
          confidenceScore: "1.00",
          rationale: input.rationale,
          evidence: input.evidence,
          updatedAt: new Date(),
        },
      });
  }

  async function upsertEdgeWithConfidence(input: {
    companyId: string;
    projectId: string;
    sourceNodeId: string;
    targetNodeId: string;
    edgeType: string;
    confidence: string;
    confidenceScore: string;
    rationale: string;
    evidence: Array<Record<string, unknown>>;
  }) {
    await db
      .insert(rt2V33GraphEdges)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        edgeType: input.edgeType,
        confidence: input.confidence,
        confidenceScore: input.confidenceScore,
        rationale: input.rationale,
        evidence: input.evidence,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          rt2V33GraphEdges.companyId,
          rt2V33GraphEdges.projectId,
          rt2V33GraphEdges.sourceNodeId,
          rt2V33GraphEdges.targetNodeId,
          rt2V33GraphEdges.edgeType,
        ],
        set: {
          confidence: input.confidence,
          confidenceScore: input.confidenceScore,
          rationale: input.rationale,
          evidence: input.evidence,
          updatedAt: new Date(),
        },
      });
  }

  async function refreshGraphReport(companyId: string, projectId: string) {
    const nodes = await db
      .select()
      .from(rt2V33GraphNodes)
      .where(and(eq(rt2V33GraphNodes.companyId, companyId), eq(rt2V33GraphNodes.projectId, projectId)));
    const edges = await db
      .select()
      .from(rt2V33GraphEdges)
      .where(and(eq(rt2V33GraphEdges.companyId, companyId), eq(rt2V33GraphEdges.projectId, projectId)));

    // Detect communities using Leiden-like algorithm
    const graphNodes: import("@paperclipai/shared").Rt2GraphNode[] = nodes.map((n) => ({
      id: n.id,
      nodeKey: n.nodeKey,
      nodeType: n.nodeType as import("@paperclipai/shared").Rt2GraphNodeType,
      label: n.label,
      sourceId: n.sourceId,
      reportDate: n.reportDate ? String(n.reportDate).slice(0, 10) : null,
      metadata: n.metadata as Record<string, unknown>,
    }));
    const graphEdges: import("@paperclipai/shared").Rt2GraphEdge[] = edges.map((e) => ({
      id: e.id,
      edgeType: e.edgeType as import("@paperclipai/shared").Rt2GraphEdgeType,
      sourceNodeId: e.sourceNodeId,
      targetNodeId: e.targetNodeId,
      confidence: e.confidence as import("@paperclipai/shared").Rt2GraphConfidence,
      confidenceScore: e.confidenceScore ? Number(e.confidenceScore) : null,
      rationale: e.rationale,
      evidence: (e.evidence as unknown as import("@paperclipai/shared").Rt2GraphEdgeEvidence[]) ?? [],
    }));

    const communityAssignment = detectCommunities(graphNodes, graphEdges);

    // Compute centrality and god nodes per community
    const centrality = new Map<string, number>();
    for (const node of nodes) {
      const connections = edges.filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id).length;
      centrality.set(node.id, connections);
    }

    const communityKeys = [...new Set(communityAssignment.values())];
    const communitiesData = communityKeys.map((key, idx) => {
      const memberNodes = nodes.filter((n) => communityAssignment.get(n.id) === key);
      // God node is the one with highest centrality in the community
      let godNodeId: string | null = null;
      let maxCentrality = -1;
      for (const node of memberNodes) {
        const c = centrality.get(node.id) ?? 0;
        if (c > maxCentrality) {
          maxCentrality = c;
          godNodeId = node.id;
        }
      }
      return {
        communityKey: key,
        label: `Community ${idx + 1}`,
        algorithm: "leiden_label_propagation",
        memberNodeCount: memberNodes.length,
        godNodeId,
      };
    });

    // Upsert communities to rt2_v33_graph_communities
    for (const comm of communitiesData) {
      await db
        .insert(rt2V33GraphCommunities)
        .values({
          companyId,
          projectId,
          communityKey: comm.communityKey,
          algorithm: comm.algorithm,
          label: comm.label,
          memberNodeCount: comm.memberNodeCount,
          godNodeId: comm.godNodeId,
          reportPath: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [rt2V33GraphCommunities.companyId, rt2V33GraphCommunities.projectId, rt2V33GraphCommunities.communityKey],
          set: {
            algorithm: comm.algorithm,
            label: comm.label,
            memberNodeCount: comm.memberNodeCount,
            godNodeId: comm.godNodeId,
            updatedAt: new Date(),
          },
        });
    }

    const confidenceSummary = {
      EXTRACTED: edges.filter((edge) => edge.confidence === "EXTRACTED").length,
      INFERRED: edges.filter((edge) => edge.confidence === "INFERRED").length,
      AMBIGUOUS: edges.filter((edge) => edge.confidence === "AMBIGUOUS").length,
    };

    const godNodeCount = communitiesData.filter((c) => c.godNodeId).length;
    const markdownLines = [
      "# Graph Analysis Report",
      "",
      "## Summary",
      `- **Nodes**: ${nodes.length}`,
      `- **Edges**: ${edges.length}`,
      `- **EXTRACTED**: ${confidenceSummary.EXTRACTED}`,
      `- **INFERRED**: ${confidenceSummary.INFERRED}`,
      `- **AMBIGUOUS**: ${confidenceSummary.AMBIGUOUS}`,
      "",
      "## Communities",
      ...communitiesData.map(
        (c) => `- **${c.label}** (${c.communityKey}): ${c.memberNodeCount} nodes${c.godNodeId ? ` — god node: ${c.godNodeId.slice(0, 8)}...` : ""}`,
      ),
      "",
      `**Total communities:** ${communitiesData.length}`,
      `**God nodes:** ${godNodeCount}`,
    ];
    const markdown = markdownLines.join("\n");

    await db
      .insert(rt2V33GraphReports)
      .values({
        companyId,
        projectId,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        confidenceSummary,
        markdown,
        communityCount: communitiesData.length,
        godNodeCount,
        centralTaskNodeIds: communitiesData.map((c) => c.godNodeId).filter(Boolean) as string[],
        ambiguousEdges: [],
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33GraphReports.companyId, rt2V33GraphReports.projectId],
        set: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          confidenceSummary,
          markdown,
          communityCount: communitiesData.length,
          godNodeCount,
          centralTaskNodeIds: communitiesData.map((c) => c.godNodeId).filter(Boolean) as string[],
          ambiguousEdges: [],
          updatedAt: new Date(),
        },
      });
  }

  async function projectGraphEvent(event: Rt2DomainEvent) {
    const projectId = projectIdFor(event);
    if (!projectId) return;

    const projectNode = await upsertNode({
      companyId: event.companyId,
      projectId,
      key: nodeKey("project", projectId),
      type: "project",
      sourceId: projectId,
      label: nodeLabel("project", projectId),
    });
    const entityNode = await upsertNode({
      companyId: event.companyId,
      projectId,
      key: nodeKey(event.entityType, event.entityId),
      type: event.entityType,
      sourceId: event.entityId,
      label: nodeLabel(event.entityType, event.entityId),
      metadata: { lastEventType: event.eventType },
    });
    const actorNode = await upsertNode({
      companyId: event.companyId,
      projectId,
      key: nodeKey(`actor_${event.actorType}`, event.actorId),
      type: "actor",
      sourceId: event.actorId,
      label: nodeLabel(event.actorType, event.actorId),
      metadata: { actorType: event.actorType },
    });
    const eventNode = await upsertNode({
      companyId: event.companyId,
      projectId,
      key: nodeKey("event", event.id),
      type: "event",
      sourceId: event.id,
      label: event.eventType,
      metadata: { eventType: event.eventType, entityType: event.entityType, entityId: event.entityId },
    });

    const evidence = [{ source: "domain_event", eventId: event.id, eventType: event.eventType }];
    await upsertEdge({
      companyId: event.companyId,
      projectId,
      sourceNodeId: projectNode.id,
      targetNodeId: entityNode.id,
      edgeType: `project_${event.entityType}`,
      rationale: `${event.entityType} belongs to project ${projectId}`,
      evidence,
    });
    await upsertEdge({
      companyId: event.companyId,
      projectId,
      sourceNodeId: actorNode.id,
      targetNodeId: eventNode.id,
      edgeType: "actor_event",
      rationale: `${event.actorType} ${event.actorId} caused ${event.eventType}`,
      evidence,
    });
    await upsertEdge({
      companyId: event.companyId,
      projectId,
      sourceNodeId: eventNode.id,
      targetNodeId: entityNode.id,
      edgeType: "event_entity",
      rationale: `${event.eventType} changed ${event.entityType}:${event.entityId}`,
      evidence,
    });

    const taskIssueId = asString(event.payload.taskIssueId);
    if (event.entityType === "todo" && taskIssueId) {
      const taskNode = await upsertNode({
        companyId: event.companyId,
        projectId,
        key: nodeKey("task", taskIssueId),
        type: "task",
        sourceId: taskIssueId,
        label: nodeLabel("task", taskIssueId),
      });
      await upsertEdge({
        companyId: event.companyId,
        projectId,
        sourceNodeId: taskNode.id,
        targetNodeId: entityNode.id,
        edgeType: "task_todo",
        rationale: `Todo ${event.entityId} is linked to task ${taskIssueId}`,
        evidence,
      });
    }

    if (event.entityType === "deliverable" && taskIssueId) {
      const taskNode = await upsertNode({
        companyId: event.companyId,
        projectId,
        key: nodeKey("task", taskIssueId),
        type: "task",
        sourceId: taskIssueId,
        label: nodeLabel("task", taskIssueId),
      });
      await upsertEdge({
        companyId: event.companyId,
        projectId,
        sourceNodeId: taskNode.id,
        targetNodeId: entityNode.id,
        edgeType: "task_deliverable",
        rationale: `Deliverable ${event.entityId} is linked to task ${taskIssueId}`,
        evidence,
      });
    }

    await refreshGraphReport(event.companyId, projectId);
  }

  async function upsertDailyWikiPage(input: {
    companyId: string;
    projectId: string;
    userId: string;
    reportDate: string;
    pageKey: string;
    markdown: string;
    shortSummary: string[];
    sourceEventIds: string[];
    history?: import("@paperclipai/shared").Rt2DailyActivityEntry[];
  }) {
    await db
      .insert(rt2V33DailyWikiPages)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        userId: input.userId,
        reportDate: input.reportDate,
        pageKey: input.pageKey,
        markdown: input.markdown,
        shortSummary: input.shortSummary,
        history: input.history ?? [],
        sourceEventIds: input.sourceEventIds,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          rt2V33DailyWikiPages.companyId,
          rt2V33DailyWikiPages.projectId,
          rt2V33DailyWikiPages.userId,
          rt2V33DailyWikiPages.reportDate,
        ],
        set: {
          pageKey: input.pageKey,
          markdown: input.markdown,
          shortSummary: input.shortSummary,
          sourceEventIds: input.sourceEventIds,
          history: input.history ?? [],
          updatedAt: new Date(),
        },
      });
  }

  async function getOrCreateDailyPage(
    companyId: string,
    date: string,
    userId: string,
    projectId: string,
  ): Promise<{ pageKey: string; eventLines: string[]; sourceEventIds: string[] }> {
    const existing = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(
        and(
          eq(rt2V33DailyWikiPages.companyId, companyId),
          eq(rt2V33DailyWikiPages.projectId, projectId),
          eq(rt2V33DailyWikiPages.userId, userId),
          eq(rt2V33DailyWikiPages.reportDate, date),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const pageKey = dailyPageKeyFor(date, userId === "all" ? undefined : userId);
    return {
      pageKey,
      eventLines: existing?.markdown ? parseMarkdownEventLines(existing.markdown) : [],
      sourceEventIds: existing?.sourceEventIds ?? [],
    };
  }

  function parseMarkdownEventLines(markdown: string): string[] {
    return markdown
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- 20") || line.startsWith("- [20"));
  }

  async function projectDailyForDate(companyId: string, date: string) {
    const events = await listEvents(companyId);
    const dateEvents = events.filter((e) => dateFromEvent(e) === date);
    if (dateEvents.length === 0) return;

    const projectIds = [...new Set(dateEvents.map((e) => projectIdFor(e)).filter(Boolean))];
    const projectId = projectIds[0] ?? "";

    // Full daily page (all users combined)
    const fullEventLines = dateEvents.map(eventLine);
    const fullMarkdown = renderDailyMarkdown(fullEventLines);
    await upsertDailyWikiPage({
      companyId,
      projectId,
      userId: "all",
      reportDate: date,
      pageKey: dailyPageKeyFor(date),
      markdown: fullMarkdown,
      shortSummary: summarizeMarkdown(fullMarkdown),
      sourceEventIds: dateEvents.map((e) => e.id),
    });

    // Per-user pages
    const userIds = [...new Set(dateEvents.map((e) => e.actorId))];
    for (const userId of userIds) {
      const userPage = await getOrCreateDailyPage(companyId, date, userId, projectId);
      const userEvents = dateEvents.filter((e) => e.actorId === userId);
      const userEventLines = userEvents.map(eventLine);
      const userMarkdown = renderDailyMarkdown(userEventLines);
      await upsertDailyWikiPage({
        companyId,
        projectId,
        userId,
        reportDate: date,
        pageKey: userPage.pageKey,
        markdown: userMarkdown,
        shortSummary: summarizeMarkdown(userMarkdown),
        sourceEventIds: userEvents.map((e) => e.id),
      });
    }
  }

  async function projectDailyEvent(event: Rt2DomainEvent) {
    const date = dateFromEvent(event);
    const projectId = projectIdFor(event) ?? "";
    if (!projectId) return;

    // Update full daily page
    const fullPage = await getOrCreateDailyPage(event.companyId, date, "all", projectId);
    if (!fullPage.sourceEventIds.includes(event.id)) {
      const newLines = [eventLine(event)];
      const allLines = [...fullPage.eventLines, ...newLines];
      await upsertDailyWikiPage({
        companyId: event.companyId,
        projectId,
        userId: "all",
        reportDate: date,
        pageKey: fullPage.pageKey,
        markdown: renderDailyMarkdown(allLines),
        shortSummary: summarizeMarkdown(renderDailyMarkdown(allLines)),
        sourceEventIds: [...fullPage.sourceEventIds, event.id],
      });
    }

    // Update per-user page for the actor
    const userId = event.actorId;
    const userPage = await getOrCreateDailyPage(event.companyId, date, userId, projectId);
    if (!userPage.sourceEventIds.includes(event.id)) {
      const newLines = [eventLine(event)];
      const allLines = [...userPage.eventLines, ...newLines];
      await upsertDailyWikiPage({
        companyId: event.companyId,
        projectId,
        userId,
        reportDate: date,
        pageKey: dailyPageKeyFor(date, userId),
        markdown: renderDailyMarkdown(allLines),
        shortSummary: summarizeMarkdown(renderDailyMarkdown(allLines)),
        sourceEventIds: [...userPage.sourceEventIds, event.id],
      });
    }
  }

  async function projectAllDaily(companyId: string) {
    const events = await listEvents(companyId);
    const dates = [...new Set(events.map(dateFromEvent))];
    for (const date of dates.sort()) {
      await projectDailyForDate(companyId, date);
    }
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2V33DailyWikiPages)
      .where(eq(rt2V33DailyWikiPages.companyId, companyId));
    return {
      companyId,
      projectedDates: dates.length,
      totalPages: count?.count ?? 0,
      lastProjectedAt: new Date().toISOString(),
    };
  }

  async function projectWikiForCompany(companyId: string) {
    const events = await listEvents(companyId);
    const eventIds = events.map((event) => event.id);
    const index = renderIndex(events);
    await upsertWikiPage({
      companyId,
      pageKey: "index.md",
      pageType: "index",
      title: "RT2 Knowledge Index",
      markdown: index.markdown,
      summary: index.summary,
      sourceEventIds: eventIds,
    });
    const log = renderLog(events);
    await upsertWikiPage({
      companyId,
      pageKey: "log.md",
      pageType: "log",
      title: "RT2 Knowledge Log",
      markdown: log.markdown,
      summary: log.summary,
      sourceEventIds: eventIds,
    });

    const topics = new Map<string, { title: string; metadata: Record<string, unknown> }>();
    for (const event of events) {
      for (const topic of topicKeysFor(event)) {
        topics.set(topic.pageKey, { title: topic.title, metadata: topic.metadata });
      }
    }
    for (const [pageKey, topic] of topics) {
      const topicEvents = events.filter((event) => matchesTopic(event, pageKey));
      const rendered = renderTopic(pageKey, topic.title, topicEvents);
      await upsertWikiPage({
        companyId,
        pageKey,
        pageType: "topic",
        title: topic.title,
        markdown: rendered.markdown,
        summary: rendered.summary,
        sourceEventIds: topicEvents.map((event) => event.id),
        metadata: topic.metadata,
      });
    }
  }

  function computeDailyWikiHash(pages: { updatedAt: Date; sourceEventIds: string[] }[]): string {
    const input = {
      pageCount: pages.length,
      latestUpdatedAt: pages.length > 0 ? Math.max(...pages.map((p) => p.updatedAt.getTime())) : 0,
      eventCount: pages.reduce((acc, p) => acc + (p.sourceEventIds?.length ?? 0), 0),
    };
    // Simple hash using JSON stringification (could be replaced with crypto.subtle SHA-256)
    let hash = 0;
    const str = JSON.stringify(input);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }

  async function getGraphCache(scopeKey: string) {
    const [row] = await db
      .select()
      .from(rt2V33GraphCache)
      .where(eq(rt2V33GraphCache.scopeKey, scopeKey))
      .limit(1);
    return row ?? null;
  }

  async function upsertGraphCache(input: {
    scopeKey: string;
    companyId: string;
    projectId: string;
    inputHash: string;
    inputWindow?: Record<string, unknown>;
  }) {
    await db
      .insert(rt2V33GraphCache)
      .values({
        scopeKey: input.scopeKey,
        companyId: input.companyId,
        projectId: input.projectId,
        inputHash: input.inputHash,
        inputWindow: input.inputWindow ?? {},
        lastProjectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33GraphCache.scopeKey],
        set: {
          inputHash: input.inputHash,
          inputWindow: input.inputWindow ?? {},
          lastProjectedAt: new Date(),
        },
      });
  }

  async function projectDailyWikiPageToGraph(event: Rt2DomainEvent) {
    const date = dateFromEvent(event);
    const projectId = projectIdFor(event) ?? "";
    if (!projectId) return;

    // GRAPH-03: Incremental refresh via graph_cache hash comparison
    const scopeKey = `graph_daily_${event.companyId}_${date}`;
    const dailyPages = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(and(eq(rt2V33DailyWikiPages.companyId, event.companyId), eq(rt2V33DailyWikiPages.reportDate, date)));

    const currentHash = computeDailyWikiHash(dailyPages);
    const cached = await getGraphCache(scopeKey);

    if (cached && cached.inputHash === currentHash) {
      // No changes since last projection, skip
      return;
    }

    // Process pages and update cache
    for (const page of dailyPages) {
      // Create daily_wiki_page node
      const pageNode = await upsertNode({
        companyId: event.companyId,
        projectId,
        key: nodeKey("daily_wiki_page", page.pageKey),
        type: "daily_wiki_page",
        sourceId: page.id,
        label: page.pageKey,
        metadata: { reportDate: date, userId: page.userId, shortSummary: page.shortSummary },
      });

      // Create INFERRED edges from daily wiki page to related task nodes (via sourceEventIds)
      // For each event that contributed to this daily page, create edges to the event's entities
      for (const sourceEventId of page.sourceEventIds ?? []) {
        // Find the event in the graph
        const eventNodeKey = nodeKey("event", sourceEventId);
        const existingNodes = await db
          .select()
          .from(rt2V33GraphNodes)
          .where(
            and(
              eq(rt2V33GraphNodes.companyId, event.companyId),
              eq(rt2V33GraphNodes.projectId, projectId),
              eq(rt2V33GraphNodes.nodeKey, eventNodeKey),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingNodes) {
          // Edge from daily wiki page to event (INFERRED - implied by daily activity)
          await upsertEdgeWithConfidence({
            companyId: event.companyId,
            projectId,
            sourceNodeId: pageNode.id,
            targetNodeId: existingNodes.id,
            edgeType: "daily_page_event",
            confidence: "INFERRED",
            confidenceScore: "0.70",
            rationale: "Daily wiki page contains this event, implied by activity pattern",
            evidence: [{ source: "daily_wiki_page", pageKey: page.pageKey, eventId: sourceEventId }],
          });
        }
      }

      // Also create edges from daily wiki page to actor nodes for per-user pages
      if (page.userId && page.userId !== "all") {
        const actorNodeKey = nodeKey(`actor_user`, page.userId);
        const actorNode = await db
          .select()
          .from(rt2V33GraphNodes)
          .where(
            and(
              eq(rt2V33GraphNodes.companyId, event.companyId),
              eq(rt2V33GraphNodes.projectId, projectId),
              eq(rt2V33GraphNodes.nodeKey, actorNodeKey),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (actorNode) {
          await upsertEdgeWithConfidence({
            companyId: event.companyId,
            projectId,
            sourceNodeId: actorNode.id,
            targetNodeId: pageNode.id,
            edgeType: "actor_daily_page",
            confidence: "EXTRACTED",
            confidenceScore: "1.00",
            rationale: `User ${page.userId} authored daily page ${page.pageKey}`,
            evidence: [{ source: "daily_wiki_page", pageKey: page.pageKey, userId: page.userId }],
          });
        }
      }
    }

    // Update cache after successful projection
    await upsertGraphCache({
      scopeKey,
      companyId: event.companyId,
      projectId,
      inputHash: currentHash,
      inputWindow: { date, pageCount: dailyPages.length },
    });
  }

  async function projectEvent(eventId: string) {
    return domainEvents.processEvent(PROJECTOR_NAME, eventId, async (event) => {
      await projectWikiForCompany(event.companyId);
      await projectGraphEvent(event);
      await projectDailyEvent(event);
      await projectDailyWikiPageToGraph(event);
    });
  }

  async function projectAll(companyId: string, limit = 100) {
    const allCompanyEvents = await listEvents(companyId);
    const rows = await db
      .select()
      .from(rt2V33DomainEvents)
      .where(eq(rt2V33DomainEvents.companyId, companyId))
      .orderBy(asc(rt2V33DomainEvents.occurredAt), asc(rt2V33DomainEvents.createdAt))
      .limit(limit);
    let processedEvents = 0;
    for (const row of rows) {
      const result = await projectEvent(row.id);
      if (result.status === "processed") processedEvents += 1;
    }
    const [wikiCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2V33WikiPages)
      .where(eq(rt2V33WikiPages.companyId, companyId));
    const [nodeCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2V33GraphNodes)
      .where(eq(rt2V33GraphNodes.companyId, companyId));
    const [edgeCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2V33GraphEdges)
      .where(eq(rt2V33GraphEdges.companyId, companyId));
    const processedRows = allCompanyEvents.length > 0
      ? await db
          .select({ eventId: rt2V33ProjectorEvents.eventId })
          .from(rt2V33ProjectorEvents)
          .where(
            and(
              eq(rt2V33ProjectorEvents.projectorName, PROJECTOR_NAME),
              eq(rt2V33ProjectorEvents.status, "processed"),
              inArray(rt2V33ProjectorEvents.eventId, allCompanyEvents.map((event) => event.id)),
            ),
          )
      : [];
    return {
      companyId,
      processedEvents,
      pendingEvents: Math.max(0, allCompanyEvents.length - processedRows.length),
      wikiPages: wikiCount?.count ?? 0,
      graphNodes: nodeCount?.count ?? 0,
      graphEdges: edgeCount?.count ?? 0,
      lastProjectedAt: new Date().toISOString(),
    };
  }

  async function listWikiPages(companyId: string, input: { pageType?: Rt2WikiPageType; limit?: number }) {
    const where = input.pageType
      ? and(eq(rt2V33WikiPages.companyId, companyId), eq(rt2V33WikiPages.pageType, input.pageType))
      : eq(rt2V33WikiPages.companyId, companyId);
    const rows = await db
      .select()
      .from(rt2V33WikiPages)
      .where(where)
      .orderBy(desc(rt2V33WikiPages.updatedAt))
      .limit(input.limit ?? 50);
    return {
      companyId,
      pages: rows.map(toWikiPage),
    };
  }

  async function getWikiPage(companyId: string, pageKey: string) {
    const row = await db
      .select()
      .from(rt2V33WikiPages)
      .where(and(eq(rt2V33WikiPages.companyId, companyId), eq(rt2V33WikiPages.pageKey, pageKey)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("RT2 wiki page not found");
    return toWikiPage(row);
  }

  async function exportObsidianVault(companyId: string, input: { pageType?: Rt2WikiPageType; limit?: number }): Promise<Rt2ObsidianVaultExport> {
    const list = await listWikiPages(companyId, input);
    return {
      companyId,
      vaultName: `rt2-company-${companyId}`,
      generatedAt: new Date().toISOString(),
      files: list.pages.map((page) => ({
        path: vaultPathFor(page.pageKey),
        title: page.title,
        pageKey: page.pageKey,
        content: renderVaultFile(page),
        sourceEventIds: page.sourceEventIds,
        updatedAt: page.updatedAt,
      })),
    };
  }

  async function getVaultWriterSettings(companyId: string): Promise<Rt2ObsidianVaultWriterSettings | null> {
    const row = await db
      .select()
      .from(rt2V33KnowledgeVaultSettings)
      .where(eq(rt2V33KnowledgeVaultSettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return row ? toVaultSettings(row) : null;
  }

  async function saveVaultWriterSettings(
    companyId: string,
    input: Rt2ObsidianVaultWriterSettingsInput,
  ): Promise<Rt2ObsidianVaultWriterSettings> {
    const vaultName = input.vaultName ?? `rt2-company-${companyId}`;
    const exportSubdirectory = input.exportSubdirectory ?? "rt2-export";
    const dryRun = await dryRunVaultWriter(companyId, {
      vaultName,
      rootPath: input.rootPath,
      exportSubdirectory,
      writerMode: input.writerMode ?? "dry_run",
    });
    const [row] = await db
      .insert(rt2V33KnowledgeVaultSettings)
      .values({
        companyId,
        vaultName,
        rootPath: input.rootPath,
        exportSubdirectory,
        writerMode: input.writerMode ?? "dry_run",
        lastDryRun: dryRun as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33KnowledgeVaultSettings.companyId],
        set: {
          vaultName,
          rootPath: input.rootPath,
          exportSubdirectory,
          writerMode: input.writerMode ?? "dry_run",
          lastDryRun: dryRun as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toVaultSettings(row);
  }

  async function dryRunVaultWriter(
    companyId: string,
    input?: Partial<Rt2ObsidianVaultWriterSettingsInput>,
  ): Promise<Rt2ObsidianVaultDryRunResult> {
    const settings = input?.rootPath
      ? {
          vaultName: input.vaultName ?? `rt2-company-${companyId}`,
          rootPath: input.rootPath,
          exportSubdirectory: input.exportSubdirectory ?? "rt2-export",
          writerMode: input.writerMode ?? "dry_run",
        }
      : await getVaultWriterSettings(companyId);
    const rootPath = settings?.rootPath ?? "";
    const exportSubdirectory = settings?.exportSubdirectory ?? "rt2-export";
    const exportPath = rootPath ? joinVaultPath(rootPath, exportSubdirectory) : "";
    const vault = await exportObsidianVault(companyId, { limit: 100 });
    const files: Rt2ObsidianVaultDryRunFile[] = vault.files.map((file) => {
      const conflictRisk: Rt2KnowledgeEvidenceStatus = file.sourceEventIds.length > 0 ? "ready" : "missing";
      return {
        path: `${exportSubdirectory}/${file.path}`,
        action: rootPath ? "update" : "conflict",
        pageKey: file.pageKey,
        title: file.title,
        conflictRisk,
        reason: rootPath
          ? "RT2-controlled wiki page can be rendered to the configured vault target."
          : "Vault root path is not configured.",
      };
    });
    const warnings: string[] = [];
    if (!rootPath) warnings.push("Vault root path is not configured.");
    if ((settings?.writerMode ?? "dry_run") === "local_path") {
      warnings.push("Local path write is guarded as a dry-run contract in the web server runtime.");
    }
    return {
      companyId,
      vaultName: settings?.vaultName ?? vault.vaultName,
      rootPath,
      exportPath,
      writerMode: settings?.writerMode ?? "dry_run",
      fileCount: files.length,
      conflictCount: files.filter((file) => file.action === "conflict").length,
      generatedAt: new Date().toISOString(),
      files,
      warnings,
    };
  }

  async function buildImportPreviewCandidates(
    companyId: string,
    input: Rt2ObsidianVaultImportPreviewInput,
  ): Promise<Rt2KnowledgeImportCandidate[]> {
    const pages = await listWikiPages(companyId, { limit: 100 });
    const pagesByKey = new Map(pages.pages.map((page) => [page.pageKey, page]));
    const candidates: Rt2KnowledgeImportCandidate[] = [];

    for (const file of input.files) {
      const pageKey = frontmatterValue(file.content, "rt2_page_key") ?? normalizePageKey(file.path);
      const pageType = inferPageType(frontmatterValue(file.content, "rt2_page_type")) ?? "topic";
      const markdown = stripFrontmatter(file.content);
      const existing = pagesByKey.get(pageKey) ?? null;
      const changed = existing ? existing.markdown.trim() !== markdown.trim() : true;
      const rt2UpdatedAt = existing?.updatedAt ?? null;
      const vaultUpdatedAt = frontmatterValue(file.content, "rt2_updated_at");
      const hasTimestampConflict = Boolean(existing && vaultUpdatedAt && rt2UpdatedAt && vaultUpdatedAt !== rt2UpdatedAt && changed);
      candidates.push({
        id: candidateId(["wiki", pageKey]),
        kind: "wiki_page",
        action: hasTimestampConflict ? "conflict" : changed ? (existing ? "update" : "create") : "skip",
        path: file.path,
        targetKey: pageKey,
        label: titleFromMarkdown(markdown, pageKey),
        status: hasTimestampConflict ? "ambiguous" : changed ? "ready" : "stale",
        beforeSummary: existing?.summary.join(" / ") ?? null,
        afterSummary: summarizeMarkdown(markdown).join(" / ") || `${pageType} page from vault`,
        warnings: hasTimestampConflict ? ["RT2 page changed after the exported vault timestamp."] : [],
      });

      if (input.projectId) {
        candidates.push({
          id: candidateId(["node", pageKey]),
          kind: "graph_node",
          action: "update",
          path: file.path,
          targetKey: `vault_page:${pageKey}`,
          label: `Vault page: ${titleFromMarkdown(markdown, pageKey)}`,
          status: "ready",
          beforeSummary: existing ? "Existing wiki page node may be refreshed." : null,
          afterSummary: "Graph node represents the Obsidian page in RT2 Task Mesh.",
          warnings: [],
        });
        for (const link of extractWikiLinks(markdown)) {
          candidates.push({
            id: candidateId(["edge", pageKey, link]),
            kind: "graph_edge",
            action: "update",
            path: file.path,
            targetKey: `${pageKey}->${link}`,
            label: `${pageKey} links to ${link}`,
            status: "ambiguous",
            beforeSummary: null,
            afterSummary: "Vault wikilink candidate is imported as AMBIGUOUS until an operator validates the relationship.",
            warnings: ["Vault wikilink is operator-supplied evidence and remains AMBIGUOUS."],
          });
        }
      }
    }
    return candidates;
  }

  async function previewObsidianVaultImport(
    companyId: string,
    input: Rt2ObsidianVaultImportPreviewInput,
  ): Promise<Rt2ObsidianVaultImportPreview> {
    const companyEvents = await listEvents(companyId);
    const companyEventIds = new Set(companyEvents.map((event) => event.id));
    const importedEventIds = new Set<string>();
    const matchedEventIds = new Set<string>();

    const files = input.files.map((file) => {
      const pageKey = frontmatterValue(file.content, "rt2_page_key");
      const pageType = inferPageType(frontmatterValue(file.content, "rt2_page_type"));
      const companyIdInFile = frontmatterValue(file.content, "rt2_company_id");
      const sourceEventIds = frontmatterList(file.content, "rt2_source_event_ids");
      const warnings: string[] = [];

      if (!pageKey) warnings.push("missing rt2_page_key");
      if (!pageType) warnings.push("missing or invalid rt2_page_type");
      if (companyIdInFile && companyIdInFile !== companyId) warnings.push("company id mismatch");
      if (sourceEventIds.length === 0) warnings.push("missing source event ids");

      for (const eventId of sourceEventIds) {
        importedEventIds.add(eventId);
        if (companyEventIds.has(eventId)) matchedEventIds.add(eventId);
      }

      return {
        path: file.path,
        pageKey,
        pageType,
        title: pageKey ?? file.path,
        sourceEventIds,
        status: importedEvidenceStatus({ warnings, sourceEventIds, matchedEventIds }),
        warnings,
      };
    });

    const missingEventIds = [...importedEventIds].filter((eventId) => !matchedEventIds.has(eventId));
    const hasAmbiguous = files.some((file) => file.status === "ambiguous");
    const evidenceStatus: Rt2KnowledgeEvidenceStatus = hasAmbiguous
      ? "ambiguous"
      : missingEventIds.length > 0
        ? "stale"
        : importedEventIds.size > 0
          ? "ready"
          : "missing";

    const candidates = await buildImportPreviewCandidates(companyId, input);
    const conflicts = candidates.filter((candidate) => candidate.action === "conflict");

    return {
      companyId,
      vaultName: input.vaultName ?? `rt2-company-${companyId}`,
      fileCount: files.length,
      importedEventIds: [...importedEventIds],
      matchedEventIds: [...matchedEventIds],
      missingEventIds,
      evidenceStatus,
      files,
      candidates,
      conflicts,
      generatedAt: new Date().toISOString(),
    };
  }

  async function applyObsidianVaultImport(
    companyId: string,
    input: Rt2ObsidianVaultImportApplyInput,
  ): Promise<Rt2ObsidianVaultImportApplyResult> {
    const preview = await previewObsidianVaultImport(companyId, input);
    const approved = new Set(input.approvedCandidateIds);
    let updatedWikiPages = 0;
    let updatedGraphNodes = 0;
    let updatedGraphEdges = 0;

    for (const candidate of preview.candidates) {
      if (!approved.has(candidate.id) || candidate.action === "skip" || candidate.action === "conflict") continue;
      const sourceFile = input.files.find((file) => candidate.path === file.path);
      if (!sourceFile) continue;
      if (candidate.kind === "wiki_page") {
        const markdown = stripFrontmatter(sourceFile.content);
        await upsertWikiPage({
          companyId,
          pageKey: candidate.targetKey,
          pageType: inferPageType(frontmatterValue(sourceFile.content, "rt2_page_type")) ?? "topic",
          title: titleFromMarkdown(markdown, candidate.targetKey),
          markdown,
          summary: summarizeMarkdown(markdown),
          sourceEventIds: frontmatterList(sourceFile.content, "rt2_source_event_ids"),
          metadata: { source: "obsidian_vault_import", path: sourceFile.path },
        });
        updatedWikiPages += 1;
      }
      if (candidate.kind === "graph_node" && input.projectId) {
        await upsertNode({
          companyId,
          projectId: input.projectId,
          key: candidate.targetKey,
          type: "vault_page",
          sourceId: candidate.targetKey,
          label: candidate.label,
          metadata: { source: "obsidian_vault_import", path: sourceFile.path },
        });
        updatedGraphNodes += 1;
      }
      if (candidate.kind === "graph_edge" && input.projectId) {
        const [sourceKey, targetKey] = candidate.targetKey.split("->");
        if (!sourceKey || !targetKey) continue;
        const sourceNode = await upsertNode({
          companyId,
          projectId: input.projectId,
          key: `vault_page:${sourceKey}`,
          type: "vault_page",
          sourceId: sourceKey,
          label: `Vault page: ${sourceKey}`,
        });
        const targetNode = await upsertNode({
          companyId,
          projectId: input.projectId,
          key: `vault_page:${targetKey}`,
          type: "vault_page",
          sourceId: targetKey,
          label: `Vault page: ${targetKey}`,
        });
        await db
          .insert(rt2V33GraphEdges)
          .values({
            companyId,
            projectId: input.projectId,
            sourceNodeId: sourceNode.id,
            targetNodeId: targetNode.id,
            edgeType: "vault_wikilink",
            confidence: "AMBIGUOUS",
            confidenceScore: "0.50",
            rationale: `Imported Obsidian wikilink ${sourceKey} -> ${targetKey}`,
            evidence: [{ source: "obsidian_vault_import", path: sourceFile.path }],
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              rt2V33GraphEdges.companyId,
              rt2V33GraphEdges.projectId,
              rt2V33GraphEdges.sourceNodeId,
              rt2V33GraphEdges.targetNodeId,
              rt2V33GraphEdges.edgeType,
            ],
            set: {
              confidence: "AMBIGUOUS",
              confidenceScore: "0.50",
              rationale: `Imported Obsidian wikilink ${sourceKey} -> ${targetKey}`,
              evidence: [{ source: "obsidian_vault_import", path: sourceFile.path }],
              updatedAt: new Date(),
            },
          });
        updatedGraphEdges += 1;
      }
    }

    const [audit] = await db
      .insert(rt2V33KnowledgeSyncDecisions)
      .values({
        companyId,
        pageKey: "bulk-import",
        filePath: input.vaultName ?? "vault-import",
        decision: "approved_import",
        reason: input.reason ?? "Approved vault import candidates.",
        afterState: {
          approvedCandidateIds: input.approvedCandidateIds,
          updatedWikiPages,
          updatedGraphNodes,
          updatedGraphEdges,
        },
      })
      .returning();

    return {
      companyId,
      appliedCandidateIds: preview.candidates.filter((candidate) => approved.has(candidate.id)).map((candidate) => candidate.id),
      skippedCandidateIds: preview.candidates.filter((candidate) => !approved.has(candidate.id)).map((candidate) => candidate.id),
      updatedWikiPages,
      updatedGraphNodes,
      updatedGraphEdges,
      auditId: audit.id,
      appliedAt: new Date().toISOString(),
    };
  }

  async function resolveObsidianVaultConflict(
    companyId: string,
    input: Rt2ObsidianVaultConflictResolutionInput,
    actorId = "system",
  ): Promise<Rt2ObsidianVaultConflictResolutionResult> {
    const pageKey = frontmatterValue(input.file.content, "rt2_page_key") ?? normalizePageKey(input.file.path);
    const existing = await db
      .select()
      .from(rt2V33WikiPages)
      .where(and(eq(rt2V33WikiPages.companyId, companyId), eq(rt2V33WikiPages.pageKey, pageKey)))
      .then((rows) => rows[0] ?? null);
    const beforeState = existing ? { markdown: existing.markdown, updatedAt: toIso(existing.updatedAt) } : null;
    let applied = false;

    if (input.decision === "vault_wins" || input.decision === "manual_merge") {
      const markdown = input.decision === "manual_merge"
        ? input.manualMarkdown?.trim() || stripFrontmatter(input.file.content)
        : stripFrontmatter(input.file.content);
      await upsertWikiPage({
        companyId,
        pageKey,
        pageType: inferPageType(frontmatterValue(input.file.content, "rt2_page_type")) ?? "topic",
        title: titleFromMarkdown(markdown, pageKey),
        markdown,
        summary: summarizeMarkdown(markdown),
        sourceEventIds: frontmatterList(input.file.content, "rt2_source_event_ids"),
        metadata: { source: "obsidian_conflict_resolution", path: input.file.path, decision: input.decision },
      });
      applied = true;
    }

    const [audit] = await db
      .insert(rt2V33KnowledgeSyncDecisions)
      .values({
        companyId,
        pageKey,
        filePath: input.file.path,
        decision: input.decision,
        reason: input.reason,
        actorId,
        beforeState,
        afterState: {
          applied,
          manualMerge: input.decision === "manual_merge",
          projectId: input.projectId ?? null,
        },
      })
      .returning();

    return {
      companyId,
      pageKey,
      decision: input.decision,
      applied,
      auditId: audit.id,
      resolvedAt: new Date().toISOString(),
    };
  }

  async function getLocalBridgeRow(companyId: string) {
    return db
      .select()
      .from(rt2V33KnowledgeBridgePairings)
      .where(eq(rt2V33KnowledgeBridgePairings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function createLocalBridgePairing(
    companyId: string,
    input: Rt2LocalBridgePairingRequest = {},
  ): Promise<Rt2LocalBridgePairingResult> {
    const token = `rt2lb_${randomUUID()}_${randomUUID()}`;
    const bridgeName = input.bridgeName ?? "RT2 Local Knowledge Bridge";
    const vaultName = input.vaultName ?? `rt2-company-${companyId}`;
    const [row] = await db
      .insert(rt2V33KnowledgeBridgePairings)
      .values({
        companyId,
        bridgeName,
        vaultName,
        tokenHash: hashPairingToken(token),
        status: "paired",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2V33KnowledgeBridgePairings.companyId],
        set: {
          bridgeName,
          vaultName,
          tokenHash: hashPairingToken(token),
          status: "paired",
          blockedReason: null,
          conflictCount: "0",
          lastSeenAt: null,
          metadata: {},
          updatedAt: new Date(),
        },
      })
      .returning();
    return { bridge: toLocalBridge(row), pairingToken: token };
  }

  async function recordLocalBridgeHeartbeat(
    companyId: string,
    input: Rt2LocalBridgeHeartbeatInput,
  ): Promise<Rt2LocalBridgePairing> {
    const existing = await db
      .select()
      .from(rt2V33KnowledgeBridgePairings)
      .where(and(eq(rt2V33KnowledgeBridgePairings.companyId, companyId), eq(rt2V33KnowledgeBridgePairings.id, input.bridgeId)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("RT2 local knowledge bridge pairing not found");
    if (existing.tokenHash !== hashPairingToken(input.pairingToken)) {
      throw forbidden("Invalid local knowledge bridge pairing token");
    }
    const [row] = await db
      .update(rt2V33KnowledgeBridgePairings)
      .set({
        status: input.status ?? "available",
        blockedReason: input.blockedReason ?? null,
        conflictCount: String(input.conflictCount ?? 0),
        lastSeenAt: new Date(),
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(and(eq(rt2V33KnowledgeBridgePairings.companyId, companyId), eq(rt2V33KnowledgeBridgePairings.id, input.bridgeId)))
      .returning();
    return toLocalBridge(row);
  }

  async function enqueueLocalBridgeSync(
    companyId: string,
    input: Rt2LocalBridgeQueueInput,
  ): Promise<Rt2LocalBridgeQueueItem> {
    const bridge = await getLocalBridgeRow(companyId);
    const [row] = await db
      .insert(rt2V33KnowledgeBridgeQueue)
      .values({
        companyId,
        bridgeId: bridge?.id ?? null,
        operation: input.operation,
        status: input.blockedReason ? "blocked" : "queued",
        pageKey: input.pageKey ?? null,
        vaultPath: input.vaultPath ?? null,
        candidateIds: input.candidateIds ?? [],
        blockedReason: input.blockedReason ?? null,
        updatedAt: new Date(),
      })
      .returning();
    return toLocalBridgeQueueItem(row);
  }

  async function listLocalBridgeQueue(companyId: string, limit = 20): Promise<Rt2LocalBridgeQueueItem[]> {
    const rows = await db
      .select()
      .from(rt2V33KnowledgeBridgeQueue)
      .where(eq(rt2V33KnowledgeBridgeQueue.companyId, companyId))
      .orderBy(desc(rt2V33KnowledgeBridgeQueue.createdAt))
      .limit(limit);
    return rows.map(toLocalBridgeQueueItem);
  }

  async function applyLocalBridgeQueue(
    companyId: string,
    input: Rt2LocalBridgeQueueApplyInput,
  ): Promise<Rt2LocalBridgeQueueItem> {
    const status = input.status ?? "applied";
    const [row] = await db
      .update(rt2V33KnowledgeBridgeQueue)
      .set({
        status,
        blockedReason: input.blockedReason ?? null,
        result: input.result ?? null,
        appliedAt: status === "applied" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(rt2V33KnowledgeBridgeQueue.companyId, companyId), eq(rt2V33KnowledgeBridgeQueue.id, input.queueId)))
      .returning();
    if (!row) throw notFound("RT2 local knowledge bridge queue item not found");
    if (status === "applied") {
      await db
        .update(rt2V33KnowledgeBridgePairings)
        .set({ lastAppliedAt: new Date(), status: "available", blockedReason: null, updatedAt: new Date() })
        .where(eq(rt2V33KnowledgeBridgePairings.companyId, companyId));
    }
    return toLocalBridgeQueueItem(row);
  }

  async function getLocalBridgeHealth(companyId: string): Promise<Rt2LocalBridgeHealth> {
    const bridgeRow = await getLocalBridgeRow(companyId);
    const queue = await listLocalBridgeQueue(companyId, 20);
    const bridge = bridgeRow ? toLocalBridge(bridgeRow) : null;
    const now = Date.now();
    const stale = Boolean(bridgeRow?.lastSeenAt && now - bridgeRow.lastSeenAt.getTime() > LOCAL_BRIDGE_STALE_MS);
    const blockedReason = bridge?.blockedReason ?? queue.find((item) => item.blockedReason)?.blockedReason ?? null;
    const queueCounts = {
      queued: queue.filter((item) => item.status === "queued").length,
      running: queue.filter((item) => item.status === "running").length,
      applied: queue.filter((item) => item.status === "applied").length,
      blocked: queue.filter((item) => item.status === "blocked").length,
      conflict: queue.filter((item) => item.status === "conflict").length,
      failed: queue.filter((item) => item.status === "failed").length,
    };
    const reasons: Rt2LocalBridgeHealth["reasons"] = [];
    let status: Rt2LocalBridgeStatus = bridge?.status ?? "unavailable";
    if (!bridge) {
      reasons.push({ code: "bridge_unpaired", message: "No trusted local knowledge bridge has been paired." });
      status = "unavailable";
    } else if (stale) {
      reasons.push({ code: "bridge_stale", message: "Local bridge heartbeat is stale." });
      status = "stale";
    } else if (bridge.status === "blocked" || queueCounts.blocked > 0) {
      reasons.push({ code: "bridge_blocked", message: blockedReason ?? "Local bridge reported a blocked sync operation." });
      status = "blocked";
    } else if (bridge.status === "conflict" || bridge.conflictCount > 0 || queueCounts.conflict > 0) {
      reasons.push({ code: "bridge_conflicts", message: "Local bridge has unresolved vault conflicts." });
      status = "conflict";
    } else if (bridge.status === "unavailable") {
      reasons.push({ code: "bridge_unavailable", message: "Local bridge is unavailable." });
      status = "unavailable";
    }
    return {
      companyId,
      status,
      generatedAt: new Date().toISOString(),
      bridge,
      queue: queueCounts,
      lastAppliedAt: bridge?.lastAppliedAt ?? queue.find((item) => item.appliedAt)?.appliedAt ?? null,
      conflictCount: bridge?.conflictCount ?? queueCounts.conflict,
      blockedReason,
      stale,
      reasons,
      recentQueue: queue,
    };
  }

  async function getDailyWikiPage(companyId: string, date: string, userId?: string) {
    const userKey = userId ?? "all";
    const row = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(
        and(
          eq(rt2V33DailyWikiPages.companyId, companyId),
          eq(rt2V33DailyWikiPages.reportDate, date),
          eq(rt2V33DailyWikiPages.userId, userKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return toDailyWikiPage(row);
  }

  async function listDailyWikiPages(
    companyId: string,
    options?: { date?: string; limit?: number; projectId?: string; userId?: string },
  ) {
    const conditions = [eq(rt2V33DailyWikiPages.companyId, companyId)];
    if (options?.date) {
      conditions.push(eq(rt2V33DailyWikiPages.reportDate, options.date));
    }
    if (options?.projectId) {
      conditions.push(eq(rt2V33DailyWikiPages.projectId, options.projectId));
    }
    if (options?.userId) {
      conditions.push(eq(rt2V33DailyWikiPages.userId, options.userId));
    }
    const rows = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(and(...conditions))
      .orderBy(desc(rt2V33DailyWikiPages.reportDate))
      .limit(options?.limit ?? 100);
    return {
      companyId,
      pages: rows.map(toDailyWikiPage),
    };
  }

  return {
    applyObsidianVaultImport,
    applyLocalBridgeQueue,
    createLocalBridgePairing,
    dryRunVaultWriter,
    enqueueLocalBridgeSync,
    exportObsidianVault,
    getDailyWikiPage,
    getLocalBridgeHealth,
    getWikiPage,
    getVaultWriterSettings,
    listLocalBridgeQueue,
    listDailyWikiPages,
    listWikiPages,
    previewObsidianVaultImport,
    projectAll,
    projectAllDaily,
    projectEvent,
    projectGraphEvent,
    projectWikiForCompany,
    recordLocalBridgeHeartbeat,
    resolveObsidianVaultConflict,
    saveVaultWriterSettings,
  };
}
