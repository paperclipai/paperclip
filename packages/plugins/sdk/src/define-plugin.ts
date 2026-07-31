/**
 * `definePlugin` — the top-level helper for authoring a Paperclip plugin.
 *
 * Plugin authors call `definePlugin()` and export the result as the default
 * export from their worker entrypoint. The host imports the worker module,
 * calls `setup()` with a `PluginContext`, and from that point the plugin
 * responds to events, jobs, webhooks, and UI requests through the context.
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 *
 * @example
 * ```ts
 * // dist/worker.ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Linear sync plugin starting");
 *
 *     // Subscribe to events
 *     ctx.events.on("issue.created", async (event) => {
 *       const companyId = event.companyId;
 *       const config = await ctx.config.get(companyId);
 *       const apiKey = await ctx.secrets.resolve(config.apiKeyRef, { companyId, configPath: "apiKeyRef" });
 *       await ctx.http.fetch(`https://api.linear.app/...`, {
 *         method: "POST",
 *         headers: { Authorization: `Bearer ${apiKey}` },
 *         body: JSON.stringify({ title: event.payload.title }),
 *       });
 *     });
 *
 *     // Register a job handler
 *     ctx.jobs.register("full-sync", async (job) => {
 *       ctx.logger.info("Running full-sync job", { runId: job.runId });
 *       // ... sync logic
 *     });
 *
 *     // Register data for the UI
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({
 *         scopeKind: "company",
 *         scopeId: String(companyId),
 *         stateKey: "last-sync",
 *       });
 *       return { lastSync: state };
 *     });
 *   },
 * });
 * ```
 */

import type { PluginContext } from "./types.js";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentStartInteractiveSetupParams,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  DetectExternalObjectsParams,
  DetectExternalObjectsResult,
  ResolveExternalObjectParams,
  PluginExternalObjectResolveResult,
  RefreshExternalObjectsParams,
  RefreshExternalObjectsResult,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

/**
 * Optional plugin-reported diagnostics returned from the `health()` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.2 — `health`
 */
export interface PluginHealthDiagnostics {
  /** Machine-readable status: `"ok"` | `"degraded"` | `"error"`. */
  status: "ok" | "degraded" | "error";
  /** Human-readable description of the current health state. */
  message?: string;
  /** Plugin-reported key-value diagnostics (e.g. connection status, queue depth). */
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config validation result
// ---------------------------------------------------------------------------

/**
 * Result returned from the `validateConfig()` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 */
export interface PluginConfigValidationResult {
  /** Whether the config is valid. */
  ok: boolean;
  /** Non-fatal warnings about the config. */
  warnings?: string[];
  /** Validation errors (populated when `ok` is `false`). */
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Webhook handler input
// ---------------------------------------------------------------------------

/**
 * Input received by the plugin worker's `handleWebhook` handler.
 *
 * @see PLUGIN_SPEC.md §13.7 — `handleWebhook`
 */
export interface PluginWebhookInput {
  /** Endpoint key matching the manifest declaration. */
  endpointKey: string;
  /** Inbound request headers. */
  headers: Record<string, string | string[]>;
  /** Raw request body as a UTF-8 string. */
  rawBody: string;
  /** Parsed JSON body (if applicable and parseable). */
  parsedBody?: unknown;
  /** Unique request identifier for idempotency checks. */
  requestId: string;
}

export interface PluginApiRequestInput {
  routeKey: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  actor: {
    actorType: "user" | "agent";
    actorId: string;
    agentId?: string | null;
    userId?: string | null;
    runId?: string | null;
  };
  companyId: string;
  headers: Record<string, string>;
}

export interface PluginApiResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

// ---------------------------------------------------------------------------
// Config change context
// ---------------------------------------------------------------------------

/**
 * Scope metadata delivered alongside a `configChanged` RPC so the worker knows
 * *which company's* configuration changed.
 *
 * The host→worker `configChanged` message has always carried the company scope,
 * but the SDK historically dropped it before invoking `onConfigChanged`, leaving
 * proactive plugins to keep a single worker-global config. That is safe for a
 * single-tenant plugin but silently collapses a multi-company plugin onto
 * whichever company's config was delivered last. Threading the scope through
 * lets a `multiCompanyConfig` plugin maintain per-company state.
 *
 * @see PLUGIN_SPEC.md §13.4 — `configChanged`
 */
export interface PluginConfigChangeContext {
  /**
   * The company whose configuration changed, or `null` for an instance/global
   * save that is not bound to a specific company.
   */
  companyId: string | null;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/**
 * The plugin definition shape passed to `definePlugin()`.
 *
 * The only required field is `setup`, which receives the `PluginContext` and
 * is where the plugin registers its handlers (events, jobs, data, actions,
 * tools, etc.).
 *
 * All other lifecycle hooks are optional. If a hook is not implemented the
 * host applies default behaviour (e.g. restarting the worker on config change
 * instead of calling `onConfigChanged`).
 *
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */
export interface PluginDefinition {
  /**
   * Called once when the plugin worker starts up, after `initialize` completes.
   *
   * This is where the plugin registers all its handlers: event subscriptions,
   * job handlers, data/action handlers, and tool registrations. Registration
   * must be synchronous after `setup` resolves — do not register handlers
   * inside async callbacks that may resolve after `setup` returns.
   *
   * @param ctx - The full plugin context provided by the host
   */
  setup(ctx: PluginContext): Promise<void>;

