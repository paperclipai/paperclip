import type {
  PluginStatus,
  PluginCategory,
  PluginCapability,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginStateScopeKind,
  PluginLauncherPlacementZone,
  PluginLauncherAction,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginApiRouteAuthMode,
  PluginApiRouteCheckoutPolicy,
  PluginApiRouteMethod,
  PluginDatabaseCoreReadTable,
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceMode,
  PluginDatabaseNamespaceStatus,
  AgentAdapterType,
  AgentRole,
  AgentStatus,
  IssuePriority,
  ProjectStatus,
  RoutineCatchUpPolicy,
  RoutineConcurrencyPolicy,
  RoutineStatus,
  IssueSurfaceVisibility,
} from "../constants.js";
import type { Agent } from "./agent.js";
import type { CompanySkill } from "./company-skill.js";
import type { Project } from "./project.js";
import type { Routine, RoutineTrigger, RoutineVariable } from "./routine.js";

// ---------------------------------------------------------------------------
// JSON Schema placeholder – plugins declare config schemas as JSON Schema
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object used for plugin config schemas and tool parameter schemas.
 * Plugins provide these as plain JSON Schema compatible objects.
 */
export type JsonSchema = Record<string, unknown>;

export type {
  PluginDatabaseCoreReadTable,
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceMode,
  PluginDatabaseNamespaceStatus,
} from "../constants.js";

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
 * Declares an environment runtime driver contributed by the plugin.
 *
 * Requires the `environment.drivers.register` capability.
 */
export interface PluginEnvironmentDriverDeclaration {
  /** Stable driver key, unique within the plugin. Namespaced by plugin ID at runtime. */
  driverKey: string;
  /**
   * Driver classification.
   *
   * `environment_driver` is used by core `driver: "plugin"` environments.
   * `sandbox_provider` is used by core `driver: "sandbox"` environments whose
   * provider key is implemented by a plugin.
   */
  kind?: "environment_driver" | "sandbox_provider";
  /** Human-readable name shown in environment configuration UI. */
  displayName: string;
  /** Optional description for operator-facing docs or UI affordances. */
  description?: string;
  /** JSON Schema describing the driver's provider-specific configuration. */
  configSchema: JsonSchema;
}

/**
 * Declares a normal Paperclip agent that a plugin can provision and later
 * resolve by stable key within each company.
 */
export interface PluginManagedAgentDeclaration {
  /** Stable identifier for this managed agent, unique within the plugin. */
  agentKey: string;
  /** Suggested visible agent name. */
  displayName: string;
  /** Optional suggested role. Defaults to `general`. */
  role?: AgentRole | string;
  /** Optional suggested title shown in agent surfaces. */
  title?: string | null;
  /** Optional icon for agent list/detail surfaces. */
  icon?: string | null;
  /** Suggested capability summary for the agent. */
  capabilities?: string | null;
  /** Suggested adapter type. Defaults to `process`. */
  adapterType?: AgentAdapterType | string;
  /**
   * Optional ordered list of compatible adapter types. When present, the host
   * prefers the most-used compatible adapter already configured in the company,
   * falling back to `adapterType`.
   */
  adapterPreference?: Array<AgentAdapterType | string>;
  /** Suggested adapter configuration. */
  adapterConfig?: Record<string, unknown>;
  /** Suggested Paperclip runtime configuration. */
  runtimeConfig?: Record<string, unknown>;
  /** Suggested permissions object. Normalized by the host on create/reset. */
  permissions?: Record<string, unknown>;
  /** Suggested starting status when no board approval is required. */
  status?: Extract<AgentStatus, "idle" | "paused">;
  /** Suggested monthly budget in cents. */
  budgetMonthlyCents?: number;
  /** Optional managed instructions content or pointer metadata for plugin UI. */
  instructions?: {
    entryFile?: string;
    content?: string;
    files?: Record<string, string>;
    assetPath?: string;
  };
}

/**
 * Declares a company-scoped local folder a trusted plugin wants the operator
 * to configure. The host treats this as a generic filesystem root: plugin
 * code may request required relative folders/files, then use SDK helpers for
 * path-safe reads and atomic writes under that root.
 */
