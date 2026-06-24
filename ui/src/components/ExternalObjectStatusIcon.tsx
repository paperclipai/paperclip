import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
} from "@paperclipai/shared";
import { Clock } from "lucide-react";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
} from "../lib/status-colors";
import {
  externalObjectCategoryLabel,
  externalObjectIconForCategory,
  externalObjectIconForKey,
  externalObjectLivenessLabel,
} from "../lib/external-objects";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { cn } from "../lib/utils";

interface ExternalObjectStatusIconProps {
  category: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  statusIconKey?: string | null;
  /** Optional override label used in `aria-label` (e.g. provider-specific copy). */
  label?: string | null;
  className?: string;
  /** Tailwind size class — defaults to `h-3.5 w-3.5` (compact pill use). */
  sizeClassName?: string;
  /**
   * When true the icon renders inline at 12 px with the `mr-1`/`align`
   * adjustments used by `MarkdownIssueLink`. Used by the markdown decorator.
   */
  inline?: boolean;
}

/**
 * Pure presentational icon for an external object's status. Combines:
 *
 * - A category icon (lucide) from `externalObjectIconForCategory`.
 * - Tone classes (text + border) from `externalObjectStatusIcon`.
 * - An overlaid clock micro-mark when liveness is `stale`.
 * - Reduced-motion-aware spinner for the `running` category.
 *
 * Never mounts plugin React; the host is the sole renderer of identity glyphs.
 */
export function ExternalObjectStatusIcon({
  category,
  liveness,
  statusIconKey,
  label,
  className,
  sizeClassName = "h-3.5 w-3.5",
  inline = false,
}: ExternalObjectStatusIconProps) {
  const reducedMotion = usePrefersReducedMotion();
  const Icon = externalObjectIconForKey(statusIconKey) ?? externalObjectIconForCategory(category);
  const tone = statusIconKey === "git-merge"
    ? "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400"
    : externalObjectStatusIcon[category] ?? externalObjectStatusIconDefault;
  const livenessSuffix = liveness === "fresh" || liveness === "unknown"
    ? ""
    : ` (${externalObjectLivenessLabel(liveness)})`;
  const ariaLabel = `${label ?? externalObjectCategoryLabel(category)}${livenessSuffix}`;

  // The clock overlay needs a positioned wrapper. Inline mode keeps the icon
  // tight to the surrounding text; pill mode expects to size by sizeClassName.
  const wrapperBase = inline
    ? "relative mr-1 inline-flex shrink-0 align-[-0.125em]"
    : "relative inline-flex shrink-0";
  const iconSize = inline ? "h-3 w-3" : sizeClassName;
  const isSpinner = category === "running";
  const animateClass = isSpinner && !reducedMotion ? "animate-spin" : "";

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn(wrapperBase, className)}
    >
      <Icon
        aria-hidden="true"
        className={cn(iconSize, tone.split(" ").filter((c) => c.startsWith("text-")).join(" "), animateClass)}
      />
      {liveness === "stale" ? (
        <Clock
          aria-hidden="true"
          className={cn(
            "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-background text-muted-foreground",
            inline ? "" : "p-px",
          )}
        />
      ) : null}
    </span>
  );
}
