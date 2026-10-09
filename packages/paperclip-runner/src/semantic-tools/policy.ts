import type { CapabilityRunContext } from "../mock-core/capability-control-plane-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "./catalog.js";
import type {
  CapabilitySemanticAuthorizationDecision,
  CapabilitySemanticOperationId,
  CapabilitySemanticPolicyContext,
  CapabilitySemanticScenarioPolicy,
  CapabilitySemanticToolDescriptor,
} from "./types.js";

export const CAPABILITY_SEMANTIC_READ_OPERATION_IDS = [
  "get_task_context",
  "get_task_history",
  "list_documents",
  "read_document",
  "list_document_revisions",
  "list_agents",
  "get_agent",
  "search_tasks",
  "list_approvals",
  "get_approval",
  "get_approval_context",
  "get_workspace_runtime",
] as const satisfies readonly CapabilitySemanticOperationId[];

const READ_OPERATIONS = new Set<CapabilitySemanticOperationId>(
  CAPABILITY_SEMANTIC_READ_OPERATION_IDS,
);

export function isCapabilitySemanticReadOperation(operationId: string): boolean {
  return READ_OPERATIONS.has(operationId as CapabilitySemanticOperationId);
}

export const DEFAULT_CAPABILITY_SCENARIO_POLICY: CapabilitySemanticScenarioPolicy = {
  id: "capability-default",
};

export function createCapabilitySemanticPolicyContext(
  context: CapabilityRunContext,
  scenario: CapabilitySemanticScenarioPolicy = DEFAULT_CAPABILITY_SCENARIO_POLICY,
  explicitClaims: readonly string[] = context.capabilities,
): CapabilitySemanticPolicyContext {
  return deepFreeze({
    runId: context.activeTask.executionRunId ?? context.activeTask.checkoutRunId ?? "",
    actor: context.actor,
    task: context.activeTask,
    runClaims: sortedUnique(context.capabilities),
    explicitClaims: sortedUnique(explicitClaims),
    scenario,
  });
}

export function decideCapabilitySemanticAuthorization(
  descriptor: CapabilitySemanticToolDescriptor,
  context: CapabilitySemanticPolicyContext,
  phase: "exposure" | "invocation",
  input?: unknown,
): CapabilitySemanticAuthorizationDecision {
  const effectiveClaims = computeEffectiveClaims(context);
  const base = { phase, operationId: descriptor.operationId, effectiveClaims } as const;
  const deny = (
    code: Exclude<CapabilitySemanticAuthorizationDecision["code"], "allowed">,
    reason: string,
  ): CapabilitySemanticAuthorizationDecision => ({ ...base, allowed: false, code, reason });

  if (context.actor.status !== "active") {
    return deny("actor_inactive", "The mock actor is not active.");
  }
  if (!descriptor.allowedModes.includes(context.task.workMode)) {
    return deny("task_mode_denied", "The semantic operation is unavailable in this task mode.");
  }
  if (
    context.scenario.denyOperations?.includes(descriptor.operationId) === true ||
    (descriptor.exposure === "optional" &&
      context.scenario.allowOperations !== undefined &&
      !context.scenario.allowOperations.includes(descriptor.operationId))
  ) {
    return deny("scenario_denied", "The active scenario does not permit this semantic operation.");
  }
  if (descriptor.disabledByDefault === true) {
    if (
      descriptor.operationId !== "generic_api_request" ||
      context.scenario.enableGenericApiRequest !== true
    ) {
      return deny("generic_api_disabled", "The generic API escape hatch is disabled.");
    }
  }
  if (
    descriptor.allowedRoles !== undefined &&
    !descriptor.allowedRoles.includes(context.actor.role.trim().toLowerCase())
  ) {
    return deny("actor_role_denied", "The actor role cannot invoke this semantic operation.");
  }
  if (descriptor.requiredClaims.some((claim) => !effectiveClaims.includes(claim))) {
    return deny("required_claim_missing", "The run lacks an explicit claim required by this operation.");
  }
  if (
    phase === "invocation" &&
    (context.task.assigneeActorId !== context.actor.id ||
      context.task.executionRunId !== context.runId ||
      context.task.checkoutRunId !== context.runId)
  ) {
    return deny("task_ownership_denied", "The run no longer owns the active task.");
  }
  if (
    phase === "invocation" &&
    !READ_OPERATIONS.has(descriptor.operationId) &&
    ["done", "cancelled"].includes(context.task.status)
  ) {
    return deny("task_state_denied", "The active task is already terminal.");
  }
  if (descriptor.operationId === "request_human_input" && input !== undefined) {
    const interactionKind = readStringProperty(input, "interactionKind");
    if (
      interactionKind !== undefined &&
      context.scenario.allowedInteractionKinds !== undefined &&
      !context.scenario.allowedInteractionKinds.includes(
        interactionKind as Parameters<NonNullable<typeof context.scenario.allowedInteractionKinds>["includes"]>[0],
      )
    ) {
      return deny("interaction_kind_denied", "The scenario does not allow this interaction kind.");
    }
  }
  return { ...base, allowed: true, code: "allowed", reason: "Explicit semantic policy allowed the operation." };
}

export function exposedCapabilitySemanticDescriptors(
  context: CapabilitySemanticPolicyContext,
): readonly CapabilitySemanticToolDescriptor[] {
  return CAPABILITY_SEMANTIC_TOOL_CATALOG.filter(
    (descriptor) => decideCapabilitySemanticAuthorization(descriptor, context, "exposure").allowed,
  );
}

function computeEffectiveClaims(context: CapabilitySemanticPolicyContext): string[] {
  const granted = new Set([
    ...context.actor.capabilityGrants,
    ...(context.scenario.claims ?? []),
  ]);
  const explicitlyDelegated = new Set(context.explicitClaims);
  return sortedUnique(
    context.runClaims.filter((claim) => granted.has(claim) && explicitlyDelegated.has(claim)),
  );
}

function readStringProperty(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
