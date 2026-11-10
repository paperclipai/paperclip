import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";

/**
 * SIGNATURE ELEMENT 3 — the state mark.
 *
 * State never gets a coloured block. The chip is a hole punched in the slab
 * back to the page (`--tint-well`) with foreground text; the status hue lives
 * only in an 8px marker, and the marker's SHAPE carries the state too —
 *
 *   needs_review       open ring   "waiting on you"      --status-task-icon-in_review
 *   changes_requested  solid dot   "sent back"           --status-task-icon-blocked
 *
 * So a kind is a solid shape on the left and a state is a ring on the right:
 * different shape, different mass, opposite ends of the unit. The hues are
 * the app's status tokens, unchanged — and no kind uses violet, so the Review
 * ring is the only violet on any surface.
 *
 * Sizes: sm (22px, 10px text) wherever it rides a meta line; md (24px, 12px
 * text) where it stands alone. The label truncates before the pill can leave
 * its unit (a 260px pane). `StateDot` is the marker alone: section tallies
 * and the Review chip in the panel.
 */

const STATES = {
  needs_review: { label: "Review", marker: "border-2 border-(--status-task-icon-in_review)" },
  changes_requested: { label: "Changes requested", marker: "bg-(--status-task-icon-blocked)" },
} as const;

// Line-height after the size: tailwind-merge drops a leading that precedes a font size.
const SIZES = {
  sm: "gap-1.5 py-1.5 pl-2 pr-2.5 text-(length:--text-nano) leading-none",
  md: "gap-1.5 py-1.5 pl-2 pr-2.5 text-xs leading-none",
} as const;

export function StateMark({
  review,
  size = "sm",
  className,
}: {
  review: LabArtifact["review"];
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (!review) return null;
  const state = STATES[review];
  return (
    <span
      data-state={review}
      className={cn("inline-flex min-w-0 max-w-full shrink-0 items-center rounded-full bg-(--tint-well) font-medium text-foreground", SIZES[size], className)}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", state.marker)} />
      <span className="truncate">{state.label}</span>
    </span>
  );
}

/** The marker alone, for places too small for the word (the caller supplies the accessible text). */
export function StateDot({ review, className }: { review: LabArtifact["review"]; className?: string }) {
  if (!review) return null;
  return <span aria-hidden data-state={review} className={cn("block size-2 shrink-0 rounded-full", STATES[review].marker, className)} />;
}

/**
 * "N to review": the ring and a count, for a heading that holds several
 * artifacts — a panel section, a folder's pocket, an opened stack's caption.
 */
export function ReviewTally({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <p data-tally className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium leading-4 text-foreground", className)}>
      <StateDot review="needs_review" />
      <span>
        <span className="font-mono text-(length:--text-micro)">{count}</span> to review
      </span>
    </p>
  );
}
