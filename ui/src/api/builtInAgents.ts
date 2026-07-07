import type { Agent, Approval } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Lifecycle of a built-in agent, derived server-side from row existence,
 * adapter-config completeness, board-approval state, and `pausedAt`.
 *
 * `not_provisioned → pending_approval → needs_setup → ready ⇄ paused`
 *
 * `pending_approval` only occurs when the company requires board approval for
 * new agents; otherwise provisioning goes straight to `needs_setup`/`ready`.
 */
export type BuiltInAgentStatus =
  | "not_provisioned"
  | "pending_approval"
  | "needs_setup"
  | "ready"
  | "paused";

export interface BuiltInAgentDefinition {
  key: string;
  displayName: string;
  featureKeys: string[];
  shortPurpose: string;
  defaultInstructions: string;
  defaultRole: string;
  allowedAdapterTypes?: string[];
  defaultBudgetMonthlyCents?: number;
}

export interface BuiltInAgentState {
  definition: BuiltInAgentDefinition;
  status: BuiltInAgentStatus;
  agentId: string | null;
  agent: Agent | null;
  pauseReason: string | null;
  /** Present when provisioning queued a board hire approval (HTTP 202). */
  approval?: Approval | null;
}

export interface BuiltInAgentProvisionInput {
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
}

/**
 * Error `code` thrown as HTTP 412 by `requireBuiltInAgent` on the server when a
 * feature needs a built-in agent that is missing or not fully configured. The
 * configure-on-first-use modal is triggered from this signal.
 */
export const BUILT_IN_AGENT_NOT_CONFIGURED_CODE = "built_in_agent_not_configured";

/**
 * Warning `code` returned alongside a paused built-in agent so callers can
 * surface the use-while-paused toast without treating the agent as ready.
 */
export const BUILT_IN_AGENT_PAUSED_CODE = "built_in_agent_paused";

export const builtInAgentsApi = {
  list: (companyId: string) =>
    api.get<BuiltInAgentState[]>(`/companies/${companyId}/built-in-agents`),
  provision: (companyId: string, key: string, input: BuiltInAgentProvisionInput = {}) =>
    api.post<BuiltInAgentState>(`/companies/${companyId}/built-in-agents/${key}/provision`, input),
  reset: (companyId: string, key: string) =>
    api.post<BuiltInAgentState>(`/companies/${companyId}/built-in-agents/${key}/reset`, {}),
};
