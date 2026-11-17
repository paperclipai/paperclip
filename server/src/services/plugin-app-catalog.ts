/**
 * Connector types provided by plugins.
 *
 * A plugin with the `connectors.provide` capability declares `apps` in its
 * manifest using the built-in app-definition schema. This module turns the
 * apps of every *ready* plugin into namespaced catalog entries and answers one
 * question for the Connectors APIs and the tool gateway: is the connector a
 * connection was made from still available?
 *
 * The plugins table is the source of truth. Several plugin lifecycle managers
 * can exist in one process (and several processes can share one database), so
 * no in-memory event is relied on: every reader that needs an answer reads the
 * plugin rows, and the shared lookup table used by synchronous helpers such as
 * `getConnectableAppDefinition` is replaced from that same read.
 *
 * Disabling a plugin (or removing an app in an upgrade) only hides its apps
 * and connections. Nothing is deleted, so settings, credentials, installs and
 * grants come back unchanged when the plugin is enabled again. Uninstalling
 * retires the connections through the normal connection removal path.
 */
import { createHash } from "node:crypto";
import { and, eq, like, or, sql } from "drizzle-orm";
import { plugins, toolConnections, type Db } from "@paperclipai/db";
import {
  appDefinitionSchema,
  connectionSourceSlug,
  isPluginAppSlug,
  parsePluginAppSlug,
  pluginAppDefinition,
  pluginAppSlug,
  setPluginAppDefinitions,
  type AppDefinition,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export interface PluginAppCatalog {
  /** Catalog entries for every app of every ready plugin, namespaced. */
  definitions: AppDefinition[];
  /** False only for a plugin connector whose plugin or app is not available. */
  isAvailable(sourceSlug: string | null | undefined): boolean;
}

const parsedDefinitions = new Map<string, AppDefinition[]>();

const ALL_AVAILABLE: PluginAppCatalog = { definitions: [], isAvailable: () => true };

/** The apps a ready plugin row contributes. Invalid entries are skipped. */
export function pluginRowAppDefinitions(row: {
  pluginKey: string;
  status: string;
  manifestJson: { capabilities?: readonly string[]; apps?: readonly unknown[] } | null;
}): AppDefinition[] {
  const manifest = row.manifestJson;
  if (row.status !== "ready" || !manifest?.capabilities?.includes("connectors.provide")) return [];
  const definitions: AppDefinition[] = [];
  for (const declared of manifest.apps ?? []) {
    // Manifests are validated at install and upgrade; parse again so a row
    // written by an older host can never put a malformed entry in the catalog.
    const parsed = appDefinitionSchema.safeParse(declared);
    if (!parsed.success) {
      logger.warn({ pluginKey: row.pluginKey }, "Skipping an invalid plugin connector definition");
      continue;
    }
    definitions.push(pluginAppDefinition(row.pluginKey, parsed.data as AppDefinition));
  }
  return definitions;
}

/** Read every ready plugin's apps and refresh the shared catalog lookups. */
export async function loadPluginAppCatalog(db: Db): Promise<PluginAppCatalog> {
  const rows = await db
    .select({ pluginKey: plugins.pluginKey, status: plugins.status, manifestJson: plugins.manifestJson })
    .from(plugins)
    .where(and(
      eq(plugins.status, "ready"),
      sql`${plugins.manifestJson}->'capabilities' @> '["connectors.provide"]'::jsonb`,
    ));
  const definitions = rows.flatMap((row) => {
    // Parsing is the costly part; reuse it while the manifest is unchanged.
    const key = `${row.pluginKey}\u0000${createHash("sha256").update(JSON.stringify(row.manifestJson)).digest("hex")}`;
    let cached = parsedDefinitions.get(key);
    if (!cached) {
      cached = pluginRowAppDefinitions(row);
      if (parsedDefinitions.size > 500) parsedDefinitions.clear();
      parsedDefinitions.set(key, cached);
    }
    return cached;
  });
  setPluginAppDefinitions(definitions);
  const available = new Set(definitions.map((app) => app.slug));
  return {
    definitions,
    isAvailable: (sourceSlug) => !isPluginAppSlug(sourceSlug) || available.has(sourceSlug!),
  };
}

/**
 * The availability check for a set of saved rows. Rows that were not made
 * from a plugin connector need no plugin read, so built-in connections pay
 * nothing for this check.
 */
export async function pluginAppCatalogFor(
  db: Db,
  rows: Iterable<Parameters<typeof connectionSourceSlug>[0]>,
): Promise<PluginAppCatalog> {
  for (const row of rows) {
    if (isPluginAppSlug(connectionSourceSlug(row))) return loadPluginAppCatalog(db);
  }
  return ALL_AVAILABLE;
}

export function pluginKeyForConnectionSource(sourceSlug: string | null | undefined): string | null {
  return parsePluginAppSlug(sourceSlug)?.pluginKey ?? null;
}

/**
 * Retire every connection made from a plugin's apps when it is uninstalled.
 * Uses the standard connection removal, so rows stay (archived) for audit
 * while grants are revoked and connection-owned credentials are deleted.
 * Removal is idempotent, so archived rows are retried too: a removal that
 * failed part-way finishes on the next attempt. Any failure is thrown, so
 * the uninstall is not reported as done while credentials remain.
 */
export async function retirePluginAppConnections(db: Db, pluginKey: string): Promise<number> {
  const prefix = `${pluginAppSlug(pluginKey, "x").slice(0, -1)}%`;
  const rows = await db
    .select({ id: toolConnections.id, companyId: toolConnections.companyId, config: toolConnections.config, transportConfig: toolConnections.transportConfig })
    .from(toolConnections)
    .where(or(
      like(sql<string>`${toolConnections.config}->>'sourceTemplateKey'`, prefix),
      like(sql<string>`${toolConnections.transportConfig}->>'sourceTemplateKey'`, prefix),
    ));
  const owned = rows.filter((row) => pluginKeyForConnectionSource(connectionSourceSlug(row)) === pluginKey);
  if (owned.length === 0) return 0;
  const { toolAccessService } = await import("./tool-access.js");
  const access = toolAccessService(db);
  const failures: unknown[] = [];
  for (const row of owned) {
    try {
      await access.archiveConnection(row.id, row.companyId);
    } catch (error) {
      logger.warn({ err: error, pluginKey, connectionId: row.id }, "Could not retire a plugin connector connection");
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not remove ${failures.length} connection(s) of this plugin's connectors. Try uninstalling again.`);
  }
  return owned.length;
}
