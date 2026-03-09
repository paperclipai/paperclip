/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins (soft delete or hard purge)
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 * - Discovering and executing plugin-contributed agent tools
 *
 * All routes require board-level authentication (assertBoard middleware).
 *
 * @module server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginWebhookDeliveries } from "@paperclipai/db";
import type {
  PluginStatus,
  PaperclipPluginManifestV1,
  PluginBridgeErrorCode,
  PluginLauncherRenderContextSnapshot,
  UpdateCompanyPluginAvailability,
} from "@paperclipai/shared";
import {
  PLUGIN_STATUSES,
  updateCompanyPluginAvailabilitySchema,
} from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { getPluginUiContributionMetadata, pluginLoader } from "../services/plugin-loader.js";
import { logActivity } from "../services/activity-log.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/** UI slot declaration extracted from plugin manifest */
type PluginUiSlotDeclaration = NonNullable<NonNullable<PaperclipPluginManifestV1["ui"]>["slots"]>[number];
/** Launcher declaration extracted from plugin manifest */
type PluginLauncherDeclaration = NonNullable<PaperclipPluginManifestV1["launchers"]>[number];

/**
 * Normalized UI contribution for frontend slot host consumption.
 * Only includes plugins in 'ready' state with non-empty slot declarations.
 */
type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  /**
   * Relative path within the plugin's UI directory to the entry module
   * (e.g. `"index.js"`). The frontend constructs the full import URL as
   * `/_plugins/${pluginId}/ui/${uiEntryFile}`.
   */
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

/** Request body for POST /api/plugins/install */
interface PluginInstallRequest {
  /** npm package name (e.g., @paperclip/plugin-linear) or local path */
  packageName: string;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
}

/** Response body for GET /api/plugins/:pluginId/health */
interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/** UUID v4 regex used for plugin ID route resolution. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve a plugin by either database ID or plugin key.
 *
 * Lookup order:
 * - UUID-like IDs: getById first, then getByKey.
 * - Scoped package keys (e.g. "@scope/name"): getByKey only, never getById.
 * - Other non-UUID IDs: try getById first (test/memory registries may allow this),
 *   then fallback to getByKey. Any UUID parse error from getById is ignored.
 *
 * @param registry - The plugin registry service instance
 * @param pluginId - Either a database UUID or plugin key (manifest id)
 * @returns Plugin record or null if not found
 */
async function resolvePlugin(
  registry: ReturnType<typeof pluginRegistryService>,
  pluginId: string,
) {
  const isUuid = UUID_REGEX.test(pluginId);
  const isScopedPackageKey = pluginId.startsWith("@") || pluginId.includes("/");

  // Scoped package IDs are valid plugin keys but invalid UUIDs.
  // Skip getById() entirely to avoid Postgres uuid parse errors.
  if (isScopedPackageKey && !isUuid) {
    return registry.getByKey(pluginId);
  }

  try {
    const byId = await registry.getById(pluginId);
    if (byId) return byId;
  } catch (error) {
    const maybeCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    // Ignore invalid UUID cast errors and continue with key lookup.
    if (maybeCode !== "22P02") {
      throw error;
    }
  }

  return registry.getByKey(pluginId);
}

async function isPluginAvailableForCompany(
  registry: ReturnType<typeof pluginRegistryService>,
  companyId: string,
  pluginId: string,
): Promise<boolean> {
  const availability = await registry.getCompanyAvailability(companyId, pluginId);
  return availability?.available === true;
}

/**
 * Optional dependencies for plugin job scheduling routes.
 *
 * When provided, job-related routes (list jobs, list runs, trigger job) are
 * mounted. When omitted, the routes return 501 Not Implemented.
 */
export interface PluginRouteJobDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
}

/**
 * Optional dependencies for plugin webhook routes.
 *
 * When provided, the webhook ingestion route is enabled. When omitted,
 * webhook POST requests return 501 Not Implemented.
 */
export interface PluginRouteWebhookDeps {
  /** The worker manager for dispatching handleWebhook RPC calls. */
  workerManager: PluginWorkerManager;
}

/**
 * Optional dependencies for plugin tool routes.
 *
 * When provided, tool discovery and execution routes are enabled.
 * When omitted, the tool routes return 501 Not Implemented.
 */
export interface PluginRouteToolDeps {
  /** The tool dispatcher for listing and executing plugin tools. */
  toolDispatcher: PluginToolDispatcher;
}

/**
 * Optional dependencies for plugin UI bridge routes.
 *
 * When provided, the getData and performAction bridge proxy routes are enabled,
 * allowing plugin UI components to communicate with their worker backend via
 * `usePluginData()` and `usePluginAction()` hooks.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginRouteBridgeDeps {
  /** The worker manager for dispatching getData/performAction RPC calls. */
  workerManager: PluginWorkerManager;
}

