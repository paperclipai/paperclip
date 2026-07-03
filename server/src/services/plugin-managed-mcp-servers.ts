/**
 * Plugin-managed MCP servers (NEO-286 §7, D2-7).
 *
 * Lets a plugin declare an MCP server it manages (`mcpServers` in the
 * manifest) and reconcile it into the same company-scoped `mcp_servers`
 * table that operators configure directly. Because the reconciled row is an
 * ordinary company MCP server, every downstream guarantee applies unchanged:
 * company isolation in the pooled client manager, `enabled=false` governance
 * default, per-agent `agent_mcp_servers` bindings and tool filtering, the
 * SSRF guard, and the merged plugin+MCP tools endpoint.
 *
 * Ownership is tracked through `plugin_managed_resources`
 * (resourceKind `mcp_server`) exactly like managed agents/routines/skills.
 * Plugin lifecycle transitions deregister/re-register the server in the
 * company pool via `attachPluginManagedMcpServerLifecycle`: disabling or
 * unloading the plugin force-disables its managed servers (stamping
 * `metadata.pluginManaged.autoDisabled`), and re-enabling the plugin
 * restores only the servers that stamp disabled — an operator's explicit
 * disable is never overridden.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginManagedResources } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type {
  McpServer,
  PaperclipPluginManifestV1,
  PluginManagedMCPServerDeclaration,
  PluginManagedMCPServerResolution,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { mcpServerService } from "./mcp-servers.js";
import { secretService } from "./secrets.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import { logger } from "../middleware/logger.js";

const MANAGED_MCP_SERVER_RESOURCE_KIND = "mcp_server";

type McpServersLike = Pick<
  ReturnType<typeof mcpServerService>,
  "list" | "getById" | "create" | "update"
>;

interface PluginManagedMcpServerServiceOptions {
  pluginId: string;
  pluginKey: string;
  manifest?: PaperclipPluginManifestV1 | null;
  /** Injectable for tests; defaults to the real db-backed service. */
  mcpServers?: McpServersLike;
}

export interface PluginManagedMcpServerReconcileOptions {
  /**
   * Write-only plaintext credential sealed at persistence. This is the only
   * supported path for secret material — manifests must never carry it.
   */
  credential?: string | null;
}

function pluginKeySlug(pluginKey: string) {
  return normalizeAgentUrlKey(pluginKey) ?? "plugin";
}

function slugSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "");
}

