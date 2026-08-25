import { useEffect, useMemo } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Download, Maximize2, Minus, Network, Plus, Upload } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { useOrgViewport } from "../components/org/useOrgViewport";
import { useAgentActivity } from "../hooks/useAgentActivity";
import { ActivityBeams, type NodePositions } from "../components/activity/ActivityBeams";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

// ── Layout algorithm ────────────────────────────────────────────────────

/** Compute the width each subtree needs. */
function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

/** Recursively assign x,y positions. */
function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    id: node.id,
    name: node.name,
    role: node.role,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  return result;
}

/** Flatten layout tree to list of nodes. */
function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect all parent→child edges. */
function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { statusDotColor, defaultDotColor } from "../lib/agent-status-dot";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  // Import is floored server-side on cloud-managed instances (403 cloud_managed), so the
  // button is hidden rather than dead-ending. Export stays available. Both
  // buttons also respect the operator-hidden settings registry.
  const isCloud = Boolean(useCloudInstance());
  const { hidden: hiddenSettings } = useHiddenSettings();
  const showImport = !isCloud && !hiddenSettings.has("company.import");
  const showExport = !hiddenSettings.has("company.export");

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  // Layout computation
  const layout = useMemo(() => layoutForest(orgTree ?? []), [orgTree]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  // Compute SVG bounds
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 600 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  // Pan / zoom / pinch viewport (shared with the Office view)
  const {
    containerRef,
    pan,
    zoom,
    dragging,
    suppressNextCardClick,
    zoomTowardPoint,
    fitToScreen,
    viewportHandlers,
  } = useOrgViewport({ contentBounds: bounds, ready: allNodes.length > 0 });

  // Live activity: which agents are working (pulse) + agent→agent beams.
  const { liveAgentIds, activeBeams } = useAgentActivity(selectedCompanyId);
  const nodePositions = useMemo<NodePositions>(
    () => new Map(allNodes.map((n) => [n.id, { x: n.x + CARD_W / 2, y: n.y + CARD_H / 2 }])),
    [allNodes],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message="No organizational hierarchy defined." />;
  }

  return (
    <div className="flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-start gap-2">
        {showImport && (
          <Link to="/company/import">
            <Button variant="outline" size="sm">
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Import company
            </Button>
          </Link>
        )}
        {showExport && (
          <Link to="/company/export">
            <Button variant="outline" size="sm">
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export company
            </Button>
          </Link>
        )}
      </div>
      <div
        ref={containerRef}
        data-testid="org-chart-viewport"
        className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
        style={{
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          overscrollBehavior: "contain",
        }}
        {...viewportHandlers}
      >
        {/* Zoom controls */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1.5">
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 1.2, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent sm:size-7"
            onClick={() => {
              const container = containerRef.current;
              if (container) {
                zoomTowardPoint(zoom * 0.8, {
                  x: container.clientWidth / 2,
                  y: container.clientHeight / 2,
                });
              }
            }}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
          <button
            className="flex size-9 items-center justify-center rounded border border-border bg-background text-(length:--text-nano) transition-colors hover:bg-accent sm:size-7"
            onClick={fitToScreen}
            title="Fit to screen"
            aria-label="Fit chart to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>

        {/* SVG layer for edges */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{
            width: "100%",
            height: "100%",
          }}
        >
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {edges.map(({ parent, child }) => {
              const x1 = parent.x + CARD_W / 2;
              const y1 = parent.y + CARD_H;
              const x2 = child.x + CARD_W / 2;
              const y2 = child.y;
              const midY = (y1 + y2) / 2;

              return (
                <path
                  key={`${parent.id}-${child.id}`}
                  d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
              );
            })}
            {/* Live signal beams (delegation / mention / sync) */}
            <ActivityBeams nodePositions={nodePositions} beams={activeBeams} />
          </g>
        </svg>

        {/* Card layer */}
        <div
          data-testid="org-chart-card-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {allNodes.map((node) => {
            const agent = agentMap.get(node.id);
            const dotColor = statusDotColor[node.status] ?? defaultDotColor;

            return (
              <Card
                key={node.id}
                data-org-card
                data-viewport-card
                className="block absolute py-0 hover:shadow-md hover:border-foreground/20 transition-(--tp-box-shadow-border-color) duration-150 cursor-pointer select-none"
                style={{
                  left: node.x,
                  top: node.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                }}
                onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div className="flex items-center px-4 py-3 gap-3">
                  {/* Agent icon + status dot */}
                  <div className="relative shrink-0">
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                      <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3">
                      {liveAgentIds.has(node.id) && (
                        <span
                          className="live-ping absolute inset-0 rounded-full"
                          style={{ backgroundColor: dotColor }}
                        />
                      )}
                      <span
                        className="relative block h-3 w-3 rounded-full border-2 border-card"
                        style={{ backgroundColor: dotColor }}
                      />
                    </span>
                  </div>
                  {/* Name + role + adapter type */}
                  <div className="flex flex-col items-start min-w-0 flex-1">
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {node.name}
                    </span>
                    <span className="text-(length:--text-micro) text-muted-foreground leading-tight mt-0.5">
                      {agent?.title ?? roleLabel(node.role)}
                    </span>
                    {agent && (
                      <span className="text-(length:--text-nano) text-muted-foreground/60 font-mono leading-tight mt-1">
                        {getAdapterLabel(agent.adapterType)}
                      </span>
                    )}
                    {agent && agent.capabilities && (
                      <span className="text-(length:--text-nano) text-muted-foreground/80 leading-tight mt-1 line-clamp-2">
                        {agent.capabilities}
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
