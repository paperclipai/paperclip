/**
 * Instance-level plugin environment rows declared by the managed-config
 * `environments` section (`driver: "plugin"` entries, see `managed-config.ts`).
 *
 * Each declared entry owns exactly one row, identified by the marker
 * `metadata.managedPluginEnvironment = "<pluginKey>:<driverKey>"` (unique
 * index `environments_managed_plugin_environment_idx`) next to
 * `managedByPaperclip: true`, which puts the row behind the environments-route
 * write floor on cloud-managed instances.
 *
 * - The first ensure adopts an existing unmarked row for the same plugin and
 *   driver instead of adding a second one, so a hand-made row keeps the agents
 *   that point at it (and their computers).
 * - Later ensures converge the row to the declaration and write nothing when
 *   it already matches.
 * - Archiving is only for a declared plugin that is not running; the next
 *   successful ensure reactivates the row. Nothing here archives a row
 *   because its entry left the document.
 *
 * The driver config always goes through the plugin environment validator
 * (`normalizeEnvironmentConfig` + `validatePluginEnvironmentDriverConfig`),
 * the same path an operator-created plugin environment takes.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, environments } from "@paperclipai/db";
import type { PluginEnvironmentConfig } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { normalizeEnvironmentConfig } from "./environment-config.js";
import { validatePluginEnvironmentDriverConfig } from "./plugin-environment-driver.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export const MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY = "managedPluginEnvironment";

export function managedPluginEnvironmentMarker(input: { pluginKey: string; driverKey: string }): string {
  return `${input.pluginKey}:${input.driverKey}`;
}

export interface ManagedPluginEnvironmentInput {
  name: string;
  description?: string;
  pluginKey: string;
  driverKey: string;
  driverConfig?: Record<string, unknown>;
  /** Runs the plugin's own config validation (`environmentValidateConfig`). */
  workerManager: Pick<PluginWorkerManager, "call" | "isRunning">;
}

export type ManagedPluginEnvironmentReconcileAction = "added" | "adopted" | "updated" | "unchanged";

export type EnvironmentRow = typeof environments.$inferSelect;

export interface ManagedPluginEnvironmentRowResult {
  row: EnvironmentRow;
  action: ManagedPluginEnvironmentReconcileAction;
}

function metadataOf(row: Pick<EnvironmentRow, "metadata">): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function servesPair(row: EnvironmentRow, input: { pluginKey: string; driverKey: string }): boolean {
  const config = (row.config ?? {}) as Record<string, unknown>;
  return config.pluginKey === input.pluginKey && config.driverKey === input.driverKey;
}

async function validatedDriverConfig(db: Db, input: ManagedPluginEnvironmentInput): Promise<PluginEnvironmentConfig> {
  const normalized = normalizeEnvironmentConfig({
    driver: "plugin",
    config: { pluginKey: input.pluginKey, driverKey: input.driverKey, driverConfig: input.driverConfig ?? {} },
  }) as unknown as PluginEnvironmentConfig;
  return await validatePluginEnvironmentDriverConfig({
    db,
    workerManager: input.workerManager as PluginWorkerManager,
    config: normalized,
  });
}

async function logForEveryCompany(
  db: Db,
  input: { action: string; environmentId: string; details: Record<string, unknown> },
): Promise<void> {
  const companyIds = await db.select({ id: companies.id }).from(companies).then((rows) => rows.map((row) => row.id));
  await Promise.all(companyIds.map((companyId) => logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "managed-environment-reconciler",
    action: input.action,
    entityType: "environment",
    entityId: input.environmentId,
    details: input.details,
  })));
}

/**
 * Ensure the row for one declared plugin entry. Idempotent: a row that
 * already matches the declaration is returned without a write.
 */