/** Request body for POST /api/plugins/tools/execute */
interface PluginToolExecuteRequest {
  /** Fully namespaced tool name (e.g., "acme.linear:search-issues"). */
  tool: string;
  /** Parameters matching the tool's declared JSON Schema. */
  parameters?: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
}

/**
 * Create Express router for plugin management API.
 *
 * Routes provided:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /plugins | List all plugins (optional ?status= filter) |
 * | GET | /plugins/ui-contributions | Get UI slots from ready plugins |
 * | GET | /plugins/:pluginId | Get single plugin by ID or key |
 * | POST | /plugins/install | Install from npm or local path |
 * | DELETE | /plugins/:pluginId | Uninstall (optional ?purge=true) |
 * | POST | /plugins/:pluginId/enable | Enable a plugin |
 * | POST | /plugins/:pluginId/disable | Disable a plugin |
 * | GET | /plugins/:pluginId/health | Run health diagnostics |
 * | POST | /plugins/:pluginId/upgrade | Upgrade to newer version |
 * | GET | /plugins/:pluginId/jobs | List jobs for a plugin |
 * | GET | /plugins/:pluginId/jobs/:jobId/runs | List runs for a job |
 * | POST | /plugins/:pluginId/jobs/:jobId/trigger | Manually trigger a job |
 * | POST | /plugins/:pluginId/webhooks/:endpointKey | Receive inbound webhook |
 * | GET | /plugins/tools | List all available plugin tools |
 * | GET | /plugins/tools?pluginId=... | List tools for a specific plugin |
 * | POST | /plugins/tools/execute | Execute a plugin tool |
 * | GET | /plugins/:pluginId/config | Get current plugin config |
 * | POST | /plugins/:pluginId/config | Save (upsert) plugin config |
 * | POST | /plugins/:pluginId/config/test | Test config via validateConfig RPC |
 * | GET | /companies/:companyId/plugins | List company-scoped plugin availability |
 * | GET | /companies/:companyId/plugins/:pluginId | Get company-scoped plugin availability |
 * | PUT | /companies/:companyId/plugins/:pluginId | Save company-scoped plugin availability/settings |
 * | POST | /plugins/:pluginId/bridge/data | Proxy getData to plugin worker |
 * | POST | /plugins/:pluginId/bridge/action | Proxy performAction to plugin worker |
 * | POST | /plugins/:pluginId/data/:key | Proxy getData to plugin worker (key in URL) |
 * | POST | /plugins/:pluginId/actions/:key | Proxy performAction to plugin worker (key in URL) |
 * | GET | /plugins/:pluginId/dashboard | Aggregated health dashboard data |
 *
 * **Route Ordering Note:** Static routes (like /ui-contributions, /tools) must be
 * registered before parameterized routes (like /:pluginId) to prevent Express from
 * matching them as a plugin ID.
 *
 * @param db - Database connection instance
 * @param jobDeps - Optional job scheduling dependencies
 * @param webhookDeps - Optional webhook ingestion dependencies
 * @param toolDeps - Optional tool dispatcher dependencies
 * @param bridgeDeps - Optional bridge proxy dependencies for getData/performAction
 * @returns Express router with plugin routes mounted
 */
