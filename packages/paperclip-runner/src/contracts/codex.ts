import type {
  PrpCapabilities,
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import type { SessionSnapshot } from "../reducer/session-reducer.js";
import {
  PRP_BLOCK_RESULT_OUTPUT_SCHEMA,
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_NAME,
  PRP_SEMANTIC_TOOL_NAMES,
} from "./completion-result.js";

export const CODEX_TASK_ENVELOPE_SCHEMA = "paperclip.skillless_task.v1" as const;
export const CODEX_CODEX_PROTOCOL_VERSION = "v2" as const;
/** @deprecated Use the provider-neutral PRP completion contract exports. */
export const CODEX_COMPLETION_TOOL_NAME = PRP_COMPLETION_TOOL_NAME;
/** @deprecated Use the provider-neutral PRP completion contract exports. */
export const CODEX_BLOCK_TOOL_NAME = PRP_BLOCK_TOOL_NAME;
/** @deprecated Use the provider-neutral PRP completion contract exports. */
export const CODEX_SEMANTIC_TOOL_NAMES = PRP_SEMANTIC_TOOL_NAMES;
export const CODEX_SKILLLESS_BASE_INSTRUCTIONS =
  "Complete only the supplied task envelope. Do not discover or invoke skills. Do not call a control-plane API. Return exactly one semantic completion result; use paperclip_finish when the work is done or needs review, and paperclip_block only when work cannot continue." as const;

export interface CodexTaskEnvelope {
  schema: typeof CODEX_TASK_ENVELOPE_SCHEMA;
  objective: string;
  completionContract: {
    revision: string;
    criteria: Array<{ id: string; requirement: string }>;
  };
  constraints: string[];
  expectedResultSchema: "paperclip.run_result.v1";
}

export interface CodexModelContextSnapshot {
  protocolVersion: typeof CODEX_CODEX_PROTOCOL_VERSION;
  codexVersion: string;
  clientInfo: {
    name: "paperclip-runner";
    title: "Paperclip Runner";
    version: string;
  };
  model: string;
  modelProvider: string;
  workingDirectory: string;
  collaborationMode: "default" | "plan";
  sandbox: unknown;
  approvalPolicy: unknown;
  baseInstructions: string;
  instructionSources: string[];
  instructionPolicy: {
    skillInstructions: boolean;
    appInstructions: false;
    collaborationInstructions: boolean;
  };
  environmentKeys: string[];
  dynamicToolNames: string[];
  modelInputKinds: ["text"];
  liveConsole?: {
    conversationMode?: "task" | "direct";
    runtimeRequestResolution: boolean;
    goals: boolean;
    threadLineage: boolean;
  };
  envelope: CodexTaskEnvelope;
}

export interface CodexRunMetadata {
  schema: "paperclip.runner.codex.metadata.v1";
  fixtureName: string;
  identity: {
    schema: "paperclip.prp.identity.v1";
    companyId: string;
    issueId: string;
    runId: string;
    environmentLeaseId: string;
    runnerInstanceId: string;
    normalizedSessionId: string;
    driverSessionId?: string;
    providerSessionId?: string;
  };
  capabilities: PrpCapabilities;
}

export interface CodexRunTrace {
  schema: "paperclip.runner.codex.trace.v1";
  metadata: CodexRunMetadata;
  context: CodexModelContextSnapshot;
  events: PrpEvent[];
  proposedResult: unknown | null;
  result: PrpStructuredRunResult | null;
  resultDecision: CodexResultDecision;
  liveSnapshot: SessionSnapshot;
  replaySnapshot: SessionSnapshot;
  diagnostics: string[];
  assertions: {
    exactlyOneTerminalResult: boolean;
    proposalAccepted: boolean;
    liveReplayParity: boolean;
    stableIdentity: boolean;
    sourceSequenceContinuous: boolean;
    stableItemIdentity: boolean;
    contextIsSkillless: boolean;
    unrelatedSkillsAbsent: boolean;
    credentialsAbsent: boolean;
  };
}

export interface CodexResultValidationIssue {
  code:
    | "schema_validation"
    | "contract_revision_mismatch"
    | "unknown_criterion"
    | "missing_criterion"
    | "duplicate_criterion"
    | "invalid_disposition";
  path: string;
  message: string;
}

export type CodexResultDecision =
  | { status: "accepted"; result: PrpStructuredRunResult; issues: [] }
  | { status: "rejected"; result: null; issues: CodexResultValidationIssue[] };

export function createCodexTaskEnvelope(input: {
  objective: string;
  contractRevision?: string;
  criteria?: Array<{ id: string; requirement: string }>;
  constraints?: string[];
}): CodexTaskEnvelope {
  return {
    schema: CODEX_TASK_ENVELOPE_SCHEMA,
    objective: input.objective,
    completionContract: {
      revision: input.contractRevision ?? "codex-demo-v1",
      criteria:
        input.criteria ?? [{ id: "objective", requirement: "Complete the objective safely." }],
    },
    constraints: input.constraints ?? [
      "Work only inside the supplied working directory.",
      "Do not discover or invoke skills.",
      "Do not call a control-plane API.",
      "Return one semantic completion result.",
    ],
    expectedResultSchema: "paperclip.run_result.v1",
  };
}

/** @deprecated Use PRP_COMPLETION_RESULT_OUTPUT_SCHEMA. */
export const CODEX_RESULT_OUTPUT_SCHEMA = PRP_COMPLETION_RESULT_OUTPUT_SCHEMA;
/** @deprecated Use PRP_BLOCK_RESULT_OUTPUT_SCHEMA. */
export const CODEX_BLOCK_RESULT_OUTPUT_SCHEMA = PRP_BLOCK_RESULT_OUTPUT_SCHEMA;
export const CODEX_RESULT_PROVIDER_INPUT_SCHEMA = PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA;
export const CODEX_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA = PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA;

export function isSkilllessCodexContext(
  context: CodexModelContextSnapshot,
  options: { dynamicTools: boolean } = { dynamicTools: true },
): boolean {
  const serialized = JSON.stringify(context).toLowerCase();
  const expectedTools = options.dynamicTools ? [...CODEX_SEMANTIC_TOOL_NAMES] : [];
  return (
    context.instructionSources.length === 0 &&
    context.baseInstructions === CODEX_SKILLLESS_BASE_INSTRUCTIONS &&
    context.modelInputKinds.length === 1 &&
    context.modelInputKinds[0] === "text" &&
    context.dynamicToolNames.length === expectedTools.length &&
    context.dynamicToolNames.every((name) =>
      expectedTools.includes(name as (typeof expectedTools)[number]),
    ) &&
    context.instructionPolicy.skillInstructions === false &&
    context.instructionPolicy.appInstructions === false &&
    !serialized.includes("paperclip_api_key") &&
    !serialized.includes("authorization: bearer") &&
    !serialized.includes("/api/issues/") &&
    !serialized.includes('"type":"skill"')
  );
}
