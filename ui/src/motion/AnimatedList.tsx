import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { staggerContainer, staggerItem } from "./transitions";
import { useReducedMotionSafe } from "./useReducedMotion";

interface AnimatedListProps {
  children: ReactNode;
  className?: string;
}

/**
 * Wraps a list of children with staggered entrance animation.
 * Each direct child should be wrapped in AnimatedListItem.
 */
export function AnimatedList({ children, className }: AnimatedListProps) {
  const prefersReducedMotion = useReducedMotionSafe();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface AnimatedListItemProps {
  children: ReactNode;
  className?: string;
}

export function AnimatedListItem({ children, className }: AnimatedListItemProps) {
  const prefersReducedMotion = useReducedMotionSafe();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div variants={staggerItem} className={className}>
      {children}
    </motion.div>
  );
}
