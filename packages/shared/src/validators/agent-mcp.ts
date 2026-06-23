import { z } from "zod";
import { MCP_TRANSPORTS } from "../constants.js";

/** A name used as the server key in `.mcp.json` — safe slug, no spaces. */
const mcpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "MCP server name must be alphanumeric, dash or underscore");

/**
 * One env var (stdio) or request header (http). A `secretName` marks the value as
 * a secret the board provides at approval time (stored in `company_secrets`, never
 * in the request payload). Otherwise `value` is a plain, non-sensitive literal.
 */
export const mcpEnvEntrySchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    value: z.string().max(4000).optional(),
    secretName: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
  })
  .refine((e) => Boolean(e.secretName) || e.value !== undefined, {
    message: "Each env entry needs either a value or a secretName",
  });

const agentMcpServerBaseSchema = z.object({
  name: mcpServerNameSchema,
  description: z.string().trim().max(500).optional(),
  transport: z.enum(MCP_TRANSPORTS),
  reason: z.string().trim().min(1).max(2000),
  // http transport
  url: z.string().trim().url().max(2000).optional(),
  // stdio transport
  command: z.string().trim().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.array(mcpEnvEntrySchema).max(50).optional(),
});

function refineTransport(data: z.infer<typeof agentMcpServerBaseSchema>, ctx: z.RefinementCtx) {
  if (data.transport === "http" && !data.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "http transport requires url", path: ["url"] });
  }
  if (data.transport === "stdio" && !data.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio transport requires command", path: ["command"] });
  }
}

/**
 * Payload an agent submits to request an MCP server (the `request_mcp_install`
 * approval payload). Declares secret values by NAME only.
 */
export const requestMcpInstallSchema = agentMcpServerBaseSchema.superRefine(refineTransport);
export type RequestMcpInstall = z.infer<typeof requestMcpInstallSchema>;

/** Board-supplied secret values, keyed by the `secretName` declared in the request. */
export const mcpSecretValuesSchema = z.record(z.string().min(1), z.string().min(1));
export type McpSecretValues = z.infer<typeof mcpSecretValuesSchema>;

/** Board creates/installs an MCP server directly (same shape + optional secret values). */
export const createAgentMcpServerSchema = agentMcpServerBaseSchema
  .extend({ secretValues: mcpSecretValuesSchema.optional() })
  .superRefine(refineTransport);
export type CreateAgentMcpServer = z.infer<typeof createAgentMcpServerSchema>;

export const setAgentMcpServerStatusSchema = z.object({
  status: z.enum(["enabled", "disabled"]),
});

/**
 * Payload an agent submits to request a catalog skill install (`request_skill_install`,
 * issue #5). On approval the board calls the existing `installFromCatalog`.
 */
export const requestSkillInstallSchema = z.object({
  catalogSkillId: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().min(1).max(2000),
});
export type RequestSkillInstall = z.infer<typeof requestSkillInstallSchema>;

/**
 * Payload an agent submits to request a plugin install (`request_plugin_install`).
 * Plugins are instance-scoped and privileged: approval requires an instance admin.
 */
export const requestPluginInstallSchema = z.object({
  packageName: z.string().trim().min(1).max(214).regex(/^[^<>:"|?*\s]+$/, "Invalid package name"),
  // Optional: first-party plugins are bundled (no npm version). Pin a version for
  // real npm packages when auditability matters; the board reviews the package name.
  version: z.string().trim().min(1).max(64).optional(),
  reason: z.string().trim().min(1).max(2000),
});
export type RequestPluginInstall = z.infer<typeof requestPluginInstallSchema>;
