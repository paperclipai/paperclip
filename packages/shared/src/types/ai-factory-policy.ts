export type FactoryStageType = "work" | "verification" | "review" | "approval" | "deployment";

export type FactoryStageCondition = "production" | "non_production";

export interface FactoryPolicyStageV1 {
  key: string;
  type: FactoryStageType;
  role: string;
  independent?: boolean;
  optionalWhen?: FactoryStageCondition;
}

export interface FactoryPolicyV1 {
  version: 1;
  extends: "paperclipai/paperclip/paperclip-ai-factory";
  topology: {
    defaultExecutionLanes: number;
    maxExecutionLanes: number;
    allowParallelLanes: boolean;
    noGrandchildren: true;
  };
  roles: {
    controlOwnerRole: string;
    laneCoordinatorRole: string;
  };
  stages: FactoryPolicyStageV1[];
  productionAuthority: {
    mode: "autonomous_unless_hold" | "board_approval_required";
    requireCapabilityPreflightBeforeEscalation: boolean;
    requireBoardApprovalForIrreversibleActions: boolean;
  };
  recovery: {
    attemptMinutes: number[];
    maxAttemptsPerEvidenceFingerprint: number;
  };
}

export interface FactoryPolicyServerInvariantsV1 {
  appendOnlyEvidence: true;
  generatedProseIsAdvisory: true;
  explicitHoldsStopMutation: true;
  noGrandchildren: true;
  recoveryDeduplicatedByEvidenceFingerprint: true;
}

export interface CompiledFactoryPolicyV1 {
  version: 1;
  skillKey: string;
  contentHash: string;
  policy: FactoryPolicyV1;
  serverInvariants: FactoryPolicyServerInvariantsV1;
  precedence: readonly [
    "server_invariants",
    "issue_contract",
    "company_policy",
    "agent_skills",
  ];
}

export interface CompanyAiFactoryPolicyView {
  baseSkillKey: "paperclipai/paperclip/paperclip-ai-factory";
  overlaySkillKey: string;
  overlaySkillId: string;
  overlaySkillName: string;
  compiled: CompiledFactoryPolicyV1;
  defaultPolicy: FactoryPolicyV1;
  differsFromDefault: boolean;
}

export interface CompanyAiFactoryPolicySelectRequest {
  skillId: string;
}
