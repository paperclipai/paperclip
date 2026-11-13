import { DAYTONA_TOOLS, daytonaClient, daytonaRisk, executeDaytonaTool, isCurrentDaytonaCatalogEntry, isDaytonaConnection, isDaytonaToolName } from "./daytona.js";
import type { NativeCatalogEntry, NativeRestRequest } from "./native-rest-client.js";
import { ONEPASSWORD_TOOLS, isOnePasswordConnection, isOnePasswordToolName, onePasswordRisk, isCurrentOnePasswordEntry } from "./connectors/onepassword/catalog.js";
import { callOnePassword, executeOnePasswordTool } from "./connectors/onepassword/client.js";
import { UNIKRAFT_DEFAULT_METRO, UNIKRAFT_TOOLS, executeUnikraftTool, isCurrentUnikraftCatalogEntry, isUnikraftConnection,
  isUnikraftToolName, unikraftClient, unikraftRisk } from "./connectors/unikraft/client.js";

type ConnectionShape = { transport: string; config?: Record<string, unknown> };
const methodConfig = (connection: ConnectionShape) => {
  const value = connection.config?.methodConfig;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

/** A provider whose action catalog is generated from its published HTTP API
 * and executed by a Paperclip bridge rather than a remote MCP server. Shared
 * connection code consumes this contract instead of naming providers. */
export type NativeProviderCatalog = {
  slug: string;
  name: string;
  tools: typeof DAYTONA_TOOLS;
  isConnection(connection: ConnectionShape): boolean;
  isToolName(name: string): boolean;
  risk(name: string): "read" | "write" | "destructive";
  isCurrentEntry(entry: NativeCatalogEntry): boolean;
  probe(connection: ConnectionShape, headers: Record<string, string>, request: NativeRestRequest): Promise<unknown>;
  execute(input: Parameters<typeof executeDaytonaTool>[0]): Promise<unknown>;
};

export const NATIVE_PROVIDER_CATALOGS: readonly NativeProviderCatalog[] = [
  {
    slug: "1password", name: "1Password", tools: ONEPASSWORD_TOOLS,
    isConnection: isOnePasswordConnection, isToolName: isOnePasswordToolName, risk: onePasswordRisk, isCurrentEntry: isCurrentOnePasswordEntry,
    probe: (_connection, headers) => callOnePassword(headers, "onepassword_list_vaults", {}, 15_000),
    execute: executeOnePasswordTool,
  },
  {
    slug: "daytona", name: "Daytona", tools: DAYTONA_TOOLS,
    isConnection: isDaytonaConnection, isToolName: isDaytonaToolName, risk: daytonaRisk, isCurrentEntry: isCurrentDaytonaCatalogEntry,
    probe: (connection, headers, request) => daytonaClient(headers, request, methodConfig(connection).organizationId).probe(),
    execute: executeDaytonaTool,
  },
  {
    slug: "unikraft", name: "Unikraft", tools: UNIKRAFT_TOOLS,
    isConnection: isUnikraftConnection, isToolName: isUnikraftToolName, risk: unikraftRisk, isCurrentEntry: isCurrentUnikraftCatalogEntry,
    probe: (connection, headers, request) => unikraftClient(headers, request, methodConfig(connection).metro ?? UNIKRAFT_DEFAULT_METRO).probe(),
    execute: executeUnikraftTool,
  },
];

export const NATIVE_PROVIDER_SLUGS: readonly string[] = NATIVE_PROVIDER_CATALOGS.map(provider => provider.slug);

export function nativeProviderCatalogFor(connection: ConnectionShape): NativeProviderCatalog | null {
  return NATIVE_PROVIDER_CATALOGS.find(provider => provider.isConnection(connection)) ?? null;
}

export function nativeProviderCatalogForSlug(slug: unknown): NativeProviderCatalog | null {
  return NATIVE_PROVIDER_CATALOGS.find(provider => provider.slug === slug) ?? null;
}
