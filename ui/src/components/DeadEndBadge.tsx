import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Row tint applied to the offending descendant in the Sub-tasks list so the dead-end leaf
 * reads as the place the chain died (P6 surface 1c). Kept as a shared const so the inbox row,
 * the detail breadcrumb, and the sub-tasks row stay in visual lockstep.
 */
export const DEAD_END_ROW_TINT = "border border-destructive/30 bg-destructive/10";

/**
 * The `× dead end` marker (P6 surfaces 1a/1b/1c). A red outline `Badge` naming the leaf where a
 * blocked chain stalled with no routable owner. Callers compose the text — the inbox row shows
 * `dead end · PAP-1234`, the breadcrumb shows `PAP-1234 · dead end` — so the content is a slot.
 */
export function DeadEndBadge({
  children = "dead end",
  className,
  title,
}: {
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      data-testid="dead-end-badge"
      title={title}
      className={cn(
        "max-w-full min-w-0 justify-start truncate font-medium",
        "border-destructive/40 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <X className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </Badge>
  );
}

export default DeadEndBadge;
