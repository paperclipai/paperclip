/**
 * Core types for the Paperclip plugin worker-side SDK.
 *
 * These types define the stable public API surface that plugin workers import
 * from `@paperclipai/plugin-sdk`.  The host provides a concrete implementation
 * of `PluginContext` to the plugin at initialisation time.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  PaperclipPluginManifestV1,
  PluginStateScopeKind,
  PluginEventType,
  PluginToolDeclaration,
  PluginLauncherDeclaration,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueDocument,
  IssueDocumentSummary,
  Agent,
  Goal,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Re-exports from @paperclipai/shared (plugin authors import from one place)
// ---------------------------------------------------------------------------

export type {
  PaperclipPluginManifestV1,
  PluginJobDeclaration,
  PluginWebhookDeclaration,
  PluginToolDeclaration,
  PluginUiSlotDeclaration,
  PluginUiDeclaration,
  PluginLauncherActionDeclaration,
  PluginLauncherRenderDeclaration,
  PluginLauncherDeclaration,
  PluginMinimumHostVersion,
  PluginRecord,
  PluginConfig,
  JsonSchema,
  PluginStatus,
  PluginCategory,
  PluginCapability,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginLauncherPlacementZone,
  PluginLauncherAction,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginStateScopeKind,
  PluginJobStatus,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginWebhookDeliveryStatus,
  PluginEventType,
  PluginBridgeErrorCode,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueDocument,
  IssueDocumentSummary,
  Agent,
  Goal,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Scope key — identifies where plugin state is stored
// ---------------------------------------------------------------------------

/**
 * A scope key identifies the exact location where plugin state is stored.
 * Scope is partitioned by `scopeKind` and optional `scopeId`.
 *
 * Examples:
 * - `{ scopeKind: "instance" }` — single global value for the whole instance
 * - `{ scopeKind: "project", scopeId: "proj-uuid" }` — per-project state
 * - `{ scopeKind: "issue", scopeId: "iss-uuid" }` — per-issue state
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state`
 */
export interface ScopeKey {
  /** What kind of Paperclip object this state is scoped to. */
  scopeKind: PluginStateScopeKind;
  /** UUID or text identifier for the scoped object. Omit for `instance` scope. */
  scopeId?: string;
  /** Optional sub-namespace within the scope to avoid key collisions. Defaults to `"default"`. */
  namespace?: string;
  /** The state key within the namespace. */
  stateKey: string;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Optional filter applied when subscribing to an event. The host evaluates
 * the filter server-side so filtered-out events never cross the process boundary.
 *
 * All filter fields are optional. If omitted the plugin receives every event
 * of the subscribed type.
 *
 * @see PLUGIN_SPEC.md §16.1 — Event Filtering
 */
export interface EventFilter {
  /** Only receive events for this project. */
  projectId?: string;
  /** Only receive events for this company. */
  companyId?: string;
  /** Only receive events for this agent. */
  agentId?: string;
  /** Additional arbitrary filter fields. */
  [key: string]: unknown;
}

/**
 * Envelope wrapping every domain event delivered to a plugin worker.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export interface PluginEvent<TPayload = unknown> {
  /** Unique event identifier (UUID). */
  eventId: string;
  /** The event type (e.g. `"issue.created"`). */
  eventType: PluginEventType | `plugin.${string}`;
  /** ISO 8601 timestamp when the event occurred. */
  occurredAt: string;
  /** ID of the actor that caused the event, if applicable. */
  actorId?: string;
  /** Type of actor: `"user"`, `"agent"`, `"system"`, or `"plugin"`. */
  actorType?: "user" | "agent" | "system" | "plugin";
  /** Primary entity involved in the event. */
  entityId?: string;
  /** Type of the primary entity. */
  entityType?: string;
  /** UUID of the company this event belongs to. */
  companyId: string;
  /** Typed event payload. */
  payload: TPayload;
}

// ---------------------------------------------------------------------------
// Job context
// ---------------------------------------------------------------------------

/**
 * Context passed to a plugin job handler when the host triggers a scheduled run.
 *
 * @see PLUGIN_SPEC.md §13.6 — `runJob`
 */
export interface PluginJobContext {
  /** Stable job key matching the declaration in the manifest. */
  jobKey: string;
  /** UUID for this specific job run instance. */
  runId: string;
  /** What triggered this run. */
  trigger: "schedule" | "manual" | "retry";
  /** ISO 8601 timestamp when the run was scheduled to start. */
  scheduledAt: string;
}

