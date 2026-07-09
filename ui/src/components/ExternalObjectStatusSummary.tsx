import type { ExternalObjectSummary } from "@paperclipai/shared";
import {
  dominantExternalObjectTone,
  externalObjectCategoryLabel,
  externalObjectDominantCount,
  externalObjectIconForCategory,
  externalObjectIconForKey,
} from "../lib/external-objects";
import { externalObjectStatusBadge, externalObjectStatusBadgeDefault } from "../lib/status-colors";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { cn } from "../lib/utils";

interface ExternalObjectStatusSummaryProps {
  summary: ExternalObjectSummary | null | undefined;
  /** Compact mode trims everything down to the icon + count, no label text. */
  compact?: boolean;
  className?: string;
}

function dominantCategory(summary: ExternalObjectSummary): string {
  // Prefer the first object that matches the highestSeverity tone, since the
  // server has already ranked them server-side.
  const match = summary.objects.find((object) => object.statusTone === summary.highestSeverity);
  return match?.statusCategory ?? "unknown";
}

function dominantObject(summary: ExternalObjectSummary) {
  return summary.objects.find((object) => object.statusTone === summary.highestSeverity) ?? null;
}

function buildBreakdownTitle(summary: ExternalObjectSummary): string {
  const parts: string[] = [];
  for (const [category, count] of Object.entries(summary.byStatusCategory)) {
    if (!count) continue;
    parts.push(`${count} ${externalObjectCategoryLabel(category).toLowerCase()}`);
  }
  if (summary.staleCount > 0) parts.push(`${summary.staleCount} stale`);
  parts.push(`${summary.total} total`);
  return `External objects: ${parts.join(", ")}`;
}

/**
 * Compact rollup marker used by sidebar projects and issue list rows. Renders
 * the dominant severity icon plus a count badge. Hidden when there are zero
 * external objects or every object is in a muted tone.
 */
// design-allow(pill-pattern): COMPONENT-INVENTORY §5.1 — external-object status is a deliberately
// separate status-presentation family; not a Badge.
export function ExternalObjectStatusSummary({
  summary,
  compact,
  className,
}: ExternalObjectStatusSummaryProps) {
  const reducedMotion = usePrefersReducedMotion();
  const tone = dominantExternalObjectTone(summary);
  const total = summary?.total ?? 0;
  if (!summary || total === 0 || !tone) return null;

  const object = dominantObject(summary);
  const category = object?.statusCategory ?? dominantCategory(summary);
  const Icon = externalObjectIconForKey(object?.statusIconKey) ?? externalObjectIconForCategory(category);
  const badgeClass = externalObjectStatusBadge[category] ?? externalObjectStatusBadgeDefault;
  const dominantCount = externalObjectDominantCount(summary);
  const title = buildBreakdownTitle(summary);
  const animateClass = category === "running" && !reducedMotion ? "animate-spin" : "";

  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-(length:--text-nano) font-medium tabular-nums leading-none",
        badgeClass,
        compact && "px-1 py-0.5",
        className,
      )}
      data-external-status={category}
      data-external-tone={tone}
    >
      <Icon aria-hidden="true" className={cn("h-3 w-3 shrink-0", animateClass)} />
      <span>{dominantCount > 0 ? dominantCount : total}</span>
    </span>
  );
}
