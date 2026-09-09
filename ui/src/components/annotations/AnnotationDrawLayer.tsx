import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoJsonGeometry } from "../../api/annotations";
import type { DrawTool, ViewportState } from "./types";
import { unprojectFromScreen } from "./viewport-utils";

const SNAP_CLOSE_RADIUS_PX = 12;
/** Minimum distinct vertices before polygon can snap-close (FIX IUN-2268 #3). */
const MIN_POLYGON_VERTICES = 3;

interface DrawLayerProps {
  tool: DrawTool;
  viewport: ViewportState;
  onComplete: (geometry: GeoJsonGeometry) => void;
  onCancel: () => void;
}

interface InProgressLine {
  type: "LineString";
  coords: [number, number][];
}

interface InProgressPolygon {
  type: "Polygon";
  coords: [number, number][];
}

type InProgressDraw = InProgressLine | InProgressPolygon | null;

export function AnnotationDrawLayer({ tool, viewport, onComplete, onCancel }: DrawLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [inProgress, setInProgress] = useState<InProgressDraw>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // Reset when tool changes.
  useEffect(() => {
    setInProgress(null);
    setMousePos(null);
  }, [tool]);

  // Escape cancels draw.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInProgress(null);
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  function isNearFirst(px: number, py: number, coords: [number, number][]): boolean {
    if (coords.length === 0) return false;
    const [firstLng, firstLat] = coords[0];
    const vp = viewport;
    const fx = vp.width / 2 + (firstLng - vp.centerLng) * vp.scale;
    const fy = vp.height / 2 - (firstLat - vp.centerLat) * vp.scale;
    return Math.hypot(px - fx, py - fy) < SNAP_CLOSE_RADIUS_PX;
  }

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === "select") return;
    const { x, y } = getCanvasCoords(e);
    const { lng, lat } = unprojectFromScreen(x, y, viewport);

    if (tool === "point") {
      onComplete({ type: "Point", coordinates: [lng, lat] });
      return;
    }

    if (tool === "line") {
      setInProgress((prev) => {
        const existing = prev?.type === "LineString" ? prev : null;
        return { type: "LineString", coords: [...(existing?.coords ?? []), [lng, lat]] };
      });
      return;
    }

    if (tool === "polygon") {
      setInProgress((prev) => {
        const existing = prev?.type === "Polygon" ? prev : null;
        const coords = existing ? [...existing.coords] : [];

        // Snap-to-close: only close if we have >= MIN_POLYGON_VERTICES unique vertices.
        // FIX(IUN-2268 #3): dblclick path already guarded; snap path was missing this check.
        if (
          coords.length >= MIN_POLYGON_VERTICES &&
          isNearFirst(x, y, coords)
        ) {
          const closed: [number, number][] = [...coords, coords[0]];
          onComplete({ type: "Polygon", coordinates: [closed] });
          return null;
        }

        return { type: "Polygon", coords: [...coords, [lng, lat]] };
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, viewport, getCanvasCoords, onComplete]);

  const handleDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (tool === "line") {
      setInProgress((prev) => {
        if (prev?.type !== "LineString" || prev.coords.length < 2) return null;
        onComplete({ type: "LineString", coordinates: prev.coords });
        return null;
      });
      return;
    }
    if (tool === "polygon") {
      setInProgress((prev) => {
        if (prev?.type !== "Polygon" || prev.coords.length < MIN_POLYGON_VERTICES) return null;
        const closed: [number, number][] = [...prev.coords, prev.coords[0]];
        onComplete({ type: "Polygon", coordinates: [closed] });
        return null;
      });
    }
  }, [tool, onComplete]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    setMousePos(getCanvasCoords(e));
  }, [getCanvasCoords]);

  // Render draw state to canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!inProgress) return;

    const coords = inProgress.coords;
    if (coords.length === 0) return;

    function geoToCanvas(lng: number, lat: number): [number, number] {
      const x = viewport.width / 2 + (lng - viewport.centerLng) * viewport.scale;
      const y = viewport.height / 2 - (lat - viewport.centerLat) * viewport.scale;
      return [x, y];
    }

    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);

    ctx.beginPath();
    const [x0, y0] = geoToCanvas(coords[0][0], coords[0][1]);
    ctx.moveTo(x0, y0);

    for (let i = 1; i < coords.length; i++) {
      const [xi, yi] = geoToCanvas(coords[i][0], coords[i][1]);
      ctx.lineTo(xi, yi);
    }

    // Preview line to mouse cursor.
    if (mousePos && (tool === "line" || tool === "polygon")) {
      ctx.setLineDash([6, 3]);
      ctx.lineTo(mousePos.x, mousePos.y);
    }

    ctx.stroke();
    ctx.setLineDash([]);

    // Draw vertex dots.
    coords.forEach(([lng, lat]) => {
      const [cx, cy] = geoToCanvas(lng, lat);
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#6366f1";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Highlight snap-close target for polygon when >= MIN_POLYGON_VERTICES vertices exist.
    if (
      tool === "polygon" &&
      inProgress.type === "Polygon" &&
      inProgress.coords.length >= MIN_POLYGON_VERTICES &&
      mousePos &&
      isNearFirst(mousePos.x, mousePos.y, inProgress.coords)
    ) {
      const [fx, fy] = geoToCanvas(inProgress.coords[0][0], inProgress.coords[0][1]);
      ctx.beginPath();
      ctx.arc(fx, fy, SNAP_CLOSE_RADIUS_PX, 0, Math.PI * 2);
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProgress, mousePos, tool, viewport]);

  if (tool === "select") return null;

  const cursor = tool === "point" ? "crosshair" : "crosshair";

  return (
    <canvas
      ref={canvasRef}
      width={viewport.width}
      height={viewport.height}
      className="absolute inset-0"
      style={{ cursor, zIndex: 20 }}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      onMouseMove={handleMouseMove}
    />
  );
}
