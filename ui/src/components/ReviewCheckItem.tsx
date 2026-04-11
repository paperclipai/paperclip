import { CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { useState } from "react";
import type { ReviewCheck } from "../api/reviewPipeline";

const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  passed: { icon: CheckCircle2, color: "text-green-500", label: "passed" },
  failed: { icon: XCircle, color: "text-red-500", label: "failed" },
  running: { icon: Loader2, color: "text-blue-500 animate-spin", label: "running" },
  pending: { icon: Clock, color: "text-muted-foreground", label: "pending" },
  skipped: { icon: Clock, color: "text-muted-foreground", label: "skipped" },
};

export function ReviewCheckItem({ check }: { check: ReviewCheck }) {
  const [open, setOpen] = useState(false);
  const config = statusConfig[check.status] ?? statusConfig.pending;
  const Icon = config.icon;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50">
        <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
        <span className="flex-1 text-left font-medium">{check.stepName}</span>
        <Badge variant="outline" className="text-xs">{check.executor}</Badge>
        <span className="text-xs text-muted-foreground">{config.label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-10 pb-2">
        {check.summary && <p className="text-sm text-muted-foreground">{check.summary}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}
