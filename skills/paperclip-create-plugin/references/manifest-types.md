import type {
  PluginStatus,
  PluginCategory,
  PluginCapability,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginStateScopeKind,
} from "../constants.js";

// ---------------------------------------------------------------------------
// JSON Schema placeholder – plugins declare config schemas as JSON Schema
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object used for plugin config schemas and tool parameter schemas.
 * Plugins provide these as plain JSON Schema compatible objects.
 */
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Manifest sub-types — nested declarations within PaperclipPluginManifestV1
// ---------------------------------------------------------------------------

/**
 * Declares a scheduled job a plugin can run.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
export interface PluginJobDeclaration {
  /** Stable identifier for this job, unique within the plugin. */
  jobKey: string;
  /** Human-readable name shown in the operator UI. */
  displayName: string;
  /** Optional description of what the job does. */
  description?: string;
  /** Cron expression for the schedule (e.g. "star/15 star star star star" or "0 * * * *"). */
  schedule?: string;
}

/**
 * Declares a webhook endpoint the plugin can receive.
 * Route: `POST /api/plugins/:pluginId/webhooks/:endpointKey`
 *
 * @see PLUGIN_SPEC.md §18 — Webhooks
 */
export interface PluginWebhookDeclaration {
  /** Stable identifier for this endpoint, unique within the plugin. */
  endpointKey: string;
  /** Human-readable name shown in the operator UI. */
  displayName: string;
  /** Optional description of what this webhook handles. */
  description?: string;
}

/**
 * Declares an agent tool contributed by the plugin. Tools are namespaced
 * by plugin ID at runtime (e.g. `linear:search-issues`).
 *
 * Requires the `agent.tools.register` capability.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export interface PluginToolDeclaration {
  /** Tool name, unique within the plugin. Namespaced by plugin ID at runtime. */
  name: string;
  /** Human-readable name shown to agents and in the UI. */
  displayName: string;
  /** Description provided to the agent so it knows when to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: JsonSchema;
}

/**
 * Declares a UI extension slot the plugin fills with a React component.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export interface PluginUiSlotDeclaration {
  /** The type of UI mount point (page, detailTab, taskDetailView, toolbarButton, etc.). */
  type: PluginUiSlotType;
  /** Unique slot identifier within the plugin. */
  id: string;
  /** Human-readable name shown in navigation or tab labels. */
  displayName: string;
  /** Which export name in the UI bundle provides this component. */
  exportName: string;
  /**
   * Entity targets for context-sensitive slots.
   * Required for `detailTab`, `taskDetailView`, and `contextMenuItem`.
   */
  entityTypes?: PluginUiSlotEntityType[];
  /**
   * Optional ordering hint within a slot surface. Lower numbers appear first.
   * Defaults to host-defined ordering if omitted.
   */
  order?: number;
}

// ---------------------------------------------------------------------------
// Plugin Manifest V1
// ---------------------------------------------------------------------------

/**
 * The manifest shape every plugin package must export.
 * See PLUGIN_SPEC.md §10.1 for the normative definition.
 */
export interface PaperclipPluginManifestV1 {
  /** Globally unique plugin identifier (e.g. `"acme.linear-sync"`). Must be lowercase alphanumeric with dots, hyphens, or underscores. */
  id: string;
  /** Plugin API version. Must be `1` for the current spec. */
  apiVersion: 1;
  /** Semver version of the plugin package (e.g. `"1.2.0"`). */
  version: string;
  /** Human-readable name (max 100 chars). */
  displayName: string;
  /** Short description (max 500 chars). */
  description: string;
  /** Author name (max 200 chars). May include email in angle brackets, e.g. `"Jane Doe <jane@example.com>"`. */
  author: string;
  /** One or more categories classifying this plugin. */
  categories: PluginCategory[];
  /** Minimum Paperclip host version required (semver). */
  minimumPaperclipVersion?: string;
  /** Capabilities this plugin requires from the host. Enforced at runtime. */
  capabilities: PluginCapability[];
  /** Entrypoint paths relative to the package root. */
  entrypoints: {
    /** Path to the worker entrypoint (required). */
    worker: string;
    /** Path to the UI bundle directory (required when `ui.slots` is declared). */
    ui?: string;
  };
  /** JSON Schema for operator-editable instance configuration. */
  instanceConfigSchema?: JsonSchema;
  /** Scheduled jobs this plugin declares. Requires `jobs.schedule` capability. */
  jobs?: PluginJobDeclaration[];
  /** Webhook endpoints this plugin declares. Requires `webhooks.receive` capability. */
  webhooks?: PluginWebhookDeclaration[];
  /** Agent tools this plugin contributes. Requires `agent.tools.register` capability. */
  tools?: PluginToolDeclaration[];
  /** UI extension slots this plugin fills. Requires `entrypoints.ui`. */
  ui?: {
    slots: PluginUiSlotDeclaration[];
  };
}

// ---------------------------------------------------------------------------
// Plugin Record – represents a row in the `plugins` table
// ---------------------------------------------------------------------------

/**
 * Domain type for an installed plugin as persisted in the `plugins` table.
 * See PLUGIN_SPEC.md §21.3 for the schema definition.
 */
