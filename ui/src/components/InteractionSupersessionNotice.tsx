import { ArrowLeftRight, ArrowUpRight, Clock, TriangleAlert } from "lucide-react";
import type { IssueThreadInteraction } from "../lib/issue-thread-interactions";
import {
  buildSupersessionPointers,
  pendingConfirmationHazardPlacement,
  proseAnswerWarning,
  type SupersessionPointer,
} from "../lib/interaction-supersession-hazard";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * RBR-914 (AC4 of RBR-893). The multi-pending-confirmation hazard, rendered.
 *
 * Until this shipped, the only evidence that two contradictory irreversible confirmations were
 * sitting pending on the same task was a `console.warn` on the server — invisible to the person who
 * actually has to answer. Three things go on the card, and only when they apply:
 *
 *  1. Which of the coexisting pending confirmations is **newest** (AC1). Not "which wins" — the
 *     server deliberately does not pick a winner, and neither do we.
 *  2. What answering **in prose** will actually do (AC2), stated concretely rather than as generic
 *     caution, because a plain comment is not a safe way to answer one of several.
 *  3. The explicit `supersedesInteractionIds` / `supersededByInteractionId` pointer relationship
 *     (AC3), so nobody has to diff two payloads by eye to see that one ask replaced another.
 *
 * Presentation only. This component reads interaction rows the thread already loaded and never
 * resolves, expires, or reorders anything.
 */
export interface InteractionSupersessionNoticeProps {
  interaction: IssueThreadInteraction;
  /**
   * Every interaction the surrounding surface knows about for this task. Omitted (or a lone
   * interaction) means there is nothing to compare against and the notice renders nothing — a card
   * shown out of thread context must not imply it is the only pending ask.
   */
  threadInteractions?: readonly IssueThreadInteraction[];
  className?: string;
}

export function InteractionSupersessionNotice({
  interaction,
  threadInteractions,
  className,
}: InteractionSupersessionNoticeProps) {
  const siblings = threadInteractions ?? [];
  const placement = pendingConfirmationHazardPlacement(interaction, siblings);
  const pointers = buildSupersessionPointers(interaction, siblings);
  if (!placement && !pointers) return null;

  return (
    <div className={cn("mt-4 space-y-3", className)} data-testid="interaction-supersession-notice">
      {placement ? (
        <div
          className="rounded-sm border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
          data-testid="interaction-multi-pending-hazard"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow) text-amber-700 dark:text-amber-200">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              {placement.total} confirmations pending at once
            </span>
            {placement.hazard.newestIsAmbiguous ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="gap-1 border-amber-500/50 text-amber-800 dark:text-amber-100"
                    data-testid="interaction-newest-ambiguous-badge"
                  >
                    <Clock className="h-3 w-3" aria-hidden />
                    Newest unclear
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  The two most recent pending confirmations were created at the same moment, so
                  which one is newer cannot be established from the record. Nothing here guesses.
                </TooltipContent>
              </Tooltip>
            ) : placement.isNewest ? (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/50 text-amber-800 dark:text-amber-100"
                data-testid="interaction-newest-badge"
              >
                <Clock className="h-3 w-3" aria-hidden />
                Newest of {placement.total}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1 border-border text-muted-foreground"
                data-testid="interaction-not-newest-badge"
              >
                <Clock className="h-3 w-3" aria-hidden />
                Older — #{placement.position} of {placement.total}
              </Badge>
            )}
          </div>

          <p className="mt-2 leading-6" data-testid="interaction-prose-answer-warning">
            {proseAnswerWarning(placement.hazard)}
          </p>

          <p className="mt-2 text-xs leading-5 text-amber-800/90 dark:text-amber-100/80">
            Nothing was auto-expired. An agent must not be able to retire another agent's ask, and
            guessing which ask a reply answered is the failure this behaviour exists to prevent — so
            these confirmations can legitimately coexist and each one needs its own answer.
          </p>

          {placement.others.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs" data-testid="interaction-coexisting-list">
              {placement.others.map((other) => (
                <li key={other.id}>
                  <a
                    href={`#interaction-${other.id}`}
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                  >
                    {other.title?.trim() || "Confirmation request"}
                    <ArrowUpRight className="h-3 w-3" aria-hidden />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {pointers ? (
        <div
          className="rounded-sm border border-border/70 bg-muted/40 px-4 py-3 text-xs text-muted-foreground"
          data-testid="interaction-supersession-pointers"
        >
          <div className="inline-flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-eyebrow)">
            <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
            Supersession links
          </div>
          {pointers.replaces.length > 0 ? (
            <div className="mt-2" data-testid="interaction-supersedes-list">
              <div className="text-foreground">
                {pointers.replaces.length === 1
                  ? "This request explicitly replaces:"
                  : `This request explicitly replaces ${pointers.replaces.length} earlier requests:`}
              </div>
              <ul className="mt-1 space-y-1">
                {pointers.replaces.map((pointer) => (
                  <li key={pointer.id}>
                    <PointerRef pointer={pointer} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {pointers.replacedBy ? (
            <div className="mt-2" data-testid="interaction-superseded-by">
              <div className="text-foreground">This request was replaced by:</div>
              <div className="mt-1">
                <PointerRef pointer={pointers.replacedBy} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A named supersession target. Cross-issue links are legal server-side (same company), so the
 * target genuinely may not be on this task — in that case say so instead of rendering an anchor
 * that scrolls nowhere.
 */
function PointerRef({ pointer }: { pointer: SupersessionPointer }) {
  if (!pointer.href || !pointer.label) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1" data-testid="interaction-pointer-offthread">
        <span className="font-mono text-(length:--text-micro)">{pointer.id}</span>
        <span>— not on this task</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <a
        href={pointer.href}
        className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
      >
        {pointer.label}
        <ArrowUpRight className="h-3 w-3" aria-hidden />
      </a>
      {pointer.status ? (
        <Badge variant="outline" className="py-0 text-(length:--text-micro)">
          {pointer.status}
        </Badge>
      ) : null}
    </span>
  );
}
