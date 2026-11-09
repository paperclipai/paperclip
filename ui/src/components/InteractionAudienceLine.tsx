import { Users } from "lucide-react";
import type { InteractionAudienceDescription } from "../lib/interaction-audience";
import { cn } from "../lib/utils";

/**
 * Who may resolve an interaction, stated before anyone acts.
 *
 * One component for both surfaces that ask for a decision: the full
 * issue-thread card (`variant="card"`) and a collapsed attention row sitting
 * directly above compact Accept/Reject buttons (`variant="compact"`,
 * PAP-17287). The compact form trades the full sentence for a glanceable clause
 * and hands the long form to the title attribute, so the two surfaces can never
 * describe the same policy differently.
 *
 * Presentation only: the description is derived from the server's evaluated
 * audience, and nothing here enables or disables a control. The resolution
 * routes re-check authority at use time.
 */
export function InteractionAudienceLine({
  audience,
  variant = "card",
  className,
}: {
  audience: InteractionAudienceDescription;
  variant?: "card" | "compact";
  className?: string;
}) {
  const compact = variant === "compact";
  return (
    <div
      className={cn(
        "flex items-start gap-2 text-xs leading-5 text-muted-foreground",
        compact ? "min-w-0" : "max-w-3xl",
        className,
      )}
      data-testid="interaction-audience"
      data-audience-policy={audience.policy}
      data-audience-open={audience.isOpen ? "true" : "false"}
      data-audience-variant={variant}
      title={compact
        ? [audience.summary, audience.narrowedNote].filter(Boolean).join(" ")
        : undefined}
    >
      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {/* The clause names an agent, and an agent name is one unbreakable word.
          Without a break the row's `overflow-hidden` shell cuts it mid-word with
          no ellipsis, so a reader sees a plausible but *wrong* responder
          ("Only ReleaseEngineeringPlatformCoordin") and nothing signals the
          truncation. Wrapping is the only safe failure mode for a sentence whose
          whole job is to name who may act (PAP-17289). */}
      <div className="min-w-0 break-words">
        {/* The compact form drops the policy badge: its clause already names the
            responder, and "Anyone — Anyone can respond" spends a scarce line on
            saying one thing twice. The badge stays on the card, where the longer
            sentence needs a heading. */}
        {compact ? null : (
          <>
            <span className="font-medium text-foreground">{audience.label}</span>
            {" — "}
          </>
        )}
        <span data-testid="interaction-audience-summary">
          {compact ? audience.shortSummary : audience.summary}
        </span>
        {/* The reason an audience is narrower than the requester asked for is
            worth a sentence on the card. A collapsed row keeps it in the title
            and shows it in full once the row expands. */}
        {!compact && audience.narrowedNote ? (
          <span className="block" data-testid="interaction-audience-note">
            {audience.narrowedNote}
          </span>
        ) : null}
      </div>
    </div>
  );
}
