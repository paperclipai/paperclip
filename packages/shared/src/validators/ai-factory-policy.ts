import { z } from "zod";

export const FACTORY_STAGE_TYPES = [
  "work",
  "verification",
  "review",
  "approval",
  "deployment",
] as const;

export const factoryPolicyStageV1Schema = z.object({
  key: z.string().trim().min(1).regex(/^[a-z][a-z0-9_-]*$/),
  type: z.enum(FACTORY_STAGE_TYPES),
  role: z.string().trim().min(1),
  independent: z.boolean().optional(),
  optionalWhen: z.enum(["production", "non_production"]).optional(),
}).strict();

export const factoryPolicyV1Schema = z.object({
  version: z.literal(1),
  extends: z.literal("paperclipai/paperclip/paperclip-ai-factory"),
  topology: z.object({
    defaultExecutionLanes: z.number().int().min(1).max(10),
    maxExecutionLanes: z.number().int().min(1).max(10),
    allowParallelLanes: z.boolean(),
    noGrandchildren: z.literal(true),
  }).strict(),
  roles: z.object({
    controlOwnerRole: z.string().trim().min(1),
    laneCoordinatorRole: z.string().trim().min(1),
  }).strict(),
  stages: z.array(factoryPolicyStageV1Schema).min(3).max(20),
  productionAuthority: z.object({
    mode: z.enum(["autonomous_unless_hold", "board_approval_required"]),
    requireCapabilityPreflightBeforeEscalation: z.boolean(),
    requireBoardApprovalForIrreversibleActions: z.boolean(),
  }).strict(),
  recovery: z.object({
    attemptMinutes: z.array(z.number().int().min(1).max(60)).min(1).max(3),
    maxAttemptsPerEvidenceFingerprint: z.number().int().min(1).max(3),
  }).strict(),
}).strict().superRefine((policy, context) => {
  // V1 creates one lane per typed request. Keep this field honest until a
  // server-owned bulk-lane transaction exists rather than accepting a value
  // that no runtime path consumes.
  if (policy.topology.defaultExecutionLanes !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["topology", "defaultExecutionLanes"],
      message: "AI Factory policy v1 supports exactly one default execution lane",
    });
  }
  if (policy.topology.defaultExecutionLanes > policy.topology.maxExecutionLanes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["topology", "defaultExecutionLanes"],
      message: "defaultExecutionLanes cannot exceed maxExecutionLanes",
    });
  }
  if (!policy.topology.allowParallelLanes && policy.topology.defaultExecutionLanes !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["topology", "defaultExecutionLanes"],
      message: "defaultExecutionLanes must be 1 when parallel lanes are disabled",
    });
  }

  const stageKeys = new Set<string>();
  for (const [index, stage] of policy.stages.entries()) {
    if (stageKeys.has(stage.key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", index, "key"],
        message: `Duplicate stage key: ${stage.key}`,
      });
    }
    stageKeys.add(stage.key);
  }
  const requiredStages = [
    { key: "contract", type: "work", independent: false, optionalWhen: undefined },
    { key: "implementation", type: "work", independent: false, optionalWhen: undefined },
    { key: "independent_qa", type: "verification", independent: true, optionalWhen: undefined },
    { key: "technical_acceptance", type: "review", independent: false, optionalWhen: undefined },
    { key: "deployment", type: "deployment", independent: false, optionalWhen: "production" },
    { key: "live_qa", type: "verification", independent: true, optionalWhen: "production" },
    { key: "final_acceptance", type: "approval", independent: false, optionalWhen: "production" },
  ] as const;
  let previousRequiredIndex = -1;
  for (const required of requiredStages) {
    const stageIndex = policy.stages.findIndex((stage) => stage.key === required.key);
    if (stageIndex < 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: `Missing required stage: ${required.key}`,
      });
      continue;
    }
    const stage = policy.stages[stageIndex]!;
    if (stageIndex <= previousRequiredIndex) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stageIndex, "key"],
        message: `Required stage is out of order: ${required.key}`,
      });
    }
    previousRequiredIndex = Math.max(previousRequiredIndex, stageIndex);
    if (stage.type !== required.type) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stageIndex, "type"],
        message: `${required.key} must use stage type ${required.type}`,
      });
    }
    if ((stage.independent ?? false) !== required.independent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stageIndex, "independent"],
        message: `${required.key} independent must be ${required.independent}`,
      });
    }
    if (stage.optionalWhen !== required.optionalWhen) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages", stageIndex, "optionalWhen"],
        message: required.optionalWhen
          ? `${required.key} must be conditional on ${required.optionalWhen}`
          : `${required.key} cannot be conditional`,
      });
    }
  }

  const attempts = policy.recovery.attemptMinutes;
  if (attempts.some((value, index) => index > 0 && value <= attempts[index - 1]!)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery", "attemptMinutes"],
      message: "attemptMinutes must be strictly increasing",
    });
  }
  if (policy.recovery.maxAttemptsPerEvidenceFingerprint > attempts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recovery", "maxAttemptsPerEvidenceFingerprint"],
      message: "maxAttemptsPerEvidenceFingerprint cannot exceed the retry schedule length",
    });
  }
});

export const companyAiFactoryPolicySelectSchema = z.object({
  skillId: z.string().uuid(),
}).strict();

export type FactoryPolicyV1Input = z.infer<typeof factoryPolicyV1Schema>;
export type CompanyAiFactoryPolicySelectInput = z.infer<typeof companyAiFactoryPolicySelectSchema>;
