import type {
  AgentAdapterType,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";
import type {
  TrustAuthorizationPolicy,
  TrustPreset,
} from "../trust-policy.js";
import type { AgentOrgChainHealth } from "../agent-eligibility.js";
import type { AgentApiKeyScope } from "../validators/agent.js";

export interface AgentPermissions extends Record<string, unknown> {
  canCreateAgents: boolean;
  canCreateSkills?: boolean;
  trustPreset?: TrustPreset;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "simple_default" | "explicit_grant" | "agent_creator" | "ceo_role" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  errorReason?: string | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  orgChainHealth?: AgentOrgChainHealth;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export type ClearAgentErrorResponse = Agent;

export interface AgentKeyCreated {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

// The public status union for an adapter login session. The name is neutral: it
// carries no vendor word and no roadmap word. The union is closed. A public
// response returns only one of these six values.
export const ADAPTER_AUTH_SESSION_STATUSES = [
  "starting",
  "waiting_for_user",
  "authenticated",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type AdapterAuthSessionStatus = (typeof ADAPTER_AUTH_SESSION_STATUSES)[number];

// The internal status union. It extends the public union with two server-only
// states. The server never returns these two states in a public response.
//
// - `promoting`: the readiness-and-promotion window. The server maps this state
//   to the public `waiting_for_user` state.
// - `cleanup_pending`: a terminal outcome whose sandbox delete failed. A reaper
//   retries the delete. The server never projects this state to a public status;
//   it resolves the terminal status first.
export const ADAPTER_AUTH_SESSION_INTERNAL_STATUSES = [
  ...ADAPTER_AUTH_SESSION_STATUSES,
  "promoting",
  "cleanup_pending",
] as const;
export type AdapterAuthSessionInternalStatus =
  (typeof ADAPTER_AUTH_SESSION_INTERNAL_STATUSES)[number];

// Fixed, non-secret failure information. The `reason` is a stable code. The
// `message` is a short, non-secret sentence. Neither field carries a prompt, a
// credential byte, an account identifier, or a provider lease identifier.
export interface AdapterAuthSessionFailure {
  reason: string;
  message: string | null;
}

// The public login-session response. It carries only these five fields. It never
// carries the prompt, a credential byte, an account identifier, or the provider
// lease identifier. The `status` is always a public status.
export interface AdapterAuthSessionResponse {
  sessionId: string;
  environmentId: string;
  status: AdapterAuthSessionStatus;
  expiresAt: string | null;
  failure: AdapterAuthSessionFailure | null;
}

// The one-time login prompt. The server returns it only through an owner read.
export interface AdapterAuthSessionPrompt {
  url: string;
  code: string;
}

// The owner read of a login session. It adds the one-time prompt to the public
// response. Only the owner principal that started the session reads this shape.
export interface AdapterAuthSessionOwnerResponse extends AdapterAuthSessionResponse {
  prompt: AdapterAuthSessionPrompt | null;
}

// The request that starts a login session for one adapter in one environment.
// The owner principal comes from the authenticated caller, not from this body.
export interface StartAdapterAuthSessionRequest {
  environmentId: string;
  adapterType: AgentAdapterType;
  ttlSeconds?: number;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
