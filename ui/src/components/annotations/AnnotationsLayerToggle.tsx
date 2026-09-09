import { Map } from "lucide-react";
import { cn } from "@/lib/utils";

interface AnnotationsLayerToggleProps {
  enabled: boolean;
  count: number;
  onToggle: () => void;
}

export function AnnotationsLayerToggle({ enabled, count, onToggle }: AnnotationsLayerToggleProps) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
        enabled
          ? "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
          : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      <Map className="h-3.5 w-3.5" />
      Annotations
      {enabled && count > 0 && (
        <span className="ml-1 rounded-full bg-amber-500/30 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
          {count}
        </span>
      )}
    </button>
  );
}
