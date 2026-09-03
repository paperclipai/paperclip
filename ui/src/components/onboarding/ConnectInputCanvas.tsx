import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";
import {
  CANVAS_CONTENT_ENTER,
  CANVAS_ENTER_TRAVEL,
  CANVAS_CONTENT_EXIT,
  CANVAS_CONTENT_TRAVEL,
} from "./onboarding-motion";

/**
 * The connect step's input surface: one card that holds whatever the current
 * choice needs, rather than a different control appearing in a different place
 * for each combination.
 *
 * There are four things it can hold — a browser-code login for Claude, a
 * displayed-code login for Codex, and an API key field for either — and they are
 * not the same shape or the same height. Giving each its own slot would move the
 * Connect button every time the choice changed. One canvas that resizes keeps
 * the step's furniture still and makes the card read as the answer to the tile
 * above it.
 *
 * It is closed until a source is picked. An empty card under an untouched row of
 * tiles is a box asking to be filled with nothing.
 */

/** Three lines of body text, so a short prompt and a long one open the same card. */
const MIN_CONTENT_HEIGHT = 66;

export function ConnectInputCanvas({
  open,
  contentKey,
  children,
}: {
  open: boolean;
  /**
   * Identity of what is inside, and what the swap animates between. The source
   * and the credential mode together, because either one changing means a
   * different input is needed.
   */
  contentKey: string;
  children: ReactNode;
}) {
  if (!open) return null;

  /*
    No edge and no fill of its own. Everything this holds already draws its own
    surface — the login panel is a bordered, filled card, the key field a
    bordered input — so a frame here was the same treatment twice, one nested a
    few pixels inside the other. The canvas is a place for the input to be, not
    a thing to look at.

    Which leaves the padding to the contents as well: theirs is already sized
    for what they hold, and a second inset would push it off the step's measure.

    The wrapper animates its arrival and nothing else. Picking a source is what
    brings this into being, so it descends into place rather than appearing
    already there — the movement is what ties it to the tile just pressed.

    Opacity and transform only. An earlier version animated *height* here with
    `overflow: hidden`, and stalled three separate times — once leaving the login
    card rendered inside a two-pixel box, once at four percent opacity while
    `open` was true throughout. The casualty each time was the OAuth URL a
    customer has to click. A height that is measured once cannot hold a panel
    that grows when a login starts; these two properties can, because neither
    clips and neither is measured.
  */
  return (
    <motion.div
      className="mt-5 flex items-center"
      style={{ minHeight: MIN_CONTENT_HEIGHT }}
      initial={{ opacity: 0, y: -CANVAS_ENTER_TRAVEL }}
      animate={{ opacity: 1, y: 0, transition: CANVAS_CONTENT_ENTER }}
    >
      {/*
        `popLayout`, so the leaving input is taken out of flow while it animates
        and the arriving one decides the card's height on its own. The default
        mode would stack them and jump the card to the sum of both mid-swap.

        Not `mode="wait"`: it will not mount the next child until the previous
        reports its exit finished, that report never came here, and the swap
        stalled into an instant change with no transition at all.
      */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={contentKey}
          className="w-full"
          initial={{ opacity: 0, y: CANVAS_CONTENT_TRAVEL }}
          animate={{ opacity: 1, y: 0, transition: CANVAS_CONTENT_ENTER }}
          exit={{
            opacity: 0,
            y: CANVAS_CONTENT_TRAVEL,
            transition: CANVAS_CONTENT_EXIT,
          }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * The API key field, for when the credential mode is keys rather than a
 * subscription.
 *
 * Built to the login panel's shape on purpose: same card, same padding, same
 * label-left / control-right row, same 28px control height. These two are
 * alternatives to each other — one canvas shows one or the other, and the
 * credential switch above trades between them — so they should read as two
 * answers to one question rather than as two different kinds of thing. Before
 * this the key field was a stacked label over a full-width input with no card
 * at all, and flipping the mode changed the shape of the step rather than its
 * content.
 *
 * The variable name is the label rather than a sentence about it. Someone
 * pasting a key knows which one they are holding; what they cannot know is where
 * this step will put it, and the name answers that in the place it is asked —
 * while staying short enough to sit opposite the field the way "Sign in to the
 * environment" sits opposite its button.
 */
export function ApiKeyField({
  envKey,
  value,
  onChange,
}: {
  envKey: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount, because the canvas only opens when this is the thing that
  // was asked for. Layout effect so it happens before paint rather than as a
  // visible jump after it.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <label className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-medium text-foreground">
          {envKey}
        </span>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Paste your key"
          // `h-7` is the login button's height, so the two states put their
          // control on the same line and the card does not change depth when the
          // mode is flipped.
          className={cn(
            "h-7 w-(--sz-220px) shrink-0 rounded-md border border-border bg-background px-2",
            "font-mono text-xs outline-none placeholder:font-sans",
            "focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)",
          )}
        />
      </label>
    </div>
  );
}
