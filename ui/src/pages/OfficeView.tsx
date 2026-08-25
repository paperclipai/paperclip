import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentIcon } from "../components/AgentIconPicker";
import { statusDotColor, defaultDotColor } from "../lib/agent-status-dot";
import { Building2, Maximize2, Minus, Plus } from "lucide-react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { useOrgViewport } from "../components/org/useOrgViewport";
import { useAgentActivity } from "../hooks/useAgentActivity";
import { useOffice3D } from "../hooks/useOffice3D";
import { ActivityBeams, type NodePositions } from "../components/activity/ActivityBeams";
import { Office3DFrame } from "../components/office/Office3DFrame";
import { layoutOffice, rosterForView, type OfficeView as OfficeViewMode } from "../components/office/officeLayout";

const OFFICE_VIEW_KEY = "paperclip.office.view";
// Opt-in CLAW3D (real Three.js 3D) behind a local flag: set
// localStorage["paperclip.office3dUrl"] to the running CLAW3D URL to reveal a
// 2.5D⇄3D toggle. (Follow-up: promote to an instance experimental setting.)
const OFFICE_3D_URL_KEY = "paperclip.office3dUrl";
const WALL_H = 24; // screen px the room "walls" rise for a 2.5D feel

function readOffice3dUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(OFFICE_3D_URL_KEY);
    return value && /^https?:\/\//.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readStoredView(): OfficeViewMode | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(OFFICE_VIEW_KEY);
    return stored === "lite" || stored === "deep" ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredView(value: OfficeViewMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OFFICE_VIEW_KEY, value);
  } catch {
    // storage may be unavailable (private mode) — toggle still works this session
  }
}

const roleLabels: Record<string, string> = AGENT_ROLE_LABELS;
function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}

function pointsAttr(pts: Array<{ x: number; y: number }>): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

