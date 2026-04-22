import { z } from "zod";

export const workspaceMcpServerTransportSchema = z.enum(["stdio", "http"]);

export const workspaceMcpServerEnvValueSchema = z.object({
  type: z.enum(["plain", "secret_ref"]),
  value: z.string().optional(),
  secretId: z.string().optional(),
  version: z.union([z.number().int().nonnegative(), z.literal("latest")]).optional(),
}).strict();

export const workspaceMcpServerEnvSchema = z.record(workspaceMcpServerEnvValueSchema);

export const workspaceMcpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: workspaceMcpServerTransportSchema,
  enabled: z.boolean().optional(),
  description: z.string().optional().nullable(),
  command: z.string().optional().nullable(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  headers: z.record(z.string()).optional().nullable(),
  env: workspaceMcpServerEnvSchema.optional().nullable(),
  timeoutSec: z.number().int().positive().optional().nullable(),
  includeTools: z.array(z.string()).optional().nullable(),
  excludeTools: z.array(z.string()).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict();

export const workspaceMcpRuntimeConfigSchema = z.object({
  mcpServers: z.array(workspaceMcpServerConfigSchema).default([]),
}).strict();

export type WorkspaceMcpServerTransport = z.infer<typeof workspaceMcpServerTransportSchema>;
export type WorkspaceMcpServerConfig = z.infer<typeof workspaceMcpServerConfigSchema>;
export type WorkspaceMcpRuntimeConfig = z.infer<typeof workspaceMcpRuntimeConfigSchema>;