// ---------------------------------------------------------------------------
// Tool run context
// ---------------------------------------------------------------------------

/**
 * Run context passed to a plugin tool handler when an agent invokes the tool.
 *
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */
export interface ToolRunContext {
  /** UUID of the agent invoking the tool. */
  agentId: string;
  /** UUID of the current agent run. */
  runId: string;
  /** UUID of the company the run belongs to. */
  companyId: string;
  /** UUID of the project the run belongs to. */
  projectId: string;
}

/**
 * Result returned from a plugin tool handler.
 *
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */
export interface ToolResult {
  /** String content returned to the agent. Required for success responses. */
  content?: string;
  /** Structured data returned alongside or instead of string content. */
  data?: unknown;
  /** If present, indicates the tool call failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Plugin entity store
// ---------------------------------------------------------------------------

/**
 * Input for creating or updating a plugin-owned entity.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export interface PluginEntityUpsert {
  /** Plugin-defined entity type (e.g. `"linear-issue"`, `"github-pr"`). */
  entityType: string;
  /** Scope where this entity lives. */
  scopeKind: PluginStateScopeKind;
  /** Optional scope ID. */
  scopeId?: string;
  /** External identifier in the remote system (e.g. Linear issue ID). */
  externalId?: string;
  /** Human-readable title for display in the Paperclip UI. */
  title?: string;
  /** Optional status string. */
  status?: string;
  /** Full entity data blob. Must be JSON-serializable. */
  data: Record<string, unknown>;
}

/**
 * A plugin-owned entity record as returned by `ctx.entities.list()`.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export interface PluginEntityRecord {
  /** UUID primary key. */
  id: string;
  /** Plugin-defined entity type. */
  entityType: string;
  /** Scope kind. */
  scopeKind: PluginStateScopeKind;
  /** Scope ID, if any. */
  scopeId: string | null;
  /** External identifier, if any. */
  externalId: string | null;
  /** Human-readable title. */
  title: string | null;
  /** Status string. */
  status: string | null;
  /** Full entity data. */
  data: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

/**
 * Query parameters for `ctx.entities.list()`.
 */
export interface PluginEntityQuery {
  /** Filter by entity type. */
  entityType?: string;
  /** Filter by scope kind. */
  scopeKind?: PluginStateScopeKind;
  /** Filter by scope ID. */
  scopeId?: string;
  /** Filter by external ID. */
  externalId?: string;
  /** Maximum number of results to return. */
  limit?: number;
  /** Number of results to skip (for pagination). */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Project workspace metadata (read-only via ctx.projects)
// ---------------------------------------------------------------------------

/**
 * Workspace metadata provided by the host. Plugins use this to resolve local
 * filesystem paths for file browsing, git, terminal, and process operations.
 *
 * @see PLUGIN_SPEC.md §7 — Project Workspaces
 * @see PLUGIN_SPEC.md §20 — Local Tooling
 */
export interface PluginWorkspace {
  /** UUID primary key. */
  id: string;
  /** UUID of the parent project. */
  projectId: string;
  /** Display name for this workspace. */
  name: string;
  /** Absolute filesystem path to the workspace directory. */
  path: string;
  /** Whether this is the project's primary workspace. */
  isPrimary: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Host API surfaces exposed via PluginContext
// ---------------------------------------------------------------------------

/**
 * `ctx.config` — read resolved operator configuration for this plugin.
 *
 * Plugin workers receive the resolved config at initialisation. Use `get()`
 * to access the current configuration at any time. The host calls
 * `configChanged` on the worker when the operator updates config at runtime.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 * @see PLUGIN_SPEC.md §13.4 — `configChanged`
 */
export interface PluginConfigClient {
  /**
   * Returns the resolved operator configuration for this plugin instance.
   * Values are validated against the plugin's `instanceConfigSchema` by the
   * host before being passed to the worker.
   */
  get(): Promise<Record<string, unknown>>;
}

/**
 * `ctx.events` — subscribe to and emit Paperclip domain events.
 *
 * Requires `events.subscribe` capability for `on()`.
 * Requires `events.emit` capability for `emit()`.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export interface PluginEventsClient {
  /**
   * Subscribe to a core Paperclip domain event or a plugin-namespaced event.
   *
   * @param name - Event type, e.g. `"issue.created"` or `"plugin.@acme/linear.sync-done"`
   * @param fn - Async event handler
   */
  on(name: PluginEventType | `plugin.${string}`, fn: (event: PluginEvent) => Promise<void>): () => void;

