import { capabilitySemanticTool, CAPABILITY_SEMANTIC_TOOL_CATALOG } from "./capability-semantic-tool-catalog.js";
import {
  CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS,
  type CapabilityAuthorizationRecord,
  type CapabilityJsonValue,
  type CapabilitySemanticToolDescriptor,
  type CapabilityToolAuthorizationContext,
  type CapabilityVisibleToolSet,
} from "./capability-semantic-tool-types.js";

export class CapabilityToolAuthorizationEngine {
  #sequence = 0;
  readonly #records: CapabilityAuthorizationRecord[] = [];

  computeVisibleTools(context: CapabilityToolAuthorizationContext): CapabilityVisibleToolSet {
    const tools: CapabilitySemanticToolDescriptor[] = [];
    const authorizationRecords = CAPABILITY_SEMANTIC_TOOL_CATALOG.map((tool) => {
      const decision = this.#evaluate(tool, context, undefined);
      const record = this.#record(context, tool, "exposure", decision.allowed ? "exposed" : "absent", decision.reason);
      if (decision.allowed) tools.push(tool);
      return record;
    });
    return deepFreeze({
      schema: "paperclip.capability.visible-tools.v1",
      tools: clone(tools),
      authorizationRecords,
    });
  }

  authorizeInvocation(
    operationId: string,
    input: CapabilityJsonValue,
    context: CapabilityToolAuthorizationContext,
  ): CapabilityAuthorizationRecord {
    if ((CAPABILITY_CONTROL_PLANE_OWNED_OPERATION_IDS as readonly string[]).includes(operationId)) {
      return this.#recordUnknown(context, operationId, "absent", "control_plane_owned_operation");
    }
    const tool = capabilitySemanticTool(operationId);
    if (tool === undefined) {
      return this.#recordUnknown(context, operationId, "absent", "unknown_operation");
    }
    const decision = this.#evaluate(tool, context, input);
    return this.#record(
      context,
      tool,
      "invocation",
      decision.allowed ? "allowed" : "denied",
      decision.reason,
    );
  }

  denyInvocation(
    operationId: string,
    context: CapabilityToolAuthorizationContext,
    reason: string,
  ): CapabilityAuthorizationRecord {
    const tool = capabilitySemanticTool(operationId);
    return tool === undefined
      ? this.#recordUnknown(context, operationId, "absent", reason)
      : this.#record(context, tool, "invocation", "denied", reason);
  }

  attachStateChange(
    sequence: number,
    beforeRevision: number,
    afterRevision: number,
    entityRefs: string[],
  ): CapabilityAuthorizationRecord {
    const record = this.#records.find((candidate) => candidate.sequence === sequence);
    if (record === undefined || record.outcome !== "allowed") {
      throw new Error(`cannot attach state change to authorization record ${sequence}`);
    }
    record.resultingStateChange = {
      beforeRevision,
      afterRevision,
      entityRefs: [...entityRefs].sort(),
    };
    return deepFreeze(clone(record));
  }

  records(): readonly CapabilityAuthorizationRecord[] {
    return deepFreeze(clone(this.#records));
  }

  #evaluate(
    tool: CapabilitySemanticToolDescriptor,
    context: CapabilityToolAuthorizationContext,
    input: CapabilityJsonValue | undefined,
  ): { allowed: boolean; reason: string } {
    const policy = context.policy ?? {};
    if (policy.deniedOperationIds?.includes(tool.operationId)) {
      return { allowed: false, reason: "operation_denied_by_policy" };
    }
    if (!tool.taskModes.includes(context.task.workMode)) {
      return { allowed: false, reason: "operation_not_available_in_task_mode" };
    }
    if (
      tool.allowedRoles !== undefined &&
      !tool.allowedRoles.map(normalize).includes(normalize(context.actor.role))
    ) {
      return { allowed: false, reason: "actor_role_not_authorized" };
    }
    const deniedClaims = new Set(policy.deniedClaims ?? []);
    if (tool.requiredClaims.some((claim) => deniedClaims.has(claim))) {
      return { allowed: false, reason: "required_claim_denied_by_policy" };
    }
    const grants = new Set([...context.actor.capabilityGrants, ...context.scenarioGrants]);
    if (tool.requiredClaims.some((claim) => !grants.has(claim))) {
      return { allowed: false, reason: "required_claim_missing" };
    }
    if (tool.operationId === "read_secret_value" && policy.allowSecretValueAccess !== true) {
      return { allowed: false, reason: "secret_value_access_disabled" };
    }
    if (tool.operationId === "generic_api_request") {
      if (policy.allowGenericEscapeHatch !== true) {
        return { allowed: false, reason: "generic_escape_hatch_disabled" };
      }
      if (input !== undefined && !genericRequestAllowed(input, policy.genericEscapeHatchAllowlist ?? [])) {
        return { allowed: false, reason: "generic_escape_hatch_target_denied" };
      }
    }
    if (tool.operationId === "request_human_input" && input !== undefined) {
      const interactionKind = objectValue(input)?.interactionKind;
      if (
        typeof interactionKind === "string" &&
        policy.allowedInteractionKinds !== undefined &&
        !policy.allowedInteractionKinds.includes(interactionKind as never)
      ) {
        return { allowed: false, reason: "interaction_kind_denied_by_policy" };
      }
    }
    return {
      allowed: true,
      reason: tool.disposition === "always_agent_tool" ? "task_scoped_always_tool" : "required_claims_granted",
    };
  }

  #record(
    context: CapabilityToolAuthorizationContext,
    tool: CapabilitySemanticToolDescriptor,
    phase: CapabilityAuthorizationRecord["phase"],
    outcome: CapabilityAuthorizationRecord["outcome"],
    reason: string,
  ): CapabilityAuthorizationRecord {
    const grants = [...new Set([...context.actor.capabilityGrants, ...context.scenarioGrants])].sort();
    const consideredClaims = [...tool.requiredClaims].sort();
    return this.#store({
      schema: "paperclip.capability.authorization-record.v1",
      sequence: ++this.#sequence,
      runId: context.runId,
      actorId: context.actor.id,
      taskId: context.task.id,
      operationId: tool.operationId,
      phase,
      outcome,
      consideredClaims,
      grantedClaims: consideredClaims.filter((claim) => grants.includes(claim)),
      missingClaims: consideredClaims.filter((claim) => !grants.includes(claim)),
      reason,
      redactions: tool.redaction.map(({ path, replacement }) => ({ path, replacement })),
      resultingStateChange: null,
    });
  }

  #recordUnknown(
    context: CapabilityToolAuthorizationContext,
    operationId: string,
    outcome: "absent" | "denied",
    reason: string,
  ): CapabilityAuthorizationRecord {
    return this.#store({
      schema: "paperclip.capability.authorization-record.v1",
      sequence: ++this.#sequence,
      runId: context.runId,
      actorId: context.actor.id,
      taskId: context.task.id,
      operationId,
      phase: "invocation",
      outcome,
      consideredClaims: [],
      grantedClaims: [],
      missingClaims: [],
      reason,
      redactions: [],
      resultingStateChange: null,
    });
  }

  #store(record: CapabilityAuthorizationRecord): CapabilityAuthorizationRecord {
    this.#records.push(record);
    return deepFreeze(clone(record));
  }
}

function genericRequestAllowed(
  input: CapabilityJsonValue,
  allowlist: Array<{ method: string; path: string }>,
): boolean {
  const object = objectValue(input);
  if (object === undefined || typeof object.method !== "string" || typeof object.path !== "string") {
    return false;
  }
  const method = object.method.toUpperCase();
  return allowlist.some(
    (entry) => entry.method.toUpperCase() === method && pathMatches(entry.path, object.path as string),
  );
}

function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.endsWith("*")) return pattern === path;
  return path.startsWith(pattern.slice(0, -1));
}

function objectValue(value: CapabilityJsonValue): Record<string, CapabilityJsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
