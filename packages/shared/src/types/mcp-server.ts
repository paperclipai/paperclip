import type { AgentEnvConfig } from "./secrets.js";
import type {
  McpServerGovernanceStatus,
  McpServerHealthStatus,
  McpServerRiskLevel,
  McpServerTransport,
} from "../constants.js";

export interface McpServer {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  transport: McpServerTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  env: AgentEnvConfig;
  /** Sealed credential material (localEncryptedProvider ref); never plaintext. */
  credentialSecretRef: string | null;
  enabled: boolean;
  /** Governance state machine; execution is denied unless "allowlisted". */
  governanceStatus: McpServerGovernanceStatus;
  /** Catalog-derived risk classification (recomputed on discovery). */
  riskLevel: McpServerRiskLevel;
  riskFactors: string[];
  governanceUpdatedAt: Date | null;
  /** Actor descriptor of the last transition (`user:<id>` / `agent:<id>` / `system`). */
  governanceUpdatedBy: string | null;
  governanceReason: string | null;
  lastHealthStatus: McpServerHealthStatus;
  lastHealthcheckAt: Date | null;
  lastDiscoveryAt: Date | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpServerRequest {
  name: string;
  slug: string;
  description?: string | null;
  transport: McpServerTransport;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  env?: AgentEnvConfig;
  /** Write-only plaintext credential; sealed via localEncryptedProvider at persistence. */
  credential?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateMcpServerRequest {
  name?: string;
  slug?: string;
  description?: string | null;
  transport?: McpServerTransport;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  env?: AgentEnvConfig;
  /** Write-only plaintext credential; undefined = keep, null = clear, string = reseal. */
  credential?: string | null;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}
