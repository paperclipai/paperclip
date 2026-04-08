import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { agentsApi, type DepartmentOrgGroup, type OrgNode } from "../api/agents";
import { AgentIcon } from "../components/AgentIconPicker";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, Download, GitBranch, Network, Upload, Users } from "lucide-react";

const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

interface LayoutNode {
  id: string;
  name: string;
  role: string;
  status: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

function subtreeWidth(node: OrgNode): number {
  if (node.reports.length === 0) return CARD_W;
  const childrenW = node.reports.reduce((sum, child) => sum + subtreeWidth(child), 0);
  const gaps = (node.reports.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.reports.length > 0) {
    const childrenW = node.reports.reduce((sum, child) => sum + subtreeWidth(child), 0);
    const gaps = (node.reports.length - 1) * GAP_X;
    let childX = x + (totalW - childrenW - gaps) / 2;

    for (const child of node.reports) {
      const childWidth = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, childX, y + CARD_H + GAP_Y));
      childX += childWidth + GAP_X;
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

function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];
  let x = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const width = subtreeWidth(root);
    result.push(layoutTree(root, x, PADDING));
    x += width + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(node: LayoutNode) {
    result.push(node);
    node.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(node: LayoutNode) {
    for (const child of node.children) {
      edges.push({ parent: node, child });
      walk(child);
    }
  }
  nodes.forEach(walk);
  return edges;
}

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";
const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}

