import { useReducedMotion } from "framer-motion";

/**
 * Returns true if the user prefers reduced motion.
 * Wraps Framer Motion's hook with a safe default (false).
 */
export function useReducedMotionSafe(): boolean {
  const prefersReducedMotion = useReducedMotion();
  return prefersReducedMotion ?? false;
}
