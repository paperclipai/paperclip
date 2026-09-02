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
export const CANVAS_CONTENT_ENTER = TAG_SWAP_ENTER;
export const CANVAS_CONTENT_EXIT = TAG_SWAP_EXIT;
export const CANVAS_CONTENT_TRAVEL = TAG_SWAP_TRAVEL;
