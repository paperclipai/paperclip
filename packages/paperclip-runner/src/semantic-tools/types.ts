import type {
  Phase7InteractionKind,
  Phase7JsonValue,
  Phase7RunContext,
} from "../mock-core/phase7-control-plane-types.js";

export type Phase7SemanticToolExposure = "always" | "optional";

export type Phase7SemanticOperationId =
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

export interface Phase7JsonSchema {
  readonly $schema?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Phase7JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Phase7JsonSchema;
  readonly items?: Phase7JsonSchema;
  readonly enum?: readonly Phase7JsonValue[];
  readonly const?: Phase7JsonValue;
  readonly oneOf?: readonly Phase7JsonSchema[];
  readonly anyOf?: readonly Phase7JsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: Phase7JsonValue;
}

export interface Phase7SemanticToolDescriptor {
  readonly schema: "paperclip.semantic-tool.v1";
  readonly operationId: Phase7SemanticOperationId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly exposure: Phase7SemanticToolExposure;
  readonly requiredClaims: readonly string[];
  readonly allowedModes: readonly Phase7RunContext["activeTask"]["workMode"][];
  readonly allowedRoles?: readonly string[];
  readonly disabledByDefault?: boolean;
  readonly inputSchema: Phase7JsonSchema;
  readonly outputSchema: Phase7JsonSchema;
}

export interface Phase7SemanticScenarioPolicy {
  readonly id: string;
  /** Claims that this scenario is permitted to grant. Run claims still narrow this set. */
  readonly claims?: readonly string[];
  readonly allowOperations?: readonly Phase7SemanticOperationId[];
  readonly denyOperations?: readonly Phase7SemanticOperationId[];
  readonly allowedInteractionKinds?: readonly Phase7InteractionKind[];
  readonly enableGenericApiRequest?: boolean;
}

export interface Phase7SemanticPolicyContext {
  readonly runId: string;
  readonly actor: Phase7RunContext["actor"];
  readonly task: Phase7RunContext["activeTask"];
  readonly runClaims: readonly string[];
  readonly explicitClaims: readonly string[];
  readonly scenario: Phase7SemanticScenarioPolicy;
}

export type Phase7AuthorizationPhase = "exposure" | "invocation";

export type Phase7SemanticDenialCode =
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

export interface Phase7SemanticAuthorizationDecision {
  readonly allowed: boolean;
  readonly phase: Phase7AuthorizationPhase;
  readonly operationId: Phase7SemanticOperationId;
  readonly code: "allowed" | Phase7SemanticDenialCode;
  readonly reason: string;
  readonly effectiveClaims: readonly string[];
}

export interface Phase7SemanticAuthorizationRecord
  extends Phase7SemanticAuthorizationDecision {
  readonly schema: "paperclip.semantic-authorization-record.v1";
  readonly id: string;
  readonly runId: string;
  readonly scenarioId: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly callId: string | null;
  readonly input: Phase7JsonValue | null;
  readonly result: Phase7JsonValue | null;
}

export interface Phase7SemanticToolDefinition {
  readonly name: Phase7SemanticOperationId;
  readonly description: string;
  readonly inputSchema: Phase7JsonSchema;
  readonly outputSchema: Phase7JsonSchema;
  readonly annotations: {
    readonly semanticContract: "paperclip.semantic-tool.v1";
    readonly operationId: Phase7SemanticOperationId;
    readonly version: 1;
    readonly exposure: Phase7SemanticToolExposure;
    readonly requiredClaims: readonly string[];
  };
}

export interface Phase7SemanticToolCall {
  readonly runId: string;
  readonly callId: string;
  readonly operationId: Phase7SemanticOperationId | string;
  readonly input: unknown;
}

export interface Phase7SemanticToolSuccess {
  readonly ok: true;
  readonly operationId: Phase7SemanticOperationId;
  readonly callId: string;
  readonly result: Phase7JsonValue;
  readonly stateRevision: number;
}

export interface Phase7SemanticToolDenial {
  readonly ok: false;
  readonly operationId: string;
  readonly callId: string;
  readonly denial: {
    readonly schema: "paperclip.semantic-denial.v1";
    readonly code: Phase7SemanticDenialCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly stateRevision: number;
}

export type Phase7SemanticToolResult =
  | Phase7SemanticToolSuccess
  | Phase7SemanticToolDenial;
