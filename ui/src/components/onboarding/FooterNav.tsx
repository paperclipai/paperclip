import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

import { Button } from "../ui/button";
import { CTA_LABEL_IN, CTA_WIDTH } from "./onboarding-motion";

/** What sits after the primary label. */
export type FooterPrimaryIcon = "arrow" | "spinner" | "none";

/**
 * Shared footer for the arc's step cards: a ghost pill "Back" and a primary
 * pill CTA that shows a spinner and a loading label while its action runs.
 *
 * `onBack` is optional — a run that entered on this step has nowhere behind it
 * to return to, and an inert Back button reads as a dead control rather than a
 * boundary.
 *
 * The primary button animates between labels rather than swapping them. The
 * connect step walks it through four ("Next" → "Sign in to Claude" → "Waiting
 * for code" → "Connecting"), which are very different widths, and a control
 * that changes size instantly reads as a different control appearing. See
 * `CTA_WIDTH` and `CTA_LABEL_*` for why the two halves are timed apart.
 */
export function FooterNav({
  onBack,
  primaryLabel,
  primaryDisabled,
  loading,
  loadingLabel,
  primaryIcon,
  onPrimary,
}: {
  onBack?: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  /**
   * Defaults to the loading state's own reading — spinner while loading, arrow
   * otherwise — so callers that predate this prop are unchanged. The connect
   * step sets it directly, because "Sign in to Claude" carries no icon while
   * "Waiting for code" carries a spinner without the step being `loading`: it
   * is waiting on another tab, not working.
   */
  primaryIcon?: FooterPrimaryIcon;
  onPrimary: () => void;
}) {
  const label = loading && loadingLabel ? loadingLabel : primaryLabel;
  const icon: FooterPrimaryIcon = primaryIcon ?? (loading ? "spinner" : "arrow");

  return (
    <div className="flex items-center justify-between pt-9">
      {onBack ? (
        // Same size as the primary, not a tier down. Back is ghost until you
        // point at it, and a shorter pill made the hover surface read as a
        // different kind of control sitting slightly low in the row rather than
        // the other half of a pair.
        //
        // The padding stays asymmetric against size="lg"'s symmetric px-4: the
        // arrow needs less room on its side than the word does on its own.
        <Button
          variant="ghost"
          size="lg"
          className="rounded-full has-[>svg]:pl-4 has-[>svg]:pr-5"
          onClick={onBack}
          disabled={loading}
        >
          <ArrowLeft className="mr-1 size-3.5" />
          Back
        </Button>
      ) : (
        <span />
      )}
      {/*
        `layout` on the button and `popLayout` on its contents are what make the
        width ease rather than jump: the outgoing label leaves the flow at once,
        so the button's target width becomes the incoming label's, and the
        layout animation carries it there while the words cross-fade in place.

        Without `popLayout` the two labels would briefly sit side by side and
        the button would widen to hold both before shrinking back.
      */}
      <motion.div layout transition={CTA_WIDTH} className="min-w-0">
        <Button
          size="lg"
          className="w-full rounded-full px-6"
          onClick={onPrimary}
          disabled={primaryDisabled || loading}
        >
          {/*
            One label in the DOM at a time, keyed so a change remounts it and it
            fades in over the width easing underneath.

            Deliberately not a cross-fade through `AnimatePresence`. That keeps
            the outgoing label mounted while it leaves, which puts two words
            inside one button: the accessible name becomes "NextConnect", and
            anything reading the button's text — including this repo's own step
            tests — sees both. It is also fragile, since an exit that never
            resolves never unmounts.

            The width carries the elegance here. The word arriving over a shape
            that is still easing reads as one control changing rather than two
            labels trading places, which is what the cross-fade was for.
          */}
          <motion.span
            key={`${label}:${icon}`}
            className="flex items-center whitespace-nowrap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={CTA_LABEL_IN}
          >
            {icon === "spinner" ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            {label}
            {icon === "arrow" ? <ArrowRight className="ml-1 size-3.5" /> : null}
          </motion.span>
        </Button>
      </motion.div>
    </div>
  );
}
