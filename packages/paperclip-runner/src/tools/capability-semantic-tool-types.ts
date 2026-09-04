import type {
  CapabilityCommandResult,
  CapabilityInteractionKind,
  CapabilityJsonValue,
  CapabilitySemanticCommand,
} from "../mock-core/capability-control-plane-types.js";

export type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";

export type CapabilityToolDisposition = "always_agent_tool" | "optional_agent_tool";

export type CapabilityOptionalCatalogGroup =
  | "discovery"
  | "delegation_dependencies"
  | "governance"
  | "cases"
  | "workspace_runtime"
  | "routines"
  | "company_skills"
  | "secrets"
  | "portability_admin"
  | "test_escape_hatch";

export type CapabilitySideEffectClass =
  | "read"
  | "task_write"
  | "company_write"
  | "governance"
  | "workspace_control"
  | "secret_read"
  | "admin"
  | "test_escape_hatch";

export type ScenarioChatdempotencyBehavior = "none" | "required" | "recommended";

export type CapabilityToolTaskMode = "standard" | "ask" | "planning" | "skill_test";

export interface CapabilityJsonSchema {
  $schema?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, CapabilityJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | CapabilityJsonSchema;
  items?: CapabilityJsonSchema;
  enum?: CapabilityJsonValue[];
  minLength?: number;
  minimum?: number;
  oneOf?: CapabilityJsonSchema[];
}

export interface CapabilityRedactionRule {
  path: string;
  replacement: "[REDACTED]" | "[SECRET_VALUE]";
  appliesTo: ReadonlyArray<"input" | "output" | "error" | "authorization_record">;
}

export type CapabilityMockCommandMapping =
  | { kind: "context_read"; projection: string }
  | { kind: "snapshot_read"; projection: string }
  | { kind: "semantic_command"; commandKind: CapabilitySemanticCommand["kind"] }
  | { kind: "operation_result" }
  | { kind: "mock_extension"; extension: string };

export interface CapabilitySemanticToolDescriptor {
  operationId: string;
  version: 1;
  title: string;
  description: string;
  inputSchema: CapabilityJsonSchema;
  outputSchema: CapabilityJsonSchema;
  disposition: CapabilityToolDisposition;
  optionalGroup: CapabilityOptionalCatalogGroup | null;
  requiredClaims: string[];
  allowedRoles?: string[];
  taskModes: CapabilityToolTaskMode[];
  sideEffectClass: CapabilitySideEffectClass;
  idempotency: ScenarioChatdempotencyBehavior;
  redaction: CapabilityRedactionRule[];
  mockCommandMapping: CapabilityMockCommandMapping;
}

export interface CapabilityScenarioToolPolicy {
  deniedOperationIds?: string[];
  deniedClaims?: string[];
  allowedInteractionKinds?: CapabilityInteractionKind[];
  allowSecretValueAccess?: boolean;
  allowGenericEscapeHatch?: boolean;
  genericEscapeHatchAllowlist?: Array<{ method: string; path: string }>;
}

export interface CapabilityToolAuthorizationContext {
  runId: string;
  actor: {
    id: string;
    role: string;
    capabilityGrants: string[];
  };
  task: {
    id: string;
    assigneeActorId: string | null;
    workMode: CapabilityToolTaskMode;
  };
  scenarioGrants: string[];
  policy?: CapabilityScenarioToolPolicy;
}

export type CapabilityAuthorizationOutcome = "exposed" | "allowed" | "denied" | "absent";

export interface CapabilityAuthorizationRecord {
  schema: "paperclip.capability.authorization-record.v1";
  sequence: number;
  runId: string;
  actorId: string;
  taskId: string;
  operationId: string;
  phase: "exposure" | "invocation";
  outcome: CapabilityAuthorizationOutcome;
  consideredClaims: string[];
  grantedClaims: string[];
  missingClaims: string[];
  reason: string;
  redactions: Array<{ path: string; replacement: string }>;
  resultingStateChange: {
    beforeRevision: number | null;
    afterRevision: number | null;
    entityRefs: string[];
  } | null;
}

export interface CapabilityVisibleToolSet {
  schema: "paperclip.capability.visible-tools.v1";
  tools: CapabilitySemanticToolDescriptor[];
  authorizationRecords: CapabilityAuthorizationRecord[];
}

export interface CapabilityPolicyDenial {
  schema: "paperclip.capability.tool-result.v1";
  ok: false;
  error: {
    code: "policy_denied" | "operation_absent" | "input_invalid" | "operation_unsupported";
    message: string;
    operationId: string;
    reason: string;
  };
  authorization: CapabilityAuthorizationRecord;
}

export interface CapabilityToolSuccess {
  schema: "paperclip.capability.tool-result.v1";
  ok: true;
  operationId: string;
  operationResultId: string;
  value: CapabilityJsonValue;
  commandResult: CapabilityCommandResult | null;
  authorization: CapabilityAuthorizationRecord;
}

export type CapabilityToolInvocationResult = CapabilityToolSuccess | CapabilityPolicyDenial;

/**
 * A result intended only for the provider/model tool-response channel.
 *
 * The distinct schema prevents this value from being assigned to an observable
 * tool-result sink. Callers receive it only by explicitly opening a
 * {@link CapabilityModelToolDelivery}; the delivery capsule itself serializes to
 * its redacted observable result.
 */
export interface CapabilityModelToolSuccess {
  schema: "paperclip.capability.model-tool-result.v1";
  ok: true;
  operationId: string;
  operationResultId: string;
  value: CapabilityJsonValue;
  commandResult: CapabilityCommandResult | null;
  authorization: CapabilityAuthorizationRecord;
}

export type CapabilityModelToolInvocationResult = CapabilityModelToolSuccess | CapabilityPolicyDenial;

export interface CapabilityModelToolDelivery {
  /** Safe for traces, snapshots, persistence, errors, and browser payloads. */
  readonly observableResult: CapabilityToolInvocationResult;

  /** Explicitly opens the narrowly scoped provider/model delivery value. */
  readModelResult(): CapabilityModelToolInvocationResult;

  /** Accidental JSON serialization is always the observable redacted form. */
  toJSON(): CapabilityToolInvocationResult;
}

export interface CapabilityToolInvocation {
  operationId: string;
  input: CapabilityJsonValue;
  idempotencyKey?: string;
}

export const CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS = [
  "checkout_task",
  "release_task",
  "select_work",
  "route_wake",
  "enforce_budget",
  "append_audit_record",
  "persist_run",
  "replay_run",
  "schedule_blocker_wake",
  "reconcile_run",
] as const;
