import { Lock } from "lucide-react";
import type { IssueLockedStub } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * Existence-only chip for a private issue referenced from a surface the current
 * viewer *can* see (a visible blocker/relation edge, or a mention in a visible
 * comment). Renders the mono identifier + a lock icon and nothing else — no
 * title ever leaks, and the chip is intentionally non-interactive (a private
 * issue 404s on direct fetch, so there is nowhere to link to).
 *
 * Feed it the exact `{ id, identifier, locked: true }` stub the server emits in
 * place of an `IssueRelationIssueSummary`; use `isLockedIssueStub` to branch.
 */
export function isLockedIssueStub(value: unknown): value is IssueLockedStub {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { locked?: unknown }).locked === true
  );
}

export function LockedIssueChip({
  identifier,
  className,
}: {
  identifier: string | null;
  className?: string;
}) {
  // Identifier is the only viewer-safe field on the stub. When the server
  // withheld even that, fall back to a neutral "Private" label so the chip
  // still reads as a locked reference rather than an empty box.
  const label = identifier ?? "Private";
  return (
    <span
      data-testid="locked-issue-chip"
      aria-label={`${label} — private, you don't have access`}
      className={cn(
        "inline-flex shrink-0 select-none items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5",
        "font-mono text-(length:--text-nano) leading-tight text-muted-foreground sm:text-(length:--text-micro)",
        className,
      )}
    >
      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
