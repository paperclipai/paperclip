import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { pageVariants, pageTransition } from "./transitions";
import { useReducedMotionSafe } from "./useReducedMotion";

interface AnimatedPageProps {
  children: ReactNode;
  className?: string;
}

export function AnimatedPage({ children, className }: AnimatedPageProps) {
  const prefersReducedMotion = useReducedMotionSafe();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={pageTransition}
      className={className}
    >
      {children}
    </motion.div>
  );
}
