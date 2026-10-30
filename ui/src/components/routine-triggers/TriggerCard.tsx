import { useId, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RoutineTriggerCard({
  kind,
  icon,
  title,
  summary,
  expanded,
  onEdit,
  onRemove,
  editLabel,
  children,
}: {
  kind: "schedule" | "webhook" | "api";
  icon: ReactNode;
  title: string;
  summary: string;
  expanded: boolean;
  onEdit: () => void;
  editLabel?: string;
  onRemove: () => void;
  children: ReactNode;
}) {
  const editorId = useId();
  return (
    <section
      aria-label={`${kind === "schedule" ? "Schedule" : kind === "api" ? "API" : "Webhook"} trigger`}
      className="rounded-md border border-border"
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={editorId}
            onClick={onEdit}
          >
            {editLabel ?? (expanded ? "Close" : `Edit ${kind}`)}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${kind}`}
            title={`Remove ${kind}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {expanded && (
        <div id={editorId} className="space-y-5 border-t border-border p-4">
          {children}
        </div>
      )}
    </section>
  );
}
