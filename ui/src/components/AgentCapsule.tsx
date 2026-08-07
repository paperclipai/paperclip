import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * AgentCapsule — the brand "capsule is the agent" motif (PAP-118).
 *
 * A single agent is drawn as a tall pill (proportion 1:≥2, radius 9999px)
 * that moves through three states as the agent comes to life:
 *
 *  - `slot`       — static dashed outline. An empty agent slot.
 *  - `configured` — solid stroke. Agent named / model picked, not yet live.
 *  - `online`     — brand agent-gradient fill radiates outward from the center,
 *                   which then breathes with an online-pulse ring (green by
 *                   default, or blue via `glow="blue"`).
 *
 * The three states are drawn as stacked layers (a dashed outline, a solid
 * stroke, and the radial fill) that cross-fade by opacity. Because
 * `border-style` is not animatable, the dashed→solid morph is realized as the
 * dashed layer fading out while the solid layer fades in — so the SAME capsule
 * can evolve in place across a flow (PAP-125, Option 4 wizard).
 *
 * The fill gradient comes from the live brand agent tokens
 * `--agent-Na` (top) → `--agent-Nb` (bottom); pick which one with `gradient`
 * (1–10). Size is a preset (`sm` | `md` | `lg`) or an explicit pixel pair so
 * the component is reusable app-wide. `prefers-reduced-motion` is honored in
 * CSS — the radial fill, layer cross-fade and both pulses are skipped and the
 * final state is rendered statically.
 */

export type AgentCapsuleState = "slot" | "configured" | "online";

export type AgentCapsuleSizePreset = "sm" | "md" | "lg";

/** Online-pulse colour. `green` for app-wide reuse; `blue` for wizard step 5. */
export type AgentCapsuleGlow = "green" | "blue";

/** Number of brand agent-gradient token pairs defined in index.css. */
export const AGENT_GRADIENT_COUNT = 10;

const SIZE_PRESETS: Record<AgentCapsuleSizePreset, { width: number; height: number }> = {
  sm: { width: 24, height: 60 },
  md: { width: 34, height: 84 },
  lg: { width: 46, height: 116 },
};

const STATE_ARIA: Record<AgentCapsuleState, string> = {
  slot: "empty agent slot",
  configured: "agent configured, offline",
  online: "agent online",
};

export interface AgentCapsuleProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "color"> {
  /** Lifecycle state of the agent the capsule represents. */
  state: AgentCapsuleState;
  /** Brand agent-gradient index (1–{@link AGENT_GRADIENT_COUNT}). Wraps if out of range. */
  gradient?: number;
  /** Size preset, or an explicit `{ width, height }` in pixels (keep height ≥ 2× width). */
  size?: AgentCapsuleSizePreset | { width: number; height: number };
  /** Online-pulse colour (only applies in the `online` state). Defaults to `green`. */
  glow?: AgentCapsuleGlow;
  /**
   * Slot→configured morph as a draw-on: the solid outline is traced around the
   * perimeter over the still-visible dashed outline (which fades once the draw
   * completes), instead of the default border cross-fade. Honors reduced
   * motion by rendering the final state instantly.
   */
  strokeDraw?: boolean;
  /** Accessible label; defaults to a description of the state. */
  "aria-label"?: string;
}

/** Duration of the strokeDraw perimeter trace; the dashed layer fades after it. */
const STROKE_DRAW_SECONDS = 0.9;
const STROKE_DRAW_EASE = [0.16, 1, 0.3, 1] as const;

/** Normalize a (possibly out-of-range) gradient index to 1…AGENT_GRADIENT_COUNT. */
function normalizeGradient(gradient: number): number {
  const n = Math.trunc(gradient);
  return ((((n - 1) % AGENT_GRADIENT_COUNT) + AGENT_GRADIENT_COUNT) % AGENT_GRADIENT_COUNT) + 1;
}

export function AgentCapsule({
  state,
  gradient = 1,
  size = "md",
  glow = "green",
  strokeDraw = false,
  className,
  style,
  "aria-label": ariaLabel,
  ...rest
}: AgentCapsuleProps) {
  const dims = typeof size === "string" ? SIZE_PRESETS[size] : size;
  const idx = normalizeGradient(gradient);
  const fill = `linear-gradient(to bottom, var(--agent-${idx}a), var(--agent-${idx}b))`;
  const reducedMotion = useReducedMotion();
  const drawn = state === "configured" || state === "online";

  return (
    <div
      role="img"
      aria-label={ariaLabel ?? STATE_ARIA[state]}
      data-state={state}
      data-gradient={idx}
      data-glow={glow}
      className={cn(
        "agent-cap relative isolate mx-auto overflow-hidden rounded-full bg-transparent",
        state === "online" && (glow === "blue" ? "agent-cap-online-blue" : "agent-cap-online"),
        className,
      )}
      style={{ width: dims.width, height: dims.height, ...style }}
      {...rest}
    >
      {/* Dashed outline — an empty agent slot. Visible (static) only in the
          slot state; cross-fades out as the capsule is configured. In
          strokeDraw mode it instead stays put while the solid outline is
          traced over it, then fades once the draw completes. */}
      <span
        aria-hidden="true"
        className={cn(
          "agent-cap-dash agent-cap-layer pointer-events-none absolute inset-0 rounded-full border-2 border-dashed border-muted-foreground/60",
          state === "slot" ? "agent-cap-slot opacity-100" : "opacity-0",
        )}
        style={
          strokeDraw && state === "configured" && !reducedMotion
            ? { transitionDelay: `${STROKE_DRAW_SECONDS}s` }
            : undefined
        }
      />
      {/* Solid stroke — agent configured, not yet live. Default: cross-fades
          in on top of the dashed layer. strokeDraw: an SVG outline traced
          around the perimeter (pathLength 0→1) over the dashed layer. */}
      {strokeDraw ? (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          width="100%"
          height="100%"
          viewBox={`0 0 ${dims.width} ${dims.height}`}
          fill="none"
        >
          <motion.rect
            x={1}
            y={1}
            width={dims.width - 2}
            height={dims.height - 2}
            rx={(dims.width - 2) / 2}
            strokeWidth={2}
            className="stroke-foreground/70"
            initial={false}
            animate={{ pathLength: drawn ? 1 : 0 }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : { duration: STROKE_DRAW_SECONDS, ease: STROKE_DRAW_EASE }
            }
          />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "agent-cap-stroke agent-cap-layer pointer-events-none absolute inset-0 rounded-full border-2 border-solid border-foreground/70",
            state === "configured" && "opacity-100",
            // Online: carry the solid outline over, then fade it as the fill completes.
            state === "online" && "agent-cap-stroke-carryover",
            state === "slot" && "opacity-0",
          )}
        />
      )}
      {/* Brand-gradient fill — radiates outward from the center when online. */}
      {state === "online" ? (
        <span
          aria-hidden="true"
          className="agent-cap-liquid absolute inset-0 block"
          style={{ background: fill }}
        />
      ) : null}
    </div>
  );
}

export default AgentCapsule;
