import { createHash } from "node:crypto";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  companySecrets,
  pluginCompanySettings,
  pluginConfig,
  plugins,
  projects,
  projectWorkspaces,
  resourceLifecycleEvents,
  type Db,
} from "@paperclipai/db";
import type { ResourceLifecycleEvent } from "@paperclipai/plugin-sdk";
import { z } from "zod";
import { secretService } from "./secrets.js";
import { persistActivity, type ActivityPublication } from "./activity-log.js";

export type ProjectSecretSnapshot = { revision: string };
export function validateProjectInstanceSecretChanges(
  changes: unknown,
): asserts changes is Record<string, string | null> {
  if (!changes || typeof changes !== "object" || Array.isArray(changes))
    throw new Error("Invalid project instance secret changes");
  const entries = Object.entries(changes);
  if (
    entries.length > 16 ||
    entries.some(
      ([key, value]) =>
        !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
        (value !== null &&
          (typeof value !== "string" ||
            !value.trim() ||
            Buffer.byteLength(value) > 131_072)),
    )
  ) {
    throw new Error("Invalid project instance secret changes");
  }
}

/** Reuses native instance credentials; values never enter the lifecycle journal or plugin entities. */
export function projectInstanceSecretService(db: Db, pluginId: string) {
  async function state(companyId: string, projectId: string, lock = false) {
    if (
      ![companyId, projectId].every(
        (id) => z.string().uuid().safeParse(id).success,
      )
    )
      throw new Error("Invalid project instance secret scope");
    const pluginQuery = db
      .select()
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    const [plugin] = await (lock ? pluginQuery.for("share") : pluginQuery);
    const settingsQuery = db
      .select()
      .from(pluginCompanySettings)
      .where(
        and(
          eq(pluginCompanySettings.pluginId, pluginId),
          eq(pluginCompanySettings.companyId, companyId),
        ),
      );
    const [settings] = await (lock
      ? settingsQuery.for("share")
      : settingsQuery);
    if (
      plugin?.status !== "ready" ||
      settings?.enabled === false ||
      !plugin.manifestJson.capabilities.includes("projects.instance-secrets") ||
      !plugin.manifestJson.capabilities.includes("events.subscribe") ||
      !plugin.manifestJson.resourceLifecycle?.includes("project")
    ) {
      throw new Error("Project instance secrets outside plugin scope");
    }
    const configQuery = db
      .select()
      .from(pluginConfig)
      .where(
        and(
          eq(pluginConfig.pluginId, pluginId),
          eq(pluginConfig.companyId, companyId),
        ),
      );
    const [config] = await (lock ? configQuery.for("share") : configQuery);
    if (!config)
      throw new Error("Project instance secrets require plugin configuration");
    const projectQuery = db
      .select()
      .from(projects)
      .where(
        and(eq(projects.companyId, companyId), eq(projects.id, projectId)),
      );
    const [project] = await (lock ? projectQuery.for("update") : projectQuery);
    const workspaces = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, companyId),
          eq(projectWorkspaces.projectId, projectId),
        ),
      )
      .orderBy(asc(projectWorkspaces.id));
    const [latestEvent] = await db
      .select({ id: resourceLifecycleEvents.id })
      .from(resourceLifecycleEvents)
      .where(
        and(
          eq(resourceLifecycleEvents.companyId, companyId),
          eq(resourceLifecycleEvents.resourceType, "project"),
          eq(resourceLifecycleEvents.resourceId, projectId),
        ),
      )
      .orderBy(desc(resourceLifecycleEvents.id))
      .limit(1);
    const secrets = await db
      .select({
        id: companySecrets.id,
        version: companySecrets.latestVersion,
        status: companySecrets.status,
      })
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "instance"),
          eq(companySecrets.ownerProjectId, projectId),
          eq(companySecrets.ownerPluginId, pluginId),
          ne(companySecrets.status, "deleted"),
        ),
      )
      .orderBy(asc(companySecrets.id));
    return {
      project,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            plugin.updatedAt,
            plugin.manifestJson,
            settings,
            config,
            project,
            workspaces,
            latestEvent,
            secrets,
          ]),
        )
        .digest("hex"),
    };
  }
  async function read(companyId: string, projectId: string) {
    try {
      return await secretService(db).projectInstance.read({
        companyId,
        projectId,
        pluginId,
      });
    } catch {
      throw new Error("Project instance secret unavailable");
    }
  }
  return {
    async read(companyId: string, projectId: string) {
      const current = await state(companyId, projectId);
      if (!current.project || current.project.archivedAt)
        throw new Error("Project instance secrets unavailable");
      return read(companyId, projectId);
    },
    async prepare(event: ResourceLifecycleEvent) {
      if (event.resourceType !== "project")
        throw new Error("Project instance secret event required");
      const snapshot = await state(event.companyId, event.resourceId);
      return {
        snapshot: { revision: snapshot.revision },
        instanceSecrets:
          snapshot.project && !snapshot.project.archivedAt
            ? await read(event.companyId, event.resourceId)
            : {},
      };
    },
    /** Caller holds the event row and account-home mutation lock, in the acknowledgment transaction. */
    async apply(
      event: ResourceLifecycleEvent,
      snapshot: ProjectSecretSnapshot,
      changes: unknown,
    ): Promise<ActivityPublication[]> {
      validateProjectInstanceSecretChanges(changes);
      const current = await state(event.companyId, event.resourceId, true);
      if (snapshot.revision !== current.revision)
        throw new Error("Project instance secret operation is stale");
      if (
        (!current.project || current.project.archivedAt) &&
        Object.values(changes).some((value) => value !== null)
      ) {
        throw new Error("Project instance secrets require an active project");
      }
      const publications: ActivityPublication[] = [];
      for (const [key, value] of Object.entries(changes)) {
        try {
          await secretService(db).projectInstance.set(
            {
              companyId: event.companyId,
              projectId: event.resourceId,
              pluginId,
            },
            key,
            value,
          );
        } catch {
          throw new Error("Project instance secret storage unavailable");
        }
        const { publication } = await persistActivity(db, {
          companyId: event.companyId,
          actorType: "plugin",
          actorId: pluginId,
          action:
            value === null
              ? "project.instance_secret.removed"
              : "project.instance_secret.saved",
          entityType: "project",
          entityId: event.resourceId,
          details: { key },
        });
        publications.push(publication);
      }
      return publications;
    },
  };
}
