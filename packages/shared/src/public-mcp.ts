import { z } from "zod";

export const DOT_RUNNER_MCP_PATH = "/mcp/runner";
export const DOT_RUNNER_MCP_SCOPES = ["paperclip:agent", "offline_access"] as const;
export const PUBLIC_MCP_PATH = "/mcp/paperclip";
export const PUBLIC_MCP_SCOPES = ["paperclip:read", "paperclip:write", "paperclip:configure", "offline_access"] as const;
export const mcpConsentSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  companyId: z.string().uuid().optional(),
  allowWrites: z.boolean().default(false),
  allowConfiguration: z.boolean().default(false),
}).strict();

export interface McpConnectionRequest {
  id: string;
  clientName: string;
  redirectOrigin: string;
  clientOrigin?: string | null;
  agentConnection?: boolean;
  requestedWrite: boolean;
  requestedConfigure?: boolean;
  offlineAccess: boolean;
  requiresSignIn: boolean;
  /** Fixed by the authorization request; null permits direct-instance selection. */
  requestedCompanyId: string | null;
  companies: Array<{ id: string; name: string; logoUrl: string | null; canWrite: boolean }>;
  setupUrl: string | null;
}

export interface McpConnectionSetup {
  enabled: boolean;
  serverUrl: string;
  invitationUrl: string;
  invitation: string;
}

export interface McpConnection {
  id: string;
  companyId: string;
  clientName: string;
  companyName: string;
  /** The signed-in person who authorized this connection; absent on older servers. */
  user?: { name: string; image: string | null } | null;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}

/** Code-scoped details shown before activating an operator-approved Dot agent. */
export interface McpDotPairingPreview {
  company: { id: string; name: string };
  agent: { id: string; name: string };
  permissions: string;
  accessDuration: string;
  pairingExpiresAt: string;
}