export interface PluginRecord {
  /** UUID primary key. */
  id: string;
  /** Unique key derived from `manifest.id`. Used for lookups. */
  pluginKey: string;
  /** npm package name (e.g. `"@acme/plugin-linear"`). */
  packageName: string;
  /** Installed semver version. */
  version: string;
  /** Plugin API version from the manifest. */
  apiVersion: number;
  /** Plugin categories from the manifest. */
  categories: PluginCategory[];
  /** Full manifest snapshot persisted at install/upgrade time. */
  manifestJson: PaperclipPluginManifestV1;
  /** Current lifecycle status. */
  status: PluginStatus;
  /** Deterministic load order (null if not yet assigned). */
  installOrder: number | null;
  /** Resolved package path for local-path installs; used to find worker entrypoint. */
  packagePath: string | null;
  /** Most recent error message, or `"disabled_by_operator"` sentinel. */
  lastError: string | null;
  /** Timestamp when the plugin was first installed. */
  installedAt: Date;
  /** Timestamp of the most recent status or metadata change. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin State – represents a row in the `plugin_state` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a single scoped key-value entry in the `plugin_state` table.
 * Plugins read and write these entries through `ctx.state` in the SDK.
 *
 * The five-part composite key `(pluginId, scopeKind, scopeId, namespace, stateKey)`
 * uniquely identifies a state entry.
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state`
 */
export interface PluginStateRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** Granularity of the scope. */
  scopeKind: PluginStateScopeKind;
  /**
   * UUID or text identifier for the scoped object.
   * `null` for `instance` scope (no associated entity).
   */
  scopeId: string | null;
  /**
   * Sub-namespace within the scope to avoid key collisions.
   * Defaults to `"default"` if not explicitly set by the plugin.
   */
  namespace: string;
  /** The key for this state entry within the namespace. */
  stateKey: string;
  /** Stored JSON value. May be any JSON-serializable type. */
  valueJson: unknown;
  /** Timestamp of the most recent write. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Config – represents a row in the `plugin_config` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a plugin's instance configuration as persisted in the
 * `plugin_config` table.
 * See PLUGIN_SPEC.md §21.3 for the schema definition.
 */
export interface PluginConfig {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. Unique — each plugin has at most one config row. */
  pluginId: string;
  /** Operator-provided configuration values (validated against `instanceConfigSchema`). */
  configJson: Record<string, unknown>;
  /** Most recent config validation error, if any. */
  lastError: string | null;
  /** Timestamp when the config row was created. */
  createdAt: Date;
  /** Timestamp of the most recent config update. */
  updatedAt: Date;
}

/**
 * Query filter for `ctx.entities.list`.
 */
export interface PluginEntityQuery {
  /** Optional filter by entity type (e.g. 'project', 'issue'). */
  entityType?: string;
  /** Optional filter by external system identifier. */
  externalId?: string;
  /** Maximum number of records to return. Defaults to 100. */
  limit?: number;
  /** Number of records to skip. Defaults to 0. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Plugin Entity – represents a row in the `plugin_entities` table
// ---------------------------------------------------------------------------

/**
 * Domain type for an external entity mapping as persisted in the `plugin_entities` table.
 */
export interface PluginEntityRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** Plugin-defined entity type. */
  entityType: string;
  /** Scope where this entity lives. */
  scopeKind: PluginStateScopeKind;
  /** UUID or text identifier for the scoped object. */
  scopeId: string | null;
  /** External identifier in the remote system. */
  externalId: string | null;
  /** Human-readable title. */
  title: string | null;
  /** Optional status string. */
  status: string | null;
  /** Full entity data blob. */
  data: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Job – represents a row in the `plugin_jobs` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a registered plugin job as persisted in the `plugin_jobs` table.
 */
export interface PluginJobRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** Job key matching the manifest declaration. */
  jobKey: string;
  /** Cron expression for the schedule. */
  schedule: string;
  /** Current job status. */
  status: "active" | "paused" | "failed";
  /** Last time the job was executed. */
  lastRunAt: Date | null;
  /** Next scheduled execution time. */
  nextRunAt: Date | null;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Job Run – represents a row in the `plugin_job_runs` table
// ---------------------------------------------------------------------------

/**
 * Domain type for a job execution history record.
 */
export interface PluginJobRunRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugin_jobs.id`. */
  jobId: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** What triggered this run. */
  trigger: "schedule" | "manual" | "retry";
  /** Current run status. */
  status: "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** Run duration in milliseconds. */
  durationMs: number | null;
  /** Error message if the run failed. */
  error: string | null;
  /** Run logs. */
  logs: string[];
  /** ISO 8601 start timestamp. */
  startedAt: Date | null;
  /** ISO 8601 finish timestamp. */
  finishedAt: Date | null;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Plugin Webhook Delivery – represents a row in the `plugin_webhook_deliveries` table
// ---------------------------------------------------------------------------

/**
 * Domain type for an inbound webhook delivery record.
 */
export interface PluginWebhookDeliveryRecord {
  /** UUID primary key. */
  id: string;
  /** FK to `plugins.id`. */
  pluginId: string;
  /** Webhook endpoint key matching the manifest. */
  webhookKey: string;
  /** External identifier from the remote system. */
  externalId: string | null;
  /** Delivery status. */
  status: "pending" | "success" | "failed";
  /** Processing duration in milliseconds. */
  durationMs: number | null;
  /** Error message if processing failed. */
  error: string | null;
  /** Webhook payload. */
  payload: Record<string, unknown>;
  /** Webhook headers. */
  headers: Record<string, string>;
  /** ISO 8601 start timestamp. */
  startedAt: Date | null;
  /** ISO 8601 finish timestamp. */
  finishedAt: Date | null;
  /** ISO 8601 creation timestamp. */
  createdAt: Date;
}