  /**
   * Subscribe to an event with an optional server-side filter.
   *
   * @param name - Event type
   * @param filter - Server-side filter evaluated before dispatching to the worker
   * @param fn - Async event handler
   * @returns An unsubscribe function that removes the handler
   */
  on(name: PluginEventType | `plugin.${string}`, filter: EventFilter, fn: (event: PluginEvent) => Promise<void>): () => void;

  /**
   * Emit a plugin-namespaced event. Other plugins with `events.subscribe` can
   * subscribe to it using `"plugin.<pluginId>.<eventName>"`.
   *
   * Requires the `events.emit` capability.
   *
   * Plugin-emitted events are automatically namespaced: if the plugin ID is
   * `"acme.linear"` and the event name is `"sync-done"`, the full event type
   * becomes `"plugin.acme.linear.sync-done"`.
   *
   * @see PLUGIN_SPEC.md §16.2 — Plugin-to-Plugin Events
   *
   * @param name - Bare event name (e.g. `"sync-done"`)
   * @param companyId - UUID of the company this event belongs to
   * @param payload - JSON-serializable event payload
   */
  emit(name: string, companyId: string, payload: unknown): Promise<void>;
}

/**
 * `ctx.jobs` — register handlers for scheduled jobs declared in the manifest.
 *
 * Requires `jobs.schedule` capability.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 */
export interface PluginJobsClient {
  /**
   * Register a handler for a scheduled job.
   *
   * The `key` must match a `jobKey` declared in the plugin manifest.
   * The host calls this handler according to the job's declared `schedule`.
   *
   * @param key - Job key matching the manifest declaration
   * @param fn - Async job handler
   */
  register(key: string, fn: (job: PluginJobContext) => Promise<void>): void;
}

/**
 * A runtime launcher registration uses the same declaration shape as a
 * manifest launcher entry.
 */
export type PluginLauncherRegistration = PluginLauncherDeclaration;

/**
 * `ctx.launchers` — register launcher declarations at runtime.
 */
export interface PluginLaunchersClient {
  /**
   * Register launcher metadata for host discovery.
   *
   * If a launcher with the same id is registered more than once, the latest
   * declaration replaces the previous one.
   */
  register(launcher: PluginLauncherRegistration): void;
}

/**
 * `ctx.http` — make outbound HTTP requests.
 *
 * Requires `http.outbound` capability.
 *
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Runtime/Integration
 */
export interface PluginHttpClient {
  /**
   * Perform an outbound HTTP request.
   *
   * The host enforces `http.outbound` capability before allowing the call.
   * Plugins may also use standard Node `fetch` or other libraries directly —
   * this client exists for host-managed tracing and audit logging.
   *
   * @param url - Target URL
   * @param init - Standard `RequestInit` options
   * @returns The response
   */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * `ctx.secrets` — resolve secret references.
 *
 * Requires `secrets.read-ref` capability.
 *
 * Plugins store secret *references* in their config (e.g. a secret name).
 * This client resolves the reference through the Paperclip secret provider
 * system and returns the resolved value at execution time.
 *
 * @see PLUGIN_SPEC.md §22 — Secrets
 */
export interface PluginSecretsClient {
  /**
   * Resolve a secret reference to its current value.
   *
   * The reference is a string identifier pointing to a secret configured
   * in the Paperclip secret provider (e.g. `"MY_API_KEY"`).
   *
   * Secret values are resolved at call time and must never be cached or
   * written to logs, config, or other persistent storage.
   *
   * @param secretRef - The secret reference string from plugin config
   * @returns The resolved secret value
   */
  resolve(secretRef: string): Promise<string>;
}

/**
 * Input for writing a plugin activity log entry.
 *
 * @see PLUGIN_SPEC.md §21.4 — Activity Log Changes
 */
export interface PluginActivityLogEntry {
  /** UUID of the company this activity belongs to. Required for auditing. */
  companyId: string;
  /** Human-readable description of the activity. */
  message: string;
  /** Optional entity type this activity relates to. */
  entityType?: string;
  /** Optional entity ID this activity relates to. */
  entityId?: string;
  /** Optional additional metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * `ctx.activity` — write plugin-originated activity log entries.
 *
 * Requires `activity.log.write` capability.
 *
 * @see PLUGIN_SPEC.md §21.4 — Activity Log Changes
 */
export interface PluginActivityClient {
  /**
   * Write an activity log entry attributed to this plugin.
   *
   * The host writes the entry with `actor_type = plugin` and
   * `actor_id = <pluginId>`.
   *
   * @param entry - The activity log entry to write
   */
  log(entry: PluginActivityLogEntry): Promise<void>;
}

/**
 * `ctx.state` — read and write plugin-scoped key-value state.
 *
 * Each plugin gets an isolated namespace: state written by plugin A can never
 * be read or overwritten by plugin B. Within a plugin, state is partitioned by
 * a five-part composite key: `(pluginId, scopeKind, scopeId, namespace, stateKey)`.
 *
 * **Scope kinds**
 *
 * | `scopeKind` | `scopeId` | Typical use |
 * |-------------|-----------|-------------|
 * | `"instance"` | omit | Global flags, last full-sync timestamps |
 * | `"company"` | company UUID | Per-company sync cursors |
 * | `"project"` | project UUID | Per-project settings, branch tracking |
 * | `"project_workspace"` | workspace UUID | Per-workspace state |
 * | `"agent"` | agent UUID | Per-agent memory |
 * | `"issue"` | issue UUID | Idempotency keys, linked external IDs |
 * | `"goal"` | goal UUID | Per-goal progress |
 * | `"run"` | run UUID | Per-run checkpoints |
 *
 * **Namespaces**
 *
 * The optional `namespace` field (default: `"default"`) lets you group related
 * keys within a scope without risking collisions between different logical
 * subsystems inside the same plugin.
 *
 * **Security**
 *
 * Never store resolved secret values. Store only secret references and resolve
 * them at call time via `ctx.secrets.resolve()`.
 *
 * @example
 * ```ts
 * // Instance-global flag
 * await ctx.state.set({ scopeKind: "instance", stateKey: "schema-version" }, 2);
 *
 * // Idempotency key per issue
 * const synced = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, stateKey: "synced-to-linear" });
 * if (!synced) {
 *   await syncToLinear(issueId);
 *   await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "synced-to-linear" }, true);
 * }
 *
 * // Per-project, namespaced for two integrations
 * await ctx.state.set({ scopeKind: "project", scopeId: projectId, namespace: "linear", stateKey: "cursor" }, cursor);
 * await ctx.state.set({ scopeKind: "project", scopeId: projectId, namespace: "github", stateKey: "last-event" }, eventId);
 * ```
 *
 * `plugin.state.read` capability required for `get()`.
 * `plugin.state.write` capability required for `set()` and `delete()`.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state`
 */
export interface PluginStateClient {
  /**
   * Read a state value.
   *
   * Returns the stored JSON value as-is, or `null` if no entry has been set
   * for this scope+key combination. Falsy values (`false`, `0`, `""`) are
   * returned correctly and are not confused with "not set".
   *
   * @param input - Scope key identifying the entry to read
   * @returns The stored JSON value, or `null` if no value has been set
   */
  get(input: ScopeKey): Promise<unknown>;