  /**
   * Called when the host wants to know if the plugin is healthy.
   *
   * The host polls this on a regular interval and surfaces the result in the
   * plugin health dashboard. If not implemented, the host infers health from
   * worker process liveness.
   *
   * @see PLUGIN_SPEC.md §13.2 — `health`
   */
  onHealth?(): Promise<PluginHealthDiagnostics>;

  /**
   * When true, this plugin's worker correctly serves configuration from more
   * than one company inside a single worker process — for example by keying its
   * state on `context.companyId` in `onConfigChanged` and running one connection
   * / subscription set per company.
   *
   * When false or omitted (the default), the plugin is treated as single-tenant.
   * The host then **fails closed** if `configChanged` would ever deliver a
   * second, distinct company's configuration to the same worker: instead of
   * silently collapsing the worker onto whichever company arrived last (a
   * cross-tenant identity/secret confusion bug), the delivery is rejected with
   * `PLUGIN_RPC_ERROR_CODES.CROSS_TENANT_CONFIG`. Re-delivering an unchanged
   * config for a different company (idempotent replay) is still allowed.
   */
  multiCompanyConfig?: boolean;

  /**
   * Called when the operator updates this plugin's company-scoped configuration
   * at runtime, without restarting the worker.
   *
   * If not implemented, the host restarts the worker to apply the new config.
   *
   * @param newConfig - The newly resolved configuration
   * @param context - Scope of the change. `context.companyId` identifies the
   *   company whose config changed (null for an instance/global save). A
   *   multi-company plugin (`multiCompanyConfig: true`) MUST key its per-company
   *   state on this value rather than assuming a single global config.
   * @see PLUGIN_SPEC.md §13.4 — `configChanged`
   */
  onConfigChanged?(
    newConfig: Record<string, unknown>,
    context?: PluginConfigChangeContext,
  ): Promise<void>;

  /**
   * Called when the host is about to shut down the plugin worker.
   *
   * The worker has at most 10 seconds (configurable via plugin config) to
   * finish in-flight work and resolve this promise. After the deadline the
   * host sends SIGTERM, then SIGKILL.
   *
   * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
   */
  onShutdown?(): Promise<void>;

  /**
   * Called to validate the current plugin configuration.
   *
   * The host calls this:
   * - after the plugin starts (to surface config errors immediately)
   * - after the operator saves a new config (to validate before persisting)
   * - via the "Test Connection" button in the settings UI
   *
   * @param config - The configuration to validate
   * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
   */
  onValidateConfig?(config: Record<string, unknown>): Promise<PluginConfigValidationResult>;

  /**
   * Called to handle an inbound webhook delivery.
   *
   * The host routes `POST /api/plugins/:pluginId/webhooks/:endpointKey` to
   * this handler. The plugin is responsible for signature verification using
   * a resolved secret ref.
   *
   * If not implemented but webhooks are declared in the manifest, the host
   * returns HTTP 501 for webhook deliveries.
   *
   * @param input - Webhook delivery metadata and payload
   * @see PLUGIN_SPEC.md §13.7 — `handleWebhook`
   */
  onWebhook?(input: PluginWebhookInput): Promise<void>;

  /**
   * Called for manifest-declared scoped JSON API routes under
   * `/api/plugins/:pluginId/api/*` after the host has enforced auth, company
   * access, capabilities, and checkout policy.
   */
  onApiRequest?(input: PluginApiRequestInput): Promise<PluginApiResponse>;

  /**
   * Called when Paperclip scans issue/comment/document content and asks this
   * plugin whether any sanitized URL candidates belong to its external object
   * providers. The host has already stripped URL userinfo, query strings, and
   * fragments unless provider-safe identity components were explicitly hashed.
   *
   * Requires `external.objects.detect`.
   */
  onDetectExternalObjects?(
    params: DetectExternalObjectsParams,
  ): Promise<DetectExternalObjectsResult>;

  /**
   * Called when Paperclip needs the current normalized status for one external
   * object owned by a manifest-declared provider.
   *
   * Requires `external.objects.read`.
   */
  onResolveExternalObject?(
    params: ResolveExternalObjectParams,
  ): Promise<PluginExternalObjectResolveResult>;

