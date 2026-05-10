import { cn } from "@/lib/utils";
import { ENTITY_TYPE_BG } from "@/lib/brain-utils";
import type { BrainEntityType } from "@/api/brain";

export function EntityTypeBadge({ type, className }: { type: BrainEntityType; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
        ENTITY_TYPE_BG[type] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {type}
    </span>
  );
}
