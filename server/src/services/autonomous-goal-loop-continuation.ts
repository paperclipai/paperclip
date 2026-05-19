import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  evaluateMissionControlAutonomousLoopGate,
  evaluateMissionControlCompletionGate,
  MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY,
  type MissionControlAutonomousLoopCeoApproval,
  type MissionControlAutonomousLoopReportEvent,
  type MissionControlAutonomousLoopUserApproval,
  type MissionControlCeoLoopDecision,
  type MissionControlCompletionGateDocument,
  type MissionControlCompletionGateResult,
  type MissionControlIssuePolicy,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { listMissionControlCompletionDocuments } from "./mission-control-gates.js";

export const AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND = "autonomous_goal_loop_iteration";
export const AUTONOMOUS_GOAL_LOOP_CONTINUATION_DOCUMENT_KEY = MISSION_CONTROL_AUTONOMOUS_LOOP_DOCUMENT_KEY;

const MAX_CONTINUATION_TITLE_LENGTH = 240;

type MissionControlCompletionGateReason = MissionControlCompletionGateResult["reason"];

type AutonomousGoalLoopContinuationReason =
  | MissionControlCompletionGateReason
  | "not_next_iteration"
  | "unsafe_next_task"
  | "ceo_self_attestation_conflict";

type MissionControlCeoLoopNextTask = NonNullable<MissionControlCeoLoopDecision["nextTask"]>;

type AutonomousGoalLoopParentIssue = {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  identifier?: string | null;
  title: string;
  priority: string;
  status?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number | null;
  executionPolicy?: unknown;
};

