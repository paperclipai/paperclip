import type { AgentPreset } from "@paperclipai/shared";
import { AgentIcon } from "./AgentIconPicker";
import { adapterLabels } from "./agent-config-primitives";
import { cn } from "../lib/utils";

interface AgentPresetCardProps {
  preset: AgentPreset;
  onSelect: (preset: AgentPreset) => void;
  selected?: boolean;
}

export function AgentPresetCard({ preset, onSelect, selected }: AgentPresetCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(preset)}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-all hover:bg-accent/50 hover:border-foreground/20",
        selected
          ? "border-foreground/30 bg-accent/60 ring-1 ring-foreground/10"
          : "border-border"
      )}
    >
      <div className="flex items-center gap-2">
        <AgentIcon icon={preset.icon} className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{preset.name}</span>
      </div>
      <span className="text-xs text-muted-foreground line-clamp-1">
        {preset.description}
      </span>
      <span className="text-[10px] font-medium text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
        {adapterLabels[preset.adapterType] ?? preset.adapterType}
      </span>
    </button>
  );
}