function defaultSlug(pluginKey: string, declaration: PluginManagedMCPServerDeclaration) {
  return declaration.slug ?? `plugin-${pluginKeySlug(pluginKey)}-${slugSegment(declaration.serverKey)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pluginManagedStamp(
  pluginKey: string,
  declaration: PluginManagedMCPServerDeclaration,
  extra?: Record<string, unknown>,
) {
  return {
    pluginKey,
    resourceKey: declaration.serverKey,
    ...(extra ?? {}),
  };
}

function declaredMetadata(
  pluginKey: string,
  declaration: PluginManagedMCPServerDeclaration,
) {
  return {
    ...(declaration.metadata ?? {}),
    pluginManaged: pluginManagedStamp(pluginKey, declaration),
  };
}

function declaredConfig(
  pluginKey: string,
  declaration: PluginManagedMCPServerDeclaration,
) {
  return {
    name: declaration.displayName,
    slug: defaultSlug(pluginKey, declaration),
    description: declaration.description ?? null,
    transport: declaration.transport,
    url: declaration.url,
    headers: declaration.headers ?? {},
  };
}

function defaultDrift(
  pluginKey: string,
  declaration: PluginManagedMCPServerDeclaration,
  server: McpServer | null,
): PluginManagedMCPServerResolution["defaultDrift"] {
  if (!server) return null;
  const declared = declaredConfig(pluginKey, declaration);
  const changedFields = (Object.keys(declared) as Array<keyof typeof declared>)
    .filter((field) => stableJson(declared[field]) !== stableJson(server[field]))
    .sort();
  return changedFields.length > 0 ? { changedFields } : null;
}

function resolution(
  pluginKey: string,
  companyId: string,
  declaration: PluginManagedMCPServerDeclaration,
  server: McpServer | null,
  status: PluginManagedMCPServerResolution["status"],
): PluginManagedMCPServerResolution {
  return {
    pluginKey,
    resourceKind: "mcp_server",
    resourceKey: declaration.serverKey,
    companyId,
    mcpServerId: server?.id ?? null,
    server,
    status,
    defaultDrift: defaultDrift(pluginKey, declaration, server),
  };
}

export function pluginManagedMcpServerService(
  db: Db,
  options: PluginManagedMcpServerServiceOptions,
) {
  const servers: McpServersLike =
    options.mcpServers ?? mcpServerService(db, { secrets: secretService(db) });

  function declarationFor(serverKey: string) {
    const declaration = options.manifest?.mcpServers?.find(
      (server) => server.serverKey === serverKey,
    );
    if (!declaration) {
      throw notFound(`Managed MCP server declaration not found: ${serverKey}`);
    }
    return declaration;
  }

  async function getBinding(companyId: string, serverKey: string) {
    return db
      .select()
      .from(pluginManagedResources)
      .where(and(
        eq(pluginManagedResources.companyId, companyId),
        eq(pluginManagedResources.pluginId, options.pluginId),
        eq(pluginManagedResources.resourceKind, MANAGED_MCP_SERVER_RESOURCE_KIND),
        eq(pluginManagedResources.resourceKey, serverKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function upsertBinding(
    companyId: string,
    declaration: PluginManagedMCPServerDeclaration,
    mcpServerId: string,
  ) {
    const defaultsJson = declaredConfig(options.pluginKey, declaration) as Record<string, unknown>;
    const existing = await getBinding(companyId, declaration.serverKey);
    if (existing) {
      if (
        existing.resourceId === mcpServerId &&
        stableJson(existing.defaultsJson) === stableJson(defaultsJson)
      ) {
        return existing;
      }
      return db
        .update(pluginManagedResources)
        .set({
          resourceId: mcpServerId,
          defaultsJson,
          updatedAt: new Date(),
        })
        .where(eq(pluginManagedResources.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    }
    return db
      .insert(pluginManagedResources)
      .values({
        companyId,
        pluginId: options.pluginId,
        pluginKey: options.pluginKey,
        resourceKind: MANAGED_MCP_SERVER_RESOURCE_KIND,
        resourceKey: declaration.serverKey,
        resourceId: mcpServerId,
        defaultsJson,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  /** Resolve the bound server, dropping rows that crossed a company boundary. */
  async function boundServer(companyId: string, serverKey: string) {
    const binding = await getBinding(companyId, serverKey);
    if (!binding) return null;
    const server = await servers.getById(binding.resourceId);
    if (!server || server.companyId !== companyId) return null;
    return server;
  }

  async function get(serverKey: string, companyId: string) {
    const declaration = declarationFor(serverKey);
    const server = await boundServer(companyId, serverKey);
    return resolution(
      options.pluginKey,
      companyId,
      declaration,
      server,
      server ? "resolved" : "missing",
    );
  }

  async function reconcile(
    serverKey: string,
    companyId: string,
    reconcileOptions?: PluginManagedMcpServerReconcileOptions,
  ) {
    const declaration = declarationFor(serverKey);

    const existing = await boundServer(companyId, serverKey);
    if (existing) {
      await upsertBinding(companyId, declaration, existing.id);
      const updated = reconcileOptions?.credential !== undefined
        ? await servers.update(existing.id, { credential: reconcileOptions.credential })
        : existing;
      return resolution(options.pluginKey, companyId, declaration, updated ?? existing, "resolved");
    }

    // Adopt an unbound server that already occupies the declared slug in
    // this company (e.g. binding lost after a plugin reinstall).
    const slug = defaultSlug(options.pluginKey, declaration);
    const bySlug = (await servers.list(companyId)).find((server) => server.slug === slug) ?? null;
    if (bySlug) {
      await upsertBinding(companyId, declaration, bySlug.id);
      const updated = reconcileOptions?.credential !== undefined
        ? await servers.update(bySlug.id, { credential: reconcileOptions.credential })
        : bySlug;
      await logManagedAction(companyId, "plugin.managed_mcp_server.reconciled", bySlug.id, {
        managedResourceKey: declaration.serverKey,
        status: "relinked",
      });
      return resolution(options.pluginKey, companyId, declaration, updated ?? bySlug, "relinked");
    }

    // Governance parity with company-configured servers: created disabled;
    // an operator (or governed flow) must enable it and bind agents before
    // any tool becomes reachable.
    const created = await servers.create(companyId, {
      ...declaredConfig(options.pluginKey, declaration),
      credential: reconcileOptions?.credential ?? null,
      enabled: false,
      metadata: declaredMetadata(options.pluginKey, declaration),
    });
    await upsertBinding(companyId, declaration, created.id);
    await logManagedAction(companyId, "plugin.managed_mcp_server.reconciled", created.id, {
      managedResourceKey: declaration.serverKey,
      status: "created",
    });
    return resolution(options.pluginKey, companyId, declaration, created, "created");
  }

  async function reset(
    serverKey: string,
    companyId: string,
    reconcileOptions?: PluginManagedMcpServerReconcileOptions,
  ) {
    const declaration = declarationFor(serverKey);
    const current = await reconcile(serverKey, companyId, reconcileOptions);
    if (!current.server) return current;

    // Re-apply the declared config. `enabled` and (absent an explicit
    // option) the sealed credential are operator-controlled and preserved.
    const updated = await servers.update(current.server.id, {
      ...declaredConfig(options.pluginKey, declaration),
      metadata: {
        ...declaredMetadata(options.pluginKey, declaration),
        pluginManaged: pluginManagedStamp(options.pluginKey, declaration, {
          ...(isPluginManagedStamp(current.server.metadata) && current.server.metadata.pluginManaged.autoDisabled
            ? { autoDisabled: true }
            : {}),
        }),
      },
      ...(reconcileOptions?.credential !== undefined ? { credential: reconcileOptions.credential } : {}),
    });
    await logManagedAction(companyId, "plugin.managed_mcp_server.reset", current.server.id, {
      managedResourceKey: declaration.serverKey,
    });
    return resolution(options.pluginKey, companyId, declaration, updated ?? current.server, "reset");
  }

  async function logManagedAction(
    companyId: string,
    action: string,
    mcpServerId: string,
    details: Record<string, unknown>,
  ) {
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: options.pluginId,
      action,
      entityType: "mcp_server",
      entityId: mcpServerId,
      details: {
        sourcePluginKey: options.pluginKey,
        ...details,
      },
    });
  }

  return {
    get,
    reconcile,
    reset,
  };
}

function isPluginManagedStamp(
  metadata: Record<string, unknown>,
): metadata is Record<string, unknown> & { pluginManaged: Record<string, unknown> } {
  return typeof metadata.pluginManaged === "object" && metadata.pluginManaged !== null;
}

// ---------------------------------------------------------------------------
// Lifecycle deregistration — plugin down ⇒ its managed servers leave the pool
// ---------------------------------------------------------------------------

async function listManagedServerBindings(db: Db, pluginId: string) {
  return db
    .select()
    .from(pluginManagedResources)
    .where(and(
      eq(pluginManagedResources.pluginId, pluginId),
      eq(pluginManagedResources.resourceKind, MANAGED_MCP_SERVER_RESOURCE_KIND),
    ));
}

/**
 * Force-disable every MCP server this plugin manages, across all companies.
 * `mcpServerService.update` also drops the pooled client connection, so
 * in-flight tool routing stops resolving to the server immediately.
 */
export async function deactivatePluginManagedMcpServers(
  db: Db,
  pluginId: string,
  serversOverride?: McpServersLike,
) {
  const servers = serversOverride ?? mcpServerService(db, { secrets: secretService(db) });
  for (const binding of await listManagedServerBindings(db, pluginId)) {
    const server = await servers.getById(binding.resourceId);
    if (!server || !server.enabled) continue;
    await servers.update(server.id, {
      enabled: false,
      metadata: {
        ...server.metadata,
        pluginManaged: {
          ...(isPluginManagedStamp(server.metadata) ? server.metadata.pluginManaged : {}),
          pluginKey: binding.pluginKey,
          resourceKey: binding.resourceKey,
          autoDisabled: true,
        },
      },
    });
  }
}

/**
 * Re-enable only the managed servers that the lifecycle hook auto-disabled.
 * Servers an operator disabled by hand carry no `autoDisabled` stamp and
 * stay down.
 */
export async function reactivatePluginManagedMcpServers(
  db: Db,
  pluginId: string,
  serversOverride?: McpServersLike,
) {
  const servers = serversOverride ?? mcpServerService(db, { secrets: secretService(db) });
  for (const binding of await listManagedServerBindings(db, pluginId)) {
    const server = await servers.getById(binding.resourceId);
    if (!server || server.enabled) continue;
    if (!isPluginManagedStamp(server.metadata) || server.metadata.pluginManaged.autoDisabled !== true) {
      continue;
    }
    const { autoDisabled: _cleared, ...stamp } = server.metadata.pluginManaged;
    await servers.update(server.id, {
      enabled: true,
      metadata: { ...server.metadata, pluginManaged: stamp },
    });
  }
}

/**
 * Wire plugin lifecycle transitions to the company MCP pool: disable managed
 * servers when their plugin goes down, restore auto-disabled ones when it
 * comes back. Returns a detach function.
 */
export function attachPluginManagedMcpServerLifecycle(
  db: Db,
  lifecycle: Pick<PluginLifecycleManager, "on" | "off">,
) {
  const log = logger.child({ service: "plugin-managed-mcp-servers" });

  const onDown = ({ pluginId, pluginKey }: { pluginId: string; pluginKey: string }) => {
    void deactivatePluginManagedMcpServers(db, pluginId).catch((err) => {
      log.warn(
        { pluginId, pluginKey, err: err instanceof Error ? err.message : String(err) },
        "failed to deactivate plugin-managed MCP servers",
      );
    });
  };
  const onUp = ({ pluginId, pluginKey }: { pluginId: string; pluginKey: string }) => {
    void reactivatePluginManagedMcpServers(db, pluginId).catch((err) => {
      log.warn(
        { pluginId, pluginKey, err: err instanceof Error ? err.message : String(err) },
        "failed to reactivate plugin-managed MCP servers",
      );
    });
  };

  lifecycle.on("plugin.disabled", onDown);
  lifecycle.on("plugin.unloaded", onDown);
  lifecycle.on("plugin.error", onDown);
  lifecycle.on("plugin.enabled", onUp);

  return () => {
    lifecycle.off("plugin.disabled", onDown);
    lifecycle.off("plugin.unloaded", onDown);
    lifecycle.off("plugin.error", onDown);
    lifecycle.off("plugin.enabled", onUp);
  };
}
