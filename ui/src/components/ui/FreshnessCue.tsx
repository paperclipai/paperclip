import { Clock, AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";

interface FreshnessCueProps {
  /** Last-updated timestamp (ISO string or Date). */
  updatedAt: string | Date;
  /** Custom threshold for "fresh" in ms (default 7 days). */
  freshThresholdMs?: number;
  /** Custom threshold for "stale" in ms (default 30 days). */
  staleThresholdMs?: number;
  /** If true, show a textual label. Default true. */
  showLabel?: boolean;
  className?: string;
}

type FreshnessLevel = "fresh" | "stale" | "unknown";

function computeFreshness(
  updatedAt: string | Date,
  freshThresholdMs: number,
  staleThresholdMs: number,
): FreshnessLevel {
  const now = Date.now();
  const age = typeof updatedAt === "string" ? now - new Date(updatedAt).getTime() : now - updatedAt.getTime();
  if (Number.isNaN(age) || age < 0) return "unknown";
  if (age <= freshThresholdMs) return "fresh";
  if (age <= staleThresholdMs) return "stale";
  return "unknown";
}

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIG: Record<FreshnessLevel, { color: string; label: string; icon: React.ReactNode }> = {
  fresh: {
    color: "text-green-600 dark:text-green-400",
    label: "Fresh",
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
  },
  stale: {
    color: "text-amber-600 dark:text-amber-400",
    label: "Stale",
    icon: <AlertTriangle className="h-3.5 w-3.5" />,
  },
  unknown: {
    color: "text-muted-foreground",
    label: "Unknown",
    icon: <HelpCircle className="h-3.5 w-3.5" />,
  },
};

/**
 * Visual indicator of how fresh/stale a research item is.
 *
 * Usage:
 * ```tsx
 * <FreshnessCue updatedAt={item.updatedAt} />
 * ```
 */
export function FreshnessCue({
  updatedAt,
  freshThresholdMs = FRESH_MS,
  staleThresholdMs = STALE_MS,
  showLabel = true,
  className = "",
}: FreshnessCueProps) {
  const level = computeFreshness(updatedAt, freshThresholdMs, staleThresholdMs);
  const config = CONFIG[level];

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${config.color} ${className}`}
      title={`Last updated: ${typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString()}`}
    >
      <span className="shrink-0">{config.icon}</span>
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}

/**
 * Compact dot-only freshness indicator. Same semantics as FreshnessCue
 * but only renders a colored dot — useful in tight spaces.
 */
export function FreshnessDot({
  updatedAt,
  freshThresholdMs = FRESH_MS,
  staleThresholdMs = STALE_MS,
  className = "",
}: FreshnessCueProps) {
  const level = computeFreshness(updatedAt, freshThresholdMs, staleThresholdMs);
  const colorMap: Record<FreshnessLevel, string> = {
    fresh: "bg-green-500",
    stale: "bg-amber-500",
    unknown: "bg-muted-foreground",
  };

  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${colorMap[level]} ${className}`}
      title={`${level} — last updated: ${typeof updatedAt === "string" ? updatedAt : updatedAt.toISOString()}`}
      aria-hidden="true"
    />
  );
}