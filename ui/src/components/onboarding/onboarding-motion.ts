// Shared motion constants for the onboarding wizard's agent arc (steps 3–5).
// Ported from the onboarding prototype so the capsule choreography reads the
// same here as it does there. Reduced motion is honoured at the token layer
// (ui/src/index.css collapses --motion-duration-* under the media query) and
// by <MotionConfig reducedMotion="user"> where these are consumed.

/** Step crossfade easing — the house signature curve, also used for in-step reveals. */
export const STEP_EASE = [0.16, 1, 0.3, 1] as const;

/** Per-step enter/exit crossfade for the keyed step container. */
export const stepMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.28, ease: STEP_EASE },
};

/**
 * The dashed slot's entrance on the agent step: fades and scales up from 50%
 * about its own centre. Deliberately no y offset — that would bias the growth
 * upward and read as a drop-in rather than something forming in place.
 */
export const CAPSULE_ENTER_DURATION = 1.0;
export const capsuleMotion = {
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1 },
  transition: {
    type: "spring" as const,
    duration: CAPSULE_ENTER_DURATION,
    bounce: 0.4,
  },
};

/** The name/role reveal: the label fade is staggered by 25% of this. */
export const PREVIEW_REVEAL_DURATION = 0.45;

/**
 * The hand-off that makes the capsule read as one object across all three
 * steps rather than three separate renders: it eases out with the departing
 * step, then resurfaces on the next one, springing back to full size so it
 * lands rather than snapping. The exit duration mirrors the step transition so
 * the two travel together.
 */