  /**
   * Write a state value. Creates the row if it does not exist; replaces it
   * atomically (upsert) if it does. Safe to call concurrently.
   *
   * Any JSON-serializable value is accepted: objects, arrays, strings,
   * numbers, booleans, and `null`.
   *
   * @param input - Scope key identifying the entry to write
   * @param value - JSON-serializable value to store
   */
  set(input: ScopeKey, value: unknown): Promise<void>;

  /**
   * Delete a state value. No-ops silently if the entry does not exist
   * (idempotent by design — safe to call without prior `get()`).
   *
   * @param input - Scope key identifying the entry to delete
   */
  delete(input: ScopeKey): Promise<void>;
}

/**
 * `ctx.entities` — create and query plugin-owned entity records.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_entities`
 */
export interface PluginEntitiesClient {
  /**
   * Create or update a plugin entity record (upsert by `externalId` within
   * the given scope, or by `id` if provided).
   *
   * @param input - Entity data to upsert
   */
  upsert(input: PluginEntityUpsert): Promise<PluginEntityRecord>;

  /**
   * Query plugin entity records.
   *
   * @param query - Filter criteria
   * @returns Matching entity records
   */
  list(query: PluginEntityQuery): Promise<PluginEntityRecord[]>;
}

/**
 * `ctx.projects` — read project and workspace metadata.
 *
 * Requires `projects.read` capability.
 * Requires `project.workspaces.read` capability for workspace operations.
 *
 * @see PLUGIN_SPEC.md §7 — Project Workspaces
 */
export interface PluginProjectsClient {
  /**
   * List projects visible to the plugin.
   *
   * Requires the `projects.read` capability.
   */
  list(input: { companyId: string; limit?: number; offset?: number }): Promise<Project[]>;

