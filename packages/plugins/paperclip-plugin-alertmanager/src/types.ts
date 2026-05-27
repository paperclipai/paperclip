/**
 * Type definitions for paperclip-plugin-alertmanager.
 *
 * Mirrors the structure of `paperclip-plugin-slack/src/types.ts`: a config
 * interface, plus payload types for the foreign system the plugin integrates
 * with (here, the Alertmanager v2 webhook envelope).
 */

import type { PluginIssueOriginKind } from "@paperclipai/shared";

/**
 * Severity levels mapped from `alert.labels.severity` to a Paperclip issue
 * priority. Anything outside this enum falls back to the default priority.
 */
export type AlertSeverity = "critical" | "warning" | "info" | string;

/**
 * Paperclip issue priority values accepted by `ctx.issues.create`. Mirrors
 * the runtime enum on the server. Kept narrow so the severity-to-priority map
 * cannot produce an unsupported value.
 */
export type PaperclipPriority = "critical" | "high" | "medium" | "low";

/**
 * Owner-map config: per-instance mapping from a label-key (e.g. `team`) to a
 * value→email map (e.g. `{ platform: "alice@blockcast.net" }`). Resolution
 * order is defined in §7.7 of the spec.
 */
export type OwnerMap = Record<string, Record<string, string>>;

/**
 * Plugin instance config. Validated by the host against the manifest's
 * `instanceConfigSchema` before being passed to the worker.
 */
export interface AlertmanagerPluginConfig {
  /** Company that receives alerts when no company-routing label is present. */
  defaultCompanyId: string;
  /**
   * Optional secret reference to the static bearer token Alertmanager uses
   * when posting webhooks. If empty, webhook authentication is disabled
   * (NOT recommended for production — see README security notes).
   */
  webhookTokenRef?: string;
  /**
   * Inline bearer token. Useful for local development and testing where
   * setting up secret refs is overkill. Resolved via `webhookTokenRef` first;
   * falls back to this if the ref is unset.
   */
  webhookToken?: string;
  /**
   * If set, only alerts whose labels match all of these key=value pairs are
   * accepted. Use to scope a shared-tenancy AM cluster.
   */
  acceptOnlyLabels?: Record<string, string>;
  /**
   * Map from Alertmanager severity label (e.g. `critical`, `warning`, `info`)
   * to a Paperclip issue priority. Defaults are merged with this map.
   */
  severityToPriority?: Record<string, PaperclipPriority>;
  /**
   * If true, transitions the issue to status=done when AM sends
   * status=resolved. If false, posts a "resolved at <ts>" comment and leaves
   * status alone.
   */
  autoCloseOnResolve?: boolean;
  /**
   * Per-instance owner map. e.g. `{ team: { platform: "alice@blockcast.net" }}`.
   */
  ownerMap?: OwnerMap;
}

// ---------------------------------------------------------------------------
// Alertmanager v2 webhook payload — see spec §5 and Prometheus docs:
// https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
// https://prometheus.io/docs/alerting/latest/notifications/
// ---------------------------------------------------------------------------

/** Alert status as reported by Alertmanager. */
export type AlertmanagerAlertStatus = "firing" | "resolved";

/**
 * One element of the `alerts[]` array in an AM v2 webhook payload.
 *
 * Notes:
 * - `endsAt` is set to `0001-01-01T00:00:00Z` (Go zero time) for firing alerts.
 * - `fingerprint` is `hash(sorted(labels))`; stable across firings of the
 *   same labels, different across pods/nodes.
 */
export interface AlertmanagerAlert {
  status: AlertmanagerAlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint: string;
}

/** Top-level AM v2 webhook envelope. */
export interface AlertmanagerWebhookPayload {
  /** Schema version. Currently always `"4"`. */
  version: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status: AlertmanagerAlertStatus;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  alerts: AlertmanagerAlert[];
}

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

/**
 * Per-fingerprint state row. Lives at `alert:<fingerprint>` in the instance
 * scope. See spec §6.
 */
export interface AlertStateRecord {
  paperclipIssueId: string;
  paperclipCompanyId: string;
  assigneeUserId: string | null;
  /**
   * Set when ownerMap routes to an agent via the `agent:<id>` value syntax.
   * Mutually exclusive with `assigneeUserId` — at most one is non-null.
   */
  assigneeAgentId: string | null;
  alertname: string;
  severity: string;
  firstSeenAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
}

/**
 * Origin kind tag we stamp onto created issues. Plugin-namespaced so that
 * future Paperclip features (e.g. inbox grouping) can recognize alerts.
 */
export const ORIGIN_KIND: PluginIssueOriginKind =
  "plugin:paperclip-plugin-alertmanager";

/**
 * Reserved annotation keys rendered as drill-in links. Keys not in this list
 * are NOT rendered as links — see spec §7.6 "Why a fixed key allowlist".
 */
export interface ObservabilityUrls {
  dashboard_url?: string;
  trace_url?: string;
  profile_url?: string;
  logs_url?: string;
  flow_query_url?: string;
  runbook_url?: string;
  generator_url?: string;
}

/**
 * Result of the owner-resolution pipeline (§7.7). Carries the email OR
 * the agentId that matched (so the caller can log it) plus which step
 * produced it. `email` and `agentId` are mutually exclusive — at most one
 * is set on any non-`no-match` resolution.
 *
 * ownerMap values prefixed with `agent:<uuid>` (case-insensitive prefix)
 * resolve to `agentId` and bypass the `users.findByEmail` cache lookup.
 * Plain email values resolve to `email` and follow the original §7.7
 * email → user-id flow.
 */
export interface OwnerResolution {
  email: string | null;
  agentId: string | null;
  source:
    | "label-override"
    | "owner-map"
    | "annotation-override"
    | "no-match";
}
