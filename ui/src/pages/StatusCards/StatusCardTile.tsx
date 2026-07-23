import { useMemo } from "react";
import type { SummarySlotIssueRef } from "@paperclipai/shared";
import { AlertTriangle, Loader2, MoreHorizontal, PauseCircle, RefreshCw } from "lucide-react";

import { MarkdownBody } from "@/components/MarkdownBody";
import { useSummaryDraftStream } from "@/components/useSummaryDraftStream";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, relativeTime } from "@/lib/utils";
import {
  deriveStatusCardLifecycle,
  describeRefreshPolicy,
  STATUS_CARD_LIFECYCLE_PRESENTATION,
} from "@/lib/status-card-state";
import { formatCents, formatTokens } from "./format";
import type { StatusCardView } from "./types";

export interface StatusCardTileProps {
  card: StatusCardView;
  companyId: string | null | undefined;
  onOpen: () => void;
  onRefresh: () => void;
  onEditInterest: () => void;
  onOpenDebug: () => void;
  onArchive: () => void;
  refreshPending?: boolean;
}

function StateDot({ className }: { className: string }) {
  return <span className={cn("mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} aria-hidden="true" />;
}

export function StatusCardTile({
  card,
  companyId,
  onOpen,
  onRefresh,
  onEditInterest,
  onOpenDebug,
  onArchive,
  refreshPending,
}: StatusCardTileProps) {
  const lifecycle = deriveStatusCardLifecycle(card);
  const presentation = STATUS_CARD_LIFECYCLE_PRESENTATION[lifecycle];

  // Stream the in-flight update into the delta banner (reuses the Summarizer
  // draft-stream machinery). Inert unless the card is actively updating.
  const generatingIssue = useMemo<SummarySlotIssueRef | null>(
    () =>
      lifecycle === "updating" && card.generatingIssueId
        ? { id: card.generatingIssueId, identifier: null, title: card.title ?? "Status update", status: "in_progress" }
        : null,
    [lifecycle, card.generatingIssueId, card.title],
  );
  const draftStream = useSummaryDraftStream(companyId, generatingIssue);

  const policyLabel = describeRefreshPolicy(card.refreshPolicy);
  const tokensLabel = formatTokens(card.todayTokens);
  const costLabel = formatCents(card.todayCostCents);
  const freshnessLabel = card.lastGeneratedAt ? relativeTime(card.lastGeneratedAt) : "no summary yet";
  const hasSummary = Boolean(card.summaryBody && card.summaryBody.trim().length > 0);

  return (
    <div
      className={cn(
        "group flex h-72 flex-col rounded-lg border border-border bg-card text-card-foreground transition-colors",
        presentation.dashedBorder && "border-dashed",
      )}
      data-testid="status-card-tile"
      data-lifecycle={lifecycle}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-4">
        {lifecycle === "compiling" ? null : <StateDot className={presentation.dotClassName} />}
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          title={card.title ?? card.interestPrompt}
        >
          <span
            className={cn(
              "line-clamp-1 text-sm font-semibold",
              lifecycle === "compiling" && "text-muted-foreground",
            )}
          >
            {card.title ?? "New card"}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="-mr-1 -mt-1 h-7 w-7 text-muted-foreground" aria-label="Card actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>Open detail</DropdownMenuItem>
            <DropdownMenuItem onSelect={onRefresh} disabled={refreshPending || lifecycle === "updating"}>
              Refresh now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEditInterest}>Edit interest &amp; settings</DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenDebug}>Query debug</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onArchive} variant="destructive">
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* State banner */}
      <div className="px-4 pt-2">
        {lifecycle === "compiling" ? (
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-foreground" role="status">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground" />
              <span>Agent is building your query…</span>
            </div>
            <p className="mt-1 line-clamp-2 text-muted-foreground">“{card.interestPrompt}”</p>
          </div>
        ) : null}

        {lifecycle === "updating" ? (
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-foreground" role="status" aria-live="polite">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              <span className="truncate" title={draftStream.statusLine ?? undefined}>
                {draftStream.statusLine
                  ?? (card.pendingChangeCount > 0
                    ? `Integrating ${card.pendingChangeCount} ${card.pendingChangeCount === 1 ? "change" : "changes"}…`
                    : "Updating now…")}
              </span>
            </div>
          </div>
        ) : null}

        {lifecycle === "stale" ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshPending}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-amber-500/10 disabled:opacity-60"
          >
            <span>
              {card.pendingChangeCount} {card.pendingChangeCount === 1 ? "change" : "changes"} since last update
            </span>
            <span className="shrink-0 font-medium text-amber-700 dark:text-amber-400">Refresh</span>
          </button>
        ) : null}

        {lifecycle === "error" ? (
          <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Last update failed
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <button type="button" onClick={onRefresh} disabled={refreshPending} className="font-medium text-destructive hover:underline disabled:opacity-60">
                Retry
              </button>
              <button type="button" onClick={onOpen} className="text-muted-foreground hover:underline">
                Details
              </button>
            </span>
          </div>
        ) : null}

        {lifecycle === "paused_budget" || lifecycle === "paused_hours" ? (
          <div className="flex items-center gap-2 rounded-md border border-orange-500/40 bg-orange-500/5 px-3 py-1.5 text-xs text-foreground">
            <PauseCircle className="h-3.5 w-3.5 shrink-0 text-orange-500" />
            <span>
              {lifecycle === "paused_budget"
                ? "Daily token cap reached — auto-updates paused"
                : "Outside active hours — auto-updates paused"}
            </span>
          </div>
        ) : null}
      </div>

      {/* Summary body — kept visible for stale/error/updating/paused (never blank) */}
      <div className="min-h-0 flex-1 overflow-hidden px-4 pt-2">
        {lifecycle === "error" && card.summaryBody ? (
          <p className="mb-1 text-(length:--text-micro) text-muted-foreground">Showing last good summary:</p>
        ) : null}
        {hasSummary ? (
          <MarkdownBody className="text-xs leading-6 text-foreground [&_p]:my-0.5">{card.summaryBody!}</MarkdownBody>
        ) : lifecycle === "compiling" ? (
          <p className="text-xs text-muted-foreground">
            You can add instructions and pick an update policy while this runs.
          </p>
        ) : lifecycle === "updating" && draftStream.draft ? (
          <MarkdownBody className="text-xs leading-6 text-foreground [&_p]:my-0.5">{draftStream.draft}</MarkdownBody>
        ) : (
          <p className="text-xs text-muted-foreground">No summary yet.</p>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <span className="truncate text-(length:--text-micro) text-muted-foreground">
          {lifecycle === "compiling" ? (
            "setting up · first summary pending"
          ) : (
            <>
              {freshnessLabel} · {policyLabel}
              {tokensLabel ? ` · ${tokensLabel}` : ""}
              {costLabel ? ` · ${costLabel}` : ""}
            </>
          )}
        </span>
        {/* Stale and error tiles already carry an inline Refresh/Retry action in
            their banner, so the footer icon is only shown for states that have
            no other refresh affordance (fresh + both paused states). */}
        {lifecycle === "fresh" || lifecycle === "paused_budget" || lifecycle === "paused_hours" ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={onRefresh}
            disabled={refreshPending}
            aria-label="Refresh card"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshPending && "animate-spin")} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
