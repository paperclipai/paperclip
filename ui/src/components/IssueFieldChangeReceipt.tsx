import { ArrowRight, ShieldCheck } from "lucide-react";
import type { ActivityEvent } from "@paperclipai/shared";
import {
  issueAuthorizationReasonLabel,
  readIssueChangeReceipt,
} from "../lib/issue-change-receipt";
import { cn } from "../lib/utils";

/**
 * Field-level audit receipt under an `issue.updated` row in the activity stream
 * (the open cross-task write design (audit) — Dotta's hard requirement).
 *
 * Opening cross-issue writes means a task's fields can be changed by an agent
 * that does not own it. The board's answer to "who moved this, and were they
 * allowed to?" must be visible on the task itself, not only in the audit log —
 * so every PATCH, agent *and* human, shows what changed, the responsible user
 * behind it, and the authorization reason that let it through.
 *
 * Renders nothing when the event carries no receipt, so pre-receipt activity
 * rows are unaffected.
 */
export function IssueFieldChangeReceipt({
  event,
  resolveAgentLabel,
  resolveUserLabel,
  className,
}: {
  event: Pick<ActivityEvent, "action" | "details" | "responsibleUserId">;
  resolveAgentLabel?: (agentId: string) => string | null | undefined;
  resolveUserLabel?: (userId: string) => string | null | undefined;
  className?: string;
}) {
  const rows = readIssueChangeReceipt(event.details, { resolveAgentLabel, resolveUserLabel });
  const reason = issueAuthorizationReasonLabel(
    typeof event.details?.authorizationReason === "string"
      ? event.details.authorizationReason
      : null,
  );
  const responsibleUserName = event.responsibleUserId
    ? resolveUserLabel?.(event.responsibleUserId) ?? null
    : null;

  if (rows.length === 0 && !reason) return null;

  return (
    <div
      data-testid="issue-field-change-receipt"
      className={cn("space-y-1 border-l-2 border-border/70 pl-2", className)}
    >
      {rows.length > 0 ? (
        <dl className="space-y-0.5">
          {rows.map((row) => (
            <div
              key={row.field}
              data-testid={`issue-change-row-${row.field}`}
              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs"
            >
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <span className="min-w-0 break-words text-muted-foreground line-through decoration-muted-foreground/50">
                  {row.from}
                </span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <span className="min-w-0 break-words font-medium text-foreground">{row.to}</span>
                {/* Long text is stored as a preview, so the receipt says so
                    rather than implying the whole value is shown. */}
                {row.truncated ? (
                  <span className="text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                    preview
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {reason ? (
        // Inline flow, not flex: as separate flex items the icon wraps onto its
        // own line and orphans above the reason at narrow widths. Inline keeps it
        // glued to the first word.
        <p className="min-w-0 text-(length:--text-micro) leading-4 text-muted-foreground">
          <ShieldCheck
            className="mr-1 inline size-3 align-(--va-0_125em)"
            aria-hidden="true"
          />
          {responsibleUserName ? (
            <>
              for <span className="text-foreground">{responsibleUserName}</span>
              {" · "}
            </>
          ) : null}
          authorized by {reason}
        </p>
      ) : null}
    </div>
  );
}
