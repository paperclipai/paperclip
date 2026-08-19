import type {
  CapabilityInteractionKind,
  CapabilityJsonValue,
  CapabilityRunContext,
} from "../mock-core/capability-control-plane-types.js";

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
