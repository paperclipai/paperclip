import { z } from "zod";
import { envBindingSchema } from "./secret.js";

const MCP_TRANSPORT_TYPES = ["stdio", "sse", "streamable-http"] as const;

export const createMcpServerSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional().nullable(),
    transportType: z.enum(MCP_TRANSPORT_TYPES),
    command: z.string().optional().nullable(),
    args: z.array(z.string()).optional().nullable(),
    url: z.string().url().optional().nullable(),
    headers: z.record(envBindingSchema).optional().nullable(),
    env: z.record(envBindingSchema).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.transportType === "stdio") {
      if (!data.command || data.command.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "command is required for stdio transport",
          path: ["command"],
        });
      }
    } else {
      if (!data.url || data.url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is required for sse and streamable-http transports",
          path: ["url"],
        });
      }
    }
  });

export type CreateMcpServer = z.infer<typeof createMcpServerSchema>;

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  transportType: z.enum(MCP_TRANSPORT_TYPES).optional(),
  command: z.string().optional().nullable(),
  args: z.array(z.string()).optional().nullable(),
  url: z.string().url().optional().nullable(),
  headers: z.record(envBindingSchema).optional().nullable(),
  env: z.record(envBindingSchema).optional().nullable(),
  enabled: z.boolean().optional(),
});

export type UpdateMcpServer = z.infer<typeof updateMcpServerSchema>;

export const assignMcpServersSchema = z.object({
  mcpServerIds: z.array(z.string().uuid()),
});

export type AssignMcpServers = z.infer<typeof assignMcpServersSchema>;
