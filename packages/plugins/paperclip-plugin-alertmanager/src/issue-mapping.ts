/**
 * Pure functions that turn an Alertmanager v2 alert into the title,
 * description, priority, and drill-in link block we hand to
 * `ctx.issues.create`.
 *
 * These functions are intentionally side-effect-free so they can be unit
 * tested without spinning up a plugin context or mocking the host RPC.
 */

import {
  DEFAULT_SEVERITY_TO_PRIORITY,
  FALLBACK_PRIORITY,
  OBSERVABILITY_URL_KEYS,
  OBSERVABILITY_URL_LABELS,
} from "./constants.js";
import type {
  AlertmanagerAlert,
  AlertmanagerWebhookPayload,
  ObservabilityUrls,
  PaperclipPriority,
} from "./types.js";

/**
 * Map an alert's severity label to a Paperclip priority value.
 *
 * Resolution order:
 *   1. operator override map (`severityToPriority`)
 *   2. built-in default map (`DEFAULT_SEVERITY_TO_PRIORITY`)
 *   3. `FALLBACK_PRIORITY` ("medium")
 *
 * Severities are matched case-insensitively against the keys of both maps.
 */
export function severityToPriority(
  severity: string | undefined,
  override?: Record<string, PaperclipPriority>,
): PaperclipPriority {
  if (!severity) return FALLBACK_PRIORITY;
  const key = severity.trim().toLowerCase();
  if (!key) return FALLBACK_PRIORITY;
  if (override && key in override) {
    const value = override[key];
    if (value !== undefined) return value;
  }
  if (key in DEFAULT_SEVERITY_TO_PRIORITY) {
    const value = DEFAULT_SEVERITY_TO_PRIORITY[key];
    if (value !== undefined) return value;
  }
  return FALLBACK_PRIORITY;
}

/**
 * Build the issue title per spec §7.1:
 *   `[<severity>] <alertname>  ·  <commonLabels.team or node or "">`
 *
 * Trailing-context segment is omitted (with the separator) when neither
 * team nor node is present, so we don't end up with a stray `·`.
 */
export function buildIssueTitle(
  alert: AlertmanagerAlert,
  envelope?: Pick<AlertmanagerWebhookPayload, "commonLabels">,
): string {
  const severity = alert.labels.severity ?? "unknown";
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const commonLabels = envelope?.commonLabels ?? {};
  const context =
    alert.labels.team ??
    alert.labels.node ??
    commonLabels.team ??
    commonLabels.node ??
    "";
  const head = `[${severity}] ${alertname}`;
  return context ? `${head} · ${context}` : head;
}

/**
 * Pull observability URLs (the reserved annotation keys from §7.6) off an
 * alert. Unknown `*_url` annotation keys are NOT included — surface them by
 * logging if you want to spot gaps.
 */
export function extractObservabilityUrls(
  alert: AlertmanagerAlert,
): ObservabilityUrls {
  const out: ObservabilityUrls = {};
  for (const key of OBSERVABILITY_URL_KEYS) {
    if (key === "generator_url") {
      // generator_url is sourced from `alert.generatorURL`, not an annotation.
      if (alert.generatorURL) out[key] = alert.generatorURL;
      continue;
    }
    const value = alert.annotations[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render the drill-in section of the issue body.
 *
 * Empty input → returns `""` (caller is expected to skip rendering the
 * section header in that case).
 */
export function renderDrillInLinks(urls: ObservabilityUrls): string {
  const lines: string[] = [];
  for (const key of OBSERVABILITY_URL_KEYS) {
    const url = urls[key];
    if (!url) continue;
    lines.push(`- [${OBSERVABILITY_URL_LABELS[key]}](${url})`);
  }
  if (lines.length === 0) return "";
  return ["### Drill in", ...lines].join("\n");
}

/**
 * Render the labels table per spec §7.2. Sorted by key for stable output.
 */
function renderLabelsTable(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "_(no labels)_";
  const rows = keys.map((k) => `| ${k} | ${labels[k]} |`);
  return ["| key | value |", "|-----|-------|", ...rows].join("\n");
}

/**
 * Build the full issue description (markdown body) per spec §7.2 + §7.6.
 *
 * Layout:
 *
 *   **Summary**: <annotations.summary or alertname>
 *
 *   <annotations.description>
 *
 *   **Started**: <startsAt>
 *   **Severity**: <severity>
 *   **Source**: <generatorURL>
 *   **Runbook**: <annotations.runbook_url or "—">
 *
 *   ### Labels
 *   | key | value |
 *   ...
 *
 *   ### Drill in
 *   - [Dashboard](...)
 *   ...
 */
export function buildIssueDescription(alert: AlertmanagerAlert): string {
  const summary =
    alert.annotations.summary ??
    alert.labels.alertname ??
    "Alert firing";
  const description = alert.annotations.description ?? "";
  const severity = alert.labels.severity ?? "unknown";
  const source = alert.generatorURL ?? "—";
  const runbook = alert.annotations.runbook_url ?? "—";

  const sections: string[] = [];
  sections.push(`**Summary**: ${summary}`);
  if (description) sections.push(description);
  sections.push(
    [
      `**Started**: ${alert.startsAt}`,
      `**Severity**: ${severity}`,
      `**Source**: ${source}`,
      `**Runbook**: ${runbook}`,
    ].join("\n"),
  );
  sections.push(`### Labels\n${renderLabelsTable(alert.labels)}`);

  const drillIn = renderDrillInLinks(extractObservabilityUrls(alert));
  if (drillIn) sections.push(drillIn);

  return sections.join("\n\n");
}

/**
 * `acceptOnlyLabels` filter (§5.2 step 4). All key=value pairs in `filter`
 * must be present and equal on `alert.labels` for the alert to be accepted.
 * Empty/unset `filter` means accept-all.
 */
export function alertMatchesLabelFilter(
  alert: AlertmanagerAlert,
  filter: Record<string, string> | undefined,
): boolean {
  if (!filter) return true;
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  for (const key of keys) {
    if (alert.labels[key] !== filter[key]) return false;
  }
  return true;
}

/**
 * Effective alert status per §5.2 step 4: prefer the per-alert status, fall
 * back to the envelope status if missing.
 */
export function effectiveAlertStatus(
  alert: AlertmanagerAlert,
  envelope: Pick<AlertmanagerWebhookPayload, "status">,
): "firing" | "resolved" {
  return alert.status ?? envelope.status;
}
