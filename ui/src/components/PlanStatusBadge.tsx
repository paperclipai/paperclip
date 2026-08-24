import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PlanDocumentStatus } from "@paperclipai/shared";

const planStatusStyles: Record<PlanDocumentStatus, string> = {
  draft: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  in_review: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  approved: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  superseded: "bg-muted-foreground/10 text-muted-foreground border-muted-foreground/20",
};

const planStatusLabels: Record<PlanDocumentStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  approved: "Approved",
  superseded: "Superseded",
};

export function PlanStatusBadge({
  status,
  className,
}: {
  status: PlanDocumentStatus;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(planStatusStyles[status] ?? planStatusStyles.draft, className)}
    >
      {planStatusLabels[status] ?? status}
    </Badge>
  );
}