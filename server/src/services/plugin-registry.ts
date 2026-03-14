import { asc, eq, ne, sql, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  plugins,
  pluginConfig,
  pluginEntities,
  pluginJobs,
  pluginJobRuns,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginStatus,
  InstallPlugin,
  UpdatePluginStatus,
  UpsertPluginConfig,
  PatchPluginConfig,
  PluginEntityRecord,
  PluginEntityQuery,
  PluginJobRecord,
  PluginJobRunRecord,
  PluginWebhookDeliveryRecord,
  PluginJobStatus,
  PluginJobRunStatus,
  PluginJobRunTrigger,
  PluginWebhookDeliveryStatus,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a Postgres error is a unique-constraint violation on the
 * `plugins_plugin_key_idx` unique index.
 */
function isPluginKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err.constraint ?? err.constraint_name;
  return err.code === "23505" && constraint === "plugins_plugin_key_idx";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * PluginRegistry – CRUD operations for the `plugins` and `plugin_config`
 * tables.  Follows the same factory-function pattern used by the rest of
 * the Paperclip service layer.
 *
 * This is the lowest-level persistence layer for plugins. Higher-level
 * concerns such as lifecycle state-machine enforcement and capability
 * gating are handled by {@link pluginLifecycleManager} and
 * {@link pluginCapabilityValidator} respectively.
 *
 * @see PLUGIN_SPEC.md §21.3 — Required Tables
 */
export function pluginRegistryService(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function getById(id: string) {
    return db
      .select()
      .from(plugins)
      .where(eq(plugins.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getByKey(pluginKey: string) {
    return db
      .select()
      .from(plugins)
      .where(eq(plugins.pluginKey, pluginKey))
      .then((rows) => rows[0] ?? null);
  }

  async function nextInstallOrder(): Promise<number> {
    const result = await db
      .select({ maxOrder: sql<number>`coalesce(max(${plugins.installOrder}), 0)` })
      .from(plugins);
    return (result[0]?.maxOrder ?? 0) + 1;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // ----- Read -----------------------------------------------------------

    /** List all registered plugins ordered by install order. */
    list: () =>
      db
        .select()
        .from(plugins)
        .orderBy(asc(plugins.installOrder)),

    /**
     * List installed plugins (excludes soft-deleted/uninstalled).
     * Use for Plugin Manager and default API list so uninstalled plugins do not appear.
     */
    listInstalled: () =>
      db
        .select()
        .from(plugins)
        .where(ne(plugins.status, "uninstalled"))
        .orderBy(asc(plugins.installOrder)),

    /** List plugins filtered by status. */
    listByStatus: (status: PluginStatus) =>
      db
        .select()
        .from(plugins)
        .where(eq(plugins.status, status))
        .orderBy(asc(plugins.installOrder)),

    /** Get a single plugin by primary key. */
    getById,

    /** Get a single plugin by its unique `pluginKey`. */
    getByKey,

    // ----- Install / Register --------------------------------------------

    /**
     * Register (install) a new plugin.
     *
     * The caller is expected to have already resolved and validated the
     * manifest from the package.  This method persists the plugin row and
     * assigns the next install order.
     */
    install: async (input: InstallPlugin, manifest: PaperclipPluginManifestV1) => {
      const existing = await getByKey(manifest.id);
      if (existing) {
        if (existing.status !== "uninstalled") {
          throw conflict(`Plugin already installed: ${manifest.id}`);
        }

        // Reinstall after soft-delete: reactivate the existing row so plugin-scoped
        // data and references remain stable across uninstall/reinstall cycles.
        return db
          .update(plugins)
          .set({
            packageName: input.packageName,
            packagePath: input.packagePath ?? null,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            categories: manifest.categories,
            manifestJson: manifest,
            status: "installed" as PluginStatus,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(plugins.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }

      const installOrder = await nextInstallOrder();

      try {
        const rows = await db
          .insert(plugins)
          .values({
            pluginKey: manifest.id,
            packageName: input.packageName,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            categories: manifest.categories,
            manifestJson: manifest,
            status: "installed" as PluginStatus,
            installOrder,
            packagePath: input.packagePath ?? null,
          })
          .returning();
        return rows[0];
      } catch (error) {
        if (isPluginKeyConflict(error)) {
          throw conflict(`Plugin already installed: ${manifest.id}`);
        }
        throw error;
      }
    },

    // ----- Update ---------------------------------------------------------

    /**
     * Update a plugin's manifest and version (e.g. on upgrade).
     * The plugin must already exist.
     */
    update: async (
      id: string,
      data: {
        packageName?: string;
        version?: string;
        manifest?: PaperclipPluginManifestV1;
      },
    ) => {
      const plugin = await getById(id);
      if (!plugin) throw notFound("Plugin not found");

      const setClause: Partial<typeof plugins.$inferInsert> & { updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (data.packageName !== undefined) setClause.packageName = data.packageName;
      if (data.version !== undefined) setClause.version = data.version;
      if (data.manifest !== undefined) {
        setClause.manifestJson = data.manifest;
        setClause.apiVersion = data.manifest.apiVersion;
        setClause.categories = data.manifest.categories;
      }

      return db
        .update(plugins)
        .set(setClause)
        .where(eq(plugins.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Status ---------------------------------------------------------

    /** Update a plugin's lifecycle status and optional error message. */
    updateStatus: async (id: string, input: UpdatePluginStatus) => {
      const plugin = await getById(id);
      if (!plugin) throw notFound("Plugin not found");

      return db
        .update(plugins)
        .set({
          status: input.status,
          lastError: input.lastError ?? null,
          updatedAt: new Date(),
        })
        .where(eq(plugins.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Uninstall / Remove --------------------------------------------

    /**
     * Uninstall a plugin.
     *
     * When `removeData` is true the plugin row (and cascaded config) is
     * hard-deleted.  Otherwise the status is set to `"uninstalled"` for
     * a soft-delete that preserves the record.
     */
    uninstall: async (id: string, removeData = false) => {
      const plugin = await getById(id);
      if (!plugin) throw notFound("Plugin not found");

      if (removeData) {
        // Hard delete – plugin_config cascades via FK onDelete
        return db
          .delete(plugins)
          .where(eq(plugins.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }

      // Soft delete – mark as uninstalled
      return db
        .update(plugins)
        .set({
          status: "uninstalled" as PluginStatus,
          updatedAt: new Date(),
        })
        .where(eq(plugins.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Config ---------------------------------------------------------

    /** Retrieve a plugin's instance configuration. */
    getConfig: (pluginId: string) =>
      db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, pluginId))
        .then((rows) => rows[0] ?? null),

    /**
     * Create or fully replace a plugin's instance configuration.
     * If a config row already exists for the plugin it is replaced;
     * otherwise a new row is inserted.
     */
    upsertConfig: async (pluginId: string, input: UpsertPluginConfig) => {
      const plugin = await getById(pluginId);
      if (!plugin) throw notFound("Plugin not found");

      const existing = await db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, pluginId))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginConfig)
          .set({
            configJson: input.configJson,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(pluginConfig.pluginId, pluginId))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginConfig)
        .values({
          pluginId,
          configJson: input.configJson,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Partially update a plugin's instance configuration via shallow merge.
     * If no config row exists yet one is created with the supplied values.
     */
    patchConfig: async (pluginId: string, input: PatchPluginConfig) => {
      const plugin = await getById(pluginId);
      if (!plugin) throw notFound("Plugin not found");

      const existing = await db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, pluginId))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        const merged = { ...existing.configJson, ...input.configJson };
        return db
          .update(pluginConfig)
          .set({
            configJson: merged,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(pluginConfig.pluginId, pluginId))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginConfig)
        .values({
          pluginId,
          configJson: input.configJson,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Record an error against a plugin's config (e.g. validation failure
     * against the plugin's instanceConfigSchema).
     */
    setConfigError: async (pluginId: string, lastError: string | null) => {
      const rows = await db
        .update(pluginConfig)
        .set({ lastError, updatedAt: new Date() })
        .where(eq(pluginConfig.pluginId, pluginId))
        .returning();

      if (rows.length === 0) throw notFound("Plugin config not found");
      return rows[0];
    },

    /** Delete a plugin's config row. */
    deleteConfig: async (pluginId: string) => {
      const rows = await db
        .delete(pluginConfig)
        .where(eq(pluginConfig.pluginId, pluginId))
        .returning();

      return rows[0] ?? null;
    },

    // ----- Entities -------------------------------------------------------

    /**
     * List persistent entity mappings owned by a specific plugin, with filtering and pagination.
     *
     * @param pluginId - The UUID of the plugin.
     * @param query - Optional filters (type, externalId) and pagination (limit, offset).
     * @returns A list of matching `PluginEntityRecord` objects.
     */
    listEntities: (pluginId: string, query?: PluginEntityQuery) => {
      const conditions = [eq(pluginEntities.pluginId, pluginId)];
      if (query?.entityType) conditions.push(eq(pluginEntities.entityType, query.entityType));
      if (query?.externalId) conditions.push(eq(pluginEntities.externalId, query.externalId));

      return db
        .select()
        .from(pluginEntities)
        .where(and(...conditions))
        .orderBy(asc(pluginEntities.createdAt))
        .limit(query?.limit ?? 100)
        .offset(query?.offset ?? 0);
    },

    /**
     * Look up a plugin-owned entity mapping by its external identifier.
     *
     * @param pluginId - The UUID of the plugin.
     * @param entityType - The type of entity (e.g., 'project', 'issue').
     * @param externalId - The identifier in the external system.
     * @returns The matching `PluginEntityRecord` or null.
     */
    getEntityByExternalId: (
      pluginId: string,
      entityType: string,
      externalId: string,
    ) =>
      db
        .select()
        .from(pluginEntities)
        .where(
          and(
            eq(pluginEntities.pluginId, pluginId),
            eq(pluginEntities.entityType, entityType),
            eq(pluginEntities.externalId, externalId),
          ),
        )
        .then((rows) => rows[0] ?? null),

    /**
     * Create or update a persistent mapping between a Paperclip object and an
     * external entity.
     *
     * @param pluginId - The UUID of the plugin.
     * @param input - The entity data to persist.
     * @returns The newly created or updated `PluginEntityRecord`.
     */
    upsertEntity: async (
      pluginId: string,
      input: Omit<typeof pluginEntities.$inferInsert, "id" | "pluginId" | "createdAt" | "updatedAt">,
    ) => {
      // Drizzle doesn't support pg-specific onConflictDoUpdate easily in the insert() call
      // with complex where clauses, so we do it manually.
      const existing = await db
        .select()
        .from(pluginEntities)
        .where(
          and(
            eq(pluginEntities.pluginId, pluginId),
            eq(pluginEntities.entityType, input.entityType),
            eq(pluginEntities.externalId, input.externalId ?? ""),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginEntities)
          .set({
            ...input,
            updatedAt: new Date(),
          })
          .where(eq(pluginEntities.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginEntities)
        .values({
          ...input,
          pluginId,
        } as any)
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Delete a specific plugin-owned entity mapping by its internal UUID.
     *
     * @param id - The UUID of the entity record.
     * @returns The deleted record, or null if not found.
     */
    deleteEntity: async (id: string) => {
      const rows = await db
        .delete(pluginEntities)
        .where(eq(pluginEntities.id, id))
        .returning();
      return rows[0] ?? null;
    },

    // ----- Jobs -----------------------------------------------------------

    /**
     * List all scheduled jobs registered for a specific plugin.
     *
     * @param pluginId - The UUID of the plugin.
     * @returns A list of `PluginJobRecord` objects.
     */
    listJobs: (pluginId: string) =>
      db
        .select()
        .from(pluginJobs)
        .where(eq(pluginJobs.pluginId, pluginId))
        .orderBy(asc(pluginJobs.jobKey)),

    /**
     * Look up a plugin job by its unique job key.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobKey - The key defined in the plugin manifest.
     * @returns The matching `PluginJobRecord` or null.
     */
    getJobByKey: (pluginId: string, jobKey: string) =>
      db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.pluginId, pluginId), eq(pluginJobs.jobKey, jobKey)))
        .then((rows) => rows[0] ?? null),

    /**
     * Register or update a scheduled job for a plugin.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobKey - The unique key for the job.
     * @param input - The schedule (cron) and optional status.
     * @returns The updated or created `PluginJobRecord`.
     */
    upsertJob: async (
      pluginId: string,
      jobKey: string,
      input: { schedule: string; status?: PluginJobStatus },
    ) => {
      const existing = await db
        .select()
        .from(pluginJobs)
        .where(and(eq(pluginJobs.pluginId, pluginId), eq(pluginJobs.jobKey, jobKey)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        return db
          .update(pluginJobs)
          .set({
            schedule: input.schedule,
            status: input.status ?? existing.status,
            updatedAt: new Date(),
          })
          .where(eq(pluginJobs.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .insert(pluginJobs)
        .values({
          pluginId,
          jobKey,
          schedule: input.schedule,
          status: input.status ?? "active",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Record the start of a specific job execution.
     *
     * @param pluginId - The UUID of the plugin.
     * @param jobId - The UUID of the parent job record.
     * @param trigger - What triggered this run (e.g., 'schedule', 'manual').
     * @returns The newly created `PluginJobRunRecord` in 'pending' status.
     */
    createJobRun: async (
      pluginId: string,
      jobId: string,
      trigger: PluginJobRunTrigger,
    ) => {
      return db
        .insert(pluginJobRuns)
        .values({
          pluginId,
          jobId,
          trigger,
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Update the status, duration, and logs of a job execution record.
     *
     * @param runId - The UUID of the job run.
     * @param input - The update fields (status, error, duration, etc.).
     * @returns The updated `PluginJobRunRecord`.
     */
    updateJobRun: async (
      runId: string,
      input: {
        status: PluginJobRunStatus;
        durationMs?: number;
        error?: string;
        logs?: string[];
        startedAt?: Date;
        finishedAt?: Date;
      },
    ) => {
      return db
        .update(pluginJobRuns)
        .set(input)
        .where(eq(pluginJobRuns.id, runId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ----- Webhooks -------------------------------------------------------

    /**
     * Create a record for an incoming webhook delivery.
     *
     * @param pluginId - The UUID of the receiving plugin.
     * @param webhookKey - The endpoint key defined in the manifest.
     * @param input - The payload, headers, and optional external ID.
     * @returns The newly created `PluginWebhookDeliveryRecord` in 'pending' status.
     */
    createWebhookDelivery: async (
      pluginId: string,
      webhookKey: string,
      input: {
        externalId?: string;
        payload: Record<string, unknown>;
        headers?: Record<string, string>;
      },
    ) => {
      return db
        .insert(pluginWebhookDeliveries)
        .values({
          pluginId,
          webhookKey,
          externalId: input.externalId,
          payload: input.payload,
          headers: input.headers ?? {},
          status: "pending",
        })
        .returning()
        .then((rows) => rows[0]);
    },

    /**
     * Update the status and processing metrics of a webhook delivery.
     *
     * @param deliveryId - The UUID of the delivery record.
     * @param input - The update fields (status, error, duration, etc.).
     * @returns The updated `PluginWebhookDeliveryRecord`.
     */
    updateWebhookDelivery: async (
      deliveryId: string,
      input: {
        status: PluginWebhookDeliveryStatus;
        durationMs?: number;
        error?: string;
        startedAt?: Date;
        finishedAt?: Date;
      },
    ) => {
      return db
        .update(pluginWebhookDeliveries)
        .set(input)
        .where(eq(pluginWebhookDeliveries.id, deliveryId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