function OrgChartCanvas({
  roots,
  agentMap,
  className = "flex-1 min-h-0",
}: {
  roots: OrgNode[];
  agentMap: Map<string, Agent>;
  className?: string;
}) {
  const navigate = useNavigate();
  const layout = useMemo(() => layoutForest(roots), [roots]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);
  const bounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 800, height: 420 };
    let maxX = 0;
    let maxY = 0;
    for (const node of allNodes) {
      maxX = Math.max(maxX, node.x + CARD_W);
      maxY = Math.max(maxY, node.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const hasInitialized = useRef(false);

  useEffect(() => {
    hasInitialized.current = false;
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [roots]);

  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    if (containerW <= 40 || containerH <= 40) return;
    const scaleX = (containerW - 40) / bounds.width;
    const scaleY = (containerH - 40) / bounds.height;
    const fitZoom = Math.min(scaleX, scaleY, 1);
    const chartW = bounds.width * fitZoom;
    const chartH = bounds.height * fitZoom;

    setZoom(fitZoom);
    setPan({
      x: (containerW - chartW) / 2,
      y: (containerH - chartH) / 2,
    });
  }, [allNodes, bounds]);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!dragging) return;
    const dx = event.clientX - dragStart.current.x;
    const dy = event.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = Math.min(Math.max(zoom * factor, 0.2), 2);
    const scale = nextZoom / zoom;

    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(nextZoom);
  }, [pan, zoom]);

  if (roots.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed border-border bg-muted/20 ${className}`}>
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          No reporting hierarchy available for this slice.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden rounded-lg border border-border bg-muted/20 ${className}`}
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent"
          onClick={() => {
            const nextZoom = Math.min(zoom * 1.2, 2);
            const container = containerRef.current;
            if (container) {
              const centerX = container.clientWidth / 2;
              const centerY = container.clientHeight / 2;
              const scale = nextZoom / zoom;
              setPan({
                x: centerX - scale * (centerX - pan.x),
                y: centerY - scale * (centerY - pan.y),
              });
            }
            setZoom(nextZoom);
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-sm transition-colors hover:bg-accent"
          onClick={() => {
            const nextZoom = Math.max(zoom * 0.8, 0.2);
            const container = containerRef.current;
            if (container) {
              const centerX = container.clientWidth / 2;
              const centerY = container.clientHeight / 2;
              const scale = nextZoom / zoom;
              setPan({
                x: centerX - scale * (centerX - pan.x),
                y: centerY - scale * (centerY - pan.y),
              });
            }
            setZoom(nextZoom);
          }}
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-[10px] transition-colors hover:bg-accent"
          onClick={() => {
            if (!containerRef.current) return;
            const containerW = containerRef.current.clientWidth;
            const containerH = containerRef.current.clientHeight;
            if (containerW <= 40 || containerH <= 40) return;
            const scaleX = (containerW - 40) / bounds.width;
            const scaleY = (containerH - 40) / bounds.height;
            const fitZoom = Math.min(scaleX, scaleY, 1);
            const chartW = bounds.width * fitZoom;
            const chartH = bounds.height * fitZoom;
            setZoom(fitZoom);
            setPan({ x: (containerW - chartW) / 2, y: (containerH - chartH) / 2 });
          }}
          aria-label="Fit chart to screen"
          title="Fit chart to screen"
        >
          Fit
        </button>
      </div>

      <svg className="absolute inset-0 pointer-events-none h-full w-full">
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
        </g>
      </svg>

      <div
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
            <div
              key={node.id}
              data-org-card
              className="absolute cursor-pointer select-none rounded-lg border border-border bg-card shadow-sm transition-[box-shadow,border-color] duration-150 hover:border-foreground/20 hover:shadow-md"
              style={{ left: node.x, top: node.y, width: CARD_W, minHeight: CARD_H }}
              onClick={() => navigate(agent ? agentUrl(agent) : `/agents/${node.id}`)}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="relative shrink-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                    <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                  </div>
                  <span
                    className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-card"
                    style={{ backgroundColor: dotColor }}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{node.name}</p>
                  <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                    {agent?.title ?? roleLabel(node.role)}
                  </p>
                  {agent ? (
                    <p className="mt-1 text-[10px] font-mono leading-tight text-muted-foreground/60">
                      {getAdapterLabel(agent.adapterType)}
                    </p>
                  ) : null}
                  {agent?.capabilities ? (
                    <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-muted-foreground/80">
                      {agent.capabilities}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [mode, setMode] = useState<"reporting" | "department">("reporting");

  const reportingQuery = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId && mode === "reporting",
  });

  const groupedQuery = useQuery({
    queryKey: queryKeys.orgByDepartment(selectedCompanyId!),
    queryFn: () => agentsApi.orgByDepartment(selectedCompanyId!),
    enabled: !!selectedCompanyId && mode === "department",
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsQuery.data]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org chart." />;
  }

  if (agentsQuery.isLoading || (mode === "reporting" ? reportingQuery.isLoading : groupedQuery.isLoading)) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (mode === "reporting" && reportingQuery.data && reportingQuery.data.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3">
        <OrgChartToolbar mode={mode} onModeChange={setMode} />
        <EmptyState icon={GitBranch} message="No organizational hierarchy defined." />
      </div>
    );
  }

  if (mode === "department" && groupedQuery.data && groupedQuery.data.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3">
        <OrgChartToolbar mode={mode} onModeChange={setMode} />
        <EmptyState icon={Building2} message="No department groupings available yet." />
      </div>
    );
  }

  const reportingTree = reportingQuery.data ?? [];
  const groupedTree = groupedQuery.data ?? [];

  return (
    <div className="flex h-full flex-col gap-3">
      <OrgChartToolbar mode={mode} onModeChange={setMode} />

      {mode === "reporting" ? (
        <OrgChartCanvas roots={reportingTree} agentMap={agentMap} />
      ) : (
        <div className="grid gap-4 overflow-y-auto pb-2 xl:grid-cols-2">
          {groupedTree.map((group) => (
            <DepartmentGroupCard key={group.department?.id ?? "__unassigned__"} group={group} agentMap={agentMap} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgChartToolbar({
  mode,
  onModeChange,
}: {
  mode: "reporting" | "department";
  onModeChange: (mode: "reporting" | "department") => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
      <div className="flex items-center gap-2">
        <Link to="/company/import">
          <Button variant="outline" size="sm">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import company
          </Button>
        </Link>
        <Link to="/company/export">
          <Button variant="outline" size="sm">
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export company
          </Button>
        </Link>
      </div>

      <div className="flex items-center rounded-md border border-border bg-background p-1">
        <button
          type="button"
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "reporting" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
          }`}
          onClick={() => onModeChange("reporting")}
        >
          Reporting hierarchy
        </button>
        <button
          type="button"
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            mode === "department" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
          }`}
          onClick={() => onModeChange("department")}
        >
          Grouped by department
        </button>
      </div>
    </div>
  );
}

function DepartmentGroupCard({
  group,
  agentMap,
}: {
  group: DepartmentOrgGroup;
  agentMap: Map<string, Agent>;
}) {
  const title = group.department?.name ?? "Unassigned";
  const description = group.department ? "Agents grouped by owning department." : "Agents without a department.";

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold">{title}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="secondary" className="shrink-0 text-xs">
          <Users className="mr-1 h-3 w-3" />
          {group.memberCount}
        </Badge>
      </div>
      <OrgChartCanvas roots={group.roots} agentMap={agentMap} className="h-[360px]" />
    </section>
  );
}
