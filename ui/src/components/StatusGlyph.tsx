import type { CSSProperties } from "react";
import {
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { taskStatusIconVar, taskStatusIconVarDefault } from "../lib/status-colors";

/**
 * Unified task status glyph — the single source-of-truth icon for every
 * task/issue status. Each status maps to one Lucide icon (all drawn on the same
 * `viewBox="0 0 24 24"` so they scale proportionally at any size), so the whole
 * set reads as one consistent icon family:
 *
 *   backlog → circle-dashed · todo → circle · in_progress → rotate-cw ·
 *   in_review → circle-dot · done → circle-check · blocked → circle-minus ·
 *   cancelled → ban · in_queue → circle-minus (blocked recoloured blue).
 *
 * Colour comes from the `--status-task-icon-*` CSS vars (AA-tuned, mode-aware;
 * see `index.css`). The glyph paints in `currentColor`, and the component
 * defaults `color` to the status' icon var — so it renders correctly
 * standalone, but a call site can recolour it by setting `color` on the SVG or
 * any ancestor (e.g. a chip pointing it at its foreground hue).
 */

export type StatusGlyphSize = "sm" | "md" | "lg";

/** sm 14 / md 16 / lg 20 — the only sizes the unified glyph ships at. */
const SIZE_PX: Record<StatusGlyphSize, number> = { sm: 14, md: 16, lg: 20 };

export type StatusGlyphStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled"
  | "in_queue";

/** Status → Lucide icon. `in_queue` borrows the blocked icon; its colour var resolves to blue. */
const STATUS_ICON: Record<string, LucideIcon> = {
  backlog: CircleDashed,
  todo: Circle,
  in_progress: RotateCw,
  in_review: CircleDot,
  done: CircleCheck,
  blocked: CircleMinus,
  cancelled: Ban,
  in_queue: CircleMinus,
};

/** Unknown statuses fall back to the backlog icon (matches the colour-var fallback). */
const STATUS_ICON_DEFAULT = CircleDashed;

interface StatusGlyphProps {
  status: string;
  /** sm 14 / md 16 / lg 20. Default `md`. */
  size?: StatusGlyphSize;
  className?: string;
  /** Accessible label; when set the SVG gets `role="img"`, else it's decorative. */
  title?: string;
}

export function StatusGlyph({ status, size = "md", className, title }: StatusGlyphProps) {
  const px = SIZE_PX[size];
  const Icon = STATUS_ICON[status] ?? STATUS_ICON_DEFAULT;
  const cssVar = taskStatusIconVar[status] ?? taskStatusIconVarDefault;
  const a11y = title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <Icon
      size={px}
      className={cn("inline-block shrink-0 align-middle", className)}
      style={{ color: `var(${cssVar})` } as CSSProperties}
      {...a11y}
    >
      {title ? <title>{title}</title> : null}
    </Icon>
  );
}
