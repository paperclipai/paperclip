import { useCallback, useId, useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { rt2GraphApi } from "../api/rt2-graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";
import type { Rt2GraphNode, Rt2GraphEdge, Rt2ProjectGraph, Rt2TaskMeshView } from "@paperclipai/shared";

/* ── Mermaid loading ── */

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidLoaderPromise) {
    mermaidLoaderPromise = import("mermaid").then((module) => module.default);
  }
  return mermaidLoaderPromise;
}

/* ── Mermaid rendering ── */

function MermaidDiagramBlock({ source, darkMode }: { source: string; darkMode: boolean }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: darkMode ? "dark" : "default",
          fontFamily: "inherit",
          flowchart: {
            curve: "basis",
            padding: 20,
          },
        });
        const rendered = await mermaid.render(`rt2-graph-${renderId}`, source);
        if (!active) return;
        setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!active) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to render diagram.";
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [darkMode, renderId, source]);

  return (
    <div className="paperclip-mermaid overflow-x-auto">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} className="flex justify-center" />
      ) : (
        <div className="space-y-2">
          <p className={cn("text-sm", error && "text-destructive")}>
            {error ? `Diagram error: ${error}` : "Rendering diagram..."}
          </p>
          {error && (
            <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
              <code>{source}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Graph to Mermaid conversion ── */

function sanitizeId(id: string): string {
  // Mermaid IDs must be alphanumeric + underscore, no special chars
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function sanitizeLabel(label: string): string {
  // Escape pipes and brackets for Mermaid
  return label.replace(/[\[\]{}|]/g, " ").trim().slice(0, 60);
}

function nodeShape(nodeType: Rt2GraphNode["nodeType"]): string {
  switch (nodeType) {
    case "project": return " stadium ";
    case "task": return " [" ;
    case "todo": return " (" ;
    case "daily_wiki_page": return " {" ;
    case "deliverable": return " [<" ;
    default: return " [" ;
  }
}

function nodeShapeClose(nodeType: Rt2GraphNode["nodeType"]): string {
  switch (nodeType) {
    case "project": return "] ";
    case "task": return "] ";
    case "todo": return ") ";
    case "daily_wiki_page": return "} ";
    case "deliverable": return ">] ";
    default: return "] ";
  }
}

function nodeStyle(nodeType: Rt2GraphNode["nodeType"]): string {
  switch (nodeType) {
    case "project": return "fill:#6366f1,color:#fff,stroke:#4f46e5,stroke-width:2px";
    case "task": return "fill:#3b82f6,color:#fff,stroke:#2563eb,stroke-width:1px";
    case "todo": return "fill:#22c55e,color:#fff,stroke:#16a34a,stroke-width:1px";
    case "daily_wiki_page": return "fill:#f59e0b,color:#fff,stroke:#d97706,stroke-width:1px";
    case "deliverable": return "fill:#ec4899,color:#fff,stroke:#db2777,stroke-width:1px";
    default: return "";
  }
}

function buildMermaidFlowchart(graph: Rt2ProjectGraph): string {
  const lines: string[] = ["flowchart TB"];
  lines.push("%% nodes");

  // Track used IDs to avoid duplicates
  const usedIds = new Set<string>();

  // Add nodes
  for (const node of graph.nodes) {
    const safeId = sanitizeId(node.id);
    const safeLabel = sanitizeLabel(node.label);
    const openShape = nodeShape(node.nodeType);
    const closeShape = nodeShapeClose(node.nodeType);
    const style = nodeStyle(node.nodeType);

    if (usedIds.has(safeId)) continue;
    usedIds.add(safeId);

    if (style) {
      lines.push(`    ${safeId}${openShape}${safeLabel}${closeShape}`);
      lines.push(`    style ${safeId} ${style}`);
    } else {
      lines.push(`    ${safeId}${openShape}${safeLabel}${closeShape}`);
    }
  }

  lines.push("%% edges");

  // Add edges
  const addedEdges = new Set<string>();
  for (const edge of graph.edges) {
    const sourceId = sanitizeId(edge.sourceNodeId);
    const targetId = sanitizeId(edge.targetNodeId);
    const edgeKey = `${sourceId}-->${targetId}`;

    if (addedEdges.has(edgeKey)) continue;
    addedEdges.add(edgeKey);

    // Determine arrow style based on edge type
    let arrow = "-->";
    if (edge.edgeType === "task_dependency") {
      arrow = "-.->"; // dashed for dependencies
    }

    lines.push(`    ${sourceId} ${arrow} ${targetId}`);
  }

  return lines.join("\n");
}

/* ── Badge helpers ── */

function NodeTypeBadge({ nodeType }: { nodeType: Rt2GraphNode["nodeType"] }) {
  const variants: Record<Rt2GraphNode["nodeType"], "default" | "secondary" | "outline"> = {
    project: "default",
    task: "secondary",
    todo: "outline",
    daily_wiki_page: "outline",
    deliverable: "default",
    actor: "secondary",
    event: "outline",
  };
  return (
    <Badge variant={variants[nodeType] ?? "secondary"} className="text-xs">
      {nodeType.replace(/_/g, " ")}
    </Badge>
  );
}

/* ── Node card ── */

function NodeCard({ node }: { node: Rt2GraphNode }) {
  const status = node.metadata?.status as string | undefined;
  return (
    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{node.label}</div>
        <div className="flex items-center gap-2 mt-1">
          <NodeTypeBadge nodeType={node.nodeType} />
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
        </div>
      </div>
    </div>
  );
}

/* ── Main panel ── */

const VIEW_LABELS: Record<Rt2TaskMeshView, string> = {
  hierarchy: "Hierarchy",
  dependency: "Dependency",
  timeline: "Timeline",
  collaborator: "Collaborator",
  deliverable: "Deliverable",
  knowledge: "Knowledge",
  economy: "Economy",
};

export function Rt2GraphPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { theme } = useTheme();
  const [viewMode, setViewMode] = useState<Rt2TaskMeshView>("hierarchy");

  const { data: graph, isLoading, error } = useQuery({
    queryKey: ["rt2-graph", companyId, projectId],
    queryFn: () => rt2GraphApi.getProjectGraph(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });
  const { data: report } = useQuery({
    queryKey: ["rt2-graph-report", companyId, projectId],
    queryFn: () => rt2GraphApi.getProjectGraphReport(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const mermaidSource = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    return buildMermaidFlowchart(graph);
  }, [graph]);

  const taskNodes = graph?.nodes.filter((n) => n.nodeType === "task") ?? [];
  const todoNodes = graph?.nodes.filter((n) => n.nodeType === "todo") ?? [];
  const wikiNodes = graph?.nodes.filter((n) => n.nodeType === "daily_wiki_page") ?? [];
  const projectNodes = graph?.nodes.filter((n) => n.nodeType === "project") ?? [];
  const deliverableNodes = graph?.nodes.filter((n) => n.nodeType === "deliverable") ?? [];
  const taskWithEvidence = taskNodes.map((node) => ({ node, evidence: node.evidence }));

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">Loading graph...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      </div>
    );
  }

  if (!graph) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">No graph data available.</p>
      </div>
    );
  }

  const isEmpty = graph.nodes.length === 0;

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Task Mesh</h3>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{graph.nodes.length} nodes</span>
            <span>·</span>
            <span>{graph.edges.length} edges</span>
            {report ? (
              <>
                <span>·</span>
                <span>{report.godNodes.length} god nodes</span>
              </>
            ) : null}
          </div>
        </div>
        {!isEmpty && (
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-0.5">
            {(graph.meshViews ?? Object.keys(VIEW_LABELS) as Rt2TaskMeshView[]).map((view) => (
              <Button
                key={view}
                size="xs"
                variant={viewMode === view ? "default" : "ghost"}
                onClick={() => setViewMode(view)}
              >
                {VIEW_LABELS[view]}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Graph visualization */}
      {(viewMode === "hierarchy" || viewMode === "dependency") && !isEmpty && mermaidSource && (
        <div className="rounded-lg border border-border bg-background/50 p-4">
          <MermaidDiagramBlock source={mermaidSource} darkMode={theme === "dark"} />
        </div>
      )}

      {/* List view */}
      {viewMode === "hierarchy" && (
        <div className="space-y-4">
          {projectNodes.map((node) => (
            <div key={node.id} className="rounded-lg border-2 border-primary/20 bg-primary/5 px-3 py-2">
              <div className="text-sm font-semibold">{node.label}</div>
              <div className="text-xs text-muted-foreground">Project</div>
            </div>
          ))}

          {taskNodes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Tasks ({taskNodes.length})
              </div>
              <div className="space-y-1">
                {taskNodes.map((node) => (
                  <NodeCard key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {todoNodes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Todos ({todoNodes.length})
              </div>
              <div className="space-y-1">
                {todoNodes.map((node) => (
                  <NodeCard key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {wikiNodes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Wiki Pages ({wikiNodes.length})
              </div>
              <div className="space-y-1">
                {wikiNodes.map((node) => (
                  <NodeCard key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {deliverableNodes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Deliverables ({deliverableNodes.length})
              </div>
              <div className="space-y-1">
                {deliverableNodes.map((node) => (
                  <NodeCard key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {graph.communities && graph.communities.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Communities ({graph.communities.length})
              </div>
              {graph.communities.map((community, i) => (
                <div key={i} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-sm font-medium">{community.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {community.memberNodeCount} nodes
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {viewMode === "collaborator" && (
        <div className="space-y-2">
          {taskWithEvidence.map(({ node, evidence }) => (
            <div key={node.id} className="rounded-lg border border-border px-3 py-2">
              <div className="text-sm font-medium">{node.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                owners: {evidence?.ownerCount ?? 0} · execution: {evidence?.latestExecutionState ?? "none"}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Timeline view - nodes grouped by date */}
      {viewMode === "timeline" && (
        <div className="space-y-4">
          {(() => {
            // Group nodes by reportDate
            const byDate = new Map<string, Rt2GraphNode[]>();
            for (const node of graph.nodes) {
              const date = node.reportDate ?? "undated";
              if (!byDate.has(date)) byDate.set(date, []);
              byDate.get(date)!.push(node);
            }
            const sortedDates = Array.from(byDate.keys()).sort((a, b) => {
              if (a === "undated") return 1;
              if (b === "undated") return -1;
              return b.localeCompare(a); // newest first
            });

            return sortedDates.map((date) => {
              const nodes = byDate.get(date)!;
              const typeGroups = new Map<Rt2GraphNode["nodeType"], Rt2GraphNode[]>();
              for (const node of nodes) {
                if (!typeGroups.has(node.nodeType)) typeGroups.set(node.nodeType, []);
                typeGroups.get(node.nodeType)!.push(node);
              }

              return (
                <div key={date} className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide sticky top-0 bg-card py-1">
                    {date === "undated" ? "Undated" : new Date(date + "T00:00:00").toLocaleDateString()}
                  </div>
                  {Array.from(typeGroups.entries()).map(([nodeType, typeNodes]) => (
                    <div key={nodeType} className="space-y-1 pl-2 border-l-2 border-border">
                      <div className="text-xs text-muted-foreground uppercase">{nodeType.replace(/_/g, " ")}s</div>
                      {typeNodes.map((node) => (
                        <NodeCard key={node.id} node={node} />
                      ))}
                    </div>
                  ))}
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* Dependency view - nodes grouped by community */}
      {viewMode === "dependency" && (
        <div className="space-y-4">
          {graph.communities && graph.communities.length > 0 ? (
            graph.communities.map((community) => {
              // Find nodes belonging to this community
              const communityNodes = graph.nodes.filter((n) =>
                n.metadata?.communityKey === community.communityKey
              );
              return (
                <div key={community.communityKey} className="space-y-2">
                  <div className="rounded-lg border-2 border-primary/20 bg-primary/5 px-3 py-2">
                    <div className="text-sm font-semibold">{community.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {community.memberNodeCount} nodes · {community.algorithm}
                    </div>
                  </div>
                  <div className="space-y-1 pl-2 border-l-2 border-border">
                    {communityNodes.map((node) => (
                      <NodeCard key={node.id} node={node} />
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No dependency community data available. Communities are detected automatically.
            </p>
          )}
        </div>
      )}

      {/* Deliverable view - focused on deliverables */}
      {viewMode === "deliverable" && (
        <div className="space-y-4">
          {deliverableNodes.length > 0 ? (
            <div className="space-y-3">
              {deliverableNodes.map((node) => {
                const meta = node.metadata as { type?: string; status?: string; reviewState?: string; url?: string; summary?: string } | undefined;
                return (
                  <div key={node.id} className="rounded-xl border border-pink-500/20 bg-pink-500/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold">{node.label}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="rounded-full bg-pink-500/20 px-2 py-0.5">
                            {meta?.type ?? "unknown"}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            {meta?.status ?? "unknown"}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            review: {meta?.reviewState ?? "none"}
                          </span>
                        </div>
                        {meta?.summary && (
                          <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
                            {meta.summary}
                          </p>
                        )}
                      </div>
                      {meta?.url && (
                        <a
                          href={meta.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline shrink-0"
                        >
                          Open ↗
                        </a>
                      )}
                    </div>
                    {/* Find parent task */}
                    {(() => {
                      const parentEdge = graph.edges.find(
                        (e) => e.edgeType === "task_deliverable" && e.targetNodeId === node.id
                      );
                      if (!parentEdge) return null;
                      const parentNode = graph.nodes.find((n) => n.id === parentEdge.sourceNodeId);
                      if (!parentNode) return null;
                      return (
                        <div className="mt-2 text-xs text-muted-foreground">
                          From task: <span className="text-foreground">{parentNode.label}</span>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No deliverables yet. Complete tasks to produce deliverables.
            </p>
          )}
        </div>
      )}

      {viewMode === "knowledge" && (
        <div className="space-y-4">
          {wikiNodes.length > 0 ? (
            wikiNodes.map((node) => <NodeCard key={node.id} node={node} />)
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">No wiki evidence yet.</p>
          )}
          {taskWithEvidence.map(({ node, evidence }) => (
            <div key={`${node.id}-knowledge`} className="rounded-lg border border-border px-3 py-2">
              <div className="text-sm font-medium">{node.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                knowledge refs: {evidence?.knowledgeRefs.length ?? 0} · status: {evidence?.status ?? "missing"}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === "economy" && (
        <div className="space-y-3">
          {taskWithEvidence.map(({ node, evidence }) => (
            <div key={`${node.id}-economy`} className="rounded-xl border border-border p-4">
              <div className="text-sm font-semibold">{node.label}</div>
              <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <span>Gold estimate: {evidence?.goldEstimate ?? 0}</span>
                <span>Deliverables: {evidence?.deliverableCount ?? 0}</span>
                <span>Quality: {evidence?.qualityStatus ?? "none"}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {graph.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {graph.warnings.slice(0, 3).join(" ")}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No nodes in graph. Create tasks to see the task mesh.
        </p>
      )}
    </div>
  );
}
