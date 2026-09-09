import { MousePointer2, MapPin, Minus, Pentagon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DrawTool } from "./types";

interface AnnotationToolbarProps {
  activeTool: DrawTool;
  onToolChange: (tool: DrawTool) => void;
  disabled?: boolean;
}

const TOOLS: { id: DrawTool; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "select",  label: "Select",  Icon: MousePointer2 },
  { id: "point",   label: "Point",   Icon: MapPin },
  { id: "line",    label: "Line",    Icon: Minus },
  { id: "polygon", label: "Polygon", Icon: Pentagon },
];

export function AnnotationToolbar({ activeTool, onToolChange, disabled }: AnnotationToolbarProps) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 rounded-lg border border-border bg-card/90 backdrop-blur-sm shadow-md p-1">
      {TOOLS.map(({ id, label, Icon }) => (
        <button
          key={id}
          title={label}
          disabled={disabled}
          onClick={() => onToolChange(id)}
          className={cn(
            "flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium transition-colors",
            activeTool === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
