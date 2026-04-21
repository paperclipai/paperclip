/**
 * `@paperclipai/plugin-sdk` — Paperclip plugin worker-side SDK.
 *
 * This is the main entrypoint for plugin worker code.  For plugin UI bundles,
 * import from `@paperclipai/plugin-sdk/ui` instead.
 *
 * @example
 * ```ts
 * // Plugin worker entrypoint (dist/worker.ts)
 * import { definePlugin, runWorker, z } from "@paperclipai/plugin-sdk";
 *
 * const plugin = definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Plugin starting up");
 *
 *     ctx.events.on("issue.created", async (event) => {
 *       ctx.logger.info("Issue created", { issueId: event.entityId });
 *     });
 *
 *     ctx.jobs.register("full-sync", async (job) => {
 *       ctx.logger.info("Starting full sync", { runId: job.runId });
 *       // ... sync implementation
 *     });
 *
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({
 *         scopeKind: "company",
 *         scopeId: String(companyId),
 *         stateKey: "last-sync-at",
 *       });
 *       return { lastSync: state };
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 *
 * export default plugin;
 * runWorker(plugin, import.meta.url);
 * ```
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export { definePlugin } from "./define-plugin.js";
export { createTestHarness } from "./testing.js";
export { createPluginBundlerPresets } from "./bundlers.js";
export { startPluginDevServer, getUiBuildSnapshot } from "./dev-server.js";
export { startWorkerRpcHost, runWorker } from "./worker-rpc-host.js";
export {
  createHostClientHandlers,
  getRequiredCapability,
  CapabilityDeniedError,
} from "./host-client-factory.js";

// JSON-RPC protocol helpers and constants
export {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  HOST_TO_WORKER_REQUIRED_METHODS,
  HOST_TO_WORKER_OPTIONAL_METHODS,
  MESSAGE_DELIMITER,
  createRequest,
  createSuccessResponse,
  createErrorResponse,
  createNotification,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  serializeMessage,
  parseMessage,
  JsonRpcParseError,
  JsonRpcCallError,
  _resetIdCounter,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

// Plugin definition and lifecycle types
export type {
  PluginDefinition,
  PaperclipPlugin,
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
  PluginApiRequestInput,
  PluginApiResponse,
} from "./define-plugin.js";
export type {
  TestHarness,
  TestHarnessOptions,
  TestHarnessLogEntry,
} from "./testing.js";
export type {
  PluginBundlerPresetInput,
  PluginBundlerPresets,
  EsbuildLikeOptions,
  RollupLikeConfig,
} from "./bundlers.js";
export type { PluginDevServer, PluginDevServerOptions } from "./dev-server.js";
export type {
  WorkerRpcHostOptions,
  WorkerRpcHost,
  RunWorkerOptions,
} from "./worker-rpc-host.js";
export type {
  HostServices,
  HostClientFactoryOptions,
  HostClientHandlers,
} from "./host-client-factory.js";

// JSON-RPC protocol types
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcErrorCode,
  PluginRpcErrorCode,
  InitializeParams,
  InitializeResult,
  ConfigChangedParams,
  ValidateConfigParams,
  OnEventParams,
  RunJobParams,
  GetDataParams,
  PerformActionParams,
  ExecuteToolParams,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginLauncherRenderContextSnapshot,
  HostToWorkerMethods,
  HostToWorkerMethodName,
  WorkerToHostMethods,
  WorkerToHostMethodName,
  HostToWorkerRequest,
  HostToWorkerResponse,
  WorkerToHostRequest,
  WorkerToHostResponse,
  WorkerToHostNotifications,
  WorkerToHostNotificationName,
} from "./protocol.js";

// Plugin context and all client interfaces
export type {
  PluginContext,
  PluginConfigClient,
  PluginEventsClient,
  PluginJobsClient,
  PluginLaunchersClient,
  PluginHttpClient,
  PluginSecretsClient,
  PluginActivityClient,
  PluginActivityLogEntry,
  PluginStateClient,
  PluginEntitiesClient,
  PluginProjectsClient,
  PluginCompaniesClient,
  PluginIssuesClient,
  PluginIssueMutationActor,
  PluginIssueRelationsClient,
  PluginIssueRelationSummary,
  PluginIssueCheckoutOwnership,
  PluginIssueWakeupResult,
  PluginIssueWakeupBatchResult,
  PluginIssueRunSummary,
  PluginIssueApprovalSummary,
  PluginIssueCostSummary,
  PluginBudgetIncidentSummary,
  PluginIssueInvocationBlockSummary,
  PluginIssueOrchestrationSummary,
  PluginIssueSubtreeOptions,
  PluginIssueAssigneeSummary,
  PluginIssueSubtree,
  PluginIssueSummariesClient,
  PluginAgentsClient,
  PluginAgentSessionsClient,
  AgentSession,
  AgentSessionEvent,
  AgentSessionSendResult,
  PluginGoalsClient,
  PluginDataClient,
  PluginActionsClient,
  PluginStreamsClient,
  PluginToolsClient,
  PluginMetricsClient,
  PluginTelemetryClient,
  PluginLogger,
} from "./types.js";

// Supporting types for context clients
export type {
  ScopeKey,
  EventFilter,
  PluginEvent,
  PluginJobContext,
  PluginLauncherRegistration,
  ToolRunContext,
  ToolResult,
  PluginEntityUpsert,
  PluginEntityRecord,
  PluginEntityQuery,
  PluginWorkspace,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueDocumentSummary,
  Agent,
  Goal,
  PluginDatabaseClient,
} from "./types.js";

// Manifest and constant types re-exported from @paperclipai/shared
// Plugin authors import manifest types from here so they have a single
// dependency (@paperclipai/plugin-sdk) for all plugin authoring needs.
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
  PluginDatabaseDeclaration,
  PluginApiRouteCompanyResolution,
  PluginApiRouteDeclaration,
  PluginRecord,
  PluginDatabaseNamespaceRecord,
  PluginMigrationRecord,
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
  PluginDatabaseCoreReadTable,
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceMode,
  PluginDatabaseNamespaceStatus,
  PluginApiRouteAuthMode,
  PluginApiRouteCheckoutPolicy,
  PluginApiRouteMethod,
  PluginEventType,
  PluginBridgeErrorCode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod re-export
// ---------------------------------------------------------------------------

/**
 * Zod is re-exported for plugin authors to use when defining their
 * `instanceConfigSchema` and tool `parametersSchema`.
 *
 * Plugin authors do not need to add a separate `zod` dependency.
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 *
 * @example
 * ```ts
 * import { z } from "@paperclipai/plugin-sdk";
 *
 * const configSchema = z.object({
 *   apiKey: z.string().describe("Your API key"),
 *   workspace: z.string().optional(),
 * });
 * ```
 */
export { z } from "zod";

// ---------------------------------------------------------------------------
// Constants re-exports (for plugin code that needs to check values at runtime)
// ---------------------------------------------------------------------------

export {
  PLUGIN_API_VERSION,
  PLUGIN_STATUSES,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_STATE_SCOPE_KINDS,
  PLUGIN_JOB_STATUSES,
  PLUGIN_JOB_RUN_STATUSES,
  PLUGIN_JOB_RUN_TRIGGERS,
  PLUGIN_WEBHOOK_DELIVERY_STATUSES,
  PLUGIN_EVENT_TYPES,
  PLUGIN_BRIDGE_ERROR_CODES,
} from "@paperclipai/shared";
