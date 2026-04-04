export type AccessMode = "read" | "read-write" | "promote";

export interface CompanyPolicy {
  companyId: string;
  namespace: string;
  accessMode: AccessMode;
}

export interface AgentPolicy {
  agentId: string;
  namespace?: string;
  accessMode?: AccessMode;
}

export interface DarwinBridgeConfig {
  darwinServerCommand?: string;
  darwinServerArgsJson?: string;
  upstashUrlSecretRef?: string;
  upstashTokenSecretRef?: string;
  upstashUrlEnvVar?: string;
  upstashTokenEnvVar?: string;
  storeEnabledEnvVar?: string;
  sharedNamespace?: string;
  companyPoliciesJson?: string;
  agentPoliciesJson?: string;
  timeoutMs?: number;
}

export interface EffectivePolicy {
  namespace: string;
  accessMode: AccessMode;
}

export interface DarwinToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface DarwinClientOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface DarwinStoreParams {
  id: string;
  text: string;
  category?: string;
  topic?: string;
  industry?: string;
  promote?: boolean;
}
