import type {
  AlertmanagerPluginConfig,
  OwnerMap,
  PaperclipPriority,
} from "./types.js";

export const PLUGIN_ID = "paperclip-plugin-alertmanager";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  alertmanager: "alertmanager",
} as const;

export const STATE_KEYS = {
  /** Per-fingerprint dedup row. See spec §6. */
  alert: (fingerprint: string) => `alert:${fingerprint}`,
  /** Per-email cached Paperclip user id (positive cache). Empty string = negative cache. */
  ownerByEmail: (email: string) => `owner-by-email:${email}`,
  /** Mirror of config.ownerMap — editable from UI without re-deploying. */
  ownerMap: "owner-map",
} as const;

/**
 * Default severity → priority map. Operators can override via
 * `config.severityToPriority`.
 */
export const DEFAULT_SEVERITY_TO_PRIORITY: Record<string, PaperclipPriority> = {
  critical: "critical",
  warning: "high",
  info: "medium",
};

/** Default owner routes shipped with the bundled Blockcast Alertmanager plugin. */
export const DEFAULT_OWNER_MAP: OwnerMap = {
  class: {
    paperclip_claude_k8s: "support@blockcast.net",
    // BLO-10699: byte-usage watermark alert on the shared `paperclip-data`
    // CephFS PVC (PaperclipDataVolumeNearlyFull/Critical). Routes to support
    // so a filling shared HOME is owned, not unassigned.
    paperclip_data_volume: "support@blockcast.net",
  },
};

/** Fallback priority when severity is unknown / unmapped. */
export const FALLBACK_PRIORITY: PaperclipPriority = "medium";

/**
 * Reserved annotation keys treated as drill-in URLs. See spec §7.6 — order
 * here is the rendered order in the issue body.
 */
export const OBSERVABILITY_URL_KEYS = [
  "dashboard_url",
  "trace_url",
  "profile_url",
  "logs_url",
  "flow_query_url",
  "runbook_url",
  "generator_url",
] as const;

/**
 * Human-readable labels for each drill-in URL key.
 */
export const OBSERVABILITY_URL_LABELS: Record<
  (typeof OBSERVABILITY_URL_KEYS)[number],
  string
> = {
  dashboard_url: "Dashboard",
  trace_url: "Tempo trace",
  profile_url: "Pyroscope flamegraph",
  logs_url: "Loki / journal logs",
  flow_query_url: "Hubble flow query",
  runbook_url: "Runbook",
  generator_url: "Source query in Prometheus",
};

/**
 * Label key on an alert that overrides owner resolution. See §7.7 step 1.
 */
export const ASSIGNEE_OVERRIDE_LABEL = "paperclip_assignee_email";
/** Annotation equivalent of the override label. §7.7 step 3. */
export const ASSIGNEE_OVERRIDE_ANNOTATION = "paperclip_assignee_email";

/**
 * Default plugin config. Used as the schema default in the manifest and as a
 * test-harness baseline.
 */
export const DEFAULT_CONFIG: AlertmanagerPluginConfig = {
  defaultCompanyId: "",
  webhookTokenRef: "",
  webhookToken: "",
  acceptOnlyLabels: {},
  severityToPriority: DEFAULT_SEVERITY_TO_PRIORITY,
  autoCloseOnResolve: false,
  ownerMap: DEFAULT_OWNER_MAP,
};

/**
 * Schema versions of the AM v2 envelope this plugin accepts. Anything else is
 * logged + dropped so a poison payload doesn't back up Alertmanager's queue.
 */
export const ACCEPTED_SCHEMA_VERSIONS = new Set(["4"]);
