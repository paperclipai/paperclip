import { z } from "zod";

export const PUBLIC_MCP_PATH = "/mcp/paperclip";
export const PUBLIC_MCP_SCOPES = ["paperclip:read", "paperclip:write", "offline_access"] as const;
export const mcpConsentSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  companyId: z.string().uuid().optional(),
  allowWrites: z.boolean().default(false),
}).strict();

export interface McpConnectionRequest {
  id: string;
  clientName: string;
  redirectOrigin: string;
  requestedWrite: boolean;
  offlineAccess: boolean;
  requiresSignIn: boolean;
  /** Fixed by the authorization request; null permits direct-instance selection. */
  requestedCompanyId: string | null;
  companies: Array<{ id: string; name: string; logoUrl: string | null; canWrite: boolean }>;
  setupUrl: string | null;
}

export interface McpConnection {
  id: string;
  companyId: string;
  clientName: string;
  companyName: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}
