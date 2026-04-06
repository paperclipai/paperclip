import { Link } from "@/lib/router";
import { DeliverableStatusBadge, DeliverablePriorityBadge } from "./DeliverableStatusBadge";
import { cn } from "@/lib/utils";
import {
  FileText,
  Clock,
  User,
  Bot,
  Code2,
  Rocket,
  Package,
  ChevronRight,
  Layers,
} from "lucide-react";
import type { Deliverable } from "../api/deliverables";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const TYPE_ICONS: Record<string, typeof FileText> = {
  code: Code2,
  document: FileText,
  deployment: Rocket,
  mixed: Package,
};

const TYPE_COLORS: Record<string, string> = {
  code: "bg-[var(--primary)]/15 text-[var(--primary)]",
  document: "bg-[var(--primary)]/15 text-[var(--primary)]",
  deployment: "bg-[var(--status-warning)]/15 text-[var(--status-warning)]",
  mixed: "bg-muted/50 text-muted-foreground",
};

export function DeliverableCard({ deliverable }: { deliverable: Deliverable }) {
  const stageCount = deliverable.stages?.length ?? 0;
  const approvedStages = deliverable.stages?.filter((s) => s.status === "approved").length ?? 0;
  const hasStages = stageCount > 0;
  const contentCount = deliverable.contents?.length ?? 0;
  const TypeIcon = TYPE_ICONS[deliverable.type] ?? Package;
  const typeColor = TYPE_COLORS[deliverable.type] ?? TYPE_COLORS.mixed;
  const stageProgress = hasStages ? (approvedStages / stageCount) * 100 : 0;

  return (
    <Link
      to={`/deliverables/${deliverable.id}`}
      className={cn(
        "group block rounded-[2px] border bg-card p-4 transition-all duration-200",
        "hover:border-primary/30 hover:shadow-md hover:shadow-primary/5",
        "hover:-translate-y-[1px]",
        deliverable.status === "in_review" && "border-[var(--primary)]/30",
        deliverable.status === "changes_requested" && "border-[var(--status-warning)]/30",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div className={cn("flex items-center justify-center h-9 w-9 rounded-[2px] shrink-0", typeColor)}>
          <TypeIcon className="h-4.5 w-4.5" />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
              {deliverable.title}
            </h3>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          {deliverable.description && (
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{deliverable.description}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DeliverableStatusBadge status={deliverable.status} />
            <DeliverablePriorityBadge priority={deliverable.priority} />

            {/* Stage progress bar */}
            {hasStages && (
              <div className="flex items-center gap-1.5">
                <Layers className="h-3 w-3 text-muted-foreground/60" />
                <div className="flex items-center gap-1">
                  <div className="w-16 h-1.5 rounded-[2px] bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-[2px] bg-[var(--status-active)] transition-all duration-500"
                      style={{ width: `${stageProgress}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {approvedStages}/{stageCount}
                  </span>
                </div>
              </div>
            )}

            {contentCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <FileText className="h-3 w-3" />
                {contentCount} file{contentCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Right metadata */}
        <div className="flex flex-col items-end gap-1 shrink-0 text-[10px] text-muted-foreground">
          {deliverable.submittedByAgentId && (
            <span className="inline-flex items-center gap-0.5 rounded-[2px] bg-[var(--primary)]/15 text-[var(--primary)] px-1.5 py-0.5">
              <Bot className="h-3 w-3" /> Agent
            </span>
          )}
          {deliverable.submittedByUserId && !deliverable.submittedByAgentId && (
            <span className="inline-flex items-center gap-0.5 rounded-[2px] bg-[var(--primary)]/15 text-[var(--primary)] px-1.5 py-0.5">
              <User className="h-3 w-3" /> User
            </span>
          )}
          {deliverable.dueAt && (
            <span className="inline-flex items-center gap-0.5">
              <Clock className="h-3 w-3" /> {formatDate(deliverable.dueAt)}
            </span>
          )}
          <span className="text-muted-foreground/50">
            {formatDate(deliverable.createdAt)}
          </span>
        </div>
      </div>
    </Link>
  );
}
