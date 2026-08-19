import type { PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";

export const NATIVE_EXECUTION_INPUT_SCHEMA = "paperclip.native-execution-input.v1" as const;
export const NATIVE_MODEL_ENVELOPE_SCHEMA = "paperclip.native-model-envelope.v1" as const;

export interface StrictCompletionContractInput {
  revision: string;
  objective: string;
  criteria: Array<{ id: string; requirement: string }>;
}

export interface NativeInteractionResponseEnvelope {
  interactionId: string;
  kind: "request_confirmation" | "ask_user_questions";
  response: Record<string, unknown>;
}

export interface NativeCredentialBindingRef {
  bindingId: string;
  service: string;
  destination: string;
  expiresAt: string | null;
  displayName: string | null;
}

export interface NativeExecutionInputV1 {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA;
  binding: {
    companyId: string;
    runId: string;
    issueId: string;
    agentId: string;
    executionWorkspaceId: string;
  };
  task: {
    identifier: string;
    title: string;
    description: string | null;
    workMode: "standard";
  };
  workspace: {
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  session: {
    normalizedSessionId: string | null;
    driverKind: "codex_app_server";
    protocolVersion: 1;
  };
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  interactionResponses: NativeInteractionResponseEnvelope[];
  credentialBindings: NativeCredentialBindingRef[];
}

/** The only task data that may enter provider-visible model input. */
export interface NativeModelEnvelopeV1 {
  schema: typeof NATIVE_MODEL_ENVELOPE_SCHEMA;
  task: NativeExecutionInputV1["task"];
  workspace: Pick<NativeExecutionInputV1["workspace"], "cwd">;
  completionContract: StrictCompletionContractInput;
  interactionResponses: NativeInteractionResponseEnvelope[];
}

export interface NativeSessionExecutionResult {
  result: PrpStructuredRunResult;
  terminal: PrpTerminalState;
  turnId: string | null;
  normalizedSessionId: string;
  providerSessionId: string | null;
  driverKind: string;
  driverVersion: string;
  nativeEventCount: number;
  highestContiguousSourceSeq: number;
  usage: Record<string, unknown> | null;
}

export class NativeExecutionInputError extends Error {
  readonly code = "native_execution_input_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "NativeExecutionInputError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeExecutionInputError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NativeExecutionInputError(`${path} contains unknown field ${unknown[0]}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NativeExecutionInputError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

/**
 * Strictly validates the closed Paperclip-to-runner launch contract. This is
 * intentionally not an extensible metadata bag: new fields require a contract
 * revision and an explicit security review.
 */
export function parseNativeExecutionInput(value: unknown): NativeExecutionInputV1 {
  const input = record(value, "input");
  exactKeys(input, [
    "schema",
    "binding",
    "task",
    "workspace",
    "session",
    "completionContract",
    "interactionResponses",
    "credentialBindings",
  ], "input");
  if (input.schema !== NATIVE_EXECUTION_INPUT_SCHEMA) {
    throw new NativeExecutionInputError(`input.schema must be ${NATIVE_EXECUTION_INPUT_SCHEMA}`);
  }

  const binding = record(input.binding, "input.binding");
  exactKeys(binding, ["companyId", "runId", "issueId", "agentId", "executionWorkspaceId"], "input.binding");
  const task = record(input.task, "input.task");
  exactKeys(task, ["identifier", "title", "description", "workMode"], "input.task");
  const workspace = record(input.workspace, "input.workspace");
  exactKeys(workspace, ["cwd", "repoUrl", "repoRef", "branchName"], "input.workspace");
  const session = record(input.session, "input.session");
  exactKeys(session, ["normalizedSessionId", "driverKind", "protocolVersion"], "input.session");
  const completionContract = record(input.completionContract, "input.completionContract");
  exactKeys(completionContract, ["id", "sha256", "schemaVersion", "contract"], "input.completionContract");
  const contract = record(completionContract.contract, "input.completionContract.contract");
  exactKeys(contract, ["revision", "objective", "criteria"], "input.completionContract.contract");

  if (task.workMode !== "standard") throw new NativeExecutionInputError("input.task.workMode must be standard");
  if (session.driverKind !== "codex_app_server" || session.protocolVersion !== 1) {
    throw new NativeExecutionInputError("input.session must select codex_app_server protocol version 1");
  }
  if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) {
    throw new NativeExecutionInputError("input.completionContract.contract.criteria must not be empty");
  }
  const criteria = contract.criteria.map((entry, index) => {
    const criterion = record(entry, `input.completionContract.contract.criteria[${index}]`);
    exactKeys(criterion, ["id", "requirement"], `input.completionContract.contract.criteria[${index}]`);
    return { id: text(criterion.id, `criteria[${index}].id`), requirement: text(criterion.requirement, `criteria[${index}].requirement`) };
  });

  if (!Array.isArray(input.interactionResponses) || !Array.isArray(input.credentialBindings)) {
    throw new NativeExecutionInputError("interactionResponses and credentialBindings must be arrays");
  }
  const interactionResponses = input.interactionResponses.map((entry, index) => {
    const response = record(entry, `input.interactionResponses[${index}]`);
    exactKeys(response, ["interactionId", "kind", "response"], `input.interactionResponses[${index}]`);
    if (response.kind !== "request_confirmation" && response.kind !== "ask_user_questions") {
      throw new NativeExecutionInputError(`input.interactionResponses[${index}].kind is unsupported`);
    }
    const kind: NativeInteractionResponseEnvelope["kind"] = response.kind;
    return {
      interactionId: text(response.interactionId, `input.interactionResponses[${index}].interactionId`),
      kind,
      response: structuredClone(record(response.response, `input.interactionResponses[${index}].response`)),
    };
  });
  const credentialBindings = input.credentialBindings.map((entry, index) => {
    const bindingRef = record(entry, `input.credentialBindings[${index}]`);
    exactKeys(bindingRef, ["bindingId", "service", "destination", "expiresAt", "displayName"], `input.credentialBindings[${index}]`);
    return {
      bindingId: text(bindingRef.bindingId, `credentialBindings[${index}].bindingId`),
      service: text(bindingRef.service, `credentialBindings[${index}].service`),
      destination: text(bindingRef.destination, `credentialBindings[${index}].destination`),
      expiresAt: nullableText(bindingRef.expiresAt, `credentialBindings[${index}].expiresAt`),
      displayName: nullableText(bindingRef.displayName, `credentialBindings[${index}].displayName`),
    };
  });

  return {
    schema: NATIVE_EXECUTION_INPUT_SCHEMA,
    binding: {
      companyId: text(binding.companyId, "input.binding.companyId"),
      runId: text(binding.runId, "input.binding.runId"),
      issueId: text(binding.issueId, "input.binding.issueId"),
      agentId: text(binding.agentId, "input.binding.agentId"),
      executionWorkspaceId: text(binding.executionWorkspaceId, "input.binding.executionWorkspaceId"),
    },
    task: {
      identifier: text(task.identifier, "input.task.identifier"),
      title: text(task.title, "input.task.title"),
      description: nullableText(task.description, "input.task.description"),
      workMode: "standard",
    },
    workspace: {
      cwd: text(workspace.cwd, "input.workspace.cwd"),
      repoUrl: nullableText(workspace.repoUrl, "input.workspace.repoUrl"),
      repoRef: nullableText(workspace.repoRef, "input.workspace.repoRef"),
      branchName: nullableText(workspace.branchName, "input.workspace.branchName"),
    },
    session: {
      normalizedSessionId: nullableText(session.normalizedSessionId, "input.session.normalizedSessionId"),
      driverKind: "codex_app_server",
      protocolVersion: 1,
    },
    completionContract: {
      id: text(completionContract.id, "input.completionContract.id"),
      sha256: text(completionContract.sha256, "input.completionContract.sha256"),
      schemaVersion: text(completionContract.schemaVersion, "input.completionContract.schemaVersion"),
      contract: {
        revision: text(contract.revision, "input.completionContract.contract.revision"),
        objective: text(contract.objective, "input.completionContract.contract.objective"),
        criteria,
      },
    },
    interactionResponses,
    credentialBindings,
  };
}

export function buildNativeModelEnvelope(input: NativeExecutionInputV1): NativeModelEnvelopeV1 {
  return {
    schema: NATIVE_MODEL_ENVELOPE_SCHEMA,
    task: structuredClone(input.task),
    workspace: { cwd: input.workspace.cwd },
    completionContract: structuredClone(input.completionContract.contract),
    interactionResponses: structuredClone(input.interactionResponses),
  };
}
