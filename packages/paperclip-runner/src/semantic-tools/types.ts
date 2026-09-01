import type {
  CapabilityInteractionKind,
  CapabilityJsonValue,
  CapabilityRunContext,
} from "../mock-core/capability-control-plane-types.js";
import type {
  PaperclipJsonSchema,
  PaperclipJsonValue,
  PaperclipSemanticActionDescriptor,
  PaperclipSemanticActionEffect,
  PaperclipSemanticActionId,
  PaperclipSemanticActionMode,
} from "../catalog/semantic-action-types.js";
import type { PrpSemanticToolEnvelope } from "../protocol/replay-contract.js";

export type CapabilitySemanticToolExposure = "always" | "optional";

export type CapabilitySemanticOperationId =
  | "get_task_context"
  | "get_task_history"
  | "list_documents"
  | "read_document"
  | "list_document_revisions"
  | "report_progress"
  | "answer_status_question"
  | "write_document"
  | "request_human_input"
  | "register_deliverable"
  | "finish_task"
  | "block_task"
  | "request_review"
  | "list_agents"
  | "get_agent"
  | "search_tasks"
  | "list_approvals"
  | "get_approval"
  | "get_approval_context"
  | "get_workspace_runtime"
  | "control_workspace_service"
  | "set_dependencies"
  | "create_task"
  | "request_approval"
  | "decide_approval"
  | "comment_on_approval"
  | "schedule_wake"
  | "generic_api_request";

export interface CapabilityJsonSchema {
  readonly $schema?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, CapabilityJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | CapabilityJsonSchema;
  readonly items?: CapabilityJsonSchema;
  readonly enum?: readonly CapabilityJsonValue[];
  readonly const?: CapabilityJsonValue;
  readonly oneOf?: readonly CapabilityJsonSchema[];
  readonly anyOf?: readonly CapabilityJsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: CapabilityJsonValue;
}

export interface CapabilitySemanticToolDescriptor {
  readonly schema: "paperclip.semantic-tool.v1";
  readonly operationId: CapabilitySemanticOperationId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly exposure: CapabilitySemanticToolExposure;
  readonly requiredClaims: readonly string[];
  readonly allowedModes: readonly CapabilityRunContext["activeTask"]["workMode"][];
  readonly allowedRoles?: readonly string[];
  readonly disabledByDefault?: boolean;
  readonly inputSchema: CapabilityJsonSchema;
  readonly outputSchema: CapabilityJsonSchema;
}

export interface CapabilitySemanticScenarioPolicy {
  readonly id: string;
  /** Claims that this scenario is permitted to grant. Run claims still narrow this set. */
  readonly claims?: readonly string[];
  readonly allowOperations?: readonly CapabilitySemanticOperationId[];
  readonly denyOperations?: readonly CapabilitySemanticOperationId[];
  readonly allowedInteractionKinds?: readonly CapabilityInteractionKind[];
  readonly enableGenericApiRequest?: boolean;
}

export interface CapabilitySemanticPolicyContext {
  readonly runId: string;
  readonly actor: CapabilityRunContext["actor"];
  readonly task: CapabilityRunContext["activeTask"];
  readonly runClaims: readonly string[];
  readonly explicitClaims: readonly string[];
  readonly scenario: CapabilitySemanticScenarioPolicy;
}

export type CapabilityAuthorizationPhase = "exposure" | "invocation";

export type CapabilitySemanticDenialCode =
  | "tool_not_exposed"
  | "actor_inactive"
  | "task_mode_denied"
  | "task_state_denied"
  | "task_ownership_denied"
  | "required_claim_missing"
  | "actor_role_denied"
  | "scenario_denied"
  | "interaction_kind_denied"
  | "generic_api_disabled"
  | "input_invalid"
  | "protected_data_denied"
  | "operation_unavailable"
  | "control_plane_denied";

export interface CapabilitySemanticAuthorizationDecision {
  readonly allowed: boolean;
  readonly phase: CapabilityAuthorizationPhase;
  readonly operationId: CapabilitySemanticOperationId;
  readonly code: "allowed" | CapabilitySemanticDenialCode;
  readonly reason: string;
  readonly effectiveClaims: readonly string[];
}

export interface CapabilitySemanticAuthorizationRecord
  extends CapabilitySemanticAuthorizationDecision {
  readonly schema: "paperclip.semantic-authorization-record.v1";
  readonly id: string;
  readonly runId: string;
  readonly scenarioId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly callId: string | null;
  readonly input: CapabilityJsonValue | null;
  readonly result: CapabilityJsonValue | null;
}