export function pluginRoutes(
  db: Db,
  loader: ReturnType<typeof pluginLoader>,
  jobDeps?: PluginRouteJobDeps,
  webhookDeps?: PluginRouteWebhookDeps,
  toolDeps?: PluginRouteToolDeps,
  bridgeDeps?: PluginRouteBridgeDeps,
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const lifecycle = pluginLifecycleManager(db, {
    loader,
    workerManager: bridgeDeps?.workerManager ?? webhookDeps?.workerManager,
  });

  /**
   * GET /api/plugins
   *
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * Query params:
   * - `status` (optional): Filter by lifecycle status. Must be one of the
   *   values in `PLUGIN_STATUSES` (`installed`, `ready`, `error`,
   *   `upgrade_pending`, `uninstalled`). Returns HTTP 400 if the value is
   *   not a recognised status string.
   *
   * Response: `PluginRecord[]`
   */
  router.get("/plugins", async (req, res) => {
    assertBoard(req);
    const rawStatus = req.query.status;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== "string" || !(PLUGIN_STATUSES as readonly string[]).includes(rawStatus)) {
        res.status(400).json({
          error: `Invalid status '${String(rawStatus)}'. Must be one of: ${PLUGIN_STATUSES.join(", ")}`,
        });
        return;
      }
    }
    const status = rawStatus as PluginStatus | undefined;
    const plugins = status
      ? await registry.listByStatus(status)
      : await registry.listInstalled();
    res.json(plugins);
  });

  // IMPORTANT: Static routes must come before parameterized routes
  // to avoid Express matching "ui-contributions" as a :pluginId

  /**
   * GET /api/plugins/ui-contributions
   *
   * Return UI contributions from all plugins in 'ready' state.
   * Used by the frontend to discover plugin UI slots and launcher metadata.
   *
   * The response is normalized for the frontend slot host:
   * - Only includes plugins with at least one declared UI slot or launcher
   * - Excludes plugins with null/missing manifestJson (defensive)
   * - Slots are extracted from manifest.ui.slots
   * - Launchers are aggregated from legacy manifest.launchers and manifest.ui.launchers
   *
   * Query params:
   * - `companyId` (optional): filters out plugins disabled for the target
   *   company and applies `assertCompanyAccess`
   *
   * Example response:
   * ```json
   * [
   *   {
   *     "pluginId": "plg_123",
   *     "pluginKey": "paperclip.claude-usage",
   *     "displayName": "Claude Usage",
   *     "version": "1.0.0",
   *     "uiEntryFile": "index.js",
   *     "slots": [],
   *     "launchers": [
   *       {
   *         "id": "claude-usage-toolbar",
   *         "displayName": "Claude Usage",
   *         "placementZone": "toolbarButton",
   *         "action": { "type": "openModal", "target": "ClaudeUsageView" },
   *         "render": { "environment": "hostOverlay", "bounds": "wide" }
   *       }
   *     ]
   *   }
   * ]
   * ```
   *
   * Response: PluginUiContribution[]
   */
  router.get("/plugins/ui-contributions", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (companyId) {
      assertCompanyAccess(req, companyId);
    }

    const plugins = await registry.listByStatus("ready");
    const availablePluginIds = companyId
      ? new Set(
        (await registry.listCompanyAvailability(companyId, { available: true }))
          .map((entry) => entry.pluginId),
      )
      : null;

    const contributions: PluginUiContribution[] = plugins
      .filter((plugin) => availablePluginIds === null || availablePluginIds.has(plugin.id))
      .map((plugin) => {
        // Safety check: manifestJson should always exist for ready plugins, but guard against null
        const manifest = plugin.manifestJson;
        if (!manifest) return null;

        const uiMetadata = getPluginUiContributionMetadata(manifest);
        if (!uiMetadata) return null;

        return {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          displayName: manifest.displayName,
          version: plugin.version,
          updatedAt: plugin.updatedAt.toISOString(),
          uiEntryFile: uiMetadata.uiEntryFile,
          slots: uiMetadata.slots,
          launchers: uiMetadata.launchers,
        };
      })
      .filter((item): item is PluginUiContribution => item !== null);
    res.json(contributions);
  });

  // ===========================================================================
  // Company-scoped plugin settings / availability routes
  // ===========================================================================

  /**
   * GET /api/companies/:companyId/plugins
   *
   * List every installed plugin as it applies to a specific company. Plugins
   * are enabled by default; rows in `plugin_company_settings` only store
   * explicit overrides and any company-scoped settings payload.
   *
   * Query params:
   * - `available` (optional): `true` or `false` filter
   */
  router.get("/companies/:companyId/plugins", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    let available: boolean | undefined;
    const rawAvailable = req.query.available;
    if (rawAvailable !== undefined) {
      if (rawAvailable === "true") available = true;
      else if (rawAvailable === "false") available = false;
      else {
        res.status(400).json({ error: '"available" must be "true" or "false"' });
        return;
      }
    }

    const result = await registry.listCompanyAvailability(companyId, { available });
    res.json(result);
  });

  /**
   * GET /api/companies/:companyId/plugins/:pluginId
   *
   * Resolve one plugin's effective availability for a company, whether that
   * result comes from the default-enabled baseline or a persisted override row.
   */
  router.get("/companies/:companyId/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin || plugin.status === "uninstalled") {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const result = await registry.getCompanyAvailability(companyId, plugin.id);
    if (!result) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    res.json(result);
  });

  /**
   * PUT /api/companies/:companyId/plugins/:pluginId
   *
   * Persist a company-scoped availability override. This never changes the
   * instance-wide install state of the plugin; it only controls whether the
   * selected company can see UI contributions and invoke plugin-backed actions.
   */
  router.put("/companies/:companyId/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params;
    assertCompanyAccess(req, companyId);

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin || plugin.status === "uninstalled") {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const parsed = updateCompanyPluginAvailabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
      return;
    }

    try {
      const result = await registry.updateCompanyAvailability(
        companyId,
        plugin.id,
        parsed.data as UpdateCompanyPluginAvailability,
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "plugin.company_settings.updated",
        entityType: "plugin_company_settings",
        entityId: `${companyId}:${plugin.id}`,
        details: {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          available: result.available,
          settingsJson: result.settingsJson,
          lastError: result.lastError,
        },
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Tool discovery and execution routes
  // ===========================================================================

  /**
   * GET /api/plugins/tools
   *
   * List all available plugin-contributed tools in an agent-friendly format.
   *
   * Query params:
   * - `pluginId` (optional): Filter to tools from a specific plugin
   *
   * Response: `AgentToolDescriptor[]`
   * Errors: 501 if tool dispatcher is not configured
   */
  router.get("/plugins/tools", async (req, res) => {
    assertBoard(req);

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled" });
      return;
    }

    const pluginId = req.query.pluginId as string | undefined;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    if (companyId) {
      assertCompanyAccess(req, companyId);
    }

    const filter = pluginId ? { pluginId } : undefined;
    const tools = toolDeps.toolDispatcher.listToolsForAgent(filter);
    if (!companyId) {
      res.json(tools);
      return;
    }

    const availablePluginIds = new Set(
      (await registry.listCompanyAvailability(companyId, { available: true }))
        .map((entry) => entry.pluginId),
    );
    res.json(tools.filter((tool) => availablePluginIds.has(tool.pluginId)));
  });

  /**
   * Reject company-scoped plugin access when the plugin is disabled for the
   * target company. This guard is reused across UI bridge and tool execution
   * endpoints so every runtime surface honors the same availability rule.
   */
  async function enforceCompanyPluginAvailability(
    companyId: string,
    pluginId: string,
    res: Response,
  ): Promise<boolean> {
    if (!await isPluginAvailableForCompany(registry, companyId, pluginId)) {
      res.status(403).json({
        error: `Plugin "${pluginId}" is not enabled for company "${companyId}"`,
      });
      return false;
    }

    return true;
  }

  /**
   * POST /api/plugins/tools/execute
   *
   * Execute a plugin-contributed tool by its namespaced name.
   *
   * This is the primary endpoint used by the agent service to invoke
   * plugin tools during an agent run.
   *
   * Request body:
   * - `tool`: Fully namespaced tool name (e.g., "acme.linear:search-issues")
   * - `parameters`: Parameters matching the tool's declared JSON Schema
   * - `runContext`: Agent run context with agentId, runId, companyId, projectId
   *
   * Response: `ToolExecutionResult`
   * Errors:
   * - 400 if request validation fails
   * - 404 if tool is not found
   * - 501 if tool dispatcher is not configured
   * - 502 if the plugin worker is unavailable or the RPC call fails
   */
  router.post("/plugins/tools/execute", async (req, res) => {
    assertBoard(req);

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled" });
      return;
    }

    const body = (req.body as PluginToolExecuteRequest | undefined);
    if (!body) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const { tool, parameters, runContext } = body;

    // Validate required fields
    if (!tool || typeof tool !== "string") {
      res.status(400).json({ error: '"tool" is required and must be a string' });
      return;
    }

    if (!runContext || typeof runContext !== "object") {
      res.status(400).json({ error: '"runContext" is required and must be an object' });
      return;
    }

    if (!runContext.agentId || !runContext.runId || !runContext.companyId || !runContext.projectId) {
      res.status(400).json({
        error: '"runContext" must include agentId, runId, companyId, and projectId',
      });
      return;
    }

    assertCompanyAccess(req, runContext.companyId);

    // Verify the tool exists
    const registeredTool = toolDeps.toolDispatcher.getTool(tool);
    if (!registeredTool) {
      res.status(404).json({ error: `Tool "${tool}" not found` });
      return;
    }

    if (!await enforceCompanyPluginAvailability(runContext.companyId, registeredTool.pluginId, res)) {
      return;
    }

    try {
      const result = await toolDeps.toolDispatcher.executeTool(
        tool,
        parameters ?? {},
        runContext,
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish between "worker not running" (502) and other errors (500)
      if (message.includes("not running") || message.includes("worker")) {
        res.status(502).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /**
   * POST /api/plugins/install
   *
   * Install a plugin from npm or a local filesystem path.
   *
   * Request body:
   * - packageName: npm package name or local path (required)
   * - version: Target version for npm packages (optional)
   * - isLocalPath: Set true if packageName is a local path
   *
   * The installer:
   * 1. Downloads from npm or loads from local path
   * 2. Validates the manifest (schema + capability consistency)
   * 3. Registers in the database
   * 4. Transitions to `ready` state if no new capability approval is needed
   *
   * Response: `PluginRecord`
   *
   * Errors:
   * - `400` — validation failure or install error (package not found, bad manifest, etc.)
   * - `500` — installation succeeded but manifest is missing (indicates a loader bug)
   */
  router.post("/plugins/install", async (req, res) => {
    assertBoard(req);
    const { packageName, version, isLocalPath } = req.body as PluginInstallRequest;

    // Input validation
    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required and must be a string" });
      return;
    }

    if (version !== undefined && typeof version !== "string") {
      res.status(400).json({ error: "version must be a string if provided" });
      return;
    }

    if (isLocalPath !== undefined && typeof isLocalPath !== "boolean") {
      res.status(400).json({ error: "isLocalPath must be a boolean if provided" });
      return;
    }

    // Validate package name format
    const trimmedPackage = packageName.trim();
    if (trimmedPackage.length === 0) {
      res.status(400).json({ error: "packageName cannot be empty" });
      return;
    }

    // Basic security check for package name (prevent injection)
    if (!isLocalPath && /[<>:"|?*]/.test(trimmedPackage)) {
      res.status(400).json({ error: "packageName contains invalid characters" });
      return;
    }

    try {
      const installOptions = isLocalPath
        ? { localPath: trimmedPackage }
        : { packageName: trimmedPackage, version: version?.trim() };

      const discovered = await loader.installPlugin(installOptions);

      if (!discovered.manifest) {
        res.status(500).json({ error: "Plugin installed but manifest is missing" });
        return;
      }

      // Transition to ready state
      const existingPlugin = await registry.getByKey(discovered.manifest.id);
      if (existingPlugin) {
        await lifecycle.load(existingPlugin.id);
        // Plugins should be enabled by default for all companies after install.
        // Best-effort: default behavior is still enabled when no row exists.
        try {
          await registry.seedEnabledForAllCompanies(existingPlugin.id);
        } catch {
          // no-op
        }
        const updated = await registry.getById(existingPlugin.id);
        res.json(updated);
      } else {
        // This shouldn't happen since installPlugin already registers in the DB
        res.status(500).json({ error: "Plugin installed but not found in registry" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // UI Bridge proxy routes (getData / performAction)
  // ===========================================================================

  /** Request body for POST /api/plugins/:pluginId/bridge/data */
  interface PluginBridgeDataRequest {
    /** Plugin-defined data key (e.g. `"sync-health"`). */
    key: string;
    /** Optional company scope for enforcing company plugin availability. */
    companyId?: string;
    /** Optional context and query parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Request body for POST /api/plugins/:pluginId/bridge/action */
  interface PluginBridgeActionRequest {
    /** Plugin-defined action key (e.g. `"resync"`). */
    key: string;
    /** Optional company scope for enforcing company plugin availability. */
    companyId?: string;
    /** Optional parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Response envelope for bridge errors. */
  interface PluginBridgeErrorResponse {
    code: PluginBridgeErrorCode;
    message: string;
    details?: unknown;
  }

  /**
   * Map a worker RPC error to a bridge-level error code.
   *
   * JsonRpcCallError carries numeric codes from the plugin RPC error code space.
   * This helper maps them to the string error codes defined in PluginBridgeErrorCode.
   *
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  function mapRpcErrorToBridgeError(err: unknown): PluginBridgeErrorResponse {
    if (err instanceof JsonRpcCallError) {
      switch (err.code) {
        case PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE:
          return {
            code: "WORKER_UNAVAILABLE",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED:
          return {
            code: "CAPABILITY_DENIED",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.TIMEOUT:
          return {
            code: "TIMEOUT",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.WORKER_ERROR:
          return {
            code: "WORKER_ERROR",
            message: err.message,
            details: err.data,
          };
        default:
          return {
            code: "UNKNOWN",
            message: err.message,
            details: err.data,
          };
      }
    }

    const message = err instanceof Error ? err.message : String(err);

    // Worker not running — surface as WORKER_UNAVAILABLE
    if (message.includes("not running") || message.includes("not registered")) {
      return {
        code: "WORKER_UNAVAILABLE",
        message,
      };
    }

    return {
      code: "UNKNOWN",
      message,
    };
  }

  /**
   * POST /api/plugins/:pluginId/bridge/data
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginData(key, params)` bridge hook.
   * The frontend sends a POST with the data key and optional params; the host
   * forwards the call to the worker via the `getData` RPC method and returns
   * the result.
   *
   * Request body:
   * - `key`: Plugin-defined data key (e.g. `"sync-health"`)
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/data", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeDataRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.companyId) {
      assertCompanyAccess(req, body.companyId);
      if (!await enforceCompanyPluginAvailability(body.companyId, plugin.id, res)) {
        return;
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/bridge/action
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginAction(key)` bridge hook.
   * The frontend sends a POST with the action key and optional params; the host
   * forwards the call to the worker via the `performAction` RPC method and
   * returns the result.
   *
   * Request body:
   * - `key`: Plugin-defined action key (e.g. `"resync"`)
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/action", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeActionRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.companyId) {
      assertCompanyAccess(req, body.companyId);
      if (!await enforceCompanyPluginAvailability(body.companyId, plugin.id, res)) {
        return;
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // URL-keyed bridge routes (key as path parameter)
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/data/:key
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker, with the
   * data key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/data`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/data/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as {
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined;

    if (body?.companyId) {
      assertCompanyAccess(req, body.companyId);
      if (!await enforceCompanyPluginAvailability(body.companyId, plugin.id, res)) {
        return;
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/actions/:key
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker, with
   * the action key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/action`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/actions/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as {
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined;

    if (body?.companyId) {
      assertCompanyAccess(req, body.companyId);
      if (!await enforceCompanyPluginAvailability(body.companyId, plugin.id, res)) {
        return;
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * GET /api/plugins/:pluginId
   *
   * Get detailed information about a single plugin.
   *
   * The :pluginId parameter accepts either:
   * - Database UUID (e.g., "abc123-def456")
   * - Plugin key (e.g., "acme.linear")
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    res.json(plugin);
  });

  /**
   * DELETE /api/plugins/:pluginId
   *
   * Uninstall a plugin.
   *
   * Query params:
   * - purge: If "true", permanently delete all plugin data (hard delete)
   *          Otherwise, soft-delete with 30-day data retention
   *
   * Response: PluginRecord (the deleted record)
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.delete("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const purge = req.query.purge === "true";

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.unload(plugin.id, purge);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/enable
   *
   * Enable a plugin that is currently disabled or in error state.
   *
   * Transitions the plugin to 'ready' state after loading and validation.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/enable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.enable(plugin.id);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/disable
   *
   * Disable a running plugin.
   *
   * Request body (optional):
   * - reason: Human-readable reason for disabling
   *
   * The plugin transitions to 'installed' state and stops processing events.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/disable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { reason?: string } | undefined;
    const reason = body?.reason;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.disable(plugin.id, reason);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/health
   *
   * Run health diagnostics on a plugin.
   *
   * Performs the following checks:
   * 1. Registry: Plugin is registered in the database
   * 2. Manifest: Manifest is valid and parseable
   * 3. Status: Plugin is in 'ready' state
   * 4. Error state: Plugin has no unhandled errors
   *
   * Response: PluginHealthCheckResult
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/health", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const checks: PluginHealthCheckResult["checks"] = [];

    // Check 1: Plugin is registered
    checks.push({
      name: "registry",
      passed: true,
      message: "Plugin found in registry",
    });

    // Check 2: Manifest is valid
    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    // Check 3: Plugin status
    const isHealthy = plugin.status === "ready";
    checks.push({
      name: "status",
      passed: isHealthy,
      message: `Current status: ${plugin.status}`,
    });

    // Check 4: No last error
    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({
        name: "error_state",
        passed: false,
        message: plugin.lastError ?? undefined,
      });
    }

    const result: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    res.json(result);
  });

  /**
   * POST /api/plugins/:pluginId/upgrade
   *
   * Upgrade a plugin to a newer version.
   *
   * Request body (optional):
   * - version: Target version (defaults to latest)
   *
   * If the upgrade adds new capabilities, the plugin transitions to
   * 'upgrade_pending' state for board approval. Otherwise, it goes
   * directly to 'ready'.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/upgrade", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { version?: string } | undefined;
    const version = body?.version;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      // Upgrade the plugin - this would typically:
      // 1. Download the new version
      // 2. Compare capabilities
      // 3. If new capabilities, mark as upgrade_pending
      // 4. Otherwise, transition to ready
      const result = await lifecycle.upgrade(plugin.id, version);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Plugin configuration routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/config
   *
   * Retrieve the current instance configuration for a plugin.
   *
   * Returns the `PluginConfig` record if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * Response: `PluginConfig | null`
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const config = await registry.getConfig(plugin.id);
    res.json(config);
  });

  /**
   * POST /api/plugins/:pluginId/config
   *
   * Save (create or replace) the instance configuration for a plugin.
   *
   * The caller provides the full `configJson` object. The server persists it
   * via `registry.upsertConfig()`.
   *
   * Request body:
   * - `configJson`: Configuration values matching the plugin's `instanceConfigSchema`
   *
   * Response: `PluginConfig`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   */
  router.post("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    try {
      const result = await registry.upsertConfig(plugin.id, {
        configJson: body.configJson,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/config/test
   *
   * Test a plugin configuration without persisting it by calling the plugin
   * worker's `validateConfig` RPC method.
   *
   * Only works when the plugin's worker implements `onValidateConfig`.
   * If the worker does not implement the method, returns
   * `{ valid: false, message: "..." }` with HTTP 200.
   *
   * Request body:
   * - `configJson`: Configuration values to validate
   *
   * Response: `{ valid: boolean; message?: string }`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps (worker manager) are not configured
   * - 502 if the worker is unavailable
   */
  router.post("/plugins/:pluginId/config/test", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "validateConfig",
        { config: body.configJson },
      );

      // The worker returns PluginConfigValidationResult { ok, warnings?, errors? }
      // Map to the frontend-expected shape { valid, message? }
      if (result.ok) {
        const warningText = result.warnings?.length
          ? `Warnings: ${result.warnings.join("; ")}`
          : undefined;
        res.json({ valid: true, message: warningText });
      } else {
        const errorText = result.errors?.length
          ? result.errors.join("; ")
          : "Configuration validation failed.";
        res.json({ valid: false, message: errorText });
      }
    } catch (err) {
      // If the worker does not implement validateConfig, return a structured response
      if (
        err instanceof JsonRpcCallError &&
        err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
      ) {
        res.json({
          valid: false,
          message: "This plugin does not support connection testing.",
        });
        return;
      }

      // Worker unavailable or other RPC errors
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // Job scheduling routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/jobs
   *
   * List all scheduled jobs for a plugin.
   *
   * Query params:
   * - `status` (optional): Filter by job status (`active`, `paused`, `failed`)
   *
   * Response: PluginJobRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const rawStatus = req.query.status as string | undefined;
    const validStatuses = ["active", "paused", "failed"];
    if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
      res.status(400).json({
        error: `Invalid status '${rawStatus}'. Must be one of: ${validStatuses.join(", ")}`,
      });
      return;
    }

    try {
      const jobs = await jobDeps.jobStore.listJobs(
        plugin.id,
        rawStatus as "active" | "paused" | "failed" | undefined,
      );
      res.json(jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/jobs/:jobId/runs
   *
   * List execution history for a specific job.
   *
   * Query params:
   * - `limit` (optional): Maximum number of runs to return (default: 50)
   *
   * Response: PluginJobRunRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs/:jobId/runs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    if (isNaN(limit) || limit < 1 || limit > 500) {
      res.status(400).json({ error: "limit must be a number between 1 and 500" });
      return;
    }

    try {
      const runs = await jobDeps.jobStore.listRunsByJob(jobId, limit);
      res.json(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/jobs/:jobId/trigger
   *
   * Manually trigger a job execution outside its cron schedule.
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately.
   * The response returns before the job completes (non-blocking).
   *
   * Response: `{ runId: string, jobId: string }`
   * Errors:
   * - 404 if plugin not found
   * - 400 if job not found, not active, already running, or worker unavailable
   */
  router.post("/plugins/:pluginId/jobs/:jobId/trigger", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Webhook ingestion route
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/webhooks/:endpointKey
   *
   * Receive an inbound webhook delivery for a plugin.
   *
   * This route is called by external systems (e.g. GitHub, Linear, Stripe) to
   * deliver webhook payloads to a plugin. The host validates that:
   * 1. The plugin exists and is in 'ready' state
   * 2. The plugin declares the `webhooks.receive` capability
   * 3. The `endpointKey` matches a declared webhook in the manifest
   *
   * The delivery is recorded in the `plugin_webhook_deliveries` table and
   * dispatched to the worker via the `handleWebhook` RPC method.
   *
   * **Note:** This route does NOT require board authentication — webhook
   * endpoints must be publicly accessible for external callers. Signature
   * verification is the plugin's responsibility.
   *
   * Response: `{ deliveryId: string, status: string }`
   * Errors:
   * - 404 if plugin not found or endpointKey not declared
   * - 400 if plugin is not in ready state or lacks webhooks.receive capability
   * - 502 if the worker is unavailable or the RPC call fails
   */
  router.post("/plugins/:pluginId/webhooks/:endpointKey", async (req, res) => {
    if (!webhookDeps) {
      res.status(501).json({ error: "Webhook ingestion is not enabled" });
      return;
    }

    const { pluginId, endpointKey } = req.params;

    // Step 1: Resolve the plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Validate the plugin is in 'ready' state
    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    // Step 3: Validate the plugin has webhooks.receive capability
    const manifest = plugin.manifestJson;
    if (!manifest) {
      res.status(400).json({ error: "Plugin manifest is missing" });
      return;
    }

    const capabilities = manifest.capabilities ?? [];
    if (!capabilities.includes("webhooks.receive")) {
      res.status(400).json({
        error: "Plugin does not have the webhooks.receive capability",
      });
      return;
    }

    // Step 4: Validate the endpointKey exists in the manifest's webhook declarations
    const declaredWebhooks = manifest.webhooks ?? [];
    const webhookDecl = declaredWebhooks.find(
      (w) => w.endpointKey === endpointKey,
    );
    if (!webhookDecl) {
      res.status(404).json({
        error: `Webhook endpoint '${endpointKey}' is not declared by this plugin`,
      });
      return;
    }

    // Step 5: Extract request data
    const requestId = randomUUID();
    const rawHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        rawHeaders[key] = value;
      } else if (Array.isArray(value)) {
        rawHeaders[key] = value.join(", ");
      }
    }

    // Express 5 may give undefined body when no Content-Type is set
    const rawBody = (req.body as Record<string, unknown> | undefined)
      ? JSON.stringify(req.body)
      : "";
    const parsedBody = req.body as unknown;
    const payload = (req.body as Record<string, unknown> | undefined) ?? {};

    // Step 6: Record the delivery in the database
    const startedAt = new Date();
    const [delivery] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: plugin.id,
        webhookKey: endpointKey,
        status: "pending",
        payload,
        headers: rawHeaders,
        startedAt,
      })
      .returning({ id: pluginWebhookDeliveries.id });

    // Step 7: Dispatch to the worker via handleWebhook RPC
    try {
      await webhookDeps.workerManager.call(plugin.id, "handleWebhook", {
        endpointKey,
        headers: req.headers as Record<string, string | string[]>,
        rawBody,
        parsedBody,
        requestId,
      });

      // Step 8: Update delivery record to success
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "success",
          durationMs,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(200).json({
        deliveryId: delivery.id,
        status: "success",
      });
    } catch (err) {
      // Step 8 (error): Update delivery record to failed
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          durationMs,
          error: errorMessage,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(502).json({
        deliveryId: delivery.id,
        status: "failed",
        error: errorMessage,
      });
    }
  });

  // ===========================================================================
  // Plugin health dashboard — aggregated diagnostics for the settings page
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/dashboard
   *
   * Aggregated health dashboard data for a plugin's settings page.
   *
   * Returns worker diagnostics (status, uptime, crash history), recent job
   * runs, recent webhook deliveries, and the current health check result —
   * all in a single response to avoid multiple round-trips.
   *
   * Response: PluginDashboardData
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/dashboard", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // --- Worker diagnostics ---
    let worker: {
      status: string;
      pid: number | null;
      uptime: number | null;
      consecutiveCrashes: number;
      totalCrashes: number;
      pendingRequests: number;
      lastCrashAt: number | null;
      nextRestartAt: number | null;
    } | null = null;

    // Try bridgeDeps first (primary source for worker manager), fallback to webhookDeps
    const wm = bridgeDeps?.workerManager ?? webhookDeps?.workerManager ?? null;
    if (wm) {
      const handle = wm.getWorker(plugin.id);
      if (handle) {
        const diag = handle.diagnostics();
        worker = {
          status: diag.status,
          pid: diag.pid,
          uptime: diag.uptime,
          consecutiveCrashes: diag.consecutiveCrashes,
          totalCrashes: diag.totalCrashes,
          pendingRequests: diag.pendingRequests,
          lastCrashAt: diag.lastCrashAt,
          nextRestartAt: diag.nextRestartAt,
        };
      }
    }

    // --- Recent job runs (last 10, newest first) ---
    let recentJobRuns: Array<{
      id: string;
      jobId: string;
      jobKey?: string;
      trigger: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    if (jobDeps) {
      try {
        const runs = await jobDeps.jobStore.listRunsByPlugin(plugin.id, undefined, 10);
        // Also fetch job definitions so we can include jobKey
        const jobs = await jobDeps.jobStore.listJobs(plugin.id);
        const jobKeyMap = new Map(jobs.map((j) => [j.id, j.jobKey]));

        recentJobRuns = runs
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r) => ({
            id: r.id,
            jobId: r.jobId,
            jobKey: jobKeyMap.get(r.jobId) ?? undefined,
            trigger: r.trigger,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error,
            startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
            finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
            createdAt: new Date(r.createdAt).toISOString(),
          }));
      } catch {
        // Job data unavailable — leave empty
      }
    }

    // --- Recent webhook deliveries (last 10, newest first) ---
    let recentWebhookDeliveries: Array<{
      id: string;
      webhookKey: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    try {
      const deliveries = await db
        .select({
          id: pluginWebhookDeliveries.id,
          webhookKey: pluginWebhookDeliveries.webhookKey,
          status: pluginWebhookDeliveries.status,
          durationMs: pluginWebhookDeliveries.durationMs,
          error: pluginWebhookDeliveries.error,
          startedAt: pluginWebhookDeliveries.startedAt,
          finishedAt: pluginWebhookDeliveries.finishedAt,
          createdAt: pluginWebhookDeliveries.createdAt,
        })
        .from(pluginWebhookDeliveries)
        .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
        .orderBy(desc(pluginWebhookDeliveries.createdAt))
        .limit(10);

      recentWebhookDeliveries = deliveries.map((d) => ({
        id: d.id,
        webhookKey: d.webhookKey,
        status: d.status,
        durationMs: d.durationMs,
        error: d.error,
        startedAt: d.startedAt ? d.startedAt.toISOString() : null,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      }));
    } catch {
      // Webhook data unavailable — leave empty
    }

    // --- Health check (same logic as GET /health) ---
    const checks: PluginHealthCheckResult["checks"] = [];

    checks.push({
      name: "registry",
      passed: true,
      message: "Plugin found in registry",
    });

    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    const isHealthy = plugin.status === "ready";
    checks.push({
      name: "status",
      passed: isHealthy,
      message: `Current status: ${plugin.status}`,
    });

    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({
        name: "error_state",
        passed: false,
        message: plugin.lastError ?? undefined,
      });
    }

    const health: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    res.json({
      pluginId: plugin.id,
      worker,
      recentJobRuns,
      recentWebhookDeliveries,
      health,
      checkedAt: new Date().toISOString(),
    });
  });

  return router;
}
