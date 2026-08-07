import { lazy, Suspense, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { STEP_EASE } from "./onboarding-motion";

// three.js is large, so the orbiting-paperclip canvas is code-split: it only
// downloads when the auth screens actually render.
const PaperclipOrbit3D = lazy(() =>
  import("./PaperclipOrbit3D").then((m) => ({ default: m.PaperclipOrbit3D })),
);

/** Duration of the hand-off out of the auth screens (modal + backdrop together). */
export const AUTH_EXIT_DURATION = 0.35;

/**
 * The orbiting-paperclip layer plus its scrim, as a non-interactive fill layer.
 * Used behind the auth screens (cloud) and behind the welcome screen (local,
 * which skips auth entirely). The scrim keeps the page calm without muting the
 * gradient; panels above it are translucent so the motif reads through.
 */
export function PaperclipBackdropLayer({ className }: { className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-0", className)}>
      <Suspense fallback={null}>
        <PaperclipOrbit3D className="size-full" />
      </Suspense>
      {/* Very slight darkening scrim — enough to settle the backdrop behind the
          panels without muting the gradient. Applies to every screen that shows
          the paperclip (cloud auth screens + the local welcome screen), since
          both render through this layer. */}
      <div className="absolute inset-0 bg-background/20" />
    </div>
  );
}

/**
 * Full-screen shell for the onboarding auth screens (create account / verify
 * code), with the orbiting 3D paperclip behind the card.
 *
 * On completion (`visible` → false) the card settles down and fades while the
 * backdrop fades out at the same time — a quick, subtle hand-off into whatever
 * comes next. Render this around the auth screens and flip `visible` when the
 * user finishes signing up or logging in.
 */
export function OnboardingAuthBackdrop({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  /** Optional dismiss affordance, matching OnboardingScaffold's close button. */
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="onboarding-auth"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background px-5 py-20"
          initial={false}
          exit={{ opacity: 0 }}
          transition={{ duration: AUTH_EXIT_DURATION, ease: STEP_EASE }}
        >
          {/* Orbiting paperclip backdrop — sits behind the card, non-interactive.
              It fades with the container; a dimming overlay keeps the card
              legible over the bright gradient. */}
          <motion.div
            className="pointer-events-none absolute inset-0 -z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: AUTH_EXIT_DURATION, ease: STEP_EASE }}
          >
            <PaperclipBackdropLayer />
          </motion.div>

          {onClose ? (
            <button
              onClick={onClose}
              className="absolute left-4 top-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
              aria-label="Close onboarding"
            >
              <X className="size-5" />
            </button>
          ) : null}

          {/* The card lowers slightly and fades on the way out. */}
          <motion.div
            className="relative"
            initial={false}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: AUTH_EXIT_DURATION, ease: STEP_EASE }}
          >
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
