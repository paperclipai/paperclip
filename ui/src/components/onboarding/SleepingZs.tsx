import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "../../lib/utils";

/**
 * Sleep marks drifting off the dormant agent.
 *
 * The capsule is grey and closed-eyed for the whole of the connect step, which
 * is accurate — nothing has been hired yet — but a still silhouette reads as a
 * placeholder that failed to load rather than as something waiting. Three small
 * z's rising off its shoulder say "asleep, not broken" without adding a second
 * thing to look at.
 *
 * Decorative and announced to nobody: the state it depicts is already carried
 * by the step's own copy.
 */

/**
 * The glyphs, smallest first. Each rises further and ends larger than the one
 * below it, so the three together read as one plume with depth rather than as
 * three identical marks on different timers — the "zzZZ" shape of the thing
 * written down.
 */
const Z_TIERS = [
  { glyph: "z", sizeClass: "text-(length:--text-nano)", scaleTo: 0.95, reach: 1 },
  { glyph: "z", sizeClass: "text-xs", scaleTo: 1.1, reach: 1.25 },
  { glyph: "Z", sizeClass: "text-sm", scaleTo: 1.25, reach: 1.5 },
] as const;

/**
 * Applied to both ends of every glyph's scale, so the marks read larger without
 * the plume changing shape — a bump to the tiers' own `scaleTo` values alone
 * would have grown the three by different amounts and flattened the depth
 * between them.
 */
const Z_SCALE = 1.1;

/**
 * Where a glyph is born, measured down from the anchor at the dome's crown.
 *
 * Low enough that the marks read as rising off the head rather than hovering
 * above it, but back off the silhouette: further down, the first frames of each
 * glyph landed on the dome's own grey and the fade-in was lost against it.
 */
const ORIGIN_DROP = 17;

const Z_SCALE_FROM = 0.55 * Z_SCALE;

type ZTier = (typeof Z_TIERS)[number];

type ZFlight = {
  launchX: number;
  launchY: number;
  driftX: number;
  driftY: number;
  rotate: number;
  duration: number;
  delay: number;
};

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

/**
 * A fresh flight for one glyph.
 *
 * Re-rolled every cycle rather than fixed at mount. Three fixed loops of
 * different lengths do drift apart, but they still repeat exactly, and at this
 * size the eye picks the period up within a few passes — which is the one thing
 * an idle animation must not do.
 */
function nextFlight(tier: ZTier, index: number, first: boolean): ZFlight {
  // Each mark leaves from a slightly different point rather than all three from
  // one. Without this the tiers launch stacked and the first moment of a cycle
  // is a smudge of overlapping glyphs instead of a plume.
  const launchX = randomBetween(-4, 4);
  // Every glyph starts `ORIGIN_DROP` below the anchor and climbs from there.
  // The drift is measured off the launch point rather than the anchor, so
  // moving the origin slides the whole plume without shortening its travel.
  const launchY = ORIGIN_DROP + randomBetween(-3, 3);
  return {
    launchX,
    launchY,
    driftX: launchX + randomBetween(9, 18) * tier.reach,
    driftY: launchY - randomBetween(20, 30) * tier.reach,
    rotate: randomBetween(-14, 16),
    duration: randomBetween(1.9, 2.6),
    // A gap between cycles, so the plume puffs rather than streams. Kept short
    // enough that all three are never idle together for long: an animation
    // whose whole point is "still running, just asleep" cannot afford stretches
    // where there is nothing on screen at all. The first delay is staggered by
    // tier so they do not launch as one on the step's first frame.
    delay: first ? index * 0.4 : randomBetween(0.3, 1.1),
  };
}

function SleepyZ({ tier, index }: { tier: ZTier; index: number }) {
  // `cycle` is a remount key, not a counter anyone reads: changing it replaces
  // the span so the next flight starts from `initial` again. Re-running
  // `animate` alone would tween from wherever the last one ended, and the glyph
  // would wander off instead of restarting at the shoulder.
  const [cycle, setCycle] = useState(0);
  const [flight, setFlight] = useState(() => nextFlight(tier, index, true));

  return (
    <motion.span
      key={cycle}
      className={cn(
        "absolute font-semibold text-muted-foreground select-none",
        tier.sizeClass,
      )}
      initial={{
        opacity: 0,
        x: flight.launchX,
        y: flight.launchY,
        scale: Z_SCALE_FROM,
        rotate: 0,
      }}
      animate={{
        opacity: [0, 1, 1, 0],
        x: flight.driftX,
        y: flight.driftY,
        scale: tier.scaleTo * Z_SCALE,
        rotate: flight.rotate,
      }}
      transition={{
        duration: flight.duration,
        delay: flight.delay,
        // Ease-out sine: the mark leaves the shoulder with a little pace and
        // slows as it goes, the way something buoyant does.
        ease: [0.39, 0.575, 0.565, 1],
        // Fades in over the first fifth and out over the last third, holding
        // solid in between. Without the hold the glyph is never fully legible.
        opacity: {
          duration: flight.duration,
          delay: flight.delay,
          times: [0, 0.2, 0.66, 1],
        },
      }}
      onAnimationComplete={() => {
        setFlight(nextFlight(tier, index, false));
        setCycle((previous) => previous + 1);
      }}
    >
      {tier.glyph}
    </motion.span>
  );
}

/**
 * Positioned absolutely over the caller's capsule, which must be `relative`.
 * The marks are anchored to the dome's upper-right shoulder and travel out
 * past the box, so nothing between here and the step's own frame may clip.
 *
 * Rendered as nothing at all when the OS asks for reduced motion. This is the
 * one animation on the step with no end — the usual token-level treatment
 * shortens durations, which for an endless loop just means it repeats faster.
 */
export function SleepingZs({ className }: { className?: string }) {
  const reducedMotion = useReducedMotion();
  if (reducedMotion) return null;

  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
    >
      <span className="absolute left-3/4 top-1/4">
        {Z_TIERS.map((tier, index) => (
          <SleepyZ key={tier.glyph + String(index)} tier={tier} index={index} />
        ))}
      </span>
    </span>
  );
}
