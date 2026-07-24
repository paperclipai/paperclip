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

/**
 * Redacted bundle metadata returned alongside a built-in agent that ships a
 * managed resource bundle (instructions + skill + routine). The server strips
 * file bodies to key lists; the UI only needs the identity/labels to render the
 * bundle status panel. Present only on bundle-backed built-ins (Reflection
 * Coach); flat built-ins (briefs/learning) omit it.
 */
export interface BuiltInAgentBundleMeta {
  stockVersion: string;
  instructions: { entryFile: string; files: string[] };
  skill: {
    skillKey: string;
    displayName: string;
    slug: string;
    canonicalKey: string;
    files: string[];
  };
  routine: {
    routineKey: string;
    title: string;
    status: "active" | "paused";
    triggerCount: number;
    scheduleLabel?: string;
  };
}

export interface BuiltInAgentDefinition {
  key: string;
  displayName: string;
  featureKeys: string[];
  shortPurpose: string;
  defaultInstructions: string;
  defaultRole: string;
  allowedAdapterTypes?: string[];
  defaultAdapterType?: string;
  defaultAdapterConfig?: Record<string, unknown>;
  defaultBudgetMonthlyCents?: number;
  bundle?: BuiltInAgentBundleMeta;
}

/** Managed resources a bundle materializes; drift is tracked per kind. */
export type BuiltInManagedResourceKind = "instructions" | "skill" | "routine";

/**
 * Drift status of one managed resource versus the shipped stock default:
 * - `missing` — expected resource absent; a reconcile will recreate it.
 * - `stock_current` — present and byte-identical to the shipped default.
 * - `stock_update_available` — unedited, but Paperclip shipped a newer default.
 * - `operator_modified` — operator-edited; reconcile preserves these edits.
 */
export type BuiltInManagedResourceStockStatus =
  | "missing"
  | "stock_current"
  | "stock_update_available"
  | "operator_modified";

export interface BuiltInManagedResourceState {
  resourceKind: BuiltInManagedResourceKind;
  resourceKey: string;
  resourceId: string | null;
  stockVersion: string;
  stockHash: string;
  currentHash: string | null;
  stockStatus: BuiltInManagedResourceStockStatus;
  /** True when an unedited resource has a newer shipped default to apply. */
  updateAvailable: boolean;
  /** True when the resource has drifted and can be reset to the default. */
  resetAvailable: boolean;
  changedFiles?: string[];
  /** True when the managed weekly schedule is active and can create background work. */
  scheduleEnabled?: boolean;
  /** Pending request_confirmation for a Reflection Coach update proposal, when one exists. */
  pendingUpdateInteractionId?: string | null;
  /** Issue containing the pending proposal interaction. */
  pendingUpdateIssueId?: string | null;
  pendingUpdateIssueIdentifier?: string | null;
}

export interface BuiltInAgentState {
  definition: BuiltInAgentDefinition;
  status: BuiltInAgentStatus;
  agentId: string | null;
  agent: Agent | null;
  pauseReason: string | null;
  /** Per-resource drift/readiness for bundle-backed built-ins (may be empty). */
  resources?: BuiltInManagedResourceState[];
  /** Present when provisioning queued a board hire approval (HTTP 202). */
  approval?: Approval | null;
}

export interface BuiltInAgentProvisionInput {
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  budgetMonthlyCents?: number;
}

/**
 * Selectors accepted by the reset endpoint. `agent` resets the agent config
 * (adapter/model/budget defaults) only; the resource kinds each reset a single
 * managed resource back to its shipped default. Omitting the array resets
 * everything (the agent-level "Reset to defaults" button).
 */
export type BuiltInResetResource = "agent" | BuiltInManagedResourceKind;

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
  /**
   * Reset built-in defaults. Pass `resources` to scope the reset to specific
   * managed resources (e.g. `["skill"]`); omit it to reset the whole agent +
   * bundle. A single-resource reset re-applies that resource's newest shipped
   * default — the same path used for both "reset drifted edits" and "apply an
   * available stock update".
   */
  reset: (companyId: string, key: string, resources?: BuiltInResetResource[]) =>
    api.post<BuiltInAgentState>(
      `/companies/${companyId}/built-in-agents/${key}/reset`,
      resources ? { resources } : {},
    ),
  /**
   * Re-materialize the bundle. Applies the newest shipped defaults to unedited
   * (`stock_update_available`) and `missing` resources while preserving
   * `operator_modified` edits — it is the safe "apply available updates" path.
   */
  reconcile: (companyId: string, key: string) =>
    api.post<BuiltInAgentState>(`/companies/${companyId}/built-in-agents/${key}/reconcile`, {}),
  runRoutine: (companyId: string, key: string, routineKey: string) =>
    api.post<unknown>(`/companies/${companyId}/built-in-agents/${key}/routines/${routineKey}/run`, {}),
  enableRoutineSchedule: (companyId: string, key: string, routineKey: string) =>
    api.post<BuiltInAgentState>(`/companies/${companyId}/built-in-agents/${key}/routines/${routineKey}/enable`, {}),
  disableRoutineSchedule: (companyId: string, key: string, routineKey: string) =>
    api.post<BuiltInAgentState>(`/companies/${companyId}/built-in-agents/${key}/routines/${routineKey}/disable`, {}),
};