type AutonomousGoalLoopChildIssue = {
  id: string;
  parentId?: string | null;
  identifier?: string | null;
  title: string;
  status?: string | null;
  originKind?: string | null;
  originId?: string | null;
  originFingerprint?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type AutonomousGoalLoopActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type AutonomousGoalLoopChildInput = {
  title: string;
  description: string;
  status: "todo";
  workMode: "standard";
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  acceptanceCriteria: string[];
  blockParentUntilDone: boolean;
  originKind: string;
  originId: string;
  originFingerprint: string;
  executionPolicy: { missionControl: MissionControlIssuePolicy } | null;
};

export type AutonomousGoalLoopContinuationPlan =
  | {
      action: "ignore" | "wait" | "report" | "blocked";
      reason: AutonomousGoalLoopContinuationReason;
      reportToUser: boolean;
      gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
      ceoLoopDecision: MissionControlCeoLoopDecision | null;
    }
  | {
      action: "create_child";
      reason: "next_iteration";
      reportToUser: false;
      gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
      ceoLoopDecision: MissionControlCeoLoopDecision;
      originKind: string;
      originId: string;
      originFingerprint: string;
      childInput: AutonomousGoalLoopChildInput;
    };

export type AutonomousGoalLoopContinuationOutcome =
  | {
      outcome: "ignored" | "waiting" | "report_required" | "blocked";
      reason: AutonomousGoalLoopContinuationReason;
      reportToUser: boolean;
      plan: AutonomousGoalLoopContinuationPlan;
    }
  | {
      outcome: "already_exists" | "created";
      reason: "next_iteration";
      reportToUser: false;
      plan: Extract<AutonomousGoalLoopContinuationPlan, { action: "create_child" }>;
      childIssue: typeof issues.$inferSelect;
      parentBlockerAdded: boolean;
    };

export type AutonomousGoalLoopState =
  | {
      enabled: false;
      status: "disabled";
    }
  | {
      enabled: true;
      status:
        | "planning"
        | "executing"
        | "validating"
        | "ceo_review"
        | "goal_reached"
        | "partial_completion"
        | "blocked"
        | "approval_required"
        | "failed";
      goal: string | null;
      iteration: number;
      maxIterations: number | null;
      progressLabel: string;
      currentDecision: {
        iteration: number;
        decision: MissionControlCeoLoopDecision["decision"];
        decisionWrittenAt: string | null;
        rationale: string;
        nextTaskTitle: string | null;
        hardGate: MissionControlCeoLoopDecision["hardGate"];
        evidence: string[];
      } | null;
      planner: {
        mode: "single_child";
        supportsParallelChildren: false;
        nextTaskTitle: string | null;
        originFingerprint: string | null;
        childIssueId: string | null;
      };
      supervisor: {
        attentionRequired: boolean;
        reason: string | null;
        recoveryAction:
          | "none"
          | "request_user_approval"
          | "resolve_blocker"
          | "manual_recovery"
          | "repair_loop_decision"
          | "adjust_loop_limits_or_close_goal"
          | "manual_review";
        owner: "none" | "operator" | "user";
        userVisible: boolean;
      };
      iterations: Array<{
        iteration: number;
        issueId: string;
        identifier: string | null;
        title: string;
        status: string | null;
        originFingerprint: string | null;
        parentId: string | null;
        createdAt: string | null;
        updatedAt: string | null;
      }>;
      observability: {
        generatedAt: string;
        chain: Array<
          | {
              kind: "goal";
              issueId: string;
              identifier: string | null;
              title: string;
              status: string | null;
            }
          | {
              kind: "iteration";
              issueId: string;
              identifier: string | null;
              title: string;
              status: string | null;
              iteration: number;
            }
        >;
      };
    };

function truncateTitle(value: string) {
  if (value.length <= MAX_CONTINUATION_TITLE_LENGTH) return value;
  return value.slice(0, MAX_CONTINUATION_TITLE_LENGTH - 1).trimEnd();
}

function continuationOriginFingerprint(decision: MissionControlCeoLoopDecision) {
  return `iteration:${decision.iteration}`;
}

function serializeDate(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function iterationFromOriginFingerprint(value: string | null | undefined) {
  const match = value?.match(/^iteration:(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed + 1 : null;
}

function readStatus(value: string | null | undefined) {
  return value ?? null;
}

function progressLabelFor(iteration: number, maxIterations: number | null) {
  return maxIterations ? `${iteration} / ${maxIterations}` : `${iteration}`;
}

const ACTION_APPROVAL_PATTERNS: Record<MissionControlAutonomousLoopUserApproval, RegExp[]> = {
  live_external_action: [
    /\b(post|publish|send|message|dm|email|outreach|comment|reply|follow|unfollow|like|retweet|boost)\b[\s\S]{0,80}\b(x|twitter|telegram|tg|instagram|insta|threads|facebook|youtube|tiktok|linkedin|reddit|fansly|onlyfans|public|customer|lead|user|audience|subscriber)s?\b/i,
    /\b(post|publish|send|message|dm|email|outreach|comment|reply|follow|unfollow|like|retweet|boost)\b[\s\S]{0,80}\bOF\b/,
    /\b(live|external|public)\s+(campaign|launch|message|post|outreach|notification|announcement)\b/i,
    /\b(contact|notify|invite)\b[\s\S]{0,80}\b(customer|lead|user|audience|subscriber|creator|prospect)s?\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b(live|prod|production)[-\s]?(flag|feature\s+flag|toggle)\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b(?:feature\s+flag|flag|toggle)\b[\s\S]{0,80}\b(live|prod|production)\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b[a-z0-9_]*(?:live|prod|production)[a-z0-9_]*\s*=\s*(?:true|1|enabled|on)\b/i,
    /\b[a-z0-9_]*(?:live|prod|production)[a-z0-9_]*\s*=\s*(?:true|1|enabled|on)\b/i,
    /\b(?:live|prod|production)[-\s]?(?:flag|feature\s+flag|toggle)\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+(?:enabled|activated|turned\s+on|on|set)\b/i,
    /\b(?:feature\s+flag|flag|toggle)\b[\s\S]{0,80}\b(?:live|prod|production)\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+(?:enabled|activated|turned\s+on|on|set)\b/i,
  ],
  destructive_action: [
    /\b(delete|deleting|destroy|drop|wipe|purge|truncate|erase|remove|deactivate|disable|revoke)\b[\s\S]{0,80}\b(production|prod|live|account|database|db|table|data|record|file|secret|key|credential|user|customer|proxy|profile)s?\b/i,
    /\b(drop|truncate)\s+(table|database|db)\b/i,
    /\brm\s+-rf\b/i,
  ],
  production_deploy: [
    /\b(deploy|release|rollout|ship|restart|migrate|promote)\b[\s\S]{0,80}\b(production|prod|live|public)\b/i,
    /\bproduction\s+(deploy|deployment|release|rollout|migration|restart)\b/i,
    /\b(?:run|apply|execute)\b[\s\S]{0,80}\b(?:prod|production|live)\b[\s\S]{0,80}\b(?:database|db|schema)?\s*migration\b/i,
    /\b(?:run|apply|execute)\b[\s\S]{0,80}\b(?:database|db|schema)\s+migration\b[\s\S]{0,80}\b(?:prod|production|live)\b/i,
    /\b(?:prod|production|live)\b[\s\S]{0,80}\b(?:database|db|schema)\s+migration\b/i,
    /\b(?:database|db|schema)\s+migration\b[\s\S]{0,80}\b(?:prod|production|live)\b/i,
    /\b(npm\s+publish|publish(?:ing)?\b[\s\S]{0,80}\b(npm|package|canary|release|registry)|push(?:ing)?\b[\s\S]{0,80}\b(release\s+tag|tag|container\s+image|docker\s+image|ghcr))\b/i,
    /\b(?:npm|canary|package)\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+published\b/i,
    /\b[a-z0-9_]*(?:publish|canary|release)[a-z0-9_]*\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+(?:enabled|activated|turned\s+on|on|set)\b/i,
    /\b(?:prod|production|live)\b[\s\S]{0,80}\b(?:service|server|app|deployment)\b[\s\S]{0,80}\b(?:is|was|be|been)\s+restarted\b/i,
    /\b(?:service|server|app|deployment)\b[\s\S]{0,80}\b(?:is|was|be|been)\s+restarted\b[\s\S]{0,80}\b(?:prod|production|live)\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b(?:publish|canary|npm)\b[\s\S]{0,80}\b(?:flag|gate|toggle|job|workflow)\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b(?:flag|gate|toggle|job|workflow)\b[\s\S]{0,80}\b(?:publish|canary|npm)\b/i,
    /\b(set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b[a-z0-9_]*(?:publish|canary|release)[a-z0-9_]*\s*=\s*(?:true|1|enabled|on)\b/i,
    /\b[a-z0-9_]*(?:publish|canary|release)[a-z0-9_]*\s*=\s*(?:true|1|enabled|on)\b/i,
    /\b(kubectl\s+apply|terraform\s+apply|systemctl\s+restart|docker\s+compose\s+up)\b/i,
  ],
  protected_branch_merge: [
    /\b(merge|push|commit|rebase|force[-\s]?push)\b[\s\S]{0,80}\b(main|master|production|prod|protected\s+branch)\b/i,
    /\b(main|master|production|prod)\s+(branch|merge|push)\b/i,
    /\bprotected\s+branch\b/i,
  ],
  spend_money: [
    /\b(buy|purchase|pay|spend|charge|subscribe|renew|order|fund|top\s*up)\b[\s\S]{0,80}\b(credit|account|subscription|plan|invoice|budget|ad|ads|campaign|proxy|server|domain|license|seat|api|token|sms|captcha)s?\b/i,
    /\b(buy|purchase|pay|spend|charge|subscribe|renew|order|fund|top\s*up)\b[\s\S]{0,80}(?:[$€£₴]\s*\d|\d+(?:[.,]\d{1,2})?\s*(?:usd|eur|gbp|uah|dollars?|euros?|pounds?|cents?))/i,
    /(?:[$€£₴]\s*\d+(?:[.,]\d{1,2})?|\b\d+(?:[.,]\d{1,2})?\s*(?:usd|eur|gbp|uah|dollars?|euros?|pounds?|cents?)\b|\b(budget|invoice|billing|payment|paid)\b)/i,
  ],
  account_or_proxy_change: [
    /\b(change|update|rotate|replace|add|remove|switch|reset|edit|modify)\b[\s\S]{0,80}\b(account|profile|proxy|proxies|credential|password|email|totp|2fa|mfa|api\s*key|token|secret|session|cookie)s?\b/i,
    /\b(proxy|proxies|account|profile|credential|password|email|totp|2fa|api\s*key|token|secret|session|cookie)\b[\s\S]{0,80}\b(change|rotation|update|replacement|reset)\b/i,
    /\b(proxy|proxies|account|profile|credential|password|email|totp|2fa|api\s*key|token|secret|session|cookie)s?\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+(?:changed|updated|rotated|replaced|reset|switched|added|removed|modified)\b/i,
  ],
};

function nextTaskTextForActionScan(task: MissionControlCeoLoopNextTask) {
  return [task.title, task.description, task.assigneeHint, ...task.acceptanceCriteria]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

const PASSIVE_CI_ARTIFACT_PATTERNS = [
  /\bpassive[_\s-]*ci[_\s-]*(artifact|check|workflow)s?\b/i,
];

const NEGATED_PASSIVE_CI_ARTIFACT_PATTERNS = [
  /\b(?:not|no|non[-\s]?)\s+passive[_\s-]*ci[_\s-]*(?:artifact|check|workflow)s?\b/i,
  /\bnot\s+(?:a\s+)?passive\b[\s\S]{0,80}\b(?:artifact|check|workflow)s?\b/i,
];

const PASSIVE_CI_QA_EVIDENCE_PATTERNS = [
  /\b(?:QA\s+PASS|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer)|review\s+evidence)\b/i,
];

const PASSIVE_CI_GREEN_CHECK_EVIDENCE_PATTERNS = [
  /\b(?:green|clean)\s+(?:CI|checks|GitHub\s+checks)\b/i,
];

const PASSIVE_CI_INCOMPLETE_EVIDENCE_PATTERNS = [
  /\b(?:not|never|without|failed|failing|red|missing|absent|required|needed|pending|awaiting|blocked|rejected|denied)\b[\s\S]{0,80}\b(?:QA\s+PASS|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer)|green|clean)\b/i,
  /\b(?:CI|checks|GitHub\s+checks)\s+(?:is\s+|are\s+)?not\s+(?:green|clean|passing|passed|complete|done)\b/i,
  /\b(?:QA\s+PASS|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer))\b[\s\S]{0,80}\b(?:did\s+not|does\s+not|not)\s+(?:pass|approve|ship|grant|clear)\b/i,
  /\b(?:QA|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer))\b[\s\S]{0,60}\bnot\s+(?:passing|passed|approved|approve|complete|done|shipped|ship|granted|clear|cleared)\b/i,
  /\b(?:green|clean)\s+(?:CI|checks|GitHub\s+checks)\s+(?:pending|awaiting|blocked|failing|failed|red)\b/i,
  /\b(?:CI|checks|GitHub\s+checks)\s+(?:are\s+)?(?:pending|awaiting|blocked|failing|failed|red|required|missing|absent)\b/i,
  /\b(?:pending|awaiting|waiting\s+for|before|without|no)\b[\s\S]{0,80}\b(?:QA\s+PASS|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer)|green|clean)\b/i,
  /\b(?:QA\s+PASS|internal\s+(?:QA|review|approval)|Claude\s+(?:Ship|Reviewer)|green|clean)\b[\s\S]{0,60}\b(?:pending|awaiting|required|needed|missing|absent|rejected|denied|failed|not\s+yet)\b/i,
];

const ACTIONABLE_DISCLAIMER_CLAUSE_PATTERNS = [
  /(?:^|[,;]\s*)(?:then\s+)?(?:publish|deploy|release|rollout|ship|restart|migrate|promote|run|apply|execute)\b/i,
  /(?:^|[,;]\s*)(?:then\s+)?(?:set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b(?:publish|canary|npm|live|prod|production|flag|gate|toggle|secret|credential|key)\b/i,
  /(?:^|[,;]\s*)(?:then\s+)?(?:set|enable|turn\s+on|flip|activate|update)\b[\s\S]{0,80}\b[a-z0-9_]*(?:publish|canary|release|live|prod|production)[a-z0-9_]*\b/i,
  /(?:^|[,;]\s*)(?:then\s+)?(?:rotate|replace)\b[\s\S]{0,80}\b(?:secret|credential|key|token)\b/i,
  /[,;]\s*(?:then\s+)?(?:npm\s+publish|publish[_\s-]?canary|canary\s+publish|package\s+publish|release\s+tag|docker\s+(?:push|image)|container\s+image|ghcr|prod(?:uction)?\s+(?:database|db|schema)?\s*migration|(?:database|db|schema)\s+migration|prod(?:uction)?\s+(?:service|server|app|deployment)?\s*restart|(?:live|prod|production)(?:[-\s]+live)?[-\s]*(?:flag|toggle)|(?:feature\s+flag|flag|toggle)\s+(?:live|prod|production)|publish_canary|[a-z0-9_]*(?:publish|canary|release|live|prod|production)[a-z0-9_]*)\b[\s\S]{0,80}\b(?:is|are|was|were|be|been)\s+(?:authorized|allowed|enabled|activated|turned\s+on|published|deployed|released|pushed|migrated|restarted|rotated|changed|updated|set|complete|completed)\b/i,
];

const SAFETY_AUTHORIZATION_DISCLAIMER_PATTERN =
  /\b(?:no|without|never)\b[\s\S]{0,140}?\b(?:deploy|deployment|publish|release\s+tag|live[-\s]?flag|spend|payment|secret|credential|key|restart|migration|migrate|prod(?:uction)?|external|npm|ghcr|docker\s+push)\b[\s\S]{0,80}?\b(?:is|are|be)\s+authorized\b/i;

const SAFETY_AUTHORIZATION_DENY_LIST_PATTERN =
  /\b(?:no|without|never)\b[\s\S]{0,180}?\b(?:deploy|deployment|publish|release\s+tag|live[-\s]?flag|spend|payment|secret|credential|key|restart|migration|migrate|prod(?:uction)?|external|npm|ghcr|docker\s+push)\b[\s\S]{0,180}?(?:,\s*or\b|\bor\b)[\s\S]{0,80}?\b(?:is|are|be)\s+authorized\b/i;

const SAFETY_DISCLAIMER_PATTERNS = [
  SAFETY_AUTHORIZATION_DISCLAIMER_PATTERN,
  /^\s*(?:any|all|only|none|no)\b[\s\S]{0,180}?\b(?:deploy|deployment|publish|release\s+tag|live[-\s]?flag|spend|payment|secret|credential|key|restart|migration|migrate|prod(?:uction)?|external|npm|ghcr|docker\s+push)\b[\s\S]{0,120}?\b(?:remains?|is|are|requires?)\b[\s\S]{0,80}?\b(?:board[-\s]?gated|user[-\s]?gated|not\s+authorized|not\s+allowed|separate|explicit)\b/i,
  /^(?!\s*(?:set|enable|turn\s+on|flip|activate|update|publish|deploy|release|restart)\b)\s*(?:the\s+)?[^.!?;]{0,80}?\b(?:job|workflow|step|gate|flag|toggle)\b[\s\S]{0,120}?\b(?:remains?|is|are)\s+(?:default[-\s]?off|disabled|board[-\s]?gated|user[-\s]?gated|not\s+authorized|not\s+allowed)\b/i,
];

function actionScanSegments(text: string) {
  return text
    .split(/(?<=[.!?;])\s+|\n+|\s+(?:but|however|then|and(?:\s+then)?|while)\s+/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function stripSafetyDisclaimers(segment: string) {
  const hasActionableAuthorizedClause = SAFETY_AUTHORIZATION_DISCLAIMER_PATTERN.test(segment) &&
    !SAFETY_AUTHORIZATION_DENY_LIST_PATTERN.test(segment) &&
    ACTIONABLE_DISCLAIMER_CLAUSE_PATTERNS.some((pattern) => pattern.test(segment));
  if (hasActionableAuthorizedClause) return segment;

  return SAFETY_DISCLAIMER_PATTERNS.reduce(
    (stripped, pattern) => stripped.replace(pattern, " "),
    segment,
  );
}

function categoryDetectedInText(input: {
  category: MissionControlAutonomousLoopUserApproval;
  text: string;
  ignoreSafetyDisclaimers?: boolean;
}) {
  return actionScanSegments(input.text).some((segment) => {
    const scanSegment = input.ignoreSafetyDisclaimers ? stripSafetyDisclaimers(segment) : segment;
    return ACTION_APPROVAL_PATTERNS[input.category].some((pattern) => pattern.test(scanSegment));
  });
}

function decisionEvidenceTextForActionScan(decision: MissionControlCeoLoopDecision) {
  return decision.evidence.join("\n");
}

function hasPassiveCiArtifactApprovalEvidence(input: { taskText: string; evidenceText: string }) {
  const combinedText = [input.taskText, input.evidenceText].filter(Boolean).join("\n");
  if (NEGATED_PASSIVE_CI_ARTIFACT_PATTERNS.some((pattern) => pattern.test(combinedText))) return false;
  if (!PASSIVE_CI_ARTIFACT_PATTERNS.some((pattern) => pattern.test(input.taskText))) return false;
  if (PASSIVE_CI_INCOMPLETE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(combinedText))) return false;
  return PASSIVE_CI_QA_EVIDENCE_PATTERNS.some((pattern) => pattern.test(input.evidenceText)) &&
    PASSIVE_CI_GREEN_CHECK_EVIDENCE_PATTERNS.some((pattern) => pattern.test(input.evidenceText));
}

function isPassiveCiArtifactProtectedBranchTask(input: { taskText: string; evidenceText: string }) {
  if (!hasPassiveCiArtifactApprovalEvidence(input)) return false;
  const text = input.taskText;
  if (!categoryDetectedInText({ category: "protected_branch_merge", text })) return false;

  return !(Object.keys(ACTION_APPROVAL_PATTERNS) as MissionControlAutonomousLoopUserApproval[])
    .filter((category) => category !== "protected_branch_merge")
    .some((category) => categoryDetectedInText({ category, text, ignoreSafetyDisclaimers: true }));
}

function detectedUserApprovalActions(input: {
  decision: MissionControlCeoLoopDecision;
  userApprovalRequired: MissionControlAutonomousLoopUserApproval[];
  ceoCanApprove: MissionControlAutonomousLoopCeoApproval[];
}) {
  const activeCategories = new Set(input.userApprovalRequired);
  const ceoApprovedCategories = new Set(input.ceoCanApprove);
  const text = nextTaskTextForActionScan(input.decision.nextTask!);
  const evidenceText = decisionEvidenceTextForActionScan(input.decision);
  const passiveCiArtifactProtectedBranch = ceoApprovedCategories.has("passive_ci_artifacts") &&
    isPassiveCiArtifactProtectedBranchTask({ taskText: text, evidenceText });
  return (Object.keys(ACTION_APPROVAL_PATTERNS) as MissionControlAutonomousLoopUserApproval[]).filter((category) => {
    if (!activeCategories.has(category)) return false;
    if (category === "protected_branch_merge" && passiveCiArtifactProtectedBranch) return false;
    return categoryDetectedInText({ category, text, ignoreSafetyDisclaimers: true });
  });
}

function ceoSelfAttestationConflict(input: {
  decision: MissionControlCeoLoopDecision | null;
  userApprovalRequired: MissionControlAutonomousLoopUserApproval[];
  ceoCanApprove: MissionControlAutonomousLoopCeoApproval[];
}) {
  if (input.decision?.decision !== "next_iteration" || !input.decision.nextTask?.safeToRunWithoutUserApproval) return null;
  const detectedCategories = detectedUserApprovalActions({
    decision: input.decision,
    userApprovalRequired: input.userApprovalRequired,
    ceoCanApprove: input.ceoCanApprove,
  });
  if (detectedCategories.length === 0) return null;
  return {
    reason: "ceo_self_attestation_conflict" as const,
    detectedCategories,
  };
}

function isDecisionRepairReason(reason: string) {
  return reason === "invalid_ceo_loop_decision" ||
    reason === "ceo_loop_iteration_mismatch" ||
    reason === "ceo_loop_decision_stale" ||
    reason === "ceo_loop_decision_from_future";
}

function supervisorFor(input: {
  reason: string;
  decision: MissionControlCeoLoopDecision | null;
}): Extract<AutonomousGoalLoopState, { enabled: true }>["supervisor"] {
  if (isDecisionRepairReason(input.reason)) {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "repair_loop_decision",
      owner: "operator",
      userVisible: false,
    };
  }
  if (input.reason === "ceo_self_attestation_conflict") {
    return {
      attentionRequired: true,
      reason: "ceo_self_attestation_conflict",
      recoveryAction: "request_user_approval",
      owner: "user",
      userVisible: true,
    };
  }
  if (input.reason === "periodic_checkpoint_required") {
    return {
      attentionRequired: true,
      reason: "periodic_checkpoint_required",
      recoveryAction: "request_user_approval",
      owner: "user",
      userVisible: true,
    };
  }
  if (input.reason === "approval_required" || input.decision?.decision === "approval_required") {
    return {
      attentionRequired: true,
      reason: "approval_required",
      recoveryAction: "request_user_approval",
      owner: "user",
      userVisible: true,
    };
  }
  if (input.reason === "partial_completion" || input.decision?.decision === "partial_completion") {
    return {
      attentionRequired: true,
      reason: "partial_completion",
      recoveryAction: "manual_review",
      owner: "user",
      userVisible: true,
    };
  }
  if (input.reason === "runtime_exceeded" || input.reason === "iteration_exceeded") {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "adjust_loop_limits_or_close_goal",
      owner: "operator",
      userVisible: true,
    };
  }
  if (input.reason === "missing_ceo_loop_decision" || input.reason === "missing_documents") {
    return {
      attentionRequired: true,
      reason: input.reason,
      recoveryAction: "manual_review",
      owner: "operator",
      userVisible: false,
    };
  }
  if (input.decision?.decision === "blocked") {
    return {
      attentionRequired: true,
      reason: "blocked",
      recoveryAction: "resolve_blocker",
      owner: "user",
      userVisible: true,
    };
  }
  if (input.decision?.decision === "failed") {
    return {
      attentionRequired: true,
      reason: "failed",
      recoveryAction: "manual_recovery",
      owner: "user",
      userVisible: true,
    };
  }
  return {
    attentionRequired: false,
    reason: null,
    recoveryAction: "none",
    owner: "none",
    userVisible: false,
  };
}

function statusFor(input: {
  reason: string;
  decision: MissionControlCeoLoopDecision | null;
  matchingChildIssue: AutonomousGoalLoopChildIssue | null;
}): Extract<AutonomousGoalLoopState, { enabled: true }>["status"] {
  if (isDecisionRepairReason(input.reason)) return "failed";
  if (input.reason === "ceo_self_attestation_conflict") return "blocked";
  if (input.reason === "periodic_checkpoint_required") return "approval_required";
  if (input.reason === "approval_required" || input.decision?.decision === "approval_required") return "approval_required";
  if (input.decision?.decision === "goal_reached") return "goal_reached";
  if (input.reason === "partial_completion" || input.decision?.decision === "partial_completion") return "partial_completion";
  if (input.decision?.decision === "blocked") return "blocked";
  if (input.decision?.decision === "failed") return "failed";
  if (input.reason === "runtime_exceeded" || input.reason === "iteration_exceeded") return "blocked";
  if (input.decision?.decision === "next_iteration") return input.matchingChildIssue ? "executing" : "planning";
  if (input.reason === "validator_pass_required" || input.reason === "validator_not_passed") return "validating";
  return "ceo_review";
}

export function buildAutonomousGoalLoopState(input: {
  issue: AutonomousGoalLoopParentIssue;
  documents: MissionControlCompletionGateDocument[];
  childIssues?: AutonomousGoalLoopChildIssue[];
  now?: string | Date;
}): AutonomousGoalLoopState {
  const gate = evaluateMissionControlAutonomousLoopGate({
    issue: input.issue,
    documents: input.documents,
    now: input.now,
  });

  if (!gate.enabled || !gate.autonomousLoopPolicy?.enabled) {
    return { enabled: false, status: "disabled" };
  }

  const decision = gate.ceoLoopDecision;
  const originFingerprint = decision?.decision === "next_iteration" ? continuationOriginFingerprint(decision) : null;
  const matchingChildIssue =
    originFingerprint && decision
      ? input.childIssues?.find(
          (child) =>
            child.originKind === AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND &&
            child.originId === input.issue.id &&
            child.originFingerprint === originFingerprint,
        ) ?? null
      : null;

  const loopPolicy = gate.autonomousLoopPolicy;
  const iteration = loopPolicy.iteration;
  const maxIterations = loopPolicy.maxIterations ?? null;
  const selfAttestationConflict = ceoSelfAttestationConflict({
    decision,
    userApprovalRequired: loopPolicy.userApprovalRequired,
    ceoCanApprove: loopPolicy.ceoCanApprove,
  });
  const effectiveReason = selfAttestationConflict?.reason ?? gate.reason;
  const supervisor = supervisorFor({ reason: effectiveReason, decision });
  const status = statusFor({ reason: effectiveReason, decision, matchingChildIssue });
  const generatedAt = input.now instanceof Date ? input.now.toISOString() : (input.now ?? new Date().toISOString());

  const iterations = (input.childIssues ?? [])
    .filter((child) => child.originKind === AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND && child.originId === input.issue.id)
    .map((child) => ({
      iteration: iterationFromOriginFingerprint(child.originFingerprint) ?? iteration + 1,
      issueId: child.id,
      identifier: child.identifier ?? null,
      title: child.title,
      status: readStatus(child.status),
      originFingerprint: child.originFingerprint ?? null,
      parentId: child.parentId ?? null,
      createdAt: serializeDate(child.createdAt),
      updatedAt: serializeDate(child.updatedAt),
    }))
    .sort((left, right) => left.iteration - right.iteration || left.title.localeCompare(right.title));

  return {
    enabled: true,
    status,
    goal: loopPolicy.goal ?? input.issue.title ?? null,
    iteration,
    maxIterations,
    progressLabel: progressLabelFor(iteration, maxIterations),
    currentDecision: decision
      ? {
          iteration: decision.iteration,
          decision: decision.decision,
          decisionWrittenAt: decision.decisionWrittenAt ?? null,
          rationale: decision.rationale,
          nextTaskTitle: decision.nextTask?.title ?? null,
          hardGate: decision.hardGate,
          evidence: decision.evidence,
        }
      : null,
    planner: {
      mode: "single_child",
      supportsParallelChildren: false,
      nextTaskTitle: decision?.nextTask?.title ?? null,
      originFingerprint,
      childIssueId: matchingChildIssue?.id ?? null,
    },
    supervisor,
    iterations,
    observability: {
      generatedAt,
      chain: [
        {
          kind: "goal",
          issueId: input.issue.id,
          identifier: input.issue.identifier ?? null,
          title: input.issue.title,
          status: readStatus(input.issue.status),
        },
        ...iterations.map((child) => ({
          kind: "iteration" as const,
          issueId: child.issueId,
          identifier: child.identifier,
          title: child.title,
          status: child.status,
          iteration: child.iteration,
        })),
      ],
    },
  };
}

function childMissionControlPolicy(parentPolicy: MissionControlIssuePolicy): MissionControlIssuePolicy {
  return {
    ...parentPolicy,
    autonomousLoop: null,
  };
}

function childDescription(input: {
  issue: AutonomousGoalLoopParentIssue;
  decision: MissionControlCeoLoopDecision;
  goal: string | null | undefined;
}) {
  const nextTask = input.decision.nextTask!;
  const parentLabel = input.issue.identifier ? `${input.issue.identifier} — ${input.issue.title}` : input.issue.title;
  const sections = [
    "## Autonomous Loop Continuation",
    "",
    `Parent: ${parentLabel}`,
    `Loop iteration: ${input.decision.iteration + 1}`,
    input.goal ? `Goal: ${input.goal}` : null,
    "Safety: safe internal autonomous-loop continuation only; passive_ci_artifacts protected-branch merges may proceed after internal QA + green CI, but live, destructive, spend, account/proxy, production deploy, publish, migration, restart, or non-passive protected-branch actions still require explicit user approval.",
    "",
    "## CEO Rationale",
    "",
    input.decision.rationale,
    "",
    "## Next Task",
    "",
    nextTask.description?.trim() || nextTask.title,
    nextTask.assigneeHint ? "" : null,
    nextTask.assigneeHint ? `Assignee hint: ${nextTask.assigneeHint}` : null,
  ].filter((value): value is string => typeof value === "string");

  return sections.join("\n");
}

function reportEventFor(input: {
  reason: AutonomousGoalLoopContinuationReason;
  decision: MissionControlCeoLoopDecision | null;
}): MissionControlAutonomousLoopReportEvent | null {
  if (input.reason === "ceo_self_attestation_conflict") return "approval_required";
  if (input.reason === "approval_required") return "approval_required";
  if (input.reason === "periodic_checkpoint_required") return "periodic_checkpoint_required";
  if (input.reason === "runtime_exceeded") return "runtime_exceeded";
  if (input.reason === "iteration_exceeded") return "iteration_exceeded";
  if (input.decision?.decision === "goal_reached") return "goal_reached";
  if (input.reason === "partial_completion" || input.decision?.decision === "partial_completion") return "partial_completion";
  if (input.decision?.decision === "blocked") return "blocker";
  if (input.decision?.decision === "failed") return "failed";
  return null;
}

function shouldReportToUser(input: {
  policy: MissionControlIssuePolicy | null;
  reason: AutonomousGoalLoopContinuationReason;
  decision: MissionControlCeoLoopDecision | null;
}) {
  const event = reportEventFor({ reason: input.reason, decision: input.decision });
  if (!event) return false;
  return input.policy?.autonomousLoop?.reportToUserOnlyOn.includes(event) ?? false;
}

function nonCreatePlan(input: {
  action: "ignore" | "wait" | "report" | "blocked";
  reason: AutonomousGoalLoopContinuationReason;
  gate: ReturnType<typeof evaluateMissionControlCompletionGate>;
  ceoLoopDecision: MissionControlCeoLoopDecision | null;
  reportToUser?: boolean;
}): AutonomousGoalLoopContinuationPlan {
  return {
    action: input.action,
    reason: input.reason,
    reportToUser: input.reportToUser ?? shouldReportToUser({
      policy: input.gate.policy,
      reason: input.reason,
      decision: input.ceoLoopDecision,
    }),
    gate: input.gate,
    ceoLoopDecision: input.ceoLoopDecision,
  };
}

export function buildAutonomousGoalLoopContinuationPlan(input: {
  issue: AutonomousGoalLoopParentIssue;
  documents: MissionControlCompletionGateDocument[];
  now?: string | Date;
}): AutonomousGoalLoopContinuationPlan {
  const gate = evaluateMissionControlCompletionGate({
    issue: input.issue,
    documents: input.documents,
    now: input.now,
  });

  if (!gate.enabled || !gate.policy?.autonomousLoop?.enabled) {
    return nonCreatePlan({
      action: "ignore",
      reason: gate.reason,
      gate,
      ceoLoopDecision: gate.ceoLoopDecision,
      reportToUser: false,
    });
  }

  const decision = gate.ceoLoopDecision;
  if (!decision) {
    return nonCreatePlan({
      action: gate.reason === "missing_documents" || gate.reason === "validator_not_passed" ? "wait" : "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: null,
      reportToUser: false,
    });
  }

  if (isDecisionRepairReason(gate.reason)) {
    return nonCreatePlan({
      action: "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: decision,
      reportToUser: false,
    });
  }

  if (decision.decision !== "next_iteration") {
    return nonCreatePlan({
      action: decision.decision === "goal_reached" || decision.decision === "partial_completion" ? "report" : "blocked",
      reason: gate.reason === "allowed" ? "not_next_iteration" : gate.reason,
      gate,
      ceoLoopDecision: decision,
    });
  }

  if (gate.reason !== "autonomous_loop_not_complete") {
    return nonCreatePlan({
      action: "blocked",
      reason: gate.reason,
      gate,
      ceoLoopDecision: decision,
    });
  }

  if (!decision.nextTask?.safeToRunWithoutUserApproval) {
    return nonCreatePlan({
      action: "blocked",
      reason: "unsafe_next_task",
      gate,
      ceoLoopDecision: decision,
      reportToUser: true,
    });
  }

  const selfAttestationConflict = ceoSelfAttestationConflict({
    decision,
    userApprovalRequired: gate.policy.autonomousLoop.userApprovalRequired,
    ceoCanApprove: gate.policy.autonomousLoop.ceoCanApprove,
  });
  if (selfAttestationConflict) {
    return nonCreatePlan({
      action: "blocked",
      reason: selfAttestationConflict.reason,
      gate,
      ceoLoopDecision: decision,
      reportToUser: true,
    });
  }

  const originFingerprint = continuationOriginFingerprint(decision);
  const loopNumber = decision.iteration + 1;
  return {
    action: "create_child",
    reason: "next_iteration",
    reportToUser: false,
    gate,
    ceoLoopDecision: decision,
    originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
    originId: input.issue.id,
    originFingerprint,
    childInput: {
      title: truncateTitle(`[Loop ${loopNumber}] ${decision.nextTask.title}`),
      description: childDescription({
        issue: input.issue,
        decision,
        goal: gate.policy.autonomousLoop.goal,
      }),
      status: "todo",
      workMode: "standard",
      priority: input.issue.priority,
      assigneeAgentId: input.issue.assigneeAgentId ?? null,
      assigneeUserId: null,
      acceptanceCriteria: decision.nextTask.acceptanceCriteria,
      blockParentUntilDone: true,
      originKind: AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND,
      originId: input.issue.id,
      originFingerprint,
      executionPolicy: {
        missionControl: childMissionControlPolicy(gate.policy),
      },
    },
  };
}

async function findExistingContinuationChild(
  db: Db,
  input: { companyId: string; parentIssueId: string; originFingerprint: string },
) {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        eq(issues.parentId, input.parentIssueId),
        eq(issues.originKind, AUTONOMOUS_GOAL_LOOP_CONTINUATION_ORIGIN_KIND),
        eq(issues.originId, input.parentIssueId),
        eq(issues.originFingerprint, input.originFingerprint),
      ),
    )
    .then((rows) => rows[0] ?? null);
}

