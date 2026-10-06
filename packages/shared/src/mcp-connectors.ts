import { z } from "zod";
import {
  isValidMcpConnectorUpstreamName,
  type McpConnectorStatus,
} from "./mcp-connector-protocol.js";

export * from "./mcp-connector-protocol.js";

/** Board-facing view of an outbound MCP connector. Never carries token or credential material. */
export interface McpConnector {
  id: string;
  companyId: string;
  name: string;
  status: McpConnectorStatus;
  /** True while this Paperclip instance holds an authenticated connector session. */
  online: boolean;
  version: string | null;
  /** Upstream NAMES the connector published. URLs stay on the connector. */
  upstreams: string[];
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  enrollmentExpiresAt: string | null;
  credentialRotatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned once when a connector is created or re-enrolled. The token is never readable again. */
export interface McpConnectorEnrollment {
  connector: McpConnector;
  enrollmentToken: string;
  enrollmentExpiresAt: string;
}

export const mcpConnectorUpstreamNameSchema = z
  .string()
  .refine(isValidMcpConnectorUpstreamName, {
    message: "Upstream names use lowercase letters, digits, '-' or '_' (max 63 characters)",
  });

export const createMcpConnectorSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();
export type CreateMcpConnector = z.infer<typeof createMcpConnectorSchema>;

/** Transport config for `transport: "connector"` tool connections. */
export const mcpConnectorTransportConfigSchema = z.object({
  connectorId: z.string().uuid(),
  upstream: mcpConnectorUpstreamNameSchema,
}).passthrough();
export type McpConnectorTransportConfig = z.infer<typeof mcpConnectorTransportConfigSchema>;

export const enrollMcpConnectorSchema = z.object({
  token: z.string().min(1).max(256),
  version: z.string().trim().max(64).optional(),
}).strict();
