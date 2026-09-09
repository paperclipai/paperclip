import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Map, Settings, Wifi, WifiOff } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useAnnotations, useCreateAnnotation, useDeleteAnnotation } from "../hooks/useAnnotations";
import { useAnnotationWebSocket, type AnnotationBBox } from "../hooks/useAnnotationWebSocket";
import { AnnotationsLayer } from "../components/annotations/AnnotationsLayer";
import { AnnotationDrawLayer } from "../components/annotations/AnnotationDrawLayer";
import { AnnotationPopup } from "../components/annotations/AnnotationPopup";
import { AnnotationToolbar } from "../components/annotations/AnnotationToolbar";
import { AnnotationsLayerToggle } from "../components/annotations/AnnotationsLayerToggle";
import { AnnotationForm } from "../components/annotations/AnnotationForm";
import { viewportToBBox } from "../components/annotations/viewport-utils";
import type { DrawTool, ViewportState } from "../components/annotations/types";
import type { Annotation, GeoJsonGeometry } from "../api/annotations";
import { useToast } from "../context/ToastContext";
import { AlertsPanel } from "../components/solaris/AlertsPanel";
import { OrgSettings } from "../components/solaris/OrgSettings";
import { useSolarisOrgs } from "../hooks/useSolarisAlerts";

// Default center: Los Angeles area (Solaris wildfire monitoring region)
const DEFAULT_CENTER_LNG = -118.25;
const DEFAULT_CENTER_LAT = 34.05;
const DEFAULT_SCALE = 100; // pixels per degree

