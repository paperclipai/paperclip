import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey, normalizeProjectUrlKey, hasNonAsciiContent } from "@paperclipai/shared";
import type { BillingActivity, Issue } from "@paperclipai/shared";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDurationMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCents(cents: number, lng = "en-US"): string {
  return `$${(cents / 100).toLocaleString(lng, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumber(n: number, lng = "en-US"): string {
  return n.toLocaleString(lng);
}

export function formatDate(date: Date | string, lng = "en-US"): string {
  return new Date(date).toLocaleDateString(lng, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(date: Date | string, lng = "en-US"): string {
  return new Date(date).toLocaleString(lng, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatShortDate(date: Date | string, lng = "en-US"): string {
  return new Date(date).toLocaleString(lng, {
    month: "short",
    day: "numeric",
  });
}

export function relativeTime(date: Date | string, lng = "en-US"): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(date, lng);
}

export function visibleRunCostUsd(run: { totalCostCents?: number | null; totalCostCentsBilled?: number | null }): number | null {
  const cents = run.totalCostCentsBilled ?? run.totalCostCents;
  if (typeof cents !== "number" || cents <= 0) return null;
  return cents / 100;
}

export function activityCostCents(activity: BillingActivity): number {
  return (activity.runTotalCostCentsBilled ?? 0) + (activity.overageCostCents ?? 0);
}

export function agentUrl(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  const key = agent.urlKey ?? (agent.name ? deriveAgentUrlKey(agent.name) : null) ?? agent.id;
  return `/agents/${key}`;
}

export function projectUrl(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  const key = project.urlKey ?? (project.name ? deriveProjectUrlKey(project.name) : null) ?? project.id;
  return `/projects/${key}`;
}

/** Normalizes a raw input string (e.g. from a URL or text box) into a valid URL key. */
export function normalizeUrlKey(input: string): string {
  return normalizeProjectUrlKey(input);
}

/** True if the string contains characters outside the ASCII range. */
export function hasNonAscii(input: string): boolean {
  return hasNonAsciiContent(input);
}

/** Returns the project-relative URL for a project workspace. */
export function projectWorkspacePath(project: { id: string; urlKey?: string | null; name?: string | null }, workspaceId: string): string {
  const pUrl = projectUrl(project);
  return `${pUrl}/workspaces/${workspaceId}`;
}

/** Returns the absolute URL for a project workspace, including the domain if needed, though typically just the full app URL scoped under its project. */
export function projectWorkspaceUrl(
  project: { id: string; urlKey?: string | null; name?: string | null },
  workspaceId: string,
): string {
  return `${projectUrl(project)}/workspaces/${workspaceId}`;
}
