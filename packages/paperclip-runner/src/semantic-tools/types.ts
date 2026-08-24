import type {
  PaperclipJsonSchema,
  PaperclipJsonValue,
  PaperclipSemanticActionDescriptor,
  PaperclipSemanticActionEffect,
  PaperclipSemanticActionId,
  PaperclipSemanticActionMode,
} from "../catalog/semantic-action-types.js";
import type { PrpSemanticToolEnvelope } from "../protocol/replay-contract.js";

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