const BBOX_DEBOUNCE_MS = 500;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function Solaris() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;

  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Solaris" }]);
  }, [setBreadcrumbs]);

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    staleTime: 5 * 60 * 1000,
  });
  const currentUserId = sessionQuery.data?.user?.id ?? null;
  // Role check: the server enforces admin delete; this is UI exposure only.
  const isAdmin = false;

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 900, height: 600 });

  // Track container dimensions.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) {
        setContainerSize({
          width: Math.floor(e.contentRect.width),
          height: Math.floor(e.contentRect.height),
        });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const [viewport, setViewport] = useState<ViewportState>({
    centerLng: DEFAULT_CENTER_LNG,
    centerLat: DEFAULT_CENTER_LAT,
    scale: DEFAULT_SCALE,
    width: containerSize.width,
    height: containerSize.height,
  });

  // Keep viewport size in sync with container.
  useEffect(() => {
    setViewport((prev) => ({
      ...prev,
      width: containerSize.width,
      height: containerSize.height,
    }));
  }, [containerSize]);

  // Computed bbox — debounced 500ms before sending to WebSocket.
  // FIX(IUN-2268 #1): bbox is recomputed on every pan/zoom and debounced before
  // updating the WebSocket, which reconnects with the new bbox parameter.
  const currentBBox = viewportToBBox(viewport);
  const debouncedBBox = useDebounced<AnnotationBBox>(currentBBox, BBOX_DEBOUNCE_MS);

  // Pan handling.
  const panRef = useRef<{ startX: number; startY: number; startLng: number; startLat: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLng: viewport.centerLng,
      startLat: viewport.centerLat,
    };
  }, [viewport.centerLng, viewport.centerLat]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!panRef.current) return;
    const dx = e.clientX - panRef.current.startX;
    const dy = e.clientY - panRef.current.startY;
    setViewport((prev) => ({
      ...prev,
      centerLng: panRef.current!.startLng - dx / prev.scale,
      centerLat: panRef.current!.startLat + dy / prev.scale,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    panRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.88;
    setViewport((prev) => ({
      ...prev,
      scale: Math.max(10, Math.min(5000, prev.scale * factor)),
    }));
  }, []);

  // Annotations state.
  const [annotationsEnabled, setAnnotationsEnabled] = useState(true);
  const [activeTool, setActiveTool] = useState<DrawTool>("select");
  const [selectedAnnotation, setSelectedAnnotation] = useState<Annotation | null>(null);
  const [pendingGeometry, setPendingGeometry] = useState<GeoJsonGeometry | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(null);

  const { data: annotations = [] } = useAnnotations(companyId);
  const createAnnotation = useCreateAnnotation();
  const deleteAnnotation = useDeleteAnnotation();
  const { pushToast } = useToast();

  // Right panel tab state.
  const [rightPanel, setRightPanel] = useState<"alerts" | "orgs" | null>("alerts");
  const { data: orgs = [] } = useSolarisOrgs(companyId);

  // WebSocket — reconnects when debouncedBBox changes (FIX #1).
  const { status: wsStatus } = useAnnotationWebSocket(
    companyId,
    annotationsEnabled ? debouncedBBox : null,
  );

  const handleDrawComplete = useCallback((geometry: GeoJsonGeometry) => {
    setPendingGeometry(geometry);
    setActiveTool("select");
  }, []);

  const handleDrawCancel = useCallback(() => {
    setPendingGeometry(null);
  }, []);

  const handleFormSubmit = useCallback(async (values: {
    label: string;
    annotationType: "perimeter" | "hazard" | "resource" | "note";
    severity: "critical" | "warning" | "info";
    visibility: "org_wide" | "admin_only";
  }) => {
    if (!pendingGeometry || !companyId) return;
    try {
      await createAnnotation.mutateAsync({
        companyId,
        geometry: pendingGeometry,
        ...values,
      });
      setPendingGeometry(null);
      pushToast({ title: "Annotation saved", tone: "success" });
    } catch {
      pushToast({ title: "Failed to save annotation", tone: "error" });
    }
  }, [pendingGeometry, companyId, createAnnotation, pushToast]);

  const handleDelete = useCallback(async (ann: Annotation) => {
    if (!companyId) return;
    try {
      await deleteAnnotation.mutateAsync({ id: ann.id, companyId });
      setSelectedAnnotation(null);
      pushToast({ title: "Annotation deleted", tone: "success" });
    } catch {
      pushToast({ title: "Failed to delete annotation", tone: "error" });
    }
  }, [companyId, deleteAnnotation, pushToast]);

  if (!companyId) return <PageSkeleton />;

  const visibleAnnotations = annotationsEnabled ? annotations : [];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar strip */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card/60 backdrop-blur-sm shrink-0">
        <Map className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Solaris</span>
        <div className="ml-4">
          <AnnotationsLayerToggle
            enabled={annotationsEnabled}
            count={annotations.length}
            onToggle={() => {
              setAnnotationsEnabled((v) => !v);
              setSelectedAnnotation(null);
            }}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {annotationsEnabled && (
            <span
              className={`flex items-center gap-1 text-[11px] ${wsStatus === "open" ? "text-green-400" : "text-muted-foreground"}`}
              title={`WebSocket: ${wsStatus}`}
            >
              {wsStatus === "open" ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              Live
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {viewport.scale.toFixed(0)}px/° · {viewport.centerLat.toFixed(3)}°N {Math.abs(viewport.centerLng).toFixed(3)}°W
          </span>
          <div className="flex rounded border border-border overflow-hidden">
            <button
              className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${rightPanel === "alerts" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setRightPanel((p) => p === "alerts" ? null : "alerts")}
              title="CAP Alerts"
            >
              <Bell className="h-3 w-3" /> Alerts
            </button>
            <button
              className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors border-l border-border ${rightPanel === "orgs" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setRightPanel((p) => p === "orgs" ? null : "orgs")}
              title="Org Settings"
            >
              <Settings className="h-3 w-3" /> Orgs
            </button>
          </div>
        </div>
      </div>

      {/* Main content: map + optional right panel */}
      <div className="flex flex-1 min-h-0">
        {/* Map viewport */}
        <div
          ref={containerRef}
          className="relative flex-1 bg-zinc-900 overflow-hidden select-none"
          style={{ cursor: panRef.current ? "grabbing" : activeTool === "select" ? "grab" : "crosshair" }}
          onMouseDown={activeTool === "select" ? handleMouseDown : undefined}
          onMouseMove={activeTool === "select" ? handleMouseMove : undefined}
          onMouseUp={activeTool === "select" ? handleMouseUp : undefined}
          onMouseLeave={activeTool === "select" ? handleMouseUp : undefined}
          onWheel={handleWheel}
        >
        {/* Grid / map background */}
        <MapBackground viewport={viewport} />

        {/* Annotation SVG layer */}
        {annotationsEnabled && (
          <AnnotationsLayer
            annotations={visibleAnnotations}
            viewport={viewport}
            onSelect={(ann) => {
              setSelectedAnnotation(ann);
              setActiveTool("select");
            }}
            selectedId={selectedAnnotation?.id ?? null}
          />
        )}

        {/* Draw layer */}
        {annotationsEnabled && activeTool !== "select" && (
          <AnnotationDrawLayer
            tool={activeTool}
            viewport={viewport}
            onComplete={handleDrawComplete}
            onCancel={handleDrawCancel}
          />
        )}

        {/* Draw toolbar */}
        {annotationsEnabled && (
          <AnnotationToolbar
            activeTool={activeTool}
            onToolChange={(t) => {
              setActiveTool(t);
              setSelectedAnnotation(null);
              setPendingGeometry(null);
            }}
          />
        )}

        {/* Annotation form (pending geometry) */}
        {pendingGeometry && (
          <AnnotationForm
            onSubmit={handleFormSubmit}
            onCancel={() => { setPendingGeometry(null); }}
            submitting={createAnnotation.isPending}
          />
        )}

        {/* Annotation popup */}
        {selectedAnnotation && !pendingGeometry && (
          <AnnotationPopup
            annotation={selectedAnnotation}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            onEdit={(ann) => {
              setEditingAnnotation(ann);
              setSelectedAnnotation(null);
            }}
            onDelete={handleDelete}
            onClose={() => setSelectedAnnotation(null)}
          />
        )}

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-20">
          <button
            className="h-8 w-8 rounded border border-border bg-card/90 text-sm font-bold hover:bg-muted flex items-center justify-center"
            onClick={() => setViewport((v) => ({ ...v, scale: Math.min(5000, v.scale * 1.3) }))}
          >
            +
          </button>
          <button
            className="h-8 w-8 rounded border border-border bg-card/90 text-sm font-bold hover:bg-muted flex items-center justify-center"
            onClick={() => setViewport((v) => ({ ...v, scale: Math.max(10, v.scale / 1.3) }))}
          >
            −
          </button>
        </div>
        </div>

        {/* Right panel: alerts or org settings */}
        {rightPanel !== null && companyId && (
          <div className="w-80 shrink-0 border-l border-border bg-background overflow-y-auto p-4">
            {rightPanel === "alerts" && <AlertsPanel companyId={companyId} orgs={orgs} />}
            {rightPanel === "orgs" && <OrgSettings companyId={companyId} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Simple SVG grid overlay to simulate a map background. */
function MapBackground({ viewport }: { viewport: ViewportState }) {
  const { width, height, centerLng, centerLat, scale } = viewport;

  // Draw lat/lng grid lines every N degrees based on scale.
  const gridDeg = scale > 500 ? 1 : scale > 100 ? 5 : scale > 20 ? 10 : 20;
  const lines: { x1: number; y1: number; x2: number; y2: number; label: string; isLng: boolean }[] = [];

  const minLng = centerLng - width / scale;
  const maxLng = centerLng + width / scale;
  const minLat = centerLat - height / scale;
  const maxLat = centerLat + height / scale;

  const startLng = Math.ceil(minLng / gridDeg) * gridDeg;
  for (let lng = startLng; lng <= maxLng; lng += gridDeg) {
    const x = width / 2 + (lng - centerLng) * scale;
    lines.push({ x1: x, y1: 0, x2: x, y2: height, label: `${lng}°`, isLng: true });
  }

  const startLat = Math.ceil(minLat / gridDeg) * gridDeg;
  for (let lat = startLat; lat <= maxLat; lat += gridDeg) {
    const y = height / 2 - (lat - centerLat) * scale;
    lines.push({ x1: 0, y1: y, x2: width, y2: y, label: `${lat}°`, isLng: false });
  }

  return (
    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 0 }}>
      {lines.map((l, i) => (
        <g key={i}>
          <line
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
          />
          <text
            x={l.isLng ? l.x1 + 2 : 4}
            y={l.isLng ? 12 : l.y1 - 2}
            fontSize={9}
            fill="rgba(255,255,255,0.25)"
            style={{ userSelect: "none" }}
          >
            {l.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
