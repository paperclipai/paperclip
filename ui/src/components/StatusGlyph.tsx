import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import { taskStatusIconVar, taskStatusIconVarDefault } from "../lib/status-colors";

/**
 * Unified task status glyph (PAP-238 3b) — the single source-of-truth icon for
 * every task/issue status. Rendered from ONE `viewBox="0 0 24 24"` SVG per
 * status so it scales proportionally at any size (fixes "done" collapsing into
 * a filled blob at small sizes). Geometry + AA hues are lifted verbatim from
 * the rev-4 spec artifact.
 *
 * Distinct shapes: backlog dashed ring (uniform via `pathLength`), todo open
 * ring, in_progress half-filled, in_review ring + dot, done disc + knockout
 * check, blocked ring + bar, cancelled ring + slash, and `in_queue` = the
 * blocked shape recoloured blue (replaces the bespoke teal "covered" state).
 *
 * Colour comes from the `--status-task-icon-*` CSS vars (AA-tuned,
 * mode-aware; see `index.css`). The glyph paints in `currentColor`, and the
 * component defaults `color` to the status' icon var — so it renders correctly
 * standalone, but a call site (3c) can recolour it by setting `color` on the
 * SVG or any ancestor (e.g. a chip pointing it at its foreground hue).
 */

export type StatusGlyphSize = "sm" | "md" | "lg";

/** sm 14 / md 16 / lg 20 — the only sizes the unified glyph ships at. */
const SIZE_PX: Record<StatusGlyphSize, number> = { sm: 14, md: 16, lg: 20 };

/** Proportional stroke for the open-ring family (24-unit viewBox). */
const SW = 2.4;

export type StatusGlyphStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled"
  | "in_queue";

interface StatusGlyphProps {
  status: string;
  /** sm 14 / md 16 / lg 20. Default `md`. */
  size?: StatusGlyphSize;
  className?: string;
  /** Accessible label; when set the SVG gets `role="img"`, else it's decorative. */
  title?: string;
}

/** Inner geometry per status (viewBox 0 0 24 24). `in_queue` reuses `blocked`. */
function glyphBody(status: string) {
  // in_queue borrows the blocked shape; its colour var resolves to the blue.
  const shape = status === "in_queue" ? "blocked" : status;
  switch (shape) {
    case "todo":
      return <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={SW} />;
    case "in_progress":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={SW} />
          <path d="M12 3.5 A8.5 8.5 0 0 1 12 20.5 Z" fill="currentColor" />
        </>
      );
    case "in_review":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={SW} />
          <circle cx="12" cy="12" r="3.6" fill="currentColor" />
        </>
      );
    case "done":
      return (
        <>
          <circle cx="12" cy="12" r="9.5" fill="currentColor" />
          {/* Check knocked out in the surface colour so the disc reads at any size. */}
          <path
            d="M7.5 12.2 10.6 15.2 16.5 8.8"
            fill="none"
            className="stroke-background"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "blocked":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={SW} />
          <rect x="7" y="10.7" width="10" height="2.6" rx="1" fill="currentColor" />
        </>
      );
    case "cancelled":
      return (
        <>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth={SW} />
          <path d="M6.5 17.5 17.5 6.5" stroke="currentColor" strokeWidth={SW} strokeLinecap="round" />
        </>
      );
    case "backlog":
    default:
      // pathLength=100 makes the dash pattern resolution-independent: 100/12.5 =
      // 8 exact dashes, so the ring is uniform with no overlap at the seam.
      return (
        <circle
          cx="12"
          cy="12"
          r="8.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={SW}
          pathLength={100}
          strokeDasharray="6.25 6.25"
        />
      );
  }
}

export function StatusGlyph({ status, size = "md", className, title }: StatusGlyphProps) {
  const px = SIZE_PX[size];
  const cssVar = taskStatusIconVar[status] ?? taskStatusIconVarDefault;
  const a11y = title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      className={cn("inline-block shrink-0 align-middle", className)}
      style={{ color: `var(${cssVar})` } as CSSProperties}
      {...a11y}
    >
      {title ? <title>{title}</title> : null}
      {glyphBody(status)}
    </svg>
  );
}
