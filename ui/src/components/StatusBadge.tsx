import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { GlyphRing } from "./NothingAesthetic";

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "blocked" || status === "failed" || status === "error"
      ? "danger"
      : status === "running" || status === "in_progress" || status === "in_review"
        ? "live"
        : status === "done" || status === "succeeded"
          ? "success"
          : status === "paused" || status === "backlog"
            ? "muted"
            : "default";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      <GlyphRing
        tone={tone}
        active={tone === "live"}
        complete={tone === "success"}
        broken={tone === "danger"}
        className="h-3.5 w-3.5"
      />
      {status.replace(/_/g, " ")}
    </span>
  );
}
