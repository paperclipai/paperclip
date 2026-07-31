import {
  AlertCircle,
  AlertOctagon,
  Archive,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Clock,
  CloudOff,
  GitMerge,
  Github,
  GitPullRequest,
  KeyRound,
  Loader2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
  ExternalObjectStatusTone,
  ExternalObjectSummary,
  ExternalObjectSummaryItem,
} from "@paperclipai/shared";

/**
 * Lucide icon for each status category. The mapping is host-owned per the
 * Phase 1B security review — providers never inject inline React.
 */
export const externalObjectCategoryIcon: Record<string, LucideIcon> = {
  unknown: CircleDashed,
  open: CircleDot,
  waiting: Clock,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  blocked: AlertOctagon,
  closed: Circle,
  archived: Archive,
  auth_required: KeyRound,
  unreachable: CloudOff,
};

export const externalObjectCategoryIconDefault: LucideIcon = CircleDashed;

export function externalObjectIconForCategory(category: string): LucideIcon {
  return externalObjectCategoryIcon[category] ?? externalObjectCategoryIconDefault;
}

const EXTERNAL_OBJECT_ICON_KEYS: Record<string, LucideIcon> = {
  archive: Archive,
  check: CheckCircle2,
  "check-circle": CheckCircle2,
  circle: Circle,
  "circle-dot": CircleDot,
  clock: Clock,
  github: Github,
  "git-merge": GitMerge,
  "git-pull-request": GitPullRequest,
  key: KeyRound,
  loader: Loader2,
  "x-circle": XCircle,
};

export function externalObjectIconForKey(iconKey: string | null | undefined): LucideIcon | null {
  if (!iconKey) return null;
  return EXTERNAL_OBJECT_ICON_KEYS[iconKey] ?? null;
}

export function externalObjectIconForLiveness(liveness: string): LucideIcon | null {
  if (liveness === "auth_required") return KeyRound;
  if (liveness === "unreachable") return CloudOff;
  return null;
}

const CATEGORY_LABELS: Record<string, string> = {
  unknown: "Not yet resolved",
  open: "Open",
  waiting: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  blocked: "Blocked",
  closed: "Closed",
  archived: "Archived",
  auth_required: "Authorization required",
  unreachable: "Unreachable",
};

export function externalObjectCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

const LIVENESS_LABELS: Record<string, string> = {
  unknown: "Not yet refreshed",
  fresh: "Fresh",
  stale: "Stale",
  auth_required: "Requires auth",
  unreachable: "Unreachable",
};

export function externalObjectLivenessLabel(liveness: string): string {
  return LIVENESS_LABELS[liveness] ?? liveness.replace(/_/g, " ");
}

/**
 * Higher number = more attention-worthy. The rollups in §5 sort by tone first.
 * Mirrors `externalObjectStatusToneSeverity` in `status-colors.ts`.
 */
const TONE_SEVERITY: Record<string, number> = {
  muted: 0,
  neutral: 1,
  success: 2,
  info: 3,
  warning: 4,
  danger: 5,
};

export function externalObjectToneSeverity(tone: string | null | undefined): number {
  if (!tone) return 0;
  return TONE_SEVERITY[tone] ?? 0;
}

const CATEGORY_TONE_FALLBACK: Record<string, ExternalObjectStatusTone> = {
  unknown: "muted",
  open: "info",
  waiting: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
  blocked: "danger",
  closed: "muted",
  archived: "muted",
  auth_required: "warning",
  unreachable: "danger",
};

export function externalObjectFallbackTone(
  category: ExternalObjectStatusCategory,
): ExternalObjectStatusTone {
  return CATEGORY_TONE_FALLBACK[category] ?? "neutral";
}

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  github_pull_request: "GitHub",
  github_issue: "GitHub",
  hubspot: "HubSpot",
  linear: "Linear",
  jira: "Jira",
  notion: "Notion",
  asana: "Asana",
};

export function externalObjectProviderLabel(providerKey: string | null | undefined): string {
  if (!providerKey) return "External";
  const lookup = PROVIDER_LABELS[providerKey];
  if (lookup) return lookup;
  return providerKey
    .split(/[._-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
  pull_request: "pull request",
  issue: "issue",
  deployment: "deployment",
  workflow_run: "workflow run",
  ticket: "ticket",
  lead: "lead",
  url_link: "URL",
};

export function externalObjectTypeLabel(objectType: string | null | undefined): string {
  if (!objectType) return "object";
  return OBJECT_TYPE_LABELS[objectType] ?? objectType.replace(/_/g, " ");
}

export function externalObjectDisplayLabel(
  providerKey: string | null | undefined,
  objectType: string | null | undefined,
  displayKey?: string | null,
): string {
  const trimmedDisplayKey = displayKey?.trim();
  if (trimmedDisplayKey) return trimmedDisplayKey;
  if (providerKey === "url" && objectType === "link") return "URL";
  return `${externalObjectProviderLabel(providerKey)} ${externalObjectTypeLabel(objectType)}`;
}

/**
 * Sort summary items by severity-first ordering: danger → warning → info →
 * success → muted/neutral. Within a tone, items keep their incoming order so
 * server-side ordering (e.g. most recent change first) is preserved.
 */
export function sortExternalObjectsBySeverity<T extends ExternalObjectSummaryItem>(
  items: readonly T[],
): T[] {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTone = externalObjectToneSeverity(a.item.statusTone);
      const bTone = externalObjectToneSeverity(b.item.statusTone);
      if (aTone !== bTone) return bTone - aTone;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Compute the dominant tone in a summary — used by sidebar / list rollups.
 * Falls back to `null` when no objects are present or every tone is `muted`.
 */
export function dominantExternalObjectTone(
  summary: Pick<ExternalObjectSummary, "highestSeverity" | "objects"> | null | undefined,
): ExternalObjectStatusTone | null {
  if (!summary) return null;
  const tone = summary.highestSeverity;
  if (!tone) return null;
  if (externalObjectToneSeverity(tone) <= TONE_SEVERITY.muted) return null;
  return tone;
}

/**
 * For the sidebar / list rollup we want the count of objects matching the
 * dominant severity (e.g. "3 failed PRs"), not the global total. Returns 0
 * whenever the dominant tone is muted so callers can render based on the
 * count without double-checking the rollup-hide rule.
 */
export function externalObjectDominantCount(
  summary: Pick<ExternalObjectSummary, "highestSeverity" | "objects"> | null | undefined,
): number {
  if (!summary) return 0;
  const tone = dominantExternalObjectTone(summary);
  if (!tone) return 0;
  return summary.objects.filter((object) => object.statusTone === tone).length;
}

/**
 * Reduced motion support — match `prefers-reduced-motion: reduce` so the
 * spinning Loader2 stays static when requested. Hooks consume this via React
 * to react to runtime changes; non-hook callers can use the helper directly.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
