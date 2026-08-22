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
  transition: { type: "spring" as const, duration: CAPSULE_ENTER_DURATION, bounce: 0.4 },
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