export function OfficeView() {
  const { selectedCompanyId } = useCompany();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();

  const [view, setView] = useState<OfficeViewMode>(() => readStoredView() ?? (isMobile ? "lite" : "deep"));
  const setViewPersist = useCallback((next: OfficeViewMode) => {
    setView(next);
    writeStoredView(next);
  }, []);

  // CLAW3D 3D office URL: instance experimental setting first, local dev flag as
  // fallback. Never available on mobile. When set, a 2.5D⇄3D toggle appears.
  const { url: instanceOffice3dUrl } = useOffice3D();
  const localOffice3dUrl = useMemo(() => readOffice3dUrl(), []);
  const office3dUrl = instanceOffice3dUrl ?? localOffice3dUrl;
  const [render3d, setRender3d] = useState(false);
  const show3dToggle = !!office3dUrl && !isMobile;
  const show3d = show3dToggle && render3d;

  const { data: agents, isLoading } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const roomsPerRow = isMobile ? 2 : 3;
  const roster = useMemo(() => rosterForView(agents ?? [], view), [agents, view]);
  const layout = useMemo(() => layoutOffice(roster, roomsPerRow), [roster, roomsPerRow]);

  const {
    containerRef,
    pan,
    zoom,
    dragging,
    suppressNextCardClick,
    zoomTowardPoint,
    fitToScreen,
    viewportHandlers,
  } = useOrgViewport({
    contentBounds: layout.bounds,
    ready: layout.desks.length > 0,
    // Re-fit on a different company or Lite/Deep view even if the new content
    // happens to share the previous width×height; the hook also re-fits on a
    // dimension change, so a plain relayout is covered too.
    fitKey: `${selectedCompanyId ?? ""}:${view}`,
  });

  // Live activity: which agents are working (pulse) + agent→agent beams.
  const { liveAgentIds, activeBeams } = useAgentActivity(selectedCompanyId);
  const nodePositions = useMemo<NodePositions>(
    () => new Map(layout.desks.map((desk) => [desk.agent.id, { x: desk.x, y: desk.y }])),
    [layout.desks],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="Select a company to view the office." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (roster.length === 0) {
    return <EmptyState icon={Building2} message="No agents to show in the office." />;
  }

  const isLite = view === "lite";

  return (
    <div className="flex h-(--sz-calc-38) min-h-(--sz-420px) flex-col md:h-full md:min-h-0">
      {/* Toolbar: Lite / Deep toggle */}
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              "inline-flex items-center rounded-md border border-border p-0.5",
              show3d && "pointer-events-none opacity-50",
            )}
            role="group"
            aria-label="Office roster"
          >
            <button
              type="button"
              aria-pressed={isLite}
              onClick={() => setViewPersist("lite")}
              className={cn(
                "h-8 rounded-sm px-2.5 text-sm transition-colors sm:h-7",
                isLite ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Key agents
            </button>
            <button
              type="button"
              aria-pressed={!isLite}
              onClick={() => setViewPersist("deep")}
              className={cn(
                "h-8 rounded-sm px-2.5 text-sm transition-colors sm:h-7",
                !isLite ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              All agents
            </button>
          </div>
          {show3dToggle && (
            <div className="inline-flex items-center rounded-md border border-border p-0.5" role="group" aria-label="Office render mode">
              <button
                type="button"
                aria-pressed={!render3d}
                onClick={() => setRender3d(false)}
                className={cn(
                  "h-8 rounded-sm px-2.5 text-sm transition-colors sm:h-7",
                  !render3d ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                2.5D
              </button>
              <button
                type="button"
                aria-pressed={render3d}
                onClick={() => setRender3d(true)}
                className={cn(
                  "h-8 rounded-sm px-2.5 text-sm transition-colors sm:h-7",
                  render3d ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                3D
              </button>
            </div>
          )}
        </div>
        <span className="text-(length:--text-nano) text-muted-foreground">
          {layout.desks.length} {layout.desks.length === 1 ? "agent" : "agents"} · {layout.rooms.length}{" "}
          {layout.rooms.length === 1 ? "room" : "rooms"}
        </span>
      </div>

      <div
        ref={containerRef}
        data-testid="office-viewport"
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
                zoomTowardPoint(zoom * 1.2, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
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
                zoomTowardPoint(zoom * 0.8, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
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
            aria-label="Fit office to screen"
          >
            <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </button>
        </div>

        {/* SVG layer: room floors + walls + labels */}
        <svg className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: "100%" }}>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {layout.rooms.map((room) => {
              const [north, east, south, west] = room.polygon;
              if (!north || !east || !south || !west) return null;
              const rightWall = [
                north,
                east,
                { x: east.x, y: east.y - WALL_H },
                { x: north.x, y: north.y - WALL_H },
              ];
              const leftWall = [
                north,
                west,
                { x: west.x, y: west.y - WALL_H },
                { x: north.x, y: north.y - WALL_H },
              ];
              return (
                <g key={room.department}>
                  {/* Back walls (drawn first, behind the floor) */}
                  <polygon points={pointsAttr(leftWall)} fill="var(--muted)" fillOpacity={0.85} stroke="var(--border)" strokeWidth={1} />
                  <polygon points={pointsAttr(rightWall)} fill="var(--card)" fillOpacity={0.9} stroke="var(--border)" strokeWidth={1} />
                  {/* Floor diamond */}
                  <polygon points={pointsAttr(room.polygon)} fill="var(--muted)" fillOpacity={0.45} stroke="var(--border)" strokeWidth={1.5} />
                  {/* Room label */}
                  <text
                    x={room.labelAnchor.x}
                    y={room.labelAnchor.y - WALL_H}
                    textAnchor="middle"
                    className="fill-muted-foreground text-(length:--text-compact) font-semibold"
                  >
                    {room.label} · {room.count}
                  </text>
                </g>
              );
            })}
            {/* Live signal beams (delegation / mention / sync) */}
            <ActivityBeams nodePositions={nodePositions} beams={activeBeams} />
          </g>
        </svg>

        {/* HTML layer: desks (billboarded avatars) */}
        <div
          data-testid="office-desk-layer"
          className="absolute inset-0"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {layout.desks.map((desk) => {
            const agent = desk.agent;
            const dotColor = statusDotColor[agent.status] ?? defaultDotColor;
            return (
              <div
                key={agent.id}
                data-viewport-card
                className="absolute flex flex-col items-center cursor-pointer select-none"
                style={{
                  left: desk.x,
                  top: desk.y,
                  transform: "translate(-50%, -50%)",
                  width: isLite ? 128 : 72,
                }}
                title={`${agent.name} · ${agent.title ?? roleLabel(agent.role)}`}
                onClick={() => navigate(agentUrl(agent))}
                onClickCapture={(e) => {
                  if (!suppressNextCardClick.current) return;
                  suppressNextCardClick.current = false;
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div className="relative">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-muted shadow-sm">
                    <AgentIcon icon={agent.icon} className="h-5 w-5 text-foreground/70" />
                  </div>
                  <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3">
                    {liveAgentIds.has(agent.id) && (
                      <span
                        className="live-ping absolute inset-0 rounded-full"
                        style={{ backgroundColor: dotColor }}
                      />
                    )}
                    <span
                      className="relative block h-3 w-3 rounded-full border-2 border-background"
                      style={{ backgroundColor: dotColor }}
                    />
                  </span>
                </div>
                {isLite && (
                  <div className="mt-1 max-w-(--sz-120px) text-center leading-tight">
                    <div className="truncate text-(length:--text-micro) font-semibold text-foreground">{agent.name}</div>
                    <div className="truncate text-(length:--text-nano) text-muted-foreground">
                      {agent.title ?? roleLabel(agent.role)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {show3d && office3dUrl && (
          <div className="absolute inset-0 z-20 bg-background">
            <Office3DFrame url={office3dUrl} onFallback={() => setRender3d(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