  /**
   * Get a single project by ID.
   *
   * Requires the `projects.read` capability.
   */
  get(projectId: string, companyId: string): Promise<Project | null>;

  /**
   * List all workspaces attached to a project.
   *
   * @param projectId - UUID of the project
   * @param companyId - UUID of the company that owns the project
   * @returns All workspaces for the project, ordered with primary first
   */
  listWorkspaces(projectId: string, companyId: string): Promise<PluginWorkspace[]>;

  /**
   * Get the primary workspace for a project.
   *
   * @param projectId - UUID of the project
   * @param companyId - UUID of the company that owns the project
   * @returns The primary workspace, or `null` if no workspace is configured
   */
  getPrimaryWorkspace(projectId: string, companyId: string): Promise<PluginWorkspace | null>;

  /**
   * Resolve the primary workspace for an issue by looking up the issue's
   * project and returning its primary workspace.
   *
   * This is a convenience method that combines `issues.get()` and
   * `getPrimaryWorkspace()` in a single RPC call.
   *
   * @param issueId - UUID of the issue
   * @param companyId - UUID of the company that owns the issue
   * @returns The primary workspace for the issue's project, or `null` if
   *   the issue has no project or the project has no workspace
   *
   * @see PLUGIN_SPEC.md §20 — Local Tooling
   */
  getWorkspaceForIssue(issueId: string, companyId: string): Promise<PluginWorkspace | null>;
}

/**
 * `ctx.data` — register `getData` handlers that back `usePluginData()` in the
 * plugin's frontend components.
 *
 * The plugin's UI calls `usePluginData(key, params)` which routes through the
 * host bridge to the worker's registered handler.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 */
export interface PluginDataClient {
  /**
   * Register a handler for a plugin-defined data key.
   *
   * @param key - Stable string identifier for this data type (e.g. `"sync-health"`)
   * @param handler - Async function that receives request params and returns JSON-serializable data
   */
  register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
}

/**
 * `ctx.actions` — register `performAction` handlers that back
 * `usePluginAction()` in the plugin's frontend components.
 *
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 */
export interface PluginActionsClient {
  /**
   * Register a handler for a plugin-defined action key.
   *
   * @param key - Stable string identifier for this action (e.g. `"resync"`)
   * @param handler - Async function that receives action params and returns a result
   */
  register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
}

/**
 * `ctx.tools` — register handlers for agent tools declared in the manifest.
 *
 * Requires `agent.tools.register` capability.
 *
 * Tool names are automatically namespaced by plugin ID at runtime.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 */
export interface PluginToolsClient {
  /**
   * Register a handler for a plugin-contributed agent tool.
   *
   * @param name - Tool name matching the manifest declaration (without namespace prefix)
   * @param declaration - Tool metadata (displayName, description, parametersSchema)
   * @param fn - Async handler that executes the tool
   */
  register(
    name: string,
    declaration: Pick<PluginToolDeclaration, "displayName" | "description" | "parametersSchema">,
    fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>,
  ): void;
}

/**
 * `ctx.logger` — structured logging from the plugin worker.
 *
 * Log output is captured by the host, stored, and surfaced in the plugin
 * health dashboard.
 *
 * @see PLUGIN_SPEC.md §26.1 — Logging
 */
export interface PluginLogger {
  /** Log an informational message. */
  info(message: string, meta?: Record<string, unknown>): void;
  /** Log a warning. */
  warn(message: string, meta?: Record<string, unknown>): void;
  /** Log an error. */
  error(message: string, meta?: Record<string, unknown>): void;
  /** Log a debug message (may be suppressed in production). */
  debug(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Plugin metrics
// ---------------------------------------------------------------------------

/**
 * `ctx.metrics` — write plugin-contributed metrics.
 *
 * Requires `metrics.write` capability.
 *
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Data Write
 */
export interface PluginMetricsClient {
  /**
   * Write a numeric metric data point.
   *
   * @param name - Metric name (plugin-namespaced by the host)
   * @param value - Numeric value
   * @param tags - Optional key-value tags for filtering
   */
  write(name: string, value: number, tags?: Record<string, string>): Promise<void>;
}

/**
 * `ctx.companies` — read company metadata.
 *
 * Requires `companies.read` capability.
 */
export interface PluginCompaniesClient {
  /**
   * List companies visible to this plugin.
   */
  list(input?: { limit?: number; offset?: number }): Promise<Company[]>;

  /**
   * Get one company by ID.
   */
  get(companyId: string): Promise<Company | null>;
}

/**
 * `ctx.issues.documents` — read and write issue documents.
 *
 * Requires:
 * - `issue.documents.read` for `list` and `get`
 * - `issue.documents.write` for `upsert` and `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PluginIssueDocumentsClient {
  /**
   * List all documents attached to an issue.
   *
   * Returns summary metadata (id, key, title, format, timestamps) without
   * the full document body. Use `get()` to fetch a specific document's body.
   *
   * Requires the `issue.documents.read` capability.
   */
  list(issueId: string, companyId: string): Promise<IssueDocumentSummary[]>;

  /**
   * Get a single document by key, including its full body content.
   *
   * Returns `null` if no document exists with the given key.
   *
   * Requires the `issue.documents.read` capability.
   *
   * @param issueId - UUID of the issue
   * @param key - Document key (e.g. `"plan"`, `"design-spec"`)
   * @param companyId - UUID of the company
   */
  get(issueId: string, key: string, companyId: string): Promise<IssueDocument | null>;

  /**
   * Create or update a document on an issue.
   *
   * If a document with the given key already exists, it is updated and a new
   * revision is created. If it does not exist, it is created.
   *
   * Requires the `issue.documents.write` capability.
   *
   * @param input - Document data including issueId, key, body, and optional title/format/changeSummary
   */
  upsert(input: {
    issueId: string;
    key: string;
    body: string;
    companyId: string;
    title?: string;
    format?: string;
    changeSummary?: string;
  }): Promise<IssueDocument>;

  /**
   * Delete a document and all its revisions.
   *
   * No-ops silently if the document does not exist (idempotent).
   *
   * Requires the `issue.documents.write` capability.
   *
   * @param issueId - UUID of the issue
   * @param key - Document key to delete
   * @param companyId - UUID of the company
   */
  delete(issueId: string, key: string, companyId: string): Promise<void>;
}

/**
 * `ctx.issues` — read and mutate issues plus comments.
 *
 * Requires:
 * - `issues.read` for read operations
 * - `issues.create` for create
 * - `issues.update` for update
 * - `issue.comments.read` for `listComments`
 * - `issue.comments.create` for `createComment`
 * - `issue.documents.read` for `documents.list` and `documents.get`
 * - `issue.documents.write` for `documents.upsert` and `documents.delete`
 */
export interface PluginIssuesClient {
  list(input: {
    companyId: string;
    projectId?: string;
    assigneeAgentId?: string;
    status?: Issue["status"];
    limit?: number;
    offset?: number;
  }): Promise<Issue[]>;
  get(issueId: string, companyId: string): Promise<Issue | null>;
  create(input: {
    companyId: string;
    projectId?: string;
    goalId?: string;
    parentId?: string;
    title: string;
    description?: string;
    priority?: Issue["priority"];
    assigneeAgentId?: string;
  }): Promise<Issue>;
  update(
    issueId: string,
    patch: Partial<Pick<
      Issue,
      "title" | "description" | "status" | "priority" | "assigneeAgentId"
    >>,
    companyId: string,
  ): Promise<Issue>;
  listComments(issueId: string, companyId: string): Promise<IssueComment[]>;
  createComment(issueId: string, body: string, companyId: string): Promise<IssueComment>;
  /** Read and write issue documents. Requires `issue.documents.read` / `issue.documents.write`. */
  documents: PluginIssueDocumentsClient;
}

/**
 * `ctx.agents` — read and manage agents.
 *
 * Requires `agents.read` for reads; `agents.pause` / `agents.resume` /
 * `agents.invoke` for write operations.
 */
export interface PluginAgentsClient {
  list(input: { companyId: string; status?: Agent["status"]; limit?: number; offset?: number }): Promise<Agent[]>;
  get(agentId: string, companyId: string): Promise<Agent | null>;
  /** Pause an agent. Throws if agent is terminated or not found. Requires `agents.pause`. */
  pause(agentId: string, companyId: string): Promise<Agent>;
  /** Resume a paused agent (sets status to idle). Throws if terminated, pending_approval, or not found. Requires `agents.resume`. */
  resume(agentId: string, companyId: string): Promise<Agent>;
  /** Invoke (wake up) an agent with a prompt payload. Throws if paused, terminated, pending_approval, or not found. Requires `agents.invoke`. */
  invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }): Promise<{ runId: string }>;
  /** Create, message, and close agent chat sessions. Requires `agent.sessions.*` capabilities. */
  sessions: PluginAgentSessionsClient;
}

// ---------------------------------------------------------------------------
// Agent Sessions — two-way chat with agents
// ---------------------------------------------------------------------------

/**
 * Represents an active conversational session with an agent.
 * Maps to an `AgentTaskSession` row on the host.
 */
export interface AgentSession {
  sessionId: string;
  agentId: string;
  companyId: string;
  status: "active" | "closed";
  createdAt: string;
}

/**
 * A streaming event received during a session's `sendMessage` call.
 * Delivered via JSON-RPC notifications from host to worker.
 */
export interface AgentSessionEvent {
  sessionId: string;
  runId: string;
  seq: number;
  /** The kind of event: "chunk" for output data, "status" for run state changes, "done" for end-of-stream, "error" for failures. */
  eventType: "chunk" | "status" | "done" | "error";
  stream: "stdout" | "stderr" | "system" | null;
  message: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Result of sending a message to a session.
 */
export interface AgentSessionSendResult {
  runId: string;
}

/**
 * `ctx.agents.sessions` — create, message, and close agent chat sessions.
 *
 * Requires `agent.sessions.create` for create, `agent.sessions.list` for list,
 * `agent.sessions.send` for sendMessage, `agent.sessions.close` for close.
 */
export interface PluginAgentSessionsClient {
  /** Create a new conversational session with an agent. Requires `agent.sessions.create`. */
  create(agentId: string, companyId: string, opts?: {
    taskKey?: string;
    reason?: string;
  }): Promise<AgentSession>;

