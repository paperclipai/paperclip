import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../kit";
import { MOTION, SLAB_FILL, SLAB_JOINTS } from "./slab";

/**
 * The state marker: the only chroma in the direction, and only a 6px dot of
 * it, followed by the production label in foreground text.
 *
 * On a slab it has no fill of its own — dot and label sit straight on the
 * slab, so it can never be taken for the button next to it. On a gallery
 * preview it is written in a BITE the slab takes out of the preview's
 * bottom-right corner, the mirror of the ink kind tab in the bottom-left: what
 * it is on the left, what it needs on the right.
 *
 * Nothing renders for an artifact with no pending state, as in the product.
 */

/** The one state vocabulary: label and dot fill per state. Counts.tsx counts in the same dots. */
export const STATE = {
  needs_review: { label: "Review", dot: "bg-(--solid-state-review)" },
  changes_requested: { label: "Changes requested", dot: "bg-(--solid-state-changes)" },
} as const;

export function StateDot({ state, className }: { state: keyof typeof STATE; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", STATE[state].dot, className)} />;
}

/**
 * A bite out of a preview's bottom-right corner, in the slab's own fill (it
 * follows the slab's hover). The state marker uses it in the gallery; so does
 * a stack mosaic's "+18". The parent must be `relative overflow-hidden`.
 *
 * It is cut, not laid on: where the bite meets the preview's right and bottom
 * edges, two 6px joints (its pseudo-elements) round the preview's new corners
 * to the set's one radius — the slab painted into the corner outside a
 * quarter circle (--solid-joint).
 */
export const CORNER_NOTCH = cn(
  "absolute right-0 bottom-0 rounded-tl-md",
  SLAB_FILL,
  MOTION,
  // The joint above the bite, on the preview's right edge; and the one beside it, on the bottom edge.
  "before:absolute before:right-0 before:bottom-full before:size-1.5 before:rounded-br-md before:shadow-(--solid-joint)",
  "after:absolute after:right-full after:bottom-0 after:size-1.5 after:rounded-br-md after:shadow-(--solid-joint)",
  SLAB_JOINTS,
);

export function StateMarker({
  review,
  on = "slab",
  collapse = false,
  className,
}: {
  review: LabArtifact["review"];
  /** `slab`: dot and label on the slab. `corner`: in a bite out of a preview's bottom-right corner. */
  on?: "slab" | "corner";
  /** Inside an `@container` narrower than 36rem, show only the dot (the label stays for screen readers). */
  collapse?: boolean;
  className?: string;
}) {
  if (!review) return null;
  return (
    <span
      data-state={review}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-(length:--text-micro) font-medium leading-none whitespace-nowrap text-foreground",
        on === "corner" ? cn(CORNER_NOTCH, "h-6 px-2") : null,
        className,
      )}
    >
      <StateDot state={review} />
      <span className={collapse ? "sr-only @xl:not-sr-only" : undefined}>{STATE[review].label}</span>
    </span>
  );
}