export async function continueAutonomousGoalLoopFromDecision(input: {
  db: Db;
  issue: AutonomousGoalLoopParentIssue;
  actor: AutonomousGoalLoopActor;
  documents?: MissionControlCompletionGateDocument[];
  now?: string | Date;
}): Promise<AutonomousGoalLoopContinuationOutcome> {
  const documents = input.documents ?? await listMissionControlCompletionDocuments(input.db, input.issue.id);
  const plan = buildAutonomousGoalLoopContinuationPlan({
    issue: input.issue,
    documents,
    now: input.now,
  });

  if (plan.action !== "create_child") {
    const outcome =
      plan.action === "ignore" ? "ignored" : plan.action === "wait" ? "waiting" : plan.action === "report" ? "report_required" : "blocked";
    return {
      outcome,
      reason: plan.reason,
      reportToUser: plan.reportToUser,
      plan,
    };
  }

  const existing = await findExistingContinuationChild(input.db, {
    companyId: input.issue.companyId,
    parentIssueId: input.issue.id,
    originFingerprint: plan.originFingerprint,
  });
  if (existing) {
    return {
      outcome: "already_exists",
      reason: "next_iteration",
      reportToUser: false,
      plan,
      childIssue: existing,
      parentBlockerAdded: false,
    };
  }

  const created = await issueService(input.db).createChild(input.issue.id, {
    ...plan.childInput,
    createdByAgentId: input.actor.agentId ?? null,
    createdByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    actorAgentId: input.actor.agentId ?? null,
    actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
    originRunId: input.actor.runId ?? null,
  });

  return {
    outcome: "created",
    reason: "next_iteration",
    reportToUser: false,
    plan,
    childIssue: created.issue,
    parentBlockerAdded: created.parentBlockerAdded,
  };
}

export function summarizeAutonomousGoalLoopContinuationOutcome(outcome: AutonomousGoalLoopContinuationOutcome) {
  if (outcome.outcome === "created" || outcome.outcome === "already_exists") {
    return {
      outcome: outcome.outcome,
      reason: outcome.reason,
      reportToUser: outcome.reportToUser,
      parentIssueId: outcome.plan.originId,
      childIssueId: outcome.childIssue.id,
      childIdentifier: outcome.childIssue.identifier ?? null,
      childTitle: outcome.childIssue.title,
      originFingerprint: outcome.plan.originFingerprint,
      parentBlockerAdded: outcome.parentBlockerAdded,
    };
  }

  return {
    outcome: outcome.outcome,
    reason: outcome.reason,
    reportToUser: outcome.reportToUser,
    ceoLoopDecision: outcome.plan.ceoLoopDecision
      ? {
          iteration: outcome.plan.ceoLoopDecision.iteration,
          decision: outcome.plan.ceoLoopDecision.decision,
          hardGate: outcome.plan.ceoLoopDecision.hardGate ?? null,
        }
      : null,
  };
}