  /** List active sessions for an agent owned by this plugin. Requires `agent.sessions.list`. */
  list(agentId: string, companyId: string): Promise<AgentSession[]>;

  /**
   * Send a message to a session and receive streaming events via the `onEvent` callback.
   * Returns immediately with `{ runId }`. Events are delivered asynchronously.
   * Requires `agent.sessions.send`.
   */
  sendMessage(sessionId: string, companyId: string, opts: {
    prompt: string;
    reason?: string;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentSessionSendResult>;

  /** Close a session, releasing resources. Requires `agent.sessions.close`. */
  close(sessionId: string, companyId: string): Promise<void>;
}

/**
 * `ctx.goals` — read and mutate goals.
 *
 * Requires:
 * - `goals.read` for read operations
 * - `goals.create` for create
 * - `goals.update` for update
 */
export interface PluginGoalsClient {
  list(input: {
    companyId: string;
    level?: Goal["level"];
    status?: Goal["status"];
    limit?: number;
    offset?: number;
  }): Promise<Goal[]>;
  get(goalId: string, companyId: string): Promise<Goal | null>;
  create(input: {
    companyId: string;
    title: string;
    description?: string;
    level?: Goal["level"];
    status?: Goal["status"];
    parentId?: string;
    ownerAgentId?: string;
  }): Promise<Goal>;
  update(
    goalId: string,
    patch: Partial<Pick<
      Goal,
      "title" | "description" | "level" | "status" | "parentId" | "ownerAgentId"
    >>,
    companyId: string,
  ): Promise<Goal>;
}

// ---------------------------------------------------------------------------
// Streaming (worker → UI push channel)
// ---------------------------------------------------------------------------

/**
 * `ctx.streams` — push real-time events from the worker to the plugin UI.
 *
 * The worker opens a named channel, emits events on it, and closes it when
 * done. On the UI side, `usePluginStream(channel)` receives these events in
 * real time via SSE.
 *
 * Streams are scoped to `(pluginId, channel, companyId)`. Multiple UI clients
 * can subscribe to the same channel concurrently.
 *
 * @example
 * ```ts
 * // Worker: stream chat tokens to the UI
 * ctx.streams.open("chat", companyId);
 * for await (const token of tokenStream) {
 *   ctx.streams.emit("chat", { type: "token", text: token });
 * }
 * ctx.streams.close("chat");
 * ```
 *
 * @see usePluginStream in `@paperclipai/plugin-sdk/ui`
 */
export interface PluginStreamsClient {
  /**
   * Open a named stream channel. Optional — `emit()` implicitly opens if needed.
   * Sends a `stream:open` event to connected UI clients.
   */
  open(channel: string, companyId: string): void;

  /**
   * Push an event to all UI clients subscribed to this channel.
   *
   * @param channel - Stream channel name (e.g. `"chat"`, `"logs"`)
   * @param event - JSON-serializable event payload
   */
  emit(channel: string, event: unknown): void;

  /**
   * Close a stream channel. Sends a `stream:close` event to connected UI
   * clients so they know no more events will arrive.
   */
  close(channel: string): void;
}

// ---------------------------------------------------------------------------
// Full plugin context
// ---------------------------------------------------------------------------

/**
 * The full plugin context object passed to the plugin worker at initialisation.
 *
 * This is the central interface plugin authors use to interact with the host.
 * Every client is capability-gated: calling a client method without the
 * required capability declared in the manifest results in a runtime error.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     ctx.events.on("issue.created", async (event) => {
 *       ctx.logger.info("Issue created", { issueId: event.entityId });
 *     });
 *
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({ scopeKind: "company", scopeId: String(companyId), stateKey: "last-sync" });
 *       return { lastSync: state };
 *     });
 *   },
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PluginContext {
  /** The plugin's manifest as validated at install time. */
  manifest: PaperclipPluginManifestV1;

  /** Read resolved operator configuration. */
  config: PluginConfigClient;

  /** Subscribe to and emit domain events. Requires `events.subscribe` / `events.emit`. */
  events: PluginEventsClient;

  /** Register handlers for scheduled jobs. Requires `jobs.schedule`. */
  jobs: PluginJobsClient;

  /** Register launcher metadata that the host can surface in plugin UI entry points. */
  launchers: PluginLaunchersClient;

  /** Make outbound HTTP requests. Requires `http.outbound`. */
  http: PluginHttpClient;

  /** Resolve secret references. Requires `secrets.read-ref`. */
  secrets: PluginSecretsClient;

  /** Write activity log entries. Requires `activity.log.write`. */
  activity: PluginActivityClient;

  /** Read and write scoped plugin state. Requires `plugin.state.read` / `plugin.state.write`. */
  state: PluginStateClient;

  /** Create and query plugin-owned entity records. */
  entities: PluginEntitiesClient;

  /** Read project and workspace metadata. Requires `projects.read` / `project.workspaces.read`. */
  projects: PluginProjectsClient;

  /** Read company metadata. Requires `companies.read`. */
  companies: PluginCompaniesClient;

  /** Read and write issues, comments, and documents. Requires issue capabilities. */
  issues: PluginIssuesClient;

  /** Read and manage agents. Requires `agents.read` for reads; `agents.pause` / `agents.resume` / `agents.invoke` for write ops. */
  agents: PluginAgentsClient;

  /** Read and mutate goals. Requires `goals.read` for reads; `goals.create` / `goals.update` for write ops. */
  goals: PluginGoalsClient;

  /** Register getData handlers for the plugin's UI components. */
  data: PluginDataClient;

  /** Register performAction handlers for the plugin's UI components. */
  actions: PluginActionsClient;

  /** Push real-time events from the worker to the plugin UI via SSE. */
  streams: PluginStreamsClient;

  /** Register agent tool handlers. Requires `agent.tools.register`. */
  tools: PluginToolsClient;

  /** Write plugin metrics. Requires `metrics.write`. */
  metrics: PluginMetricsClient;

  /** Structured logger. Output is captured and surfaced in the plugin health dashboard. */
  logger: PluginLogger;
}
