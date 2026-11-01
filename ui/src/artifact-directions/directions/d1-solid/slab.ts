/**
 * SIGNATURE 3 — the slab: one clear fill step off the canvas, one radius
 * (`rounded-md`, used by every slab, block, sheet, button and notch in the
 * set), no stroke, no shadow.
 *
 * Fill logic, shared by all three surfaces (values in tokens.css):
 *   slab        the artifact itself
 *   slab-hover  a slab that is a target, hovered or holding keyboard focus; slab-press while it is pressed
 *   button      a resting button on a slab: a step past the slab, away from the canvas
 *   sheet       the artifact's own content (an excerpt, a file's facts): the lightest fill short of ink
 *   ink         the kind block and tab; the primary action of a hovered slab, and of an artifact that waits for review
 */

export const MOTION = "transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-standard) motion-reduce:transition-none";

/** A resting slab. Add `group/slab` + SLAB_HOVER when the whole slab is a target. */
export const SLAB = `rounded-md bg-(--solid-slab) ${MOTION}`;
/** A slab that is a target steps one fill when hovered or when its primary holds keyboard focus, and one more while pressed. */
export const SLAB_HOVER =
  "hover:bg-(--solid-slab-hover) has-[[data-primary]:focus-visible]:bg-(--solid-slab-hover) active:bg-(--solid-slab-press)";

/**
 * For anything laid over a preview that must stay the colour of the slab under
 * it (a corner bite, the ring round an ink tab): it takes the slab's fill and
 * follows the same three steps.
 */
export const SLAB_FILL =
  "bg-(--solid-slab) group-hover/slab:bg-(--solid-slab-hover) group-has-[[data-primary]:focus-visible]/slab:bg-(--solid-slab-hover) group-active/slab:bg-(--solid-slab-press)";
export const SLAB_RING =
  "ring-2 ring-(--solid-slab) group-hover/slab:ring-(--solid-slab-hover) group-has-[[data-primary]:focus-visible]/slab:ring-(--solid-slab-hover) group-active/slab:ring-(--solid-slab-press)";
/** The same for `currentColor` on the two pseudo-elements of a corner bite (its joints, StateMarker.tsx). */
export const SLAB_JOINTS =
  "before:text-(--solid-slab) after:text-(--solid-slab) group-hover/slab:before:text-(--solid-slab-hover) group-hover/slab:after:text-(--solid-slab-hover) group-has-[[data-primary]:focus-visible]/slab:before:text-(--solid-slab-hover) group-has-[[data-primary]:focus-visible]/slab:after:text-(--solid-slab-hover) group-active/slab:before:text-(--solid-slab-press) group-active/slab:after:text-(--solid-slab-press)";

/** Keyboard focus: a 2px ink outline, 2px off the slab so it reads against both the slab and the canvas. */
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solid-ink)";

/**
 * For the one element that makes a whole slab clickable: its `::after` covers
 * the slab (which must be `relative`) and carries the focus outline.
 */
export const COVER =
  "after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-(--solid-ink)";

/** A filled button on a slab. */
export const BUTTON = `inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md bg-(--solid-button) px-2 text-xs font-medium whitespace-nowrap text-foreground ${MOTION}`;

/** Ink at rest: the primary of an artifact that waits for review, so "this needs you" reads without a hover. */
const BUTTON_INK = "bg-(--solid-ink) text-(--solid-ink-foreground)";

/** The button's own hover and press, for a button that is not a slab's cover. */
export const BUTTON_HOVER = "hover:bg-(--solid-ink) hover:text-(--solid-ink-foreground) active:bg-(--solid-ink) active:text-(--solid-ink-foreground)";

/**
 * The primary action of a `group/slab` (mark it `data-primary`): turns to ink
 * when the slab is hovered or the action holds keyboard focus, and goes back
 * to the button fill while the pointer is on a secondary control
 * (`data-secondary`), which takes the ink instead.
 */
export const BUTTON_PRIMARY =
  "group-hover/slab:bg-(--solid-ink) group-hover/slab:text-(--solid-ink-foreground) focus-visible:bg-(--solid-ink) focus-visible:text-(--solid-ink-foreground) group-has-[[data-secondary]:hover]/slab:bg-(--solid-button) group-has-[[data-secondary]:hover]/slab:text-foreground";

/** The primary's two looks at rest. */
export const primaryRest = (waiting: boolean) => (waiting ? BUTTON_INK : null);

/** A secondary control on a slab: no fill at rest, ink on hover. Sits above the cover. Mark it `data-secondary`. */
const GHOST = `relative z-10 inline-flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solid-meta) ${MOTION} ${BUTTON_HOVER} ${FOCUS}`;

/** The icon-only ghost: 28px square. */
export const ICON_BUTTON = `${GHOST} w-7`;

/** A ghost that carries a short mono value beside its icon (the panel's comments count). */
export const COUNT_BUTTON = `${GHOST} gap-1 px-1.5 font-mono text-(length:--text-micro) leading-none`;
