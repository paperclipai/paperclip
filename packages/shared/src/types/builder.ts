/**
 * Company AI Builder — shared types.
 *
 * The Builder is a board-operator copilot scoped to one company. See
 * `doc/plans/2026-05-04-company-ai-builder.md`.
 */

export const BUILDER_SESSION_STATES = ["active", "completed", "aborted"] as const;
export type BuilderSessionState = (typeof BUILDER_SESSION_STATES)[number];

export const BUILDER_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type BuilderMessageRole = (typeof BUILDER_MESSAGE_ROLES)[number];

export const BUILDER_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "applied",
  "rejected",
  "failed",
] as const;
export type BuilderProposalStatus = (typeof BUILDER_PROPOSAL_STATUSES)[number];

export interface BuilderRuntimeConfigSummary {
  adapterType: string;
  model: string;
  updatedAt: Date;
  source: "company_settings";
}

export interface BuilderHandoffTarget {
  kind: "approval" | "entity" | "proposal" | "settings";
  label: string;
  href: string | null;
  approvalId?: string | null;
  proposalId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * One element of a Builder message transcript. Tool calls and tool results
 * are encoded into the message itself (rather than separate tables) so the
 * full transcript is one ordered list.
 */
export interface BuilderToolCall {
  /** Provider-assigned identifier (or generated) used to correlate calls/results. */
  id: string;
  /** Tool name as registered in the Builder tool registry. */
  name: string;
  /** Arguments the model passed (already JSON-parsed). */
  arguments: Record<string, unknown>;
}

export interface BuilderToolResult {
  /** Matches `BuilderToolCall.id`. */
  toolCallId: string;
  name: string;
  /** True when the tool ran without throwing. */
  ok: boolean;
  /** Result payload (model-visible). For errors, contains `{error: string}`. */
  result: unknown;
  /** Set when the tool created a deferred mutation. */
  proposalId?: string;
  /** Status of the associated proposal (if proposalId is set). */
  proposalStatus?: BuilderProposalStatus;
  /** Set when the tool performed an immediate mutation that produced an activity row. */
  activityId?: string;
  /** Optional handoff target for the operator. */
  handoff?: BuilderHandoffTarget | null;
}

export interface BuilderMessageContent {
  /** Free-form assistant/user text. */
  text?: string;
  /** Assistant-only: tool calls the model emitted on this turn. */
  toolCalls?: BuilderToolCall[];
  /** Tool-role only: result of a previously-emitted tool call. */
  toolResult?: BuilderToolResult;
}

export interface BuilderMessage {
  id: string;
  sessionId: string;
  companyId: string;
  sequence: number;
  role: BuilderMessageRole;
  content: BuilderMessageContent;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  createdAt: Date;
}

export interface BuilderSession {
  id: string;
  companyId: string;
  createdByUserId: string | null;
  title: string;
  /** Legacy snapshot only; live Builder turns use current company settings. */
  adapterType: string;
  /** Legacy snapshot only; live Builder turns use current company settings. */
  model: string;
  state: BuilderSessionState;
  archivedAt: Date | null;
  inputTokensTotal: number;
  outputTokensTotal: number;
  costCentsTotal: number;
  /** Live Builder turns always use the current company-level Builder settings. */
  effectiveRuntimeConfig?: BuilderRuntimeConfigSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuilderSessionDetail extends BuilderSession {
  messages: BuilderMessage[];
}

export interface BuilderProviderSettings {
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuilderToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema (subset) for the tool's parameters. */
  parametersSchema: Record<string, unknown>;
  /** True iff invoking this tool requires board approval. */
  requiresApproval: boolean;
  /** Capability badge surfaced in the UI tool catalog. */
  capability: string;
  /** "core" for built-in tools; plugin id otherwise. */
  source: string;
}

export interface BuilderToolCatalog {
  tools: BuilderToolDescriptor[];
  supportedAdapterTypes: string[];
}

export interface BuilderProposal {
  id: string;
  sessionId: string;
  messageId: string;
  companyId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: BuilderProposalStatus;
  appliedActivityId: string | null;
  approvalId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  failureReason: string | null;
  handoff?: BuilderHandoffTarget | null;
  createdAt: Date;
  updatedAt: Date;
}