export interface CapabilitySemanticToolDefinition {
  readonly name: CapabilitySemanticOperationId;
  readonly description: string;
  readonly inputSchema: CapabilityJsonSchema;
  readonly outputSchema: CapabilityJsonSchema;
  readonly annotations: {
    readonly semanticContract: "paperclip.semantic-tool.v1";
    readonly operationId: CapabilitySemanticOperationId;
    readonly version: 1;
    readonly exposure: CapabilitySemanticToolExposure;
    readonly requiredClaims: readonly string[];
  };
}

export interface CapabilitySemanticToolCall {
  readonly runId: string;
  readonly callId: string;
  readonly operationId: CapabilitySemanticOperationId | string;
  readonly input: unknown;
}

export interface CapabilitySemanticToolSuccess {
  readonly ok: true;
  readonly operationId: CapabilitySemanticOperationId;
  readonly callId: string;
  readonly result: CapabilityJsonValue;
  readonly stateRevision: number;
}

export interface CapabilitySemanticToolDenial {
  readonly ok: false;
  readonly operationId: string;
  readonly callId: string;
  readonly denial: {
    readonly schema: "paperclip.semantic-denial.v1";
    readonly code: CapabilitySemanticDenialCode;
    /** Stable authority error code when the semantic boundary was allowed. */
    readonly controlPlaneCode?: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly stateRevision: number;
}

export type CapabilitySemanticToolResult =
  | CapabilitySemanticToolSuccess
  | CapabilitySemanticToolDenial;

export interface PaperclipSemanticRunContext {
  readonly runId: string;
  readonly companyId: string;
  readonly actor: {
    readonly id: string;
    readonly companyId: string;
    readonly status: string;
    readonly role: string;
    readonly claims: readonly string[];
  };
  readonly activeTask: {
    readonly id: string;
    readonly companyId: string;
    readonly assigneeActorId: string | null;
    readonly executionRunId: string | null;
    readonly status: string;
    readonly workMode: PaperclipSemanticActionMode;
  };
  /** Claims explicitly delegated to this run. Actor claims can only narrow them. */
  readonly delegatedClaims: readonly string[];
  readonly policy?: {
    readonly deniedOperationIds?: readonly PaperclipSemanticActionId[];
    readonly allowedInteractionKinds?: readonly string[];
  };
}

export type PaperclipSemanticContextProvider = (
  runId: string,
) => PaperclipSemanticRunContext | Promise<PaperclipSemanticRunContext>;

export interface PaperclipSemanticToolDefinition {
  readonly name: PaperclipSemanticActionId;
  readonly description: string;
  readonly inputSchema: PaperclipJsonSchema;
  readonly outputSchema: PaperclipJsonSchema;
  readonly annotations: {
    readonly semanticContract: "paperclip.semantic-action.v1";
    readonly version: 1;
    readonly placement: PaperclipSemanticActionDescriptor["placement"];
    readonly effect: PaperclipSemanticActionEffect;
    readonly requiredClaims: readonly string[];
  };
}

export interface PaperclipSemanticDiscoveryResult {
  readonly schema: "paperclip.semantic-discovery.v1";
  readonly query: string;
  readonly namespace: string | null;
  readonly operations: readonly PaperclipSemanticToolDefinition[];
  readonly truncated: boolean;
}

export type PaperclipSemanticAuthorizationPhase = "exposure" | "invocation";

export type PaperclipSemanticDenialCode =
  | "operation_absent"
  | "authority_context_invalid"
  | "run_mismatch"
  | "company_mismatch"
  | "actor_inactive"
  | "task_mode_denied"
  | "task_state_denied"
  | "task_ownership_denied"
  | "required_claim_missing"
  | "actor_role_denied"
  | "policy_denied"
  | "interaction_kind_denied"
  | "protected_data_denied"
  | "input_invalid"
  | "idempotency_required"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "receipt_store_unavailable"
  | "receipt_recovery_failed"
  | "binding_failed"
  | "binding_output_invalid";

export interface PaperclipSemanticAuthorizationDecision {
  readonly allowed: boolean;
  readonly phase: PaperclipSemanticAuthorizationPhase;
  readonly operationId: PaperclipSemanticActionId;
  readonly code: "allowed" | PaperclipSemanticDenialCode;
  readonly reason: string;
  readonly effectiveClaims: readonly string[];
}

export interface PaperclipSemanticAuthorizationRecord extends PaperclipSemanticAuthorizationDecision {
  readonly schema: "paperclip.semantic-authorization-record.v1";
  readonly id: string;
  readonly runId: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly callId: string | null;
  readonly inputDigest: string | null;
  readonly operationReceiptId: string | null;
}

export interface PaperclipSemanticSafeReference {
  readonly kind:
    | "task"
    | "document_revision"
    | "interaction"
    | "approval"
    | "decision"
    | "artifact"
    | "work_product"
    | "wake"
    | "monitor"
    | "audit"
    | "operation";
  readonly id: string;
}

export interface PaperclipSemanticBindingResult {
  readonly value: PaperclipJsonValue;
  readonly code?: string;
  readonly stateRevision?: number;
  readonly references?: readonly PaperclipSemanticSafeReference[];
  readonly auditReceiptId?: string;
}

export interface PaperclipAuthorizedSemanticInvocation {
  readonly runId: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly operationId: PaperclipSemanticActionId;
  readonly input: Readonly<Record<string, PaperclipJsonValue>>;
}

export interface PaperclipSemanticActionBinding {
  readonly operationId: PaperclipSemanticActionId;
  execute(
    invocation: PaperclipAuthorizedSemanticInvocation,
  ): PaperclipSemanticBindingResult | Promise<PaperclipSemanticBindingResult>;
}

export interface PaperclipSemanticCorrelation {
  readonly runId: string;
  readonly normalizedSessionId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly requestId?: string;
}

export interface PaperclipSemanticToolCall {
  readonly runId: string;
  readonly callId: string;
  readonly operationId: string;
  readonly correlation: PaperclipSemanticCorrelation;
  readonly input: unknown;
}

export interface PaperclipSemanticStoredOutcome {
  readonly operationId: PaperclipSemanticActionId;
  readonly inputDigest: string;
  readonly operationReceiptId: string;
  readonly value: PaperclipJsonValue;
  readonly code: string;
  readonly stateRevision?: number;
  readonly references: readonly PaperclipSemanticSafeReference[];
  readonly auditReceiptId?: string;
}

export type PaperclipSemanticIdempotencyClaim =
  | { readonly kind: "claimed"; readonly token: string }
  | {
      readonly kind: "duplicate";
      readonly outcome: PaperclipSemanticStoredOutcome;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "in_progress" };

/**
 * The claim operation must be atomic. Production bindings must persist this
 * store before they expose mutation actions. `complete` is the primary commit
 * path. `recover` is a required, idempotent fallback that must durably resolve
 * a claim to the same outcome when the primary commit reports an ambiguous or
 * transient failure. A store without an independent recovery path cannot be
 * used to expose mutation actions.
 */
export interface PaperclipSemanticIdempotencyStore {
  claim(input: {
    readonly scope: string;
    readonly operationId: PaperclipSemanticActionId;
    readonly inputDigest: string;
  }):
    | PaperclipSemanticIdempotencyClaim
    | Promise<PaperclipSemanticIdempotencyClaim>;
  complete(
    token: string,
    outcome: PaperclipSemanticStoredOutcome,
  ): void | Promise<void>;
  recover(
    token: string,
    outcome: PaperclipSemanticStoredOutcome,
  ): void | Promise<void>;
  release(token: string): void | Promise<void>;
}

export interface PaperclipSemanticToolSuccess {
  readonly ok: true;
  readonly operationId: PaperclipSemanticActionId;
  readonly callId: string;
  readonly value: PaperclipJsonValue;
  readonly code: string;
  readonly duplicate: boolean;
  readonly stateRevision?: number;
  readonly inputReceipt: PrpSemanticToolEnvelope;
  readonly resultReceipt: PrpSemanticToolEnvelope;
}

export interface PaperclipSemanticToolDenial {
  readonly ok: false;
  readonly operationId: string;
  readonly callId: string;
  readonly error: {
    readonly code: PaperclipSemanticDenialCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly inputReceipt: PrpSemanticToolEnvelope | null;
  readonly resultReceipt: PrpSemanticToolEnvelope | null;
}

export type PaperclipSemanticToolResult =
  PaperclipSemanticToolSuccess | PaperclipSemanticToolDenial;
