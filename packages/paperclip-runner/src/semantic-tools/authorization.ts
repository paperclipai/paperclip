import type { PaperclipSemanticActionDescriptor } from "../catalog/semantic-action-types.js";
import type {
  PaperclipSemanticAuthorizationDecision,
  PaperclipSemanticAuthorizationPhase,
  PaperclipSemanticDenialCode,
  PaperclipSemanticRunContext,
} from "./types.js";

const TERMINAL_TASK_STATES = new Set(["done", "cancelled", "canceled"]);

export function decidePaperclipSemanticAuthorization(
  descriptor: PaperclipSemanticActionDescriptor,
  context: PaperclipSemanticRunContext,
  phase: PaperclipSemanticAuthorizationPhase,
  requestedRunId: string,
  input?: unknown,
): PaperclipSemanticAuthorizationDecision {
  if (!validAuthorityContext(context, requestedRunId)) {
    return {
      allowed: false,
      phase,
      operationId: descriptor.operationId,
      code: "authority_context_invalid",
      reason: "The run authority context is malformed.",
      effectiveClaims: [],
    };
  }
  const effectiveClaims = intersectClaims(
    context.actor.claims,
    context.delegatedClaims,
  );
  const base = {
    phase,
    operationId: descriptor.operationId,
    effectiveClaims,
  } as const;
  const deny = (
    code: PaperclipSemanticDenialCode,
    reason: string,
  ): PaperclipSemanticAuthorizationDecision => ({
    ...base,
    allowed: false,
    code,
    reason,
  });

  if (context.runId !== requestedRunId) {
    return deny(
      "run_mismatch",
      "The authority context belongs to another run.",
    );
  }
  if (
    context.actor.companyId !== context.companyId ||
    context.activeTask.companyId !== context.companyId
  ) {
    return deny(
      "company_mismatch",
      "The actor and active task must belong to the run company.",
    );
  }
  if (context.actor.status !== "active") {
    return deny("actor_inactive", "The run actor is not active.");
  }
  if (context.activeTask.assigneeActorId !== context.actor.id) {
    return deny(
      "task_ownership_denied",
      "The run actor no longer owns the active task.",
    );
  }
  if (context.activeTask.executionRunId !== context.runId) {
    return deny(
      "task_ownership_denied",
      "The active task is no longer bound to this run.",
    );
  }
  if (!descriptor.allowedModes.includes(context.activeTask.workMode)) {
    return deny(
      "task_mode_denied",
      "The action is unavailable in the active task mode.",
    );
  }
  if (
    descriptor.effect !== "read" &&
    TERMINAL_TASK_STATES.has(context.activeTask.status)
  ) {
    return deny("task_state_denied", "The active task is already terminal.");
  }
  if (
    context.policy?.deniedOperationIds?.includes(descriptor.operationId) ===
    true
  ) {
    return deny("policy_denied", "Run policy denies this action.");
  }
  if (
    descriptor.allowedRoles !== undefined &&
    !descriptor.allowedRoles
      .map(normalize)
      .includes(normalize(context.actor.role))
  ) {
    return deny("actor_role_denied", "The actor role cannot use this action.");
  }
  if (
    descriptor.requiredClaims.some(
      (required) => !effectiveClaims.includes(required),
    )
  ) {
    return deny(
      "required_claim_missing",
      "The run lacks an explicitly delegated actor claim required by this action.",
    );
  }
  if (
    phase === "invocation" &&
    descriptor.operationId === "request_human_input" &&
    context.policy?.allowedInteractionKinds !== undefined
  ) {
    const interactionKind = stringProperty(input, "interactionKind");
    if (
      interactionKind !== undefined &&
      !context.policy.allowedInteractionKinds.includes(interactionKind)
    ) {
      return deny(
        "interaction_kind_denied",
        "Run policy denies this interaction kind.",
      );
    }
  }

  return {
    ...base,
    allowed: true,
    code: "allowed",
    reason: "The current run authority allows this action.",
  };
}

function validAuthorityContext(
  context: unknown,
  requestedRunId: string,
): context is PaperclipSemanticRunContext {
  if (
    !isRecord(context) ||
    !isRecord(context.actor) ||
    !isRecord(context.activeTask) ||
    (context.policy !== undefined && !isRecord(context.policy))
  ) {
    return false;
  }
  const actor = context.actor;
  const task = context.activeTask;
  const policy = context.policy;
  const stableIds = [
    requestedRunId,
    context.runId,
    context.companyId,
    actor.id,
    actor.companyId,
    task.id,
    task.companyId,
    ...(task.assigneeActorId === null ? [] : [task.assigneeActorId]),
    ...(task.executionRunId === null ? [] : [task.executionRunId]),
  ];
  return (
    stableIds.every(isStableId) &&
    isBoundedString(actor.status) &&
    isBoundedString(actor.role) &&
    isBoundedString(task.status) &&
    isBoundedString(task.workMode) &&
    validStringList(actor.claims) &&
    validStringList(context.delegatedClaims) &&
    (policy?.deniedOperationIds === undefined ||
      validStringList(policy.deniedOperationIds)) &&
    (policy?.allowedInteractionKinds === undefined ||
      validStringList(policy.allowedInteractionKinds))
  );
}

function isStableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function validStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1_000 &&
    value.every(isBoundedString)
  );
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 240;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intersectClaims(
  actorClaims: readonly string[],
  delegatedClaims: readonly string[],
): readonly string[] {
  const actor = new Set(actorClaims);
  return Object.freeze(
    [...new Set(delegatedClaims)]
      .filter((claim) => actor.has(claim))
      .sort((left, right) => left.localeCompare(right)),
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
