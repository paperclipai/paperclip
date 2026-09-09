import type { Annotation } from "../../api/annotations";
import type { ViewportState } from "./types";
import { projectToScreen } from "./viewport-utils";

interface AnnotationsLayerProps {
  annotations: Annotation[];
  viewport: ViewportState;
  onSelect: (annotation: Annotation) => void;
  selectedId: string | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  warning: "#f97316",
  info:     "#3b82f6",
};

const TYPE_SYMBOL: Record<string, string> = {
  perimeter: "⬡",
  hazard:    "⚠",
  resource:  "✛",
  note:      "📍",
};

export function AnnotationsLayer({ annotations, viewport, onSelect, selectedId }: AnnotationsLayerProps) {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ overflow: "visible" }}
    >
      {annotations.map((ann) => {
        const { geometry } = ann;
        const color = SEVERITY_COLOR[ann.severity] ?? "#3b82f6";
        const isSelected = ann.id === selectedId;

        if (geometry.type === "Point") {
          const [lng, lat] = geometry.coordinates as [number, number];
          const { x, y } = projectToScreen(lng, lat, viewport);
          return (
            <g
              key={ann.id}
              className="pointer-events-auto cursor-pointer"
              onClick={() => onSelect(ann)}
            >
              <circle
                cx={x}
                cy={y}
                r={isSelected ? 14 : 10}
                fill={color}
                stroke="white"
                strokeWidth={2}
                opacity={0.9}
              />
              <text
                x={x}
                y={y + 4}
                textAnchor="middle"
                fontSize={10}
                fill="white"
                style={{ userSelect: "none" }}
              >
                {TYPE_SYMBOL[ann.annotationType] ?? "•"}
              </text>
            </g>
          );
        }

        if (geometry.type === "LineString") {
          const coords = geometry.coordinates as [number, number][];
          const points = coords.map(([lng, lat]) => {
            const { x, y } = projectToScreen(lng, lat, viewport);
            return `${x},${y}`;
          }).join(" ");
          return (
            <g key={ann.id} className="pointer-events-auto cursor-pointer" onClick={() => onSelect(ann)}>
              <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={isSelected ? 4 : 2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.85}
              />
            </g>
          );
        }

        if (geometry.type === "Polygon") {
          const ring = (geometry.coordinates as [number, number][][])[0];
          if (!ring) return null;
          const points = ring.map(([lng, lat]) => {
            const { x, y } = projectToScreen(lng, lat, viewport);
            return `${x},${y}`;
          }).join(" ");
          return (
            <g key={ann.id} className="pointer-events-auto cursor-pointer" onClick={() => onSelect(ann)}>
              <polygon
                points={points}
                fill={color}
                fillOpacity={0.18}
                stroke={color}
                strokeWidth={isSelected ? 3.5 : 2}
                opacity={0.9}
              />
            </g>
          );
        }

        return null;
      })}
    </svg>
  );
}
