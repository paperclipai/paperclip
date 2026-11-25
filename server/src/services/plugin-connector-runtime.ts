/**
 * Calls into plugin workers for plugin-served connectors (`transport: "plugin"`).
 *
 * The tool gateway and catalog discovery own every decision (grant, policy,
 * approval, credential, audit). This module only routes one call to the
 * worker of the plugin that provides the connector, and turns "the worker is
 * not running" into a retryable unavailable error.
 */
import { and, eq } from "drizzle-orm";
import { plugins, type Db } from "@paperclipai/db";
import {
  PLUGIN_CONNECTOR_TOOL_DEFAULT_TIMEOUT_MS,
  PLUGIN_CONNECTOR_TOOL_NAME,
  getConnectableAppDefinition,
  parsePluginAppSlug,
  type AppDefinition,
  type ConnectionMethodDef,
  type PluginConnectorToolDef,
} from "@paperclipai/shared";
import type {
  ConnectorToolDescriptor,
  ConnectorToolListConnection,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { PaperclipDefinedToolDefinition } from "./connectors/paperclip-defined-tools.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { PluginWorkerUnavailableError } from "./plugin-worker-unavailable-error.js";

let workers: PluginWorkerManager | null = null;

/** Called once by the host when its worker manager exists. */
export function setPluginConnectorWorkers(manager: PluginWorkerManager | null): void {
  workers = manager;
}

export const PLUGIN_CONNECTOR_UNAVAILABLE_CODE = "plugin_connector_unavailable";

/** The plugin connection's identity, read from the connection config. */
export interface PluginConnectionIdentity {
  pluginKey: string;
  appSlug: string;
  methodKey: string;
  settings: Record<string, unknown>;
  /** True for the implicit connector of legacy top-level manifest `tools`. */
  legacyTools: boolean;
}

export function pluginConnectionIdentity(connection: {
  transport: string;
  config: Record<string, unknown>;
}): PluginConnectionIdentity | null {
  if (connection.transport !== "plugin") return null;
  const source = parsePluginAppSlug(connection.config.sourceTemplateKey);
  const methodKey = connection.config.connectionMethodKey;
  if (!source || typeof methodKey !== "string") return null;
  const settings = connection.config.settings;
  return {
    pluginKey: source.pluginKey,
    appSlug: source.appSlug,
    methodKey,
    settings: settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Record<string, unknown> : {},
    legacyTools: connection.config.legacyPluginTools === true,
  };
}

/** The method a plugin connection was made with, from the current catalog. */
export function pluginConnectionMethod(connection: { config: Record<string, unknown> }): {
  app: AppDefinition;
  method: ConnectionMethodDef;
} | null {
  const slug = connection.config.sourceTemplateKey;
  const app = typeof slug === "string" ? getConnectableAppDefinition(slug) : null;
  const method = app?.methods.find((candidate) => candidate.key === connection.config.connectionMethodKey);
  return app && method?.transport === "plugin" ? { app, method } : null;
}

async function runningWorker(db: Db, pluginKey: string): Promise<string> {
  const [plugin] = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(and(eq(plugins.pluginKey, pluginKey), eq(plugins.status, "ready")));
  if (!plugin || !workers || !workers.isRunning(plugin.id)) {
    throw new PluginWorkerUnavailableError({
      pluginId: plugin?.id ?? pluginKey,
      workerStatus: plugin && workers ? workers.getWorker(plugin.id)?.status ?? null : null,
      message: "This connector's plugin is not running right now. Try again shortly.",
    });
  }
  return plugin.id;
}

/**
 * Whether a saved catalog entry still matches a static tool declaration of
 * the connection's method. After an upgrade changes a tool's risk (or drops
 * it), the old entry is hidden until the catalog is refreshed, so policy
 * never sees an outdated risk. Dynamic catalogs are current as listed.
 */
export function pluginCatalogEntryCurrent(
  connection: { config: Record<string, unknown> },
  entry: { toolName: string; riskLevel: string },
): boolean {
  const tools = pluginConnectionMethod(connection)?.method.tools;
  if (!tools) return false;
  if (tools.kind === "dynamic") return true;
  return tools.list.some((tool) => tool.name === entry.toolName && tool.risk === entry.riskLevel);
}

export function pluginConnectionToolTimeoutMs(
  connection: { config: Record<string, unknown> },
  toolName: string,
): number {
  const method = pluginConnectionMethod(connection)?.method;
  const tools = method?.tools;
  const tool = tools?.kind === "static" ? tools.list.find((candidate) => candidate.name === toolName) : undefined;
  return tool?.timeoutMs ?? method?.timeoutMs ?? PLUGIN_CONNECTOR_TOOL_DEFAULT_TIMEOUT_MS;
}

const PLUGIN_CONNECTOR_RPC_GRACE_MS = 1_000;

/**
 * A health check for a plugin connection: its tools run in the plugin's
 * worker, so the connection is healthy only while that worker runs (static
 * catalogs are readable without it).
 */
export async function assertPluginConnectionWorker(
  db: Db,
  connection: { transport: string; config: Record<string, unknown> },
): Promise<void> {
  const identity = pluginConnectionIdentity(connection);
  if (!identity) throw new PluginWorkerUnavailableError({ pluginId: "unknown", workerStatus: null, message: "This connector is not available." });
  await runningWorker(db, identity.pluginKey);
}

function toolDescriptor(tool: ConnectorToolDescriptor | PluginConnectorToolDef): PaperclipDefinedToolDefinition {
  return {
    name: tool.name,
    title: tool.displayName ?? null,
    description: tool.description ?? tool.displayName ?? tool.name,
    inputSchema: tool.parametersSchema,
    outputSchema: null,
    // The declared risk travels with the catalog entry; the connector tool
    // policy reads it (see `connectors/tool-policy.ts`).
    annotations: {
      paperclipRisk: tool.risk,
      readOnlyHint: tool.risk === "read",
      ...(tool.risk === "destructive" ? { destructiveHint: true } : {}),
    },
  };
}

export function pluginConnectionToolDefinition(
  connection: { config: Record<string, unknown> },
  toolName: string,
): PaperclipDefinedToolDefinition | null {
  const tools = pluginConnectionMethod(connection)?.method.tools;
  if (tools?.kind !== "static") return null;
  const tool = tools.list.find((candidate) => candidate.name === toolName);
  return tool ? toolDescriptor(tool) : null;
}

/** The tools of one plugin connection, for its catalog. */
export async function listPluginConnectionTools(
  db: Db,
  connection: { id: string; companyId: string; transport: string; config: Record<string, unknown> },
  credential?: ConnectorToolListConnection["credential"],
) {
  const identity = pluginConnectionIdentity(connection);
  const resolved = pluginConnectionMethod(connection);
  if (!identity || !resolved?.method.tools) {
    throw new PluginWorkerUnavailableError({
      pluginId: identity?.pluginKey ?? "unknown",
      workerStatus: null,
      message: "This connector is not available. Its plugin is disabled or no longer provides it.",
    });
  }
  const tools = resolved.method.tools;
  if (tools.kind === "static") return tools.list.map(toolDescriptor);
  const pluginDbId = await runningWorker(db, identity.pluginKey);
  const result = await workers!.call(pluginDbId, "listConnectorTools", {
    companyId: connection.companyId,
    appSlug: identity.appSlug,
    connection: {
      id: connection.id,
      appSlug: identity.appSlug,
      methodKey: identity.methodKey,
      settings: identity.settings,
      ...(credential ? { credential } : {}),
    },
  });
  const listed = Array.isArray(result?.tools) ? result.tools : [];
  return listed
    .filter((tool) => typeof tool?.name === "string" && PLUGIN_CONNECTOR_TOOL_NAME.test(tool.name)
      && ["read", "write", "destructive"].includes(tool.risk))
    .slice(0, 500)
    .map((tool) => toolDescriptor({
      ...tool,
      parametersSchema: tool.parametersSchema && typeof tool.parametersSchema === "object" ? tool.parametersSchema : { type: "object" },
    }));
}

/** Run one plugin connector tool in its plugin's worker. */
export async function executePluginConnectionTool(
  db: Db,
  input: {
    pluginKey: string;
    appSlug: string;
    toolName: string;
    parameters: unknown;
    runContext: ToolRunContext & { connection: NonNullable<ToolRunContext["connection"]> };
    timeoutMs: number;
  },
): Promise<ToolResult> {
  const pluginDbId = await runningWorker(db, input.pluginKey);
  return workers!.call(pluginDbId, "executeTool", {
    toolName: input.toolName,
    appSlug: input.appSlug,
    parameters: input.parameters,
    runContext: input.runContext,
  }, input.timeoutMs + PLUGIN_CONNECTOR_RPC_GRACE_MS);
}
