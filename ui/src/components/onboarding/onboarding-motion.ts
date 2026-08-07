// Shared motion constants for the onboarding flows (cloud + local). Extracted
// from the original OnboardingFlow so both flow containers and the shared step
// views animate identically. Reduced-motion is honored globally via
// <MotionConfig reducedMotion="user"> in OnboardingScaffold.

/** Step crossfade easing (also reused by in-step reveals). */
export const STEP_EASE = [0.16, 1, 0.3, 1] as const;

/** Per-step enter/exit crossfade used by the scaffold's keyed motion.div. */
export const stepMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.28, ease: STEP_EASE },
};

// Agent-step dashed-pill entrance: fades + scales up from 50% from its center
// (no y offset, which would bias growth upward), with a spring bounce on
// landing.
export const CAPSULE_ENTER_DURATION = 1.0;
export const capsuleMotion = {
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: "spring" as const, duration: CAPSULE_ENTER_DURATION, bounce: 0.4 },
};

// Agent-step name/role reveal: the capsule slide-up (height growth) and the
// label fade share this duration; the fade is staggered by 25% of it.
export const PREVIEW_REVEAL_DURATION = 0.45;

// Step 2 → 3 capsule hand-off: on "Create" the capsule eases out (scale to
// 50%, fade to 0) with the exiting step, then resurfaces on the task step —
// scaling back to 100% on a spring so it lands into place, fade eased to match.
// Exit duration mirrors the step transition so they travel together.
export const capsuleHandoffExit = {
  scale: 0.5,
  opacity: 0,
  transition: { duration: 0.28, ease: STEP_EASE },
};
export const capsuleHeroMotion = {
  initial: { scale: 0.5, opacity: 0 },
  animate: { scale: 1, opacity: 1 },
  transition: {
    // Softer spring = a slower, more noticeable scale-up that still lands with
    // a natural settle; fade lengthened to travel with it.
    scale: { type: "spring" as const, stiffness: 150, damping: 16 },
    opacity: { duration: 0.55, ease: STEP_EASE },
  },
};
