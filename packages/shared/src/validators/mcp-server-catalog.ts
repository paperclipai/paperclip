import { z } from "zod";
import { MCP_SERVER_DISCOVERY_STATUSES } from "../constants.js";

const recordSchema = z.record(z.string(), z.unknown());

export const mcpServerDiscoveryStatusSchema = z.enum(MCP_SERVER_DISCOVERY_STATUSES);

export const mcpServerCatalogToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  inputSchema: recordSchema.nullable(),
  annotations: recordSchema.nullable(),
  raw: recordSchema,
});

export const mcpServerCatalogResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
  raw: recordSchema,
});

export const mcpServerCatalogPromptSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(),
  description: z.string().nullable(),
  arguments: z.array(recordSchema),
  raw: recordSchema,
});

export const mcpServerCatalogSnapshotSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  mcpServerId: z.string().uuid(),
  status: mcpServerDiscoveryStatusSchema,
  protocolVersion: z.string().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  summary: z.string().nullable(),
  tools: z.array(mcpServerCatalogToolSchema),
  resources: z.array(mcpServerCatalogResourceSchema),
  prompts: z.array(mcpServerCatalogPromptSchema),
  serverInfo: recordSchema,
  error: z.string().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: z.date(),
});
