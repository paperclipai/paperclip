import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { seatsApi } from "../api/seats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Download, ExternalLink, Network, Upload, UserMinus, UserPlus } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { orgNodeBadges } from "../lib/org-node-display";
import { formatDelegatedPermissions, seatPermissionOptions } from "../lib/seat-permissions";
import { orgNodeCanManageSeat, primarySeatAction } from "../lib/seat-actions";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// Layout constants
const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

// ── Tree layout types ───────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  seatId: string | null;
  name: string;
  role: string;
  seatType: string | null;
  operatingMode: string | null;
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
    seatId: node.seatId,
    name: node.name,
    role: node.role,
    seatType: node.seatType,
    operatingMode: node.operatingMode,
    status: node.status,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

/** Layout all root nodes side by side. */
function layoutForest(roots: OrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];

  const totalW = roots.reduce((sum, r) => sum + subtreeWidth(r), 0);
  const gaps = (roots.length - 1) * GAP_X;
  let x = PADDING;
  const y = PADDING;

  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }

  // Compute bounds and return
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

// ── Status dot colors (raw hex for SVG) ─────────────────────────────────

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  hermes_local: "Hermes",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";

// ── Main component ──────────────────────────────────────────────────────

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedSeatNode, setSelectedSeatNode] = useState<OrgNode | null>(null);
  const [attachDialogNode, setAttachDialogNode] = useState<OrgNode | null>(null);
  const [attachUserId, setAttachUserId] = useState("");
  const [permissionsDialogNode, setPermissionsDialogNode] = useState<OrgNode | null>(null);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [mutationPendingSeatId, setMutationPendingSeatId] = useState<string | null>(null);

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
  const { data: selectedSeatDetail } = useQuery({
    queryKey: selectedSeatNode?.seatId
      ? queryKeys.seats.detail(selectedCompanyId!, selectedSeatNode.seatId)
      : ["seats", "org-chart", "selected-none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, selectedSeatNode!.seatId!),
    enabled: !!selectedCompanyId && !!selectedSeatNode?.seatId,
  });
  const { data: permissionsSeatDetail } = useQuery({
    queryKey: permissionsDialogNode?.seatId
      ? queryKeys.seats.detail(selectedCompanyId!, permissionsDialogNode.seatId)
      : ["seats", "org-chart", "permissions-none"],
    queryFn: () => seatsApi.detail(selectedCompanyId!, permissionsDialogNode!.seatId!),
    enabled: !!selectedCompanyId && !!permissionsDialogNode?.seatId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);
  const selectedDisplayAgent = useMemo(
    () => (selectedSeatNode ? agentMap.get(selectedSeatNode.id) ?? null : null),
    [agentMap, selectedSeatNode],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (permissionsSeatDetail && permissionsDialogNode?.seatId === permissionsSeatDetail.id) {
      setSelectedPermissions(permissionsSeatDetail.delegatedPermissions);
    }
  }, [permissionsSeatDetail, permissionsDialogNode]);

  const invalidateSeatViews = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.org(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) }),
      selectedSeatNode?.seatId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.seats.detail(selectedCompanyId, selectedSeatNode.seatId) })
        : Promise.resolve(),
    ]);
  };

  const attachHuman = useMutation({
    mutationFn: async ({ seatId, userId }: { seatId: string; userId: string }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.attachHuman(selectedCompanyId!, seatId, userId);
    },
    onSuccess: async () => {
      await invalidateSeatViews();
      setAttachDialogNode(null);
      setAttachUserId("");
      pushToast({ tone: "success", title: "Human attached to seat" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Attach failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const detachHuman = useMutation({
    mutationFn: async (seatId: string) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.detachHuman(selectedCompanyId!, seatId, null);
    },
    onSuccess: async (result) => {
      await invalidateSeatViews();
      pushToast({
        tone: "success",
        title: "Human detached from seat",
        body:
          result.fallbackReassignedIssueCount > 0
            ? `${result.fallbackReassignedIssueCount} issues were reassigned to the fallback agent.`
            : "No open issues needed reassignment.",
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Detach failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

  const updateSeatPermissions = useMutation({
    mutationFn: async ({ seatId, delegatedPermissions }: { seatId: string; delegatedPermissions: string[] }) => {
      setMutationPendingSeatId(seatId);
      return seatsApi.update(selectedCompanyId!, seatId, { delegatedPermissions });
    },
    onSuccess: async (result) => {
      await invalidateSeatViews();
      await queryClient.invalidateQueries({ queryKey: queryKeys.seats.detail(selectedCompanyId!, result.id) });
      setPermissionsDialogNode(null);
      setSelectedPermissions([]);
      pushToast({ tone: "success", title: "Seat permissions updated" });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Permission update failed",
        body: error instanceof Error ? error.message : "Unknown error",
      });
    },
    onSettled: () => {
      setMutationPendingSeatId(null);
    },
  });

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

  // Pan & zoom state
  const containerRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Center the chart on first load
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current || allNodes.length === 0 || !containerRef.current) return;
    hasInitialized.current = true;

    const container = containerRef.current;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    // Fit chart to container
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't drag if clicking a card
    const target = e.target as HTMLElement;
    if (target.closest("[data-org-card]")) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPan({ x: dragStart.current.panX + dx, y: dragStart.current.panY + dy });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, 0.2), 2);

    // Zoom toward mouse position
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - scale * (mouseX - pan.x),
      y: mouseY - scale * (mouseY - pan.y),
    });
    setZoom(newZoom);
  }, [zoom, pan]);

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
    <div className="flex flex-col h-full">
    <div className="mb-2 flex items-center justify-start gap-2 shrink-0">
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
    <div
      ref={containerRef}
      className="w-full flex-1 min-h-0 overflow-hidden relative bg-muted/20 border border-border rounded-lg"
      style={{ cursor: dragging ? "grabbing" : "grab" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        <button
          className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
          onClick={() => {
            const newZoom = Math.min(zoom * 1.2, 2);
            const container = containerRef.current;
            if (container) {
              const cx = container.clientWidth / 2;
              const cy = container.clientHeight / 2;
              const scale = newZoom / zoom;
              setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
            }
            setZoom(newZoom);
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-sm hover:bg-accent transition-colors"
          onClick={() => {
            const newZoom = Math.max(zoom * 0.8, 0.2);
            const container = containerRef.current;
            if (container) {
              const cx = container.clientWidth / 2;
              const cy = container.clientHeight / 2;
              const scale = newZoom / zoom;
              setPan({ x: cx - scale * (cx - pan.x), y: cy - scale * (cy - pan.y) });
            }
            setZoom(newZoom);
          }}
          aria-label="Zoom out"
        >
          &minus;
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center bg-background border border-border rounded text-[10px] hover:bg-accent transition-colors"
          onClick={() => {
            if (!containerRef.current) return;
            const cW = containerRef.current.clientWidth;
            const cH = containerRef.current.clientHeight;
            const scaleX = (cW - 40) / bounds.width;
            const scaleY = (cH - 40) / bounds.height;
            const fitZoom = Math.min(scaleX, scaleY, 1);
            const chartW = bounds.width * fitZoom;
            const chartH = bounds.height * fitZoom;
            setZoom(fitZoom);
            setPan({ x: (cW - chartW) / 2, y: (cH - chartH) / 2 });
          }}
          title="Fit to screen"
          aria-label="Fit chart to screen"
        >
          Fit
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
        </g>
      </svg>

      {/* Card layer */}
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
          const orgNode: OrgNode = {
            id: node.id,
            seatId: node.seatId,
            name: node.name,
            role: node.role,
            seatType: node.seatType,
            operatingMode: node.operatingMode,
            status: node.status,
            reports: [],
          };
          const badges = orgNodeBadges(orgNode);
          const canManageSeat = orgNodeCanManageSeat(orgNode);
          const primaryAction = primarySeatAction(orgNode);
          const actionPending = mutationPendingSeatId === node.seatId;

          return (
            <div
              key={node.id}
              data-org-card
              className="absolute bg-card border border-border rounded-lg shadow-sm hover:shadow-md hover:border-foreground/20 transition-[box-shadow,border-color] duration-150 cursor-pointer select-none"
              style={{
                left: node.x,
                top: node.y,
                width: CARD_W,
                minHeight: CARD_H,
              }}
              onClick={() => {
                if (!node.seatId) {
                  navigate(agent ? agentUrl(agent) : `/agents/${node.id}`);
                  return;
                }
                setSelectedSeatNode(orgNode);
              }}
            >
              <div className="flex items-center px-4 py-3 gap-3">
                {/* Agent icon + status dot */}
                <div className="relative shrink-0">
                  <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                    <AgentIcon icon={agent?.icon} className="h-4.5 w-4.5 text-foreground/70" />
                  </div>
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card"
                    style={{ backgroundColor: dotColor }}
                  />
                </div>
                {/* Name + role + adapter type */}
                <div className="flex flex-col items-start min-w-0 flex-1">
                  <span className="text-sm font-semibold text-foreground leading-tight">
                    {node.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground leading-tight mt-0.5">
                    {agent?.title ?? roleLabel(node.role)}
                  </span>
                  {badges.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {badges.map((badge) => (
                        <span
                          key={badge.key}
                          className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
                        >
                          {badge.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {agent && (
                    <span className="text-[10px] text-muted-foreground/60 font-mono leading-tight mt-1">
                      {adapterLabels[agent.adapterType] ?? agent.adapterType}
                    </span>
                  )}
                </div>
              </div>
              {canManageSeat && (
                <div className="flex items-center justify-between border-t border-border/60 px-3 py-2">
                  <button
                    type="button"
                    className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedSeatNode(orgNode);
                    }}
                  >
                    Details
                  </button>
                  <div className="flex items-center gap-1">
                    {primaryAction && (
                      <button
                        type="button"
                        className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
                        disabled={actionPending}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (primaryAction === "attach") {
                            setAttachDialogNode(orgNode);
                            setAttachUserId("");
                            return;
                          }
                          if (orgNode.seatId) {
                            detachHuman.mutate(orgNode.seatId);
                          }
                        }}
                      >
                        {primaryAction === "attach"
                          ? <UserPlus className="mr-1 inline h-3 w-3" />
                          : <UserMinus className="mr-1 inline h-3 w-3" />}
                        {actionPending ? "Working" : primaryAction}
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPermissionsDialogNode(orgNode);
                        setSelectedPermissions([]);
                      }}
                    >
                      Perms
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
    <Sheet open={Boolean(selectedSeatNode)} onOpenChange={(open) => !open && setSelectedSeatNode(null)}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{selectedSeatDetail?.name ?? selectedSeatNode?.name ?? "Seat Detail"}</SheetTitle>
          <SheetDescription>
            {selectedSeatDetail?.name
              ? `${selectedSeatDetail.name} seat 상태와 위임 권한`
              : "Seat 상태를 확인하고 관리합니다."}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-4 text-sm">
          {!selectedSeatDetail ? (
            <p className="text-muted-foreground">Seat 정보를 불러오는 중입니다.</p>
          ) : (
            <>
              <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">Slug</dt>
                <dd className="truncate">{selectedSeatDetail.slug}</dd>
                <dt className="text-muted-foreground">Seat Type</dt>
                <dd>{selectedSeatDetail.seatType}</dd>
                <dt className="text-muted-foreground">Mode</dt>
                <dd>{selectedSeatDetail.operatingMode}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{selectedSeatDetail.status}</dd>
                <dt className="text-muted-foreground">Human</dt>
                <dd>{selectedSeatDetail.currentHumanUserId || "None"}</dd>
                <dt className="text-muted-foreground">Default Agent</dt>
                <dd className="truncate">{selectedSeatDetail.defaultAgentId || "None"}</dd>
                <dt className="text-muted-foreground">Delegated</dt>
                <dd>{formatDelegatedPermissions(selectedSeatDetail.delegatedPermissions) || "none"}</dd>
              </dl>
              <div className="flex flex-wrap gap-2 pt-2">
                {selectedSeatNode && primarySeatAction(selectedSeatNode) === "attach" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAttachDialogNode(selectedSeatNode);
                      setAttachUserId("");
                    }}
                  >
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    Attach
                  </Button>
                ) : null}
                {selectedSeatNode?.seatId && primarySeatAction(selectedSeatNode) === "detach" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => detachHuman.mutate(selectedSeatNode.seatId!)}
                  >
                    <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                    Detach
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!selectedSeatNode) return;
                    setPermissionsDialogNode(selectedSeatNode);
                    setSelectedPermissions(selectedSeatDetail.delegatedPermissions);
                  }}
                >
                  Edit Permissions
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (selectedDisplayAgent) {
                      navigate(agentUrl(selectedDisplayAgent));
                      return;
                    }
                    if (selectedSeatDetail.defaultAgentId) {
                      navigate(`/agents/${selectedSeatDetail.defaultAgentId}`);
                    }
                  }}
                  disabled={!selectedDisplayAgent && !selectedSeatDetail.defaultAgentId}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open Agent
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
    <Dialog open={Boolean(attachDialogNode)} onOpenChange={(open) => !open && setAttachDialogNode(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach Human Operator</DialogTitle>
          <DialogDescription>
            {attachDialogNode?.name ? `${attachDialogNode.name} seat에 human operator를 붙입니다.` : "Seat에 human operator를 붙입니다."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">User ID</label>
          <Input
            value={attachUserId}
            onChange={(e) => setAttachUserId(e.target.value)}
            placeholder="user-123"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAttachDialogNode(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!attachDialogNode?.seatId || !attachUserId.trim()) return;
              attachHuman.mutate({ seatId: attachDialogNode.seatId, userId: attachUserId.trim() });
            }}
            disabled={!attachDialogNode?.seatId || !attachUserId.trim() || attachHuman.isPending}
          >
            {attachHuman.isPending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(permissionsDialogNode)} onOpenChange={(open) => !open && setPermissionsDialogNode(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Delegated Permissions</DialogTitle>
          <DialogDescription>
            {permissionsDialogNode?.name
              ? `${permissionsDialogNode.name} seat에 위임 권한을 설정합니다.`
              : "Seat delegated permissions를 설정합니다."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Delegated Permissions</label>
          <div className="space-y-2 rounded-md border border-border p-3">
            {seatPermissionOptions.map((option) => {
              const checked = selectedPermissions.includes(option.key);
              return (
                <label key={option.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      setSelectedPermissions((current) => {
                        if (next) return Array.from(new Set([...current, option.key]));
                        return current.filter((value) => value !== option.key);
                      });
                    }}
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Current: {formatDelegatedPermissions(selectedPermissions) || "none"}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPermissionsDialogNode(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!permissionsDialogNode?.seatId) return;
              updateSeatPermissions.mutate({
                seatId: permissionsDialogNode.seatId,
                delegatedPermissions: selectedPermissions,
              });
            }}
            disabled={!permissionsDialogNode?.seatId || updateSeatPermissions.isPending}
          >
            {updateSeatPermissions.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
