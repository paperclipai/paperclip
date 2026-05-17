import { z } from "zod";
import { mcpCatalogProviderSchema } from "./mcp-marketplace.js";

const envNameSchema = z.string().trim().min(1).max(120).regex(/^[A-Z_][A-Z0-9_]*$/, {
  message: "Secret names must be environment-style identifiers",
});

const capabilityRefSchema = z.string().trim().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/, {
  message: "Capability references must be stable keys, not free-form values",
});

const secretLikeValuePattern = /(?:\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*[^\s]+|\bBearer\s+[^\s]+|\b(?:sk_(?:live|test)_|sk-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

function assertNoSecretLikeString(value: string | null | undefined, ctx: z.RefinementCtx, path: (string | number)[]) {
  if (!value) return;
  if (secretLikeValuePattern.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Capability config must reference named secrets, not include raw secret values",
      path,
    });
  }
}

export const agentCapabilityDesiredStateSchema = z.enum(["enabled", "disabled"]);
export type AgentCapabilityDesiredState = z.infer<typeof agentCapabilityDesiredStateSchema>;

export const agentCapabilityLiveStateSchema = z.enum([
  "not_installed",
  "approval_required",
  "installed",
  "connected",
  "failed",
]);
export type AgentCapabilityLiveState = z.infer<typeof agentCapabilityLiveStateSchema>;

export const agentCapabilityMcpServerSchema = z
  .object({
    id: capabilityRefSchema,
    provider: mcpCatalogProviderSchema.default("manual"),
    catalogId: z.string().trim().min(1).max(240).optional().nullable(),
    displayName: z.string().trim().min(1).max(160),
    transport: z.enum(["stdio", "streamable_http", "sse"]).default("stdio"),
    command: z.string().trim().min(1).max(1000).optional().nullable(),
    remoteUrl: z.string().trim().url().optional().nullable(),
    requiredSecretNames: z.array(envNameSchema).default([]),
    desiredState: agentCapabilityDesiredStateSchema.default("enabled"),
    liveState: agentCapabilityLiveStateSchema.default("not_installed"),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === "stdio" && !server.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio MCP servers must include a command",
        path: ["command"],
      });
    }
    if ((server.transport === "streamable_http" || server.transport === "sse") && !server.remoteUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remote MCP servers must include remoteUrl",
        path: ["remoteUrl"],
      });
    }
    if (server.liveState !== "not_installed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Desired capability config cannot claim liveState; live connect/install requires approval-gated apply",
        path: ["liveState"],
      });
    }
    assertNoSecretLikeString(server.displayName, ctx, ["displayName"]);
    assertNoSecretLikeString(server.command, ctx, ["command"]);
    assertNoSecretLikeString(server.remoteUrl, ctx, ["remoteUrl"]);
    assertNoSecretLikeString(server.notes, ctx, ["notes"]);
    // requiredSecretNames must be env-style identifiers AND must not embed
    // credential-shaped values. The env-name regex alone accepts uppercase
    // alphanumerics, so a shape like "AKIA…" can pass the identifier check
    // while still being a raw credential.
    for (const [index, secretName] of server.requiredSecretNames.entries()) {
      assertNoSecretLikeString(secretName, ctx, ["requiredSecretNames", index]);
    }
  });
export type AgentCapabilityMcpServer = z.infer<typeof agentCapabilityMcpServerSchema>;

export const agentCapabilityConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    mcpServers: z.array(agentCapabilityMcpServerSchema).default([]),
    skillRefs: z.array(capabilityRefSchema).default([]),
    toolRefs: z.array(capabilityRefSchema).default([]),
    liveApply: z.literal(false).default(false),
    liveExternalActions: z.literal(false).default(false),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const [index, server] of config.mcpServers.entries()) {
      if (ids.has(server.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate MCP server id: ${server.id}`,
          path: ["mcpServers", index, "id"],
        });
      }
      ids.add(server.id);
    }
  });
export type AgentCapabilityConfig = z.infer<typeof agentCapabilityConfigSchema>;
export type AgentCapabilityConfigInput = z.input<typeof agentCapabilityConfigSchema>;

export const updateAgentCapabilityConfigSchema = z.object({
  config: agentCapabilityConfigSchema,
});
export type UpdateAgentCapabilityConfig = z.infer<typeof updateAgentCapabilityConfigSchema>;

export interface AgentCapabilityAuditSummary {
  version: 1;
  mcpServerCount: number;
  mcpServerIds: string[];
  requiredSecretNames: string[];
  skillRefCount: number;
  toolRefCount: number;
  liveApply: false;
  liveExternalActions: false;
}

export interface AgentCapabilityApplyPreview {
  dryRunAvailable: true;
  requiresApprovalForLiveApply: true;
  liveApply: false;
  liveExternalActions: false;
}

export type AgentCapabilityScope = "company_default" | "agent_local";

export interface AgentCapabilitySettingsResponse {
  scope: AgentCapabilityScope;
  companyId: string;
  agentId: string | null;
  config: AgentCapabilityConfig;
  applyPreview: AgentCapabilityApplyPreview;
}

export function parseAgentCapabilityConfig(value: unknown): AgentCapabilityConfig {
  return agentCapabilityConfigSchema.parse(value ?? {});
}

export function resolveAgentCapabilityConfigForCreate(
  explicitConfig: unknown,
  companyDefaults: unknown,
): AgentCapabilityConfig {
  return parseAgentCapabilityConfig(explicitConfig ?? companyDefaults ?? {});
}

export function buildAgentCapabilityAuditSummary(config: AgentCapabilityConfig): AgentCapabilityAuditSummary {
  return {
    version: 1,
    mcpServerCount: config.mcpServers.length,
    mcpServerIds: config.mcpServers.map((server) => server.id),
    requiredSecretNames: Array.from(new Set(config.mcpServers.flatMap((server) => server.requiredSecretNames))).sort(),
    skillRefCount: config.skillRefs.length,
    toolRefCount: config.toolRefs.length,
    liveApply: false,
    liveExternalActions: false,
  };
}

export function buildAgentCapabilityApplyPreview(): AgentCapabilityApplyPreview {
  return {
    dryRunAvailable: true,
    requiresApprovalForLiveApply: true,
    liveApply: false,
    liveExternalActions: false,
  };
}
