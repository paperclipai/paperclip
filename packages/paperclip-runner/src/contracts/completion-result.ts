/** Provider-neutral semantic completion tools and their strict model-facing schemas. */
export const PRP_COMPLETION_TOOL_NAME = "paperclip_finish" as const;
export const PRP_BLOCK_TOOL_NAME = "paperclip_block" as const;
export const PRP_SEMANTIC_TOOL_NAMES = [
  PRP_COMPLETION_TOOL_NAME,
  PRP_BLOCK_TOOL_NAME,
] as const;

export const PRP_VERIFICATION_REASON_CODES = [
  "environment_unavailable",
  "tool_unavailable",
  "dependency_missing",
  "permission_denied",
  "credential_missing",
  "policy_restricted",
  "external_service_unavailable",
  "budget_exhausted",
  "other",
] as const;

export const PRP_ACTIONABLE_ATTENTION_KINDS = [
  "review",
  "human_input",
  "approval",
  "credential",
  "external_action",
  "agent_handoff",
] as const;

export const PRP_ATTENTION_OWNER_CLASSES = [
  "human",
  "agent",
  "external_system",
] as const;

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
  description:
    "Checks used to verify the work. Use failed only when the check actually ran and found a defect in the work. If a check could not run or complete because the environment, tool, dependency, permission, credential, policy, external service, or budget was unavailable, use not_run with reasonCode even when the attempted command exited non-zero.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["commandOrCheck", "status"],
    properties: {
      commandOrCheck: { type: "string", minLength: 1 },
      status: {
        enum: ["passed", "failed", "not_run"],
        description:
          "passed: the check ran and succeeded. failed: the check ran to a meaningful verdict and found the work incorrect. not_run: the check had no meaningful verdict because it was not attempted or an environment/tool/dependency/permission/credential/policy/service/budget limitation prevented it from completing; command launch or setup failures are not_run.",
      },
      reasonCode: {
        enum: [...PRP_VERIFICATION_REASON_CODES],
        description: "Required for not_run; identify why the check had no meaningful verdict.",
      },
      detail: { type: "string" },
      artifactRef: { type: "string", minLength: 1 },
    },
    allOf: [{
      if: { properties: { status: { const: "not_run" } }, required: ["status"] },
      then: { required: ["reasonCode"] },
    }],
  },
} as const;

const attentionRequestsSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "summary", "ownerClass"],
    properties: {
      kind: { enum: [...PRP_ACTIONABLE_ATTENTION_KINDS] },
      summary: { type: "string", minLength: 1 },
      ownerClass: { enum: [...PRP_ATTENTION_OWNER_CLASSES] },
      targetAgentId: { type: "string", minLength: 1 },
    },
    allOf: [{
      if: { properties: { ownerClass: { const: "agent" } }, required: ["ownerClass"] },
      then: { required: ["targetAgentId"] },
    }],
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

export const PRP_COMPLETION_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
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
  allOf: [
    {
      if: { properties: { reportedWorkDisposition: { const: "done" } }, required: ["reportedWorkDisposition"] },
      then: { properties: { attentionRequests: { maxItems: 0 } } },
    },
    {
      if: { properties: { reportedWorkDisposition: { const: "needs_review" } }, required: ["reportedWorkDisposition"] },
      then: { properties: { attentionRequests: { minItems: 1 } } },
    },
  ],
} as const;

export const PRP_BLOCK_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
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
    attentionRequests: { type: "array", maxItems: 0, items: attentionRequestsSchema.items },
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

const providerVerificationCompatibilitySchema = {
  type: "array",
  description:
    "Checks used to verify the work. Use failed only when the check actually ran and found a defect in the work. If a check could not run or complete because the environment, tool, dependency, permission, credential, policy, external service, or budget was unavailable, use not_run with reasonCode even when the attempted command exited non-zero.",
  items: {
    type: "object",
    additionalProperties: true,
    required: ["status"],
    properties: {
      commandOrCheck: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1 },
      status: {
        enum: ["passed", "failed", "not_run", "blocked", "skipped", "pass", "success", "succeeded", "fail"],
        description:
          "passed: the check ran and succeeded. failed: the check ran to a meaningful verdict and found the work incorrect. not_run: no meaningful verdict because the check was not attempted or could not complete. Prefer not_run over legacy blocked/skipped, and include reasonCode for any unavailable check.",
      },
      reasonCode: {
        enum: [...PRP_VERIFICATION_REASON_CODES],
        description: "Required for not_run; identify why the check had no meaningful verdict.",
      },
      detail: { type: "string" },
      result: { type: "string" },
      cwd: { type: "string" },
      artifactRef: { type: "string", minLength: 1 },
    },
  },
} as const;

const providerCompletionClaimCompatibilitySchema = {
  ...completionClaimSchema,
  properties: {
    ...completionClaimSchema.properties,
    criteria: {
      ...completionClaimSchema.properties.criteria,
      items: {
        ...completionClaimSchema.properties.criteria.items,
        properties: {
          ...completionClaimSchema.properties.criteria.items.properties,
          status: {
            enum: [
              "satisfied",
              "not_satisfied",
              "unknown",
              "pass",
              "passed",
              "complete",
              "completed",
              "fail",
              "failed",
              "incomplete",
            ],
            description:
              "Use satisfied when the criterion is met, not_satisfied when it is not met, or unknown when no verdict is available. Common provider aliases are accepted and normalized.",
          },
        },
      },
    },
  },
} as const;

const providerCommonResultProperties = {
  ...commonResultProperties,
  schema: {
    enum: [
      "paperclip.run_result.v1",
      "paperclip_finish",
      "paperclip_paperclip_finish",
      "paperclip_finish.v1",
    ],
  },
  completionClaim: providerCompletionClaimCompatibilitySchema,
} as const;

const providerAttentionCompatibilitySchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: true,
    required: ["kind", "summary"],
    properties: {
      kind: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
      ownerClass: { enum: [...PRP_ATTENTION_OWNER_CLASSES] },
      targetAgentId: { type: "string", minLength: 1 },
      requestedCapability: { type: "string", minLength: 1 },
      requiredAuthority: { type: "string", minLength: 1 },
      target: { type: "object", additionalProperties: true },
    },
  },
} as const;

/**
 * Provider-facing compatibility schemas. Canonical PRP validation still uses
 * the strict schemas above after legacy aliases have been normalized.
 */
export const PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: [
    "reportedWorkDisposition",
    "summary",
    "completionClaim",
    "evidence",
    "verification",
  ],
  properties: {
    ...providerCommonResultProperties,
    reportedWorkDisposition: { enum: ["done", "needs_review", "completed"] },
    verification: providerVerificationCompatibilitySchema,
    attentionRequests: providerAttentionCompatibilitySchema,
  },
} as const;

export const PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: [
    "reportedWorkDisposition",
    "summary",
    "completionClaim",
    "evidence",
    "verification",
    "blocker",
  ],
  properties: {
    ...providerCommonResultProperties,
    reportedWorkDisposition: { type: "string", const: "blocked" },
    verification: providerVerificationCompatibilitySchema,
    attentionRequests: providerAttentionCompatibilitySchema,
    blocker: PRP_BLOCK_RESULT_OUTPUT_SCHEMA.properties.blocker,
  },
} as const;