export interface PluginLocalFolderDeclaration {
  /** Stable identifier for this folder, unique within the plugin. */
  folderKey: string;
  /** Human-readable name shown in plugin settings. */
  displayName: string;
  /** Optional operator-facing description. */
  description?: string;
  /** Access level requested by the plugin. Defaults to `readWrite`. */
  access?: "read" | "readWrite";
  /** Relative directories expected to exist under the configured root. */
  requiredDirectories?: string[];
  /** Relative files expected to exist under the configured root. */
  requiredFiles?: string[];
}

/**
 * Declares a normal Paperclip project that a plugin can provision and later
 * resolve by stable key within each company.
 */
export interface PluginManagedProjectDeclaration {
  /** Stable identifier for this managed project, unique within the plugin. */
  projectKey: string;
  /** Suggested visible project name. */
  displayName: string;
  /** Suggested project description. */
  description?: string | null;
  /** Suggested starting status. Defaults to `in_progress`. */
  status?: ProjectStatus;
  /** Suggested project color. Defaults to the normal project palette. */
  color?: string | null;
  /** Optional plugin-specific defaults retained for reset/reconcile UI. */
  settings?: Record<string, unknown>;
}

export interface PluginManagedSkillFileDeclaration {
  /** Relative path inside the skill folder, for example `references/guide.md`. */
  path: string;
  /** File contents written when the skill is installed or reset. */
  content: string;
}

/**
 * Declares a company skill that a plugin can install into each company's
 * skills library and later resolve by stable key.
 */
export interface PluginManagedSkillDeclaration {
  /** Stable identifier for this managed skill, unique within the plugin. */
  skillKey: string;
  /** Suggested visible skill name. */
  displayName: string;
  /** Suggested skill slug. Defaults to `skillKey`. */
  slug?: string;
  /** Suggested skill description. */
  description?: string | null;
  /** Full `SKILL.md` contents. Defaults to generated markdown from display metadata. */
  markdown?: string;
  /** Additional files installed with the skill. */
  files?: PluginManagedSkillFileDeclaration[];
}

export type PluginManagedResourceKind = "agent" | "project" | "routine" | "skill";

export interface PluginManagedResourceRef {
  pluginKey?: string;
  resourceKind: PluginManagedResourceKind;
  resourceKey: string;
}

export interface PluginManagedRoutineDeclaration {
  /** Stable identifier for this managed routine, unique within the plugin. */
  routineKey: string;
  /** Suggested routine title template. */
  title: string;
  /** Suggested routine description template. */
  description?: string | null;
  /** Stable managed agent reference for the default assignee. */
  assigneeRef?: PluginManagedResourceRef | null;
  /** Stable managed project reference for routine-created issues. */
  projectRef?: PluginManagedResourceRef | null;
  /** Optional goal id to set on the routine in this company. */
  goalId?: string | null;
  /** Suggested starting status. Defaults to `paused` when no assignee is resolved, otherwise `active`. */
  status?: RoutineStatus;
  /** Suggested issue priority. Defaults to `medium`. */
  priority?: IssuePriority;
  /** Suggested concurrency behavior. Defaults to core routine default. */
  concurrencyPolicy?: RoutineConcurrencyPolicy;
  /** Suggested missed-trigger behavior. Defaults to core routine default. */
  catchUpPolicy?: RoutineCatchUpPolicy;
  /** Suggested routine variables. */
  variables?: RoutineVariable[];
  /** Suggested triggers created when the routine is first reconciled. */
  triggers?: Array<Pick<RoutineTrigger, "kind" | "label" | "enabled" | "cronExpression" | "timezone" | "signingMode" | "replayWindowSec">>;
  /** Defaults for issues created by this routine. */
  issueTemplate?: {
    surfaceVisibility?: IssueSurfaceVisibility;
    originId?: string | null;
    billingCode?: string | null;
  };
}

export interface PluginManagedAgentResolution {
  pluginKey: string;
  resourceKind: "agent";
  resourceKey: string;
  companyId: string;
  agentId: string | null;
  agent: Agent | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  approvalId?: string | null;
  defaultDrift?: {
    entryFile: string;
    changedFiles: string[];
  } | null;
}

export interface PluginManagedProjectResolution {
  pluginKey: string;
  resourceKind: "project";
  resourceKey: string;
  companyId: string;
  projectId: string | null;
  project: Project | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
}

