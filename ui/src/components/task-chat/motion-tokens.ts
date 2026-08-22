/**
 * Catalog of the redesign's motion tokens. This mirrors the `--motion-*`
 * custom properties declared in ui/src/index.css :root, and is the list the dev
 * tweak panel renders controls from.
 *
 * A finish-line test parses index.css for `--motion-*` declarations and asserts
 * this catalog is 1:1 with them, so the two can never silently drift: add a
 * token to index.css and you must add it here (and vice-versa).
 */

export type MotionTokenKind = "time" | "easing";

export interface MotionTokenDef {
  /** CSS custom property name, including leading `--`. */
  name: string;
  /** Display group in the tweak panel. */
  group: string;
  kind: MotionTokenKind;
  /** Slider bounds for time tokens (ms). */
  min?: number;
  max?: number;
  step?: number;
}

export const MOTION_TOKENS: MotionTokenDef[] = [
  // Easing primitives
  { name: "--motion-ease-out-expo", group: "Easing", kind: "easing" },
  { name: "--motion-ease-standard", group: "Easing", kind: "easing" },
  { name: "--motion-ease-out", group: "Easing", kind: "easing" },
  { name: "--motion-ease-scroll-pill-in", group: "Easing", kind: "easing" },
  { name: "--motion-ease-scroll-pill-out", group: "Easing", kind: "easing" },
  { name: "--motion-ease-in", group: "Easing", kind: "easing" },

  // Duration primitives
  { name: "--motion-duration-instant", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },
  { name: "--motion-duration-fast", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },
  { name: "--motion-duration-base", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },
  { name: "--motion-duration-slow", group: "Durations", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-duration-deliberate", group: "Durations", kind: "time", min: 0, max: 2000, step: 10 },
  // Shared enter/exit/swap primitives owned by the decision/quicklook motion
  // block in index.css.
  { name: "--motion-duration-enter", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },
  { name: "--motion-duration-exit", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },
  { name: "--motion-duration-swap", group: "Durations", kind: "time", min: 0, max: 1000, step: 10 },

  // State/component-scoped
  { name: "--motion-marker-enter", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-bubble-enter", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-cot-line-stagger", group: "States", kind: "time", min: 0, max: 300, step: 5 },
  { name: "--motion-cot-collapse", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-tool-enter", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-diff-reveal", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-status-enter", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-status-exit", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-approval-pulse", group: "States", kind: "time", min: 0, max: 3000, step: 20 },
  { name: "--motion-plan-entry-stagger", group: "States", kind: "time", min: 0, max: 300, step: 5 },
  { name: "--motion-plan-check", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-count-tween", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-streaming-cursor-blink", group: "States", kind: "time", min: 0, max: 3000, step: 20 },
  { name: "--motion-turn-fold", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-turn-meta", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-line-scroll", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-interstitial-dwell", group: "States", kind: "time", min: 0, max: 10000, step: 100 },
  { name: "--motion-scroll-pill-enter", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-scroll-pill-exit", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
  { name: "--motion-pane-glide", group: "States", kind: "time", min: 0, max: 1500, step: 10 },
];

/** Common easing presets offered by the tweak panel's easing picker. */
export const EASING_PRESETS: { label: string; value: string }[] = [
  { label: "ease-out-expo (house)", value: "cubic-bezier(0.16, 1, 0.3, 1)" },
  { label: "standard (house)", value: "cubic-bezier(0.4, 0, 0.2, 1)" },
  { label: "ease-out", value: "cubic-bezier(0, 0, 0.2, 1)" },
  { label: "ease-in-out", value: "cubic-bezier(0.42, 0, 0.58, 1)" },
  { label: "linear", value: "linear" },
];

/** Ordered list of the panel's groups. */
export const MOTION_TOKEN_GROUPS: string[] = Array.from(
  new Set(MOTION_TOKENS.map((t) => t.group)),
);

/** Fallback emitted by the tweak-panel export when a token has no value. */
export const MOTION_TOKEN_EXPORT_FALLBACK = "0ms";

/** Parse a CSS time value ("240ms" / "1.6s") to milliseconds. */
export function parseCssTimeMs(value: string): number {
  const v = value.trim();
  if (v.endsWith("ms")) return parseFloat(v);
  if (v.endsWith("s")) return parseFloat(v) * 1000;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