export const capsuleHandoffExit = {
  scale: 0.5,
  opacity: 0,
  transition: { duration: 0.28, ease: STEP_EASE },
};
export const capsuleHeroMotion = {
  initial: { scale: 0.5, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  transition: {
    // A soft spring: slow enough that the scale-up is noticeable, damped
    // enough that it still settles. The fade is lengthened to travel with it.
    scale: { type: "spring" as const, stiffness: 150, damping: 16 },
    opacity: { duration: 0.55, ease: STEP_EASE },
  },
};

/**
 * The credential tag's swap between "Subscription" and "API" on the connect
 * step's source tiles.
 *
 * Both labels share one clipped slot and cross inside it: the outgoing one
 * always falls out of frame while the incoming one rises into place. Fixing the
 * direction is the point — deriving it from which way the toggle moved would
 * make one control produce two different animations, and at 10px the tag is far
 * too small for that to read as anything but a flicker.
 *
 * The exit stays 80ms shorter than the enter so the slot has mostly cleared by
 * the time the arriving label reaches the middle of it, rather than the two
 * words being legible on top of each other. Both moved together when the swap
 * was lengthened, which is what keeps that relationship: stretching only the
 * enter would have opened the gap instead, and the swap would read as one label
 * leaving and a separate one arriving.
 *
 * Eased in and out — the house material curve, mirroring
 * `--motion-ease-standard` — rather than the arc's expo-out. Expo-out leaves at
 * full speed from the first frame, which suits something arriving from
 * offscreen; over 7px it just looked like the label snapped and then settled.
 * Easing into the movement gives the swap a beginning.
 */
export const TAG_SWAP_TRAVEL = 7;
export const TAG_SWAP_EASE = [0.4, 0, 0.2, 1] as const;
export const TAG_SWAP_ENTER = { duration: 0.34, ease: TAG_SWAP_EASE } as const;
export const TAG_SWAP_EXIT = { duration: 0.26, ease: TAG_SWAP_EASE } as const;

/**
 * The credential-mode link's own label swap, when that control is a line of
 * text rather than a checkbox.
 *
 * A plain crossfade, with no travel — deliberately unlike the tag it triggers.
 * The tag slides because it is being replaced inside a slot it shares with the
 * label before it; the link is not replaced, it is one control renaming itself,
 * and giving it the same movement would read as a second thing changing rather
 * than the cause of the first.
 *
 * The old label leaves quickly and the new one starts once it is nearly gone,
 * so the two are never both readable — two near-identical sentences at half
 * opacity are unreadable in a way two single words are not. Even with the
 * stagger it settles just inside the tag swap, so the sentence and the tags
 * finish together.
 */
export const LINK_LABEL_FADE_OUT = {
  duration: 0.12,
  ease: TAG_SWAP_EASE,
} as const;
export const LINK_LABEL_FADE_IN = {
  duration: 0.22,
  delay: 0.08,
  ease: TAG_SWAP_EASE,
} as const;

/**
 * The connect step's input canvas: the card that opens under the tiles once a
 * source is picked, and re-fills itself when the choice changes.
 *
 * Everything here is the tag swap's vocabulary, reused deliberately. The canvas
 * is downstream of that control — picking a source or flipping the credential
 * mode is what fills it — so a second easing or a second rhythm would read as a
 * separate thing reacting rather than the same gesture continuing.
 *
 * The canvas container itself does not animate at all. It carried an open/close
 * three times — height, then opacity — and stalled every time, once leaving the
 * login card rendered inside a two-pixel box. The content swap below is where
 * the motion lives, and it is enough.
 */
export const CANVAS_EASE = TAG_SWAP_EASE;

/**
 * The content swap inside the canvas, when the source or the credential mode
 * changes while it is already open.
 *
 * Shorter than the canvas opening, and with the same enter/exit asymmetry as the
 * tag: the outgoing input is mostly gone before the incoming one arrives, so two
 * different forms are never legible on top of each other.
 *
 * The swap itself is the tag's, not a variation on it: one input falls out of
 * the card while the next rises into place, on the same travel and the same
 * curve. Flipping the credential mode moves the tag and re-fills the canvas in
 * one gesture, and giving the two ends of that gesture different motion would
 * make them read as separate events.
 *
 * There is no spinner and no hold. An earlier version had both, on the reasoning
 * that the panels behind the canvas fetch — but they are components, available
 * the moment the choice changes, and the 400ms floor needed to make a spinner
 * legible was time added to a swap that had nothing to wait for. A spinner
 * standing in for no work is a slower screen that also says something untrue.
 */

/**
 * How far the input canvas descends into place when a source is picked.
 *
 * Larger than the swap's travel, and in the opposite direction. A swap trades
 * one input for another in a space that already exists, so it barely moves; this
 * is a surface arriving where there was none, and it comes down from above so
 * the movement reads as the tile above it opening out.
 */
export const CANVAS_ENTER_TRAVEL = 10;

export const CANVAS_CONTENT_ENTER = TAG_SWAP_ENTER;
export const CANVAS_CONTENT_EXIT = TAG_SWAP_EXIT;
export const CANVAS_CONTENT_TRAVEL = TAG_SWAP_TRAVEL;

/**
 * The connect step's sign-in sequence: picking a source, the card opening on a
 * wait, and the primary button walking through four labels.
 *
 * All of it is built from the vocabulary above rather than a second one. The
 * sequence is one gesture that starts at the tile row and ends at the button,
 * so a new curve partway through would break it into separate events — the
 * same reasoning the canvas tokens are written with.
 */

/**
 * The row collapsing to the chosen source.
 *
 * The unpicked tile fades where it stands while the picked one travels to the
 * centre, and the two are deliberately not symmetrical: one is leaving and one
 * is being kept, so animating both the same way would read as the row
 * reshuffling rather than as a choice being made. The exit is the tag's, short
 * enough to be gone before the survivor arrives.
 *
 * The travel is a layout animation, not a fixed offset — the distance depends
 * on which tile was picked, and hard-coding it would send the right-hand tile
 * the wrong way.
 */
export const SOURCE_COLLAPSE_MOVE = { duration: 0.42, ease: TAG_SWAP_EASE } as const;
export const SOURCE_COLLAPSE_FADE = TAG_SWAP_EXIT;

/**
 * The credential-mode link leaving as the row collapses.
 *
 * Faster than the collapse it accompanies. It is not part of the choice, it is
 * a control that has stopped applying — once a sign-in is running there is no
 * switching to keys without cancelling — so it should be gone before the eye
 * follows the tile, rather than travelling alongside it and inviting a press.
 */
export const SOURCE_LINK_EXIT = { duration: 0.16, ease: TAG_SWAP_EASE } as const;

/**
 * The card's staged reveal once the sign-in has something to show.
 *
 * The instruction first, the field a beat later. The order is the reading
 * order, and the gap is what makes it read as one thing unfolding rather than
 * two arriving together — it also means the sentence has been read by the time
 * the field is ready to be pasted into, which is the point of staging it at all.
 *
 * Both rise slightly, on the canvas's own travel, so the reveal belongs to the
 * surface that opened rather than being a separate entrance inside it.
 */
export const CARD_REVEAL_TRAVEL = 6;
export const CARD_REVEAL_INSTRUCTION = { duration: 0.3, ease: STEP_EASE } as const;
export const CARD_REVEAL_FIELD = { duration: 0.3, delay: 0.12, ease: STEP_EASE } as const;

/**
 * The primary button changing label.
 *
 * Two animations at once, and they are separate on purpose. The text
 * cross-fades on the link label's timing — the outgoing word mostly gone before
 * the incoming one starts, so two labels are never legible at once. The button's
 * *width* eases in and out underneath it, because "Next" and "Waiting for code"
 * are very different sizes and snapping between them would make a settled
 * control look like it was replaced.
 *
 * The width is the slower of the two, so the shape finishes arriving after the
 * word does. Reversing that reads as the button resizing and then, separately,
 * changing its mind about what it says.
 */
export const CTA_WIDTH = { duration: 0.34, ease: TAG_SWAP_EASE } as const;
export const CTA_LABEL_OUT = LINK_LABEL_FADE_OUT;
export const CTA_LABEL_IN = LINK_LABEL_FADE_IN;

/**
 * The deliberate pause between a pasted code being accepted and the step
 * advancing.
 *
 * Not a fetch — the work is already done by the time this starts. It exists so
 * "Connecting" is legible as a state rather than a flicker on the way out: the
 * step advancing the instant a paste lands reads as the paste having gone
 * wrong, because nothing acknowledged it. Two seconds is long enough to be read
 * and short enough not to feel stalled.
 */
export const CONNECTED_HOLD_MS = 2000;

/**
 * The sign-in card arriving and leaving, and the footer moving because of it.
 *
 * These are sequenced rather than concurrent, and the ordering is the whole
 * point. Running the collapse and the card's arrival together read as two
 * unrelated things happening at once; run in order, the row answering the
 * question is what *causes* the card to open.
 *
 * The footer is not animated directly. The card holds its own space while it
 * fades — `AnimatePresence` keeps it mounted through its exit — so the footer
 * only moves once the card is genuinely gone, and a `layout` animation carries
 * it. That is why the exit is quick and the settle that follows is separate:
 * "card goes, then the bar comes back up" is two beats, not one.
 */
export const CARD_ENTER = { duration: 0.3, ease: STEP_EASE } as const;
export const CARD_EXIT = { duration: 0.18, ease: TAG_SWAP_EASE } as const;
export const FOOTER_SETTLE = { duration: 0.34, ease: TAG_SWAP_EASE } as const;

/**
 * Milliseconds, for the timers that drive the sequence from one beat to the
 * next. Kept beside the transitions they mirror so the two cannot drift — a
 * timer that fires early would start the next beat over the top of the one
 * still running, which is the exact fault this sequencing exists to fix.
 */
export const SOURCE_COLLAPSE_MS = SOURCE_COLLAPSE_MOVE.duration * 1000;
export const CARD_EXIT_MS = CARD_EXIT.duration * 1000;
export const FOOTER_SETTLE_MS = FOOTER_SETTLE.duration * 1000;

/**
 * Making room for the card, and giving it back.
 *
 * Its own beat, before the card is visible at all. The card used to arrive by
 * mounting, which meant its space appeared in a single frame: everything above
 * jumped to its new position instead of travelling there, and the credential
 * link's space vanished at the same instant, compounding it.
 *
 * Nothing mounts or unmounts to make this happen now. The card and the link are
 * both always rendered, and their *heights* animate — so every frame is a real
 * layout the column can settle into, and the whole step slides. The card only
 * fades in once the room exists.
 */
export const MAKE_ROOM = { duration: 0.34, ease: TAG_SWAP_EASE } as const;
export const MAKE_ROOM_MS = MAKE_ROOM.duration * 1000;

/**
 * The unpicked tile's fade, shortened from the tag's exit.
 *
 * It leaves the flow at once and travels nowhere, so while it is still legible
 * it sits on top of the tile moving underneath it. At the tag's 260ms that
 * overlap was long enough to read as two tiles briefly occupying one another;
 * at 180 the survivor is clear before it arrives.
 */
export const SOURCE_EXIT_FADE = { duration: 0.18, ease: TAG_SWAP_EASE } as const;

/**
 * "Copied!" arriving beside a code that was put on the clipboard for you.
 *
 * It rises as it fades in, which is the difference between a label that was
 * always there and one that just happened — the code did not change, so
 * something has to say that an action occurred. Short, and it stays: this is a
 * statement about the clipboard's contents, and those are still true a second
 * later.
 */
export const COPIED_REVEAL_TRAVEL = 6;
export const COPIED_REVEAL = { duration: 0.26, ease: STEP_EASE } as const;

/**
 * How long "Copied!" waits before it appears.
 *
 * The clipboard is written the moment the card is live, but saying so while the
 * instruction and the code are themselves still fading in buries the one part
 * of the card that is reporting an event rather than presenting a fact — it
 * arrives inside the reveal and reads as another thing that was always there.
 *
 * Timed off the card's own reveal, so it lands after the last of it settles
 * rather than at a number picked to look right. The extra beat is deliberate
 * separation: this is the only thing moving by then, which is what makes it
 * noticeable at all.
 */
export const COPIED_REVEAL_DELAY_MS =
  (CARD_REVEAL_FIELD.delay + CARD_REVEAL_FIELD.duration) * 1000 + 120;

/**
 * How long to wait before the next beat of the connect sequence.
 *
 * The waits exist to let an animation finish. Where nothing is animating they
 * are just a slower screen, so reduced motion collapses them to nothing — the
 * same thing `index.css` does to the duration tokens under that media query,
 * applied to the timers that mirror them.
 *
 * No `matchMedia` at all is treated as reduced rather than as full motion. The
 * honest reading of "cannot ask" is "do not animate", and it means the sequence
 * still advances anywhere the query is unavailable — a server render, an older
 * embedder, or a test environment — instead of stalling on a beat that will
 * never elapse.
 */
export function beatDelay(ms: number): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 0;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}
