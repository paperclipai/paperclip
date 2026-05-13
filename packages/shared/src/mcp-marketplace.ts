import { z } from "zod";
import type { ToolPermissionPolicy } from "./tool-permissions.js";
import { getPaperclipMcpToolPolicy } from "./tool-permissions.js";

export const mcpCatalogProviderSchema = z.enum(["official_registry", "smithery", "docker", "glama", "manual"]);
export type McpCatalogProvider = z.infer<typeof mcpCatalogProviderSchema>;

export const mcpCatalogEntrySchema = z.object({
  provider: mcpCatalogProviderSchema,
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(4000).optional(),
  version: z.string().trim().max(80).optional(),
  transport: z.enum(["stdio", "streamable_http", "sse"]).default("stdio"),
  command: z.string().trim().max(1000).optional(),
  remoteUrl: z.string().trim().url().optional(),
  sourceUrl: z.string().trim().url().optional(),
  license: z.string().trim().max(80).optional(),
  requiredEnv: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120).regex(/^[A-Z_][A-Z0-9_]*$/),
        required: z.boolean().default(true),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .default([]),
  tools: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).optional(),
      }),
    )
    .default([]),
  trust: z
    .object({
      verifiedPublisher: z.boolean().default(false),
      sourceAvailable: z.boolean().default(false),
      containerized: z.boolean().default(false),
    })
    .default({ verifiedPublisher: false, sourceAvailable: false, containerized: false }),
});
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;
export type McpCatalogEntryInput = z.input<typeof mcpCatalogEntrySchema>;

export interface NormalizedMcpServerDefinition {
  provider: McpCatalogProvider;
  catalogId: string;
  name: string;
  title: string;
  description: string;
  version: string | null;
  transport: "stdio" | "streamable_http" | "sse";
  command: string | null;
  remoteUrl: string | null;
  sourceUrl: string | null;
  license: string | null;
  requiredSecretNames: string[];
  requiredOptionalEnvNames: string[];
  toolNames: string[];
  trust: {
    verifiedPublisher: boolean;
    sourceAvailable: boolean;
    containerized: boolean;
  };
}

export interface McpInstallPreview {
  server: NormalizedMcpServerDefinition;
  action: "allow_readonly_preview" | "blocked_pending_approval";
  requiresApproval: boolean;
  blockers: string[];
  envTemplate: Record<string, string>;
  toolPolicies: ToolPermissionPolicy[];
}

function externalMcpToolPolicy(toolName: string): ToolPermissionPolicy {
  return {
    toolName,
    category: "external_live",
    summary: "Discovered external MCP tool; blocked until catalog trust and permission review approve it.",
    actionRiskLevel: "external_live",
    riskClass: "high",
    requiredApprovalGate: "board",
    requiresExplicitApproval: true,
    mutatesPaperclip: false,
    liveSideEffect: true,
    destructive: false,
    sensitiveData: false,
  };
}

export function normalizeMcpCatalogEntry(entryLike: McpCatalogEntryInput): NormalizedMcpServerDefinition {
  const entry = mcpCatalogEntrySchema.parse(entryLike);
  return {
    provider: entry.provider,
    catalogId: entry.id,
    name: entry.name,
    title: entry.title ?? entry.name,
    description: entry.description ?? "",
    version: entry.version ?? null,
    transport: entry.transport,
    command: entry.command ?? null,
    remoteUrl: entry.remoteUrl ?? null,
    sourceUrl: entry.sourceUrl ?? null,
    license: entry.license ?? null,
    requiredSecretNames: entry.requiredEnv.filter((item) => item.required).map((item) => item.name),
    requiredOptionalEnvNames: entry.requiredEnv.filter((item) => !item.required).map((item) => item.name),
    toolNames: entry.tools.map((tool) => tool.name),
    trust: {
      verifiedPublisher: entry.trust?.verifiedPublisher ?? false,
      sourceAvailable: entry.trust?.sourceAvailable ?? false,
      containerized: entry.trust?.containerized ?? false,
    },
  };
}

export function buildMcpInstallPreview(server: NormalizedMcpServerDefinition): McpInstallPreview {
  const blockers: string[] = [];
  if (!server.trust.verifiedPublisher) blockers.push("publisher is not verified");
  if (!server.trust.sourceAvailable) blockers.push("source is not available");

  const toolPolicies = server.toolNames.map((toolName) =>
    toolName.startsWith("paperclip") ? getPaperclipMcpToolPolicy(toolName) : externalMcpToolPolicy(toolName),
  );
  const requiresApproval = blockers.length > 0 || toolPolicies.some((policy) => policy.requiresExplicitApproval);
  const envTemplate = Object.fromEntries([
    ...server.requiredSecretNames.map((name) => [name, `[REQUIRED_SECRET:${name}]`] as const),
    ...server.requiredOptionalEnvNames.map((name) => [name, `[OPTIONAL_ENV:${name}]`] as const),
  ]);

  return {
    server,
    action: requiresApproval ? "blocked_pending_approval" : "allow_readonly_preview",
    requiresApproval,
    blockers,
    envTemplate,
    toolPolicies,
  };
}
