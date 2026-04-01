import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { Download, ExternalLink, Network, Upload, UserMinus, UserPlus } from "lucide-react";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import { orgNodeBadges } from "../lib/org-node-display";
import { formatDelegatedPermissions } from "../lib/seat-permissions";
import { formatSeatPauseReason, formatSeatPauseReasons } from "../lib/seat-pause";
import { orgNodeCanManageSeat, primarySeatAction } from "../lib/seat-actions";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSeatManagement } from "../hooks/useSeatManagement";
import { SeatAttachDialog } from "../components/SeatAttachDialog";
import { SeatPauseDialog } from "../components/SeatPauseDialog";
import { SeatPermissionsDialog } from "../components/SeatPermissionsDialog";
import { useI18n } from "../i18n";
import { useAdapterLabels } from "../components/agent-config-primitives";

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
  role: OrgNode["role"];
  seatType: OrgNode["seatType"];
  operatingMode: OrgNode["operatingMode"];
  status: OrgNode["status"];
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
  const { t } = useI18n();
  const adapterLabels = useAdapterLabels();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const {
    attachDialogNode,
    attachHuman,
    attachUserId,
    attachableMembers,
    detachHuman,
    isLoadingCompanyMembers,
    mutationPendingSeatId,
    openAttachDialog,
    openPauseDialog,
    openPermissionsDialog,
    pauseDialogNode,
    pauseSeat,
    permissionsDialogNode,
    resumeSeat,
    selectedPermissions,
    selectedPauseReason,
    selectedSeatDetail,
    selectedSeatNode,
    setAttachDialogNode,
    setAttachUserId,
    setPauseDialogNode,
    setPermissionsDialogNode,
    setSelectedPermissions,
    setSelectedPauseReason,
    setSelectedSeatNode,
    submitAttach,
    submitPause,
    submitPermissions,
    submitResume,
    updateSeatPermissions,
  } = useSeatManagement(selectedCompanyId);

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
  const selectedDisplayAgent = useMemo(
    () => (selectedSeatNode ? agentMap.get(selectedSeatNode.id) ?? null : null),
    [agentMap, selectedSeatNode],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: t("orgChart.title") }]);
  }, [setBreadcrumbs, t]);

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
    return <EmptyState icon={Network} message={t("orgChart.selectCompany")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={Network} message={t("orgChart.noHierarchy")} />;
  }

  return (
    <div className="flex flex-col h-full">
    <div className="mb-2 flex items-center justify-start gap-2 shrink-0">
      <Link to="/company/import">
        <Button variant="outline" size="sm">
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {t("orgChart.importCompany")}
        </Button>
      </Link>
      <Link to="/company/export">
        <Button variant="outline" size="sm">
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {t("orgChart.exportCompany")}
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
          aria-label={t("orgChart.zoomIn")}
          title={t("orgChart.zoomIn")}
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
          aria-label={t("orgChart.zoomOut")}
          title={t("orgChart.zoomOut")}
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
          title={t("orgChart.fitToScreen")}
          aria-label={t("orgChart.fitToScreen")}
        >
          {t("orgChart.fit")}
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
                            openAttachDialog(orgNode);
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
                        openPermissionsDialog(orgNode);
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
          <SheetTitle>{selectedSeatDetail?.name ?? selectedSeatNode?.name ?? t("orgChart.seatDetail")}</SheetTitle>
          <SheetDescription>
            {selectedSeatDetail?.name
              ? `${selectedSeatDetail.name} seat status and delegated permissions`
              : t("orgChart.inspectSeatState")}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-4 text-sm">
          {!selectedSeatDetail ? (
            <p className="text-muted-foreground">{t("orgChart.loadingSeatDetails")}</p>
          ) : (
            <>
              <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">{t("common.slug")}</dt>
                <dd className="truncate">{selectedSeatDetail.slug}</dd>
                <dt className="text-muted-foreground">{t("common.seatType")}</dt>
                <dd>{selectedSeatDetail.seatType}</dd>
                <dt className="text-muted-foreground">{t("common.mode")}</dt>
                <dd>{selectedSeatDetail.operatingMode}</dd>
                <dt className="text-muted-foreground">{t("common.status")}</dt>
                <dd>{selectedSeatDetail.status}</dd>
                <dt className="text-muted-foreground">{t("common.pauseReason")}</dt>
                <dd>{formatSeatPauseReason(selectedSeatDetail.pauseReason) || t("common.none")}</dd>
                <dt className="text-muted-foreground">{t("common.pauseStack")}</dt>
                <dd>{formatSeatPauseReasons(selectedSeatDetail.pauseReasons)}</dd>
                <dt className="text-muted-foreground">{t("common.human")}</dt>
                <dd>{selectedSeatDetail.currentHumanUserId || t("common.none")}</dd>
                <dt className="text-muted-foreground">{t("common.defaultAgent")}</dt>
                <dd className="truncate">{selectedSeatDetail.defaultAgentId || t("common.none")}</dd>
                <dt className="text-muted-foreground">{t("common.delegated")}</dt>
                <dd>{formatDelegatedPermissions(selectedSeatDetail.delegatedPermissions) || t("common.none")}</dd>
              </dl>
              <div className="flex flex-wrap gap-2 pt-2">
                {selectedSeatNode?.seatId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openPauseDialog(selectedSeatNode, selectedSeatDetail.pauseReason === "maintenance" ? "maintenance" : "manual_admin")}
                  >
                    {t("common.pause")}
                  </Button>
                ) : null}
                {selectedSeatNode?.seatId && selectedSeatDetail.pauseReasons.some((reason) => reason !== "budget_enforcement") ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => submitResume(selectedSeatNode.seatId!, null)}
                  >
                    {t("common.resumeOperatorPause")}
                  </Button>
                ) : null}
                {selectedSeatNode && primarySeatAction(selectedSeatNode) === "attach" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openAttachDialog(selectedSeatNode)}
                  >
                    <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                    {t("common.attach")}
                  </Button>
                ) : null}
                {selectedSeatNode?.seatId && primarySeatAction(selectedSeatNode) === "detach" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => detachHuman.mutate(selectedSeatNode.seatId!)}
                  >
                    <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                    {t("common.detach")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => selectedSeatNode && openPermissionsDialog(selectedSeatNode, selectedSeatDetail.delegatedPermissions)}
                >
                  {t("common.editPermissions")}
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
                  {t("orgChart.openAgent")}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
    <SeatAttachDialog
      open={Boolean(attachDialogNode)}
      seatName={attachDialogNode?.name}
      userId={attachUserId}
      memberOptions={attachableMembers}
      isLoadingMembers={isLoadingCompanyMembers}
      isPending={attachHuman.isPending}
      onOpenChange={(open) => !open && setAttachDialogNode(null)}
      onUserIdChange={setAttachUserId}
      onSubmit={submitAttach}
    />
    <SeatPauseDialog
      open={Boolean(pauseDialogNode)}
      seatName={pauseDialogNode?.name}
      pauseReason={selectedPauseReason}
      isPending={pauseSeat.isPending || resumeSeat.isPending}
      onOpenChange={(open) => !open && setPauseDialogNode(null)}
      onPauseReasonChange={setSelectedPauseReason}
      onSubmit={submitPause}
    />
    <SeatPermissionsDialog
      open={Boolean(permissionsDialogNode)}
      seatName={permissionsDialogNode?.name}
      selectedPermissions={selectedPermissions}
      isPending={updateSeatPermissions.isPending}
      onOpenChange={(open) => !open && setPermissionsDialogNode(null)}
      onSelectedPermissionsChange={setSelectedPermissions}
      onSubmit={submitPermissions}
    />
    </div>
  );
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}
