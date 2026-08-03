import type { ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { X } from "lucide-react";
import { stepMotion } from "./onboarding-motion";

/**
 * Full-screen animated shell shared by both onboarding flows. Owns the close
 * button and the single `AnimatePresence`/keyed `motion.div` crossfade, so both
 * flows animate step transitions identically. `stepKey` must change whenever the
 * rendered step changes (that's what drives the enter/exit).
 */
export function OnboardingScaffold({
  stepKey,
  onClose,
  children,
}: {
  stepKey: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background">
        <button
          onClick={onClose}
          className="absolute left-4 top-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
          aria-label="Close onboarding"
        >
          <X className="size-5" />
        </button>

        <div className="flex min-h-full w-full items-center justify-center px-5 py-20">
          <AnimatePresence mode="wait">
            <motion.div key={stepKey} className="flex w-full justify-center" {...stepMotion}>
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  );
}
