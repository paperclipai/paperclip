export const PLUGIN_ID = "paperclip.cost-clipper";
export const PLUGIN_VERSION = "0.1.0";

export const DATA_KEYS = {
  overview: "cost-clipper-overview",
} as const;

export const SLOT_IDS = {
  dashboardWidget: "cost-clipper-widget",
} as const;

export const EXPORT_NAMES = {
  dashboardWidget: "CostClipperWidget",
} as const;

/** Plugin-state keys, all under scopeKind "company". */
export const STATE_KEYS = {
  /** Rolling per-agent cost aggregates for a company. */
  aggregates: "aggregates",
  /** Recent anomaly incidents (capped ring). */
  anomalies: "anomalies",
  /** Open budget incidents observed for a company. */
  budgetIncidents: "budget-incidents",
} as const;

export const METRIC_NAMES = {
  costEvent: "cost_clipper.cost_event",
  anomaly: "cost_clipper.anomaly",
} as const;

/** Most recent anomalies retained per company for the dashboard. */
export const MAX_RECENT_ANOMALIES = 50;

export type CostClipperConfig = {
  /** Min cost events for an agent before the z-score rule may fire. */
  minSamples: number;
  /** Z-score threshold above the agent's rolling mean. */
  zThreshold: number;
  /** Absolute single-event ceiling in cents; trips regardless of history. */
  absoluteCentsCeiling: number;
  /** Post an issue comment when an anomaly is attributable to an issue. */
  commentOnAnomaly: boolean;
};

export const DEFAULT_CONFIG: CostClipperConfig = {
  minSamples: 8,
  zThreshold: 3,
  absoluteCentsCeiling: 5000,
  commentOnAnomaly: true,
};