  /**
   * Optional batch resolver used by providers that can refresh many objects
   * more efficiently than individual `onResolveExternalObject` calls.
   *
   * Requires `external.objects.refresh`.
   */
  onRefreshExternalObjects?(
    params: RefreshExternalObjectsParams,
  ): Promise<RefreshExternalObjectsResult>;

  /**
   * Called to validate provider-specific configuration for a plugin-hosted
   * environment driver.
   */
  onEnvironmentValidateConfig?(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult>;

  /** Called to test reachability or readiness of a plugin-hosted environment. */
  onEnvironmentProbe?(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult>;

  /** Called before a run starts to acquire a provider lease. */
  onEnvironmentAcquireLease?(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease>;

  /** Called to reconnect to a previously acquired provider lease. */
  onEnvironmentResumeLease?(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease>;

  /** Called when a run finishes and the provider lease can be released. */
  onEnvironmentReleaseLease?(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void>;

  /** Called when the host needs to force-destroy provider state. */
  onEnvironmentDestroyLease?(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void>;

  /** Called to materialize the run workspace inside the provider lease. */
  onEnvironmentRealizeWorkspace?(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult>;

  /** Called to execute a command inside the provider lease. */
  onEnvironmentExecute?(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult>;

  /**
   * Optional, opt-in: called before execution to place host files/directories at
   * target sandbox paths using a provider-native transport instead of the default
   * base64-over-exec fallback. Defining this hook (together with
   * `onEnvironmentSyncOut`) advertises `environmentSyncIn`; leaving it undefined
   * keeps the byte-identical fallback. See `doc/plugins/SANDBOX_FILE_SYNC_HOOKS.md`.
   */
  onEnvironmentSyncIn?(
    params: PluginEnvironmentSyncInParams,
  ): Promise<PluginEnvironmentSyncResult>;

  /**
   * Optional, opt-in: called after execution to copy sandbox files/directories
   * back to target host paths using a provider-native transport. Defining this
   * hook (together with `onEnvironmentSyncIn`) advertises `environmentSyncOut`.
   * See `doc/plugins/SANDBOX_FILE_SYNC_HOOKS.md`.
   */
  onEnvironmentSyncOut?(
    params: PluginEnvironmentSyncOutParams,
  ): Promise<PluginEnvironmentSyncResult>;

  /** Called to start an interactive setup sandbox and return redacted connection metadata. */
  onEnvironmentStartInteractiveSetup?(
    params: PluginEnvironmentStartInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession>;

  /** Called to read setup status and, when authorized, a one-time connection payload. */
  onEnvironmentGetInteractiveSetup?(
    params: PluginEnvironmentGetInteractiveSetupParams,
  ): Promise<PluginEnvironmentInteractiveSetupSession>;

  /** Called to capture a reusable provider template from a live setup sandbox. */
  onEnvironmentCaptureTemplate?(
    params: PluginEnvironmentCaptureTemplateParams,
  ): Promise<PluginEnvironmentCaptureTemplateResult>;

  /** Called to cancel and clean up a setup sandbox without promoting a template. */
  onEnvironmentCancelInteractiveSetup?(
    params: PluginEnvironmentCancelInteractiveSetupParams,
  ): Promise<PluginEnvironmentCancelInteractiveSetupResult>;

  /** Called for optional best-effort cleanup of a captured provider template. */
  onEnvironmentDeleteTemplate?(
    params: PluginEnvironmentDeleteTemplateParams,
  ): Promise<PluginEnvironmentDeleteTemplateResult>;
}

// ---------------------------------------------------------------------------
// PaperclipPlugin — the sealed object returned by definePlugin()
// ---------------------------------------------------------------------------

/**
 * The sealed plugin object returned by `definePlugin()`.
 *
 * Plugin authors export this as the default export from their worker
 * entrypoint. The host imports it and calls the lifecycle methods.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PaperclipPlugin {
  /** The original plugin definition passed to `definePlugin()`. */
  readonly definition: PluginDefinition;
}

// ---------------------------------------------------------------------------
// definePlugin — top-level factory
// ---------------------------------------------------------------------------

/**
 * Define a Paperclip plugin.
 *
 * Call this function in your worker entrypoint and export the result as the
 * default export. The host will import the module and call lifecycle methods
 * on the returned object.
 *
 * @param definition - Plugin lifecycle handlers
 * @returns A sealed `PaperclipPlugin` object for the host to consume
 *
 * @example
 * ```ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Plugin started");
 *     ctx.events.on("issue.created", async (event) => {
 *       // handle event
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 * ```
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin {
  return Object.freeze({ definition });
}