export interface PluginManagedRoutineResolution {
  pluginKey: string;
  resourceKind: "routine";
  resourceKey: string;
  companyId: string;
  routineId: string | null;
  routine: Routine | null;
  status: "missing" | "missing_refs" | "resolved" | "created" | "relinked" | "reset";
  missingRefs?: PluginManagedResourceRef[];
}

export interface PluginManagedSkillResolution {
  pluginKey: string;
  resourceKind: "skill";
  resourceKey: string;
  companyId: string;
  skillId: string | null;
  skill: CompanySkill | null;
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  defaultDrift?: {
    changedFiles: string[];
  } | null;
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
   * Optional company-scoped route segment for page and routeSidebar slots.
   * Example: `kitchensink` becomes `/:companyPrefix/kitchensink`.
   */
  routePath?: string;
  /**
   * Optional ordering hint within a slot surface. Lower numbers appear first.
   * Defaults to host-defined ordering if omitted.
   */
  order?: number;
}

/**
 * Describes the action triggered by a plugin launcher surface.
 */
export interface PluginLauncherActionDeclaration {
  /** What kind of launch behavior the host should perform. */
  type: PluginLauncherAction;
  /**
   * Stable target identifier or URL. The meaning depends on `type`
   * (for example a route, tab key, action key, or external URL).
   */
  target: string;
  /** Optional arbitrary parameters passed along to the target. */
  params?: Record<string, unknown>;
}

/**
 * Optional render metadata for the destination opened by a launcher.
 */
export interface PluginLauncherRenderDeclaration {
  /** High-level container the launcher expects the host to use. */
  environment: PluginLauncherRenderEnvironment;
  /** Optional size hint for the destination surface. */
  bounds?: PluginLauncherBounds;
}

/**
 * Serializable runtime snapshot of the host launcher/container environment.
 */
export interface PluginLauncherRenderContextSnapshot {
  /** The current launcher/container environment selected by the host. */
  environment: PluginLauncherRenderEnvironment | null;
  /** Launcher id that opened this surface, if any. */
  launcherId: string | null;
  /** Current host-applied bounds hint for the environment, if any. */
  bounds: PluginLauncherBounds | null;
}

/**
 * Declares a plugin launcher surface independent of the low-level slot
 * implementation that mounts it.
 */
export interface PluginLauncherDeclaration {
  /** Stable identifier for this launcher, unique within the plugin. */
  id: string;
  /** Human-readable label shown for the launcher. */
  displayName: string;
  /** Optional description for operator-facing docs or future UI affordances. */
  description?: string;
  /** Where in the host UI this launcher should be placed. */
  placementZone: PluginLauncherPlacementZone;
  /** Optional export name in the UI bundle when the launcher has custom UI. */
  exportName?: string;
  /**
   * Optional entity targeting for context-sensitive launcher zones.
   * Reuses the same entity union as UI slots for consistency.
   */
  entityTypes?: PluginUiSlotEntityType[];
  /** Optional ordering hint within the placement zone. */
  order?: number;
  /** What should happen when the launcher is activated. */
  action: PluginLauncherActionDeclaration;
  /** Optional render/container hints for the launched destination. */
  render?: PluginLauncherRenderDeclaration;
}

/**
 * Lower-bound semver requirement for the Paperclip host.
 *
 * The host should reject installation when its running version is lower than
 * the declared minimum.
 */
export type PluginMinimumHostVersion = string;

/**
 * Groups plugin UI declarations that are served from the shared UI bundle
 * root declared in `entrypoints.ui`.
 */
export interface PluginUiDeclaration {
  /** UI extension slots this plugin fills. */
  slots?: PluginUiSlotDeclaration[];
  /** Declarative launcher metadata for host-mounted plugin entry points. */
  launchers?: PluginLauncherDeclaration[];
}

/**
 * Declares restricted database access for trusted orchestration plugins.
 *
 * The host derives the final namespace from the plugin key and optional slug,
 * applies SQL migrations before worker startup, and gates runtime SQL through
 * the `database.namespace.*` capabilities.
 */
