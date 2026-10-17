import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";
import type { CredentialMode } from "./ModelSourceTiles";
import { LINK_LABEL_FADE_IN, LINK_LABEL_FADE_OUT } from "./onboarding-motion";

/**
 * The credential-mode switch as a line of text instead of a checkbox — an
 * alternate for the connect step, not a replacement.
 *
 * The label names the destination rather than the state: "Use API key instead"
 * while on the subscription, "Use import from Claude config instead" once on API
 * keys. That is what makes a link work where a checkbox does not — a checkbox
 * can be ticked or not and reads the same either way, whereas a bare sentence
 * has to say what pressing it does. The consequence is that this control never
 * shows you where you are; the tiles' tags do that, and this alternate only
 * holds up because they are right above it.
 */

/** How each mode is named in that sentence. */
const MODE_NAME: Record<CredentialMode, string> = {
  subscription: "subscription",
  api: "API key",
  import: "import from Claude config",
};

/** The order the link walks. Wraps at both ends, whichever modes are offered. */
const MODE_ORDER: CredentialMode[] = ["subscription", "api", "import"];

/**
 * What a surface gets if it says nothing.
 *
 * The two that always existed, so a surface that has not opted in behaves exactly
 * as this control did before the import mode was drawn — same sentence, same
 * destination, same box width. A surface that offers the import mode asks for it.
 */
const DEFAULT_MODES: CredentialMode[] = ["subscription", "api"];

export function CredentialModeLink({
  mode,
  onChange,
  availableModes = DEFAULT_MODES,
}: {
  mode: CredentialMode;
  onChange: (next: CredentialMode) => void;
  /**
   * Which modes this surface offers, walked in `MODE_ORDER`. The import mode is
   * gated on the adapter and the instance (PRODUCT #3, #4), and a link that
   * walked to a mode the surface then refuses to draw would be a dead end.
   */
  availableModes?: CredentialMode[];
}) {
  const offered = availableModes.filter((entry) => MODE_ORDER.includes(entry));
  const ring = offered.length > 0 ? offered : MODE_ORDER;
  /** Where a press on the link goes while on `entry`: the next mode in the ring. */
  const destinationFor = (entry: CredentialMode) => {
    const at = ring.indexOf(entry);
    // A mode outside the offered set has nowhere to go but the start of the ring.
    return ring[(at + 1) % ring.length]!;
  };
  /**
   * The sentence this link shows while on `entry`.
   *
   * Derived rather than looked up per mode, because "where the next press goes"
   * is the thing being said and the ring is what decides it. Two modes can name
   * the same destination, and a mode can name a different one on a surface that
   * offers a third; neither is expressible as a fixed label per mode.
   */
  const labelFor = (entry: CredentialMode) =>
    `Use ${MODE_NAME[destinationFor(entry)]} instead`;
  const label = labelFor(mode);
  return (
    <button
      type="button"
      onClick={() => onChange(destinationFor(mode))}
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
        Every label this control can show, kept in the layout but out of sight, so
        the cell is as wide as the widest of them and the box never resizes
        mid-swap. `invisible` also takes them out of the accessibility tree,
        leaving the button's name to the one real label below.
      */}
      {ring.map((sizerMode) => (
        <span
          key={sizerMode}
          aria-hidden
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {labelFor(sizerMode)}
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
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
