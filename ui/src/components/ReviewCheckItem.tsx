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
  const hasScreenshots = ((check.details as Record<string, unknown>)?.screenshots as string[] ?? []).length > 0;
  const [open, setOpen] = useState(hasScreenshots);
  const config = statusConfig[check.status] ?? statusConfig.pending;
  const Icon = config.icon;
  const screenshots: string[] = (check.details as Record<string, unknown>)?.screenshots as string[] ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50">
        <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
        <span className="flex-1 text-left font-medium">{check.stepName}</span>
        <Badge variant="outline" className="text-xs">{check.executor}</Badge>
        <span className="text-xs text-muted-foreground">{config.label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-10 pb-2 space-y-3">
        {check.summary && <p className="text-sm text-muted-foreground">{check.summary}</p>}
        {screenshots.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">스크린샷 ({screenshots.length})</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {screenshots.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-border hover:border-foreground/30 transition-colors">
                  <img src={url} alt={`Screenshot ${i + 1}`} className="w-full h-auto object-contain bg-muted" loading="lazy" />
                </a>
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