export interface PluginDatabaseDeclaration {
  /** Optional stable human-readable slug included in the host-derived namespace. */
  namespaceSlug?: string;
  /** SQL migration directory relative to the plugin package root. */
  migrationsDir: string;
  /** Public core tables this plugin may read or join at runtime. */
  coreReadTables?: PluginDatabaseCoreReadTable[];
}

export type PluginApiRouteCompanyResolution =
  | { from: "body"; key: string }
  | { from: "query"; key: string }
  | { from: "issue"; param: string };

export interface PluginApiRouteDeclaration {
  /** Stable plugin-defined route key passed to the worker. */
  routeKey: string;
  /** HTTP method accepted by this route. */
  method: PluginApiRouteMethod;
  /** Plugin-local path under `/api/plugins/:pluginId/api`, e.g. `/issues/:issueId/smoke`. */
  path: string;
  /** Actor class allowed to call the route. */
  auth: PluginApiRouteAuthMode;
  /** Capability required to expose the route. Currently `api.routes.register`. */
  capability: "api.routes.register";
  /** Optional checkout policy enforced by the host before worker dispatch. */
  checkoutPolicy?: PluginApiRouteCheckoutPolicy;
  /** How the host resolves company access for this route. */
  companyResolution?: PluginApiRouteCompanyResolution;
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
  /**
   * Minimum host version required (semver lower bound).
   * Preferred generic field for new manifests.
   */
  minimumHostVersion?: PluginMinimumHostVersion;
  /**
   * Legacy alias for `minimumHostVersion`.
   * Kept for backwards compatibility with existing manifests and docs.
   */
  minimumPaperclipVersion?: PluginMinimumHostVersion;
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
  /** Restricted plugin-owned database namespace declaration. */
  database?: PluginDatabaseDeclaration;
  /** Scoped JSON API routes mounted under `/api/plugins/:pluginId/api/*`. */
  apiRoutes?: PluginApiRouteDeclaration[];
  /** Environment drivers this plugin contributes. Requires `environment.drivers.register` capability. */
  environmentDrivers?: PluginEnvironmentDriverDeclaration[];
  /** Suggested company-scoped agents this plugin can provision and resolve by stable key. */
  agents?: PluginManagedAgentDeclaration[];
  /** Suggested company-scoped projects this plugin can provision and resolve by stable key. */
  projects?: PluginManagedProjectDeclaration[];
  /** Suggested company-scoped routines this plugin can provision and resolve by stable key. */
  routines?: PluginManagedRoutineDeclaration[];
  /** Suggested company skills this plugin can install and resolve by stable key. */
  skills?: PluginManagedSkillDeclaration[];
  /** Trusted local folders this plugin can configure and access by stable key. */
  localFolders?: PluginLocalFolderDeclaration[];
  /**
   * Legacy top-level launcher declarations.
   * Prefer `ui.launchers` for new manifests.
   */
  launchers?: PluginLauncherDeclaration[];
  /** UI bundle declarations. Requires `entrypoints.ui` when populated. */
  ui?: PluginUiDeclaration;
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
  /** Most recent error message, or operator-provided disable reason. */
  lastError: string | null;
  /** Timestamp when the plugin was first installed. */
  installedAt: Date;
  /** Timestamp of the most recent status or metadata change. */
  updatedAt: Date;
}

export interface PluginDatabaseNamespaceRecord {
  id: string;
  pluginId: string;
  pluginKey: string;
  namespaceName: string;
  namespaceMode: PluginDatabaseNamespaceMode;
  status: PluginDatabaseNamespaceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginMigrationRecord {
  id: string;
  pluginId: string;
  pluginKey: string;
  namespaceName: string;
  migrationKey: string;
  checksum: string;
  pluginVersion: string;
  status: PluginDatabaseMigrationStatus;
  startedAt: Date;
  appliedAt: Date | null;
  errorMessage: string | null;
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
 * Company-scoped plugin settings row. This is intentionally generic; plugin
 * features such as local folders live inside `settingsJson` under namespaced
 * keys instead of requiring feature-specific database columns.
 */
export interface PluginCompanySettings {
  id: string;
  companyId: string;
  pluginId: string;
  enabled: boolean;
  settingsJson: Record<string, unknown>;
  lastError: string | null;
  createdAt: Date;
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