export async function ensureManagedPluginEnvironment(
  db: Db,
  input: ManagedPluginEnvironmentInput,
): Promise<ManagedPluginEnvironmentRowResult> {
  const marker = managedPluginEnvironmentMarker(input);
  const config = await validatedDriverConfig(db, input);
  const desiredConfig = { ...config } as Record<string, unknown>;
  const description = input.description ?? null;

  const result = await db.transaction(async (tx): Promise<ManagedPluginEnvironmentRowResult> => {
    // Lock every plugin row: concurrent ensures (the boot pass and a worker
    // recovery, or two builds in a rolling deploy) serialize here, so only one
    // of them can adopt or insert.
    const pluginRows = await tx.select().from(environments).where(eq(environments.driver, "plugin")).for("update");
    let row = pluginRows.find((candidate) => metadataOf(candidate)[MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY] === marker) ?? null;
    let adopted = false;
    if (!row) {
      const candidates = pluginRows
        .filter((candidate) => servesPair(candidate, input) && metadataOf(candidate)[MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY] === undefined)
        .sort((left, right) =>
          Number(right.name === input.name) - Number(left.name === input.name)
          || Number(right.status === "active") - Number(left.status === "active")
          || left.createdAt.getTime() - right.createdAt.getTime());
      row = candidates[0] ?? null;
      adopted = row !== null;
    }

    const nameOwner = await tx
      .select({ id: environments.id, driver: environments.driver })
      .from(environments)
      .where(eq(environments.name, input.name))
      .then((rows) => rows[0] ?? null);

    if (!row) {
      if (nameOwner) {
        throw new Error(
          `Failed to ensure managed plugin environment: environment "${input.name}" already exists with driver "${nameOwner.driver}"`,
        );
      }
      const now = new Date();
      const inserted = await tx
        .insert(environments)
        .values({
          name: input.name,
          description,
          driver: "plugin",
          status: "active",
          config: desiredConfig,
          envVars: {},
          metadata: { managedByPaperclip: true, [MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY]: marker },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      if (inserted) return { row: inserted, action: "added" };
      // A concurrent pass won the marker index; converge on its row.
      row = await tx
        .select()
        .from(environments)
        .where(sql`${environments.metadata} ->> ${MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY} = ${marker}`)
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Failed to ensure managed plugin environment");
    }

    // Keep the row's own name when another row already holds the declared one.
    const desiredName = nameOwner && nameOwner.id !== row.id ? row.name : input.name;
    const currentMetadata = metadataOf(row);
    const desiredMetadata = {
      ...currentMetadata,
      managedByPaperclip: true,
      [MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY]: marker,
    };
    const matches =
      row.name === desiredName &&
      (row.description ?? null) === description &&
      row.status === "active" &&
      stableJson(row.config) === stableJson(desiredConfig) &&
      stableJson(currentMetadata) === stableJson(desiredMetadata);
    if (matches) return { row, action: "unchanged" };

    const updated = await tx
      .update(environments)
      .set({
        name: desiredName,
        description,
        status: "active",
        config: desiredConfig,
        metadata: desiredMetadata,
        updatedAt: new Date(),
      })
      .where(eq(environments.id, row.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw new Error("Managed plugin environment changed during reconciliation");
    return { row: updated, action: adopted ? "adopted" : "updated" };
  });

  if (result.action !== "unchanged") {
    await logForEveryCompany(db, {
      action: `environment.managed_plugin_${result.action}`,
      environmentId: result.row.id,
      details: { pluginKey: input.pluginKey, driverKey: input.driverKey, reconciliationAction: result.action },
    });
  }
  return result;
}

/**
 * Archive the marked row of a declared plugin that is not ready or has no
 * running worker, so run scheduling stops selecting it. Returns null when
 * there is no active marked row.
 */
export async function archiveManagedPluginEnvironment(
  db: Db,
  input: { pluginKey: string; driverKey: string },
): Promise<EnvironmentRow | null> {
  const marker = managedPluginEnvironmentMarker(input);
  const archived = await db
    .update(environments)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(
      eq(environments.driver, "plugin"),
      eq(environments.status, "active"),
      sql`${environments.metadata} ->> ${MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY} = ${marker}`,
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!archived) return null;
  await logForEveryCompany(db, {
    action: "environment.managed_provider_unavailable_archived",
    environmentId: archived.id,
    details: { pluginKey: input.pluginKey, driverKey: input.driverKey },
  });
  return archived;
}

/** The marked row for one plugin entry, archived or not. */
export async function findManagedPluginEnvironment(
  db: Db,
  input: { pluginKey: string; driverKey: string },
): Promise<EnvironmentRow | null> {
  return await db
    .select()
    .from(environments)
    .where(sql`${environments.metadata} ->> ${MANAGED_PLUGIN_ENVIRONMENT_MARKER_KEY} = ${managedPluginEnvironmentMarker(input)}`)
    .then((rows) => rows[0] ?? null);
}
