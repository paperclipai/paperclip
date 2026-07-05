import { z } from "zod";
import { envBindingSchema } from "./secret.js";

/**
 * Server names must be safe as a JSON key, a TOML table name (Codex), an env
 * var fragment (PAPERCLIP_MCP_<NAME>_...), and a Claude tool prefix
 * (mcp__<name>__*).
 */
export const MCP_SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export const mcpServerNameSchema = z
  .string()
  .regex(MCP_SERVER_NAME_RE, "MCP server names must start with a letter and use only letters, digits, '-' and '_' (max 64 chars)");

const envKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name");

const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,128}$/, "Invalid HTTP header name");

// Tool names become entries in space-separated --allowedTools strings and
// `mcp__<server>__<tool>` patterns, so whitespace is not allowed.
const toolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid MCP tool name");

export const mcpServerBearerAuthSchema = z.object({
  type: z.literal("bearer"),
  token: envBindingSchema,
}).strict();

export const mcpServerOauthAuthSchema = z.object({
  type: z.literal("oauth"),
  secretId: z.string().uuid().nullable(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
}).strict();

export const mcpServerAuthSchema = z.discriminatedUnion("type", [
  mcpServerBearerAuthSchema,
  mcpServerOauthAuthSchema,
]);

const mcpServerBaseShape = {
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  allowedTools: z.array(toolNameSchema).max(200).optional(),
};

export const mcpStdioServerSchema = z.object({
  ...mcpServerBaseShape,
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(100).optional(),
  env: z.record(envKeySchema, envBindingSchema).optional(),
  cwd: z.string().trim().min(1).max(4096).optional(),
}).strict();

const remoteUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP server URLs must use http(s)",
      });
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP server URLs must not embed credentials; use headers or auth instead",
      });
    }
  });

export const mcpHttpServerSchema = z.object({
  ...mcpServerBaseShape,
  transport: z.literal("http"),
  url: remoteUrlSchema,
  headers: z.record(headerNameSchema, envBindingSchema).optional(),
  auth: mcpServerAuthSchema.optional(),
}).strict();

export const mcpSseServerSchema = z.object({
  ...mcpServerBaseShape,
  transport: z.literal("sse"),
  url: remoteUrlSchema,
  headers: z.record(headerNameSchema, envBindingSchema).optional(),
  auth: mcpServerAuthSchema.optional(),
}).strict();

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  mcpSseServerSchema,
]);

export const mcpServersConfigSchema = z
  .record(mcpServerConfigSchema)
  .superRefine((value, ctx) => {
    const names = Object.keys(value);
    if (names.length > 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At most 32 MCP servers per agent",
      });
    }
    for (const name of names) {
      if (!MCP_SERVER_NAME_RE.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            "MCP server names must start with a letter and use only letters, digits, '-' and '_' (max 64 chars)",
        });
      }
    }
  });

export type McpServerConfigInput = z.infer<typeof mcpServerConfigSchema>;
export type McpServersConfigInput = z.infer<typeof mcpServersConfigSchema>;

/** PUT /agents/:id/mcp-servers — replaces the full record. */
export const updateAgentMcpServersSchema = z.object({
  mcpServers: mcpServersConfigSchema,
});

export type UpdateAgentMcpServers = z.infer<typeof updateAgentMcpServersSchema>;

/** POST /agents/:id/mcp-servers — add or replace a single named server. */
export const upsertAgentMcpServerSchema = z.object({
  name: mcpServerNameSchema,
  server: mcpServerConfigSchema,
});

export type UpsertAgentMcpServer = z.infer<typeof upsertAgentMcpServerSchema>;
