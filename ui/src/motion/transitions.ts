import type { Transition, Variants } from "framer-motion";

// ── Spring Configs ──────────────────────────────────────────────────────────

/** Standard spring — used for most interactive elements */
export const spring: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 30,
};

/** Gentle spring — used for page transitions, large elements */
export const gentleSpring: Transition = {
  type: "spring",
  stiffness: 200,
  damping: 25,
};

/** Snappy spring — used for small interactive feedback (buttons, toggles) */
export const snappy: Transition = {
  type: "spring",
  stiffness: 500,
  damping: 35,
};

/** Bouncy spring — used for playful entrances */
export const bouncy: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 20,
};

// ── Page Transitions ────────────────────────────────────────────────────────

export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

export const pageTransition: Transition = {
  ...gentleSpring,
  opacity: { duration: 0.2 },
};

// ── List / Stagger ──────────────────────────────────────────────────────────

export const staggerContainer: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
};

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: spring,
  },
};

export const staggerItemFade: Variants = {
  initial: { opacity: 0 },
  animate: {
    opacity: 1,
    transition: { duration: 0.2 },
  },
};

// ── Card Interactions ───────────────────────────────────────────────────────

export const cardHover = { scale: 1.01, transition: snappy };
export const cardTap = { scale: 0.98, transition: snappy };

// ── Modal / Overlay ─────────────────────────────────────────────────────────

export const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.95, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: spring,
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 4,
    transition: { duration: 0.15 },
  },
};

// ── Slide Panels ────────────────────────────────────────────────────────────

export const slideFromRight: Variants = {
  initial: { x: "100%" },
  animate: { x: 0, transition: spring },
  exit: { x: "100%", transition: { duration: 0.2 } },
};

export const slideFromLeft: Variants = {
  initial: { x: "-100%" },
  animate: { x: 0, transition: spring },
  exit: { x: "-100%", transition: { duration: 0.2 } },
};

export const slideFromBottom: Variants = {
  initial: { y: "100%" },
  animate: { y: 0, transition: spring },
  exit: { y: "100%", transition: { duration: 0.2 } },
};

// ── Toast ───────────────────────────────────────────────────────────────────

export const toastVariants: Variants = {
  initial: { opacity: 0, y: -20, scale: 0.95 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring,
  },
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.95,
    transition: { duration: 0.15 },
  },
};

// ── Activity Feed Item ──────────────────────────────────────────────────────

export const feedItemVariants: Variants = {
  initial: { opacity: 0, y: -12, scale: 0.98 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: spring,
  },
};

// ── Collapse / Expand ───────────────────────────────────────────────────────

export const collapseVariants: Variants = {
  collapsed: {
    height: 0,
    opacity: 0,
    overflow: "hidden",
    transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] },
  },
  expanded: {
    height: "auto",
    opacity: 1,
    overflow: "visible",
    transition: { duration: 0.25, ease: [0.32, 0.72, 0, 1] },
  },
};

// ── Button Press ────────────────────────────────────────────────────────────

export const buttonPress = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.97 },
  transition: snappy,
};

// ── Tab Indicator ───────────────────────────────────────────────────────────

export const tabIndicatorTransition: Transition = {
  type: "spring",
  bounce: 0.15,
  duration: 0.4,
};
