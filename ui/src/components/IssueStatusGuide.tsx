import { useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import { StatusIcon } from "./StatusIcon";
import { issueStatusDescription } from "../lib/status-colors";
import { cn } from "../lib/utils";

const STATUS_ORDER = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Collapsed-by-default disclosure showing what each issue status means.
 * Goes at the bottom of the issues list so users who don't think to hover
 * status pills (or are on mobile, or use a keyboard) still have a discoverable
 * path to the taxonomy. Mirrors the descriptions surfaced on tooltip hover —
 * `issueStatusDescription` is the single source of truth.
 */
export function IssueStatusGuide({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-md border bg-card text-sm", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <HelpCircle className="h-3.5 w-3.5" />
        <span>What do these statuses mean?</span>
      </button>
      {open && (
        <ul className="divide-y border-t">
          {STATUS_ORDER.map((status) => (
            <li key={status} className="flex items-start gap-3 px-3 py-2">
              <span className="mt-0.5">
                <StatusIcon status={status} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{statusLabel(status)}</div>
                <div className="text-xs text-muted-foreground leading-snug mt-0.5">
                  {issueStatusDescription[status] ?? ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
