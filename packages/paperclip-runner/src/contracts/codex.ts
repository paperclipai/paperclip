import type {
  PrpCapabilities,
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import type { SessionSnapshot } from "../reducer/session-reducer.js";

export const CODEX_TASK_ENVELOPE_SCHEMA = "paperclip.skillless_task.v1" as const;
export const CODEX_CODEX_PROTOCOL_VERSION = "v2" as const;
export const CODEX_COMPLETION_TOOL_NAME = "paperclip_finish" as const;
export const CODEX_BLOCK_TOOL_NAME = "paperclip_block" as const;
export const CODEX_SEMANTIC_TOOL_NAMES = [
  CODEX_COMPLETION_TOOL_NAME,
  CODEX_BLOCK_TOOL_NAME,
] as const;
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
  sandbox: unknown;
  approvalPolicy: unknown;
  baseInstructions: string;
  instructionSources: string[];
  instructionPolicy: {
    skillInstructions: false;
    appInstructions: false;
    collaborationInstructions: false;
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

/**
 * Strict provider-facing subset of the wider PRP result schema.
 *
 * OpenAI structured outputs require every object to reject additional
 * properties. The accepted value is still validated against the canonical PRP
 * schema before it is committed as a semantic result.
 */
const completionClaimSchema = {
  type: "object",
  additionalProperties: false,
  required: ["contractRevision", "objectiveSatisfied", "criteria", "remainingWork"],
  properties: {
    contractRevision: { type: "string", minLength: 1 },
    objectiveSatisfied: { type: "boolean" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "status", "evidenceRefs"],
        properties: {
          criterionId: { type: "string", minLength: 1 },
          status: { enum: ["satisfied", "not_satisfied", "unknown"] },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    remainingWork: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "blocksCompletion"],
        properties: {
          description: { type: "string", minLength: 1 },
          blocksCompletion: { type: "boolean" },
        },
      },
    },
  },
} as const;

const evidenceSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["ref"],
    properties: { ref: { type: "string", minLength: 1 } },
  },
} as const;

const verificationSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["commandOrCheck", "status"],
    properties: {
      commandOrCheck: { type: "string", minLength: 1 },
      status: { enum: ["passed", "failed", "not_run"] },
    },
  },
} as const;

const attentionRequestsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary"],
    properties: {
      kind: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
    },
  },
} as const;

const artifactsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "ref"],
    properties: {
      kind: { type: "string", minLength: 1 },
      ref: { type: "string", minLength: 1 },
    },
  },
} as const;

const commonResultProperties = {
  schema: { type: "string", const: "paperclip.run_result.v1" },
  summary: { type: "string", minLength: 1 },
  completionClaim: completionClaimSchema,
  evidence: evidenceSchema,
  verification: verificationSchema,
  attentionRequests: attentionRequestsSchema,
  artifacts: artifactsSchema,
} as const;

export const CODEX_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "reportedWorkDisposition",
    "summary",
    "completionClaim",
    "evidence",
    "verification",
    "attentionRequests",
    "artifacts",
  ],
  properties: {
    ...commonResultProperties,
    reportedWorkDisposition: { enum: ["done", "needs_review"] },
  },
} as const;

export const CODEX_BLOCK_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "reportedWorkDisposition",
    "summary",
    "completionClaim",
    "evidence",
    "verification",
    "attentionRequests",
    "artifacts",
    "blocker",
  ],
  properties: {
    ...commonResultProperties,
    reportedWorkDisposition: { type: "string", const: "blocked" },
    blocker: {
      type: "object",
      additionalProperties: false,
      required: ["reasonCode", "owner", "unblockAction", "scope"],
      properties: {
        reasonCode: { type: "string", minLength: 1 },
        owner: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "name"],
          properties: {
            kind: { enum: ["agent", "user", "system", "external"] },
            name: { type: "string", minLength: 1 },
          },
        },
        unblockAction: { type: "string", minLength: 1 },
        scope: { enum: ["current_track", "task_wide"] },
      },
    },
  },
} as const;

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
    context.instructionPolicy.collaborationInstructions === false &&
    !serialized.includes("paperclip_api_key") &&
    !serialized.includes("authorization: bearer") &&
    !serialized.includes("/api/issues/") &&
    !serialized.includes('"type":"skill"')
  );
}
