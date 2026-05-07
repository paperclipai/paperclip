import { ExternalLink } from "lucide-react";
import type { ExecutionWorkspacePullRequestRecord } from "@paperclipai/shared";
import { Badge } from "./ui/badge";
import { cn, formatDateTime } from "../lib/utils";

type Variant = "default" | "secondary" | "outline" | "destructive";

const STATUS_VARIANT: Record<ExecutionWorkspacePullRequestRecord["status"], Variant> = {
  requested: "secondary",
  opened: "default",
  merged: "default",
  failed: "destructive",
  skipped: "outline",
};

const STATUS_LABEL: Record<ExecutionWorkspacePullRequestRecord["status"], string> = {
  requested: "PR requested",
  opened: "PR opened",
  merged: "PR merged",
  failed: "PR failed",
  skipped: "PR skipped",
};

export function ExecutionWorkspacePullRequestBadge({
  record,
  className,
}: {
  record: ExecutionWorkspacePullRequestRecord;
  className?: string;
}) {
  const variant = STATUS_VARIANT[record.status];
  const label = STATUS_LABEL[record.status];
  const modeLabel = record.mode === "blocking" ? "blocking" : "fire-and-forget";
  const requestedLabel = record.requestedAt ? formatDateTime(record.requestedAt) : "—";
  const tooltip = [
    `Mode: ${modeLabel}`,
    `Requested: ${requestedLabel}`,
    ...(record.error ? [`Error: ${record.error}`] : []),
  ].join(" · ");

  const commonProps = {
    className: cn(
      "gap-1",
      record.error ? "ring-1 ring-destructive/60" : "",
      className,
    ),
    title: tooltip,
    "data-testid": "execution-workspace-pull-request-badge",
    "data-status": record.status,
    "data-mode": record.mode,
  };

  if (record.url) {
    return (
      <Badge asChild variant={variant} {...commonProps}>
        <a href={record.url} target="_blank" rel="noreferrer noopener">
          <ExternalLink className="h-3 w-3 shrink-0" />
          {label}
        </a>
      </Badge>
    );
  }

  return (
    <Badge variant={variant} {...commonProps}>
      {label}
    </Badge>
  );
}
