import type { ToolRiskLevel } from "@paperclipai/shared";
import { SUPABASE_TOOLS, isSupabaseConnection, isCurrentSupabaseCatalogEntry, supabaseClient, supabaseRisk } from "./supabase/index.js";
import { VERCEL_TOOLS, isVercelConnection, isCurrentVercelCatalogEntry, vercelClient, vercelRisk } from "./vercel/index.js";

type Connection = { transport: string; config?: Record<string, unknown> };
type CatalogEntry = { toolName: string; versionHash: string; schemaHash: string | null; riskLevel: string };
type Request = (url: string, init: RequestInit) => Promise<Response>;
interface RestConnector {
  sourceTemplateKey: string;
  name: string;
  matches(connection: Connection): boolean;
  tools: Array<{ name: string; title?: string | null; description?: string | null; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }>;
  risk(name: string): ToolRiskLevel;
  isCurrent(entry: CatalogEntry): boolean;
  client(connection: Connection, headers: Record<string, string>, request: Request, signal?: AbortSignal, deadlineAt?: number): {
    probe(): Promise<unknown>;
    invoke(name: string, parameters: unknown): Promise<unknown>;
  };
}

function settings(connection: Connection): Record<string, unknown> {
  const value = connection.config?.methodConfig;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Only reviewed adapters enter the REST gateway. Provider code owns endpoints,
// schemas and payloads; the existing gateway owns grants, policy and audit.
export const REST_CONNECTORS: readonly RestConnector[] = [
  {
    sourceTemplateKey: "supabase", name: "Supabase",
    matches: isSupabaseConnection, tools: SUPABASE_TOOLS,
    risk: supabaseRisk, isCurrent: isCurrentSupabaseCatalogEntry,
    client: (connection, headers, request, signal, deadlineAt) =>
      supabaseClient(headers, request, settings(connection).projectRef, signal, deadlineAt),
  },
  {
    sourceTemplateKey: "vercel", name: "Vercel",
    matches: isVercelConnection, tools: VERCEL_TOOLS,
    risk: vercelRisk, isCurrent: isCurrentVercelCatalogEntry,
    client: (connection, headers, request, signal, deadlineAt) =>
      vercelClient(headers, request, settings(connection).teamId, signal, deadlineAt),
  },
];

export function restConnectorFor(connection: Connection): RestConnector | undefined {
  return REST_CONNECTORS.find(connector => connector.matches(connection));
}
