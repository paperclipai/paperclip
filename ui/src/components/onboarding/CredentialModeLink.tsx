import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";
import type { CredentialMode } from "./ModelSourceTiles";
import { LINK_LABEL_FADE_IN, LINK_LABEL_FADE_OUT } from "./onboarding-motion";

/**
 * The credential-mode switch as a line of text instead of a checkbox — an
 * alternate for the connect step, not a replacement.
 *
 * The label names the destination rather than the state: "Use API keys
 * instead" while on the subscription, "Use subscription instead" once on API
 * keys. That is what makes a link work where a checkbox does not — a checkbox
 * can be ticked or not and reads the same either way, whereas a bare sentence
 * has to say what pressing it does. The consequence is that this control never
 * shows you where you are; the tiles' tags do that, and this alternate only
 * holds up because they are right above it.
 */

const LINK_LABEL: Record<CredentialMode, string> = {
  subscription: "Use API keys instead",
  api: "Use subscription instead",
};

const OTHER_MODE: Record<CredentialMode, CredentialMode> = {
  subscription: "api",
  api: "subscription",
};

export function CredentialModeLink({
  mode,
  onChange,
}: {
  mode: CredentialMode;
  onChange: (next: CredentialMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(OTHER_MODE[mode])}
      className={cn(
        // A grid rather than a flow of text, so both labels can occupy one cell
        // and overlap during the swap. Same padding as the checkbox row this
        // stands in for, so switching between the two alternates moves nothing
        // else on the step.
        "group grid cursor-pointer px-3 py-2 text-left text-sm font-medium",
        "rounded-md outline-none focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
      )}
    >
      {/*
        Both labels, kept in the layout but out of sight, so the cell is as wide
        as the wider of the two and the box never resizes mid-swap. `invisible`
        also takes them out of the accessibility tree, leaving the button's name
        to the one real label below.
      */}
      {(Object.keys(LINK_LABEL) as CredentialMode[]).map((sizerMode) => (
        <span
          key={sizerMode}
          aria-hidden
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {LINK_LABEL[sizerMode]}
        </span>
      ))}

      <AnimatePresence initial={false} mode="sync">
        <motion.span
          key={mode}
          // Left-aligned in that max-width cell, so the sentence starts at the
          // same x in both states and only its tail changes.
          className={cn(
            "col-start-1 row-start-1 justify-self-start whitespace-nowrap",
            // The underline sits on the label, never on the button: the button
            // is as wide as the longer sentence, so an underline there would
            // run past the end of the shorter one.
            "underline decoration-muted-foreground/40 underline-offset-4",
            "text-muted-foreground transition-colors",
            "group-hover:text-foreground group-hover:decoration-foreground/40",
          )}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: LINK_LABEL_FADE_IN }}
          exit={{ opacity: 0, transition: LINK_LABEL_FADE_OUT }}
        >
          {LINK_LABEL[mode]}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
