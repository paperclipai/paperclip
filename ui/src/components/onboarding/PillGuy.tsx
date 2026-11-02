import { AnimatePresence, motion } from "motion/react";

import { cn } from "../../lib/utils";

/**
 * The agent, drawn as itself.
 *
 * Two states from one silhouette: `dormant` is grey and closed-eyed, waiting to
 * be configured; `alive` is the gradient-lit version with open eyes and a tuft,
 * shown once the agent is hired and ready. The arc's job is to get from one to
 * the other, so the transition between them is the arc's payoff — not
 * decoration on top of it.
 *
 * Both are the brand assets verbatim (`pill-1-dormant.svg`, `pill-1-alive.svg`)
 * rather than a redrawn approximation, so what ships is what was designed. They
 * carry their own fills — the gradients are the point — so they do not follow
 * the theme, which is correct here: the agent looks like itself on either
 * ground.
 */

const DORMANT_GRADIENT_ID = "pillguy-dormant-body";
const ALIVE_GRADIENT_ID = "pillguy-alive-body";

/** The shared silhouette. Identical in both states, which is what lets them cross-fade cleanly. */
const BODY_PATH =
  "M54.7022 14.3438C29.7981 14.3438 9.60938 34.5085 9.60938 59.3831V87.5272C9.60938 90.385 11.9261 92.7018 14.784 92.7018H94.6204C97.4782 92.7018 99.795 90.385 99.795 87.5272V59.3831C99.795 34.5085 79.6063 14.3438 54.7022 14.3438Z";

/** The tuft, alive only — the one shape that has no dormant counterpart. */
const TUFT_PATH =
  "M22.5464 10.6842C15.1541 21.0252 20.3287 39.5225 0 45.762C17.2549 61.9384 64.3127 49.1324 74.6619 21.781C79.4668 33.6086 90.5552 41.0009 96.469 42.8447C112.362 5.51809 69.8569 -5.24463 62.8342 3.25648C48.7889 -3.39656 29.7044 0.670936 22.5464 10.6842Z";

function DormantPill() {
  return (
    <svg viewBox="0 0 100 93" fill="none" aria-hidden className="size-full">
      <path d={BODY_PATH} fill={`url(#${DORMANT_GRADIENT_ID})`} />
      {/* Closed eyes: the same rounded rects as the open pair, flattened. */}
      <rect x="75.9199" y="66.3047" width="9" height="4" rx="2" fill="var(--pill-guy-eye)" />
      <rect x="28.9199" y="66.3047" width="9" height="4" rx="2" fill="var(--pill-guy-eye)" />
      <defs>
        <linearGradient
          id={DORMANT_GRADIENT_ID}
          x1="54.7022"
          y1="14.3437"
          x2="54.7022"
          y2="107.486"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--pill-guy-dormant-top)" />
          <stop offset="1" stopColor="var(--pill-guy-dormant-bottom)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function AlivePill() {
  return (
    <svg viewBox="0 0 100 93" fill="none" aria-hidden className="size-full">
      <path d={BODY_PATH} fill={`url(#${ALIVE_GRADIENT_ID})`} />
      <rect x="76.1406" y="63.1328" width="8.87072" height="10.3492" rx="4.43536" fill="var(--pill-guy-eye)" />
      <rect x="28.8301" y="63.1328" width="8.87072" height="10.3492" rx="4.43536" fill="var(--pill-guy-eye)" />
      <path d={TUFT_PATH} fill="var(--pill-guy-tuft)" />
      <defs>
        <linearGradient
          id={ALIVE_GRADIENT_ID}
          x1="54.7022"
          y1="14.3437"
          x2="54.7022"
          y2="107.486"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--pill-guy-alive-top)" />
          <stop offset="1" stopColor="var(--pill-guy-alive-bottom)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * Cross-faded rather than path-morphed. The two states share a silhouette but
 * differ in fill, eye shape, and a tuft the dormant state does not have at all
 * — there is no honest path interpolation between them, and a faked one would
 * warp the eyes through shapes the design never draws. Fading one over the
 * other in place, with a small settle on the arriving state, reads as the
 * agent waking rather than as two pictures swapping.
 *
 * `MotionConfig reducedMotion="user"` upstream neutralises the movement for
 * anyone who asks; the state still changes, it simply arrives without travel.
 */
export function PillGuy({
  state,
  className,
}: {
  state: "dormant" | "alive";
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <AnimatePresence initial={false} mode="sync">
        <motion.div
          key={state}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: state === "alive" ? 0.92 : 1 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
            scale: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          {state === "alive" ? <AlivePill /> : <DormantPill />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
