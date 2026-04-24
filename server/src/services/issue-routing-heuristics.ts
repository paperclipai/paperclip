import type { IssueWorkIntent } from "@paperclipai/shared";
import { isAgentAssignableStatus } from "./agent-assignment-status.js";

const QA_LIKE_ISSUE_PATTERN = /\bqa|release|audit|verify|test\b/;
const LEAD_LIKE_ISSUE_PATTERN = /\blead|restaurant|prospect|sheet\b/;
const ONBOARDING_LIKE_ISSUE_PATTERN = /\bonboard|onboarding|go[- ]?live|activation|rollout|intake|implementation\b/;
const TICKET_AUTHORING_STRONG_PATTERNS = [
  /\bticket-authoring task\b/,
  /\bnot an implementation task\b/,
  /\bdo not change code\b/,
  /\bwrite implementation tickets only\b/,
  /\bthis is a ticket-authoring task\b/,
] as const;
const TICKET_AUTHORING_WEAK_PATTERNS = [
  /\bactionable tickets?\b/,
  /\bcreate a concrete ticket\b/,
  /\bcreate a new issue\b/,
  /\bimplementation tickets?\b/,
  /\btranslated into actionable tickets\b/,
  /\bthis is a ticket authoring task\b/,
] as const;
const AUDIT_TICKET_CREATION_PATTERNS = [
  /\bconcrete issues are created\b/,
  /\bfor every p0 and p1 issue\b/,
  /\bno ticket is created\b/,
  /\bthe review is incomplete\b/,
  /\bdo not stop at analysis\b/,
  /\btrust validation\b/,
  /\bfailure detection exercise\b/,
] as const;
const DELIVERY_SCOPED_ASSIGNEE_ROLES = new Set(["engineer", "qa", "devops", "cto"]);
const ISSUE_WORK_INTENT_SET = new Set<IssueWorkIntent>(["delivery", "ticket_authoring", "audit", "general"]);

export const ENGINEERING_ASSIGNMENT_REBALANCE_PATTERN =
  /\bcart|checkout|frontend|backend|api|component|typescript|react|db|database|migration|refactor|bug|fix|code|branch(?:es)?|merge|git|rebase|cherry[- ]?pick|conflict|pull\s*request|\bpr\b/i;

const APP_LIKE_ENGINEERING_ISSUE_PATTERN = /\bcart|checkout|client|frontend|ui|app|mobile|react|screen|component\b/;
const WEB_LIKE_ENGINEERING_ISSUE_PATTERN = /\bweb|browser|page|route|view\b/;
const PLATFORM_LIKE_ENGINEERING_ISSUE_PATTERN = /\bplatform|infra|runtime|pipeline|orchestr|migration|database|server|backend|auth|api\b/;

const APP_ENGINEER_CANDIDATE_PATTERN = /\bproduct engineer - app\b|\bapp\b|frontend|react|mobile|ios|android|client/;
const WEB_ENGINEER_CANDIDATE_PATTERN = /\bproduct engineer - web\b|\bweb\b|frontend|react|browser|ui/;
const PLATFORM_ENGINEER_CANDIDATE_PATTERN = /\bplatform\b|infra|backend|server|runtime|devops|database/;
const QA_CANDIDATE_PATTERN = /\bqa|release\b/;
const LEAD_CANDIDATE_PATTERN = /lead generation|sales/;
const ONBOARDING_CANDIDATE_PATTERN = /\bonboarding|implementation|project manager\b/;
const ENGINEERING_CANDIDATE_PATTERN = /\bengineer\b|frontend|backend|platform/;
const SECURITY_CANDIDATE_PATTERN = /\bsecurity|appsec|threat|owasp|abuse|auth\b/;

export type IssueRoutingIssue = {
  id?: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  preferredRole?: string | null;
  desiredSkills?: string[] | null;
  workflowLaneRole?: string | null;
};

export type OperationsAssignmentCandidate = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  status: string | null;
  desiredSkills?: string[] | null;
  openAssignedIssueCount?: number | null;
};

export type OpenAssignedIssueForRouting = {
  assigneeAgentId: string | null;
  projectId: string | null;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizeSkills(values: string[] | null | undefined) {
  return Array.from(new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean)));
}

export function buildIssueRoutingText(issue: IssueRoutingIssue): string {
  return [
    normalizeText(issue.projectName),
    normalizeText(issue.title),
    normalizeText(issue.description),
    normalizeText(issue.identifier),
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildCandidateDescriptorText(candidate: Pick<OperationsAssignmentCandidate, "name" | "title">): string {
  return [normalizeText(candidate.name), normalizeText(candidate.title)].filter(Boolean).join(" ");
}

function buildCandidateSearchText(
  candidate: Pick<OperationsAssignmentCandidate, "name" | "title" | "capabilities">,
): string {
  return [
    normalizeText(candidate.name),
    normalizeText(candidate.title),
    normalizeText(candidate.capabilities),
  ]
    .filter(Boolean)
    .join(" ");
}

function isQaCandidate(candidate: OperationsAssignmentCandidate) {
  return candidate.role === "qa" || QA_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isLeadCandidate(candidate: OperationsAssignmentCandidate) {
  return candidate.role === "researcher" || LEAD_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isOnboardingCandidate(candidate: OperationsAssignmentCandidate) {
  return candidate.role === "pm" || ONBOARDING_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isEngineerCandidate(candidate: OperationsAssignmentCandidate) {
  return candidate.role === "engineer" || ENGINEERING_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isSecurityCandidate(candidate: OperationsAssignmentCandidate) {
  return candidate.role === "security" || SECURITY_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isAppEngineerCandidate(candidate: OperationsAssignmentCandidate) {
  return isEngineerCandidate(candidate) && APP_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isWebEngineerCandidate(candidate: OperationsAssignmentCandidate) {
  return isEngineerCandidate(candidate) && WEB_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

function isPlatformEngineerCandidate(candidate: OperationsAssignmentCandidate) {
  return isEngineerCandidate(candidate) && PLATFORM_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateSearchText(candidate));
}

export function isLikelyTechnicalIssueText(issueText: string | null | undefined): boolean {
  return ENGINEERING_ASSIGNMENT_REBALANCE_PATTERN.test(issueText ?? "");
}

export function isQaLikeIssueText(issueText: string | null | undefined): boolean {
  return QA_LIKE_ISSUE_PATTERN.test(issueText ?? "");
}

export function isLikelyTicketAuthoringOnlyIssueText(issueText: string | null | undefined): boolean {
  const text = issueText ?? "";
  if (text.trim().length === 0) return false;
  if (TICKET_AUTHORING_STRONG_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const weakSignalCount = TICKET_AUTHORING_WEAK_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );
  return weakSignalCount >= 2;
}

export function isLikelyAuditTicketCreationIssueText(issueText: string | null | undefined): boolean {
  const text = issueText ?? "";
  if (text.trim().length === 0) return false;
  const signalCount = AUDIT_TICKET_CREATION_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );
  return signalCount >= 3;
}

export function resolveIssueWorkIntent(input: {
  workIntent?: string | null | undefined;
  assigneeRole?: string | null | undefined;
  issueText?: string | null | undefined;
  workflowTemplateKey?: string | null | undefined;
  workflowLaneRole?: string | null | undefined;
}): IssueWorkIntent {
  if (input.workIntent && ISSUE_WORK_INTENT_SET.has(input.workIntent as IssueWorkIntent)) {
    return input.workIntent as IssueWorkIntent;
  }
  if (input.workflowTemplateKey || input.workflowLaneRole) return "delivery";
  if (isLikelyTicketAuthoringOnlyIssueText(input.issueText)) return "ticket_authoring";
  if (isLikelyAuditTicketCreationIssueText(input.issueText)) return "audit";
  if (
    DELIVERY_SCOPED_ASSIGNEE_ROLES.has(input.assigneeRole ?? "")
    || isLikelyTechnicalIssueText(input.issueText)
  ) {
    return "delivery";
  }
  return "general";
}

export function isDeliveryWorkIntent(intent: string | null | undefined) {
  return intent === "delivery";
}

function classifyIssueSignals(issueText: string) {
  return {
    isQaLikeIssue: QA_LIKE_ISSUE_PATTERN.test(issueText),
    isLeadLikeIssue: LEAD_LIKE_ISSUE_PATTERN.test(issueText),
    isOnboardingLikeIssue: ONBOARDING_LIKE_ISSUE_PATTERN.test(issueText),
    isEngineeringIssue: isLikelyTechnicalIssueText(issueText),
    isAppLikeEngineeringIssue: APP_LIKE_ENGINEERING_ISSUE_PATTERN.test(issueText),
    isWebLikeEngineeringIssue: WEB_LIKE_ENGINEERING_ISSUE_PATTERN.test(issueText),
    isPlatformLikeEngineeringIssue: PLATFORM_LIKE_ENGINEERING_ISSUE_PATTERN.test(issueText),
  };
}

function pickReadySpecialists(
  specialists: OperationsAssignmentCandidate[],
  isReadyCandidate: (candidate: Pick<OperationsAssignmentCandidate, "status">) => boolean,
) {
  const readySpecialists = specialists.filter(isReadyCandidate);
  return readySpecialists.length > 0 ? readySpecialists : specialists;
}

function resolveDesiredSkillCandidates(
  issue: IssueRoutingIssue,
  candidates: OperationsAssignmentCandidate[],
) {
  const desiredSkills = normalizeSkills(issue.desiredSkills ?? []);
  if (desiredSkills.length === 0) return [];
  return candidates.filter((candidate) => {
    const candidateSkills = normalizeSkills(candidate.desiredSkills ?? []);
    return desiredSkills.some((skill) => candidateSkills.includes(skill));
  });
}

function resolvePreferredRoleCandidates(
  issue: IssueRoutingIssue,
  candidates: OperationsAssignmentCandidate[],
) {
  const preferredRole = normalizeText(issue.preferredRole);
  if (!preferredRole) return [];
  return candidates.filter((candidate) => normalizeText(candidate.role) === preferredRole);
}

function resolveStrictWorkflowLaneCandidates(
  issue: IssueRoutingIssue,
  candidates: OperationsAssignmentCandidate[],
) {
  const workflowLaneRole = normalizeText(issue.workflowLaneRole);
  if (workflowLaneRole === "qa" || workflowLaneRole === "security" || workflowLaneRole === "cto") {
    return candidates.filter((candidate) => normalizeText(candidate.role) === workflowLaneRole);
  }
  return null;
}

export function resolveEligibleOperationsAssignmentCandidates(
  issue: IssueRoutingIssue,
  candidates: OperationsAssignmentCandidate[],
) {
  const strictWorkflowLaneCandidates = resolveStrictWorkflowLaneCandidates(issue, candidates);
  if (strictWorkflowLaneCandidates) return strictWorkflowLaneCandidates;

  const preferredRole = normalizeText(issue.preferredRole);
  const preferredRoleCandidates = resolvePreferredRoleCandidates(issue, candidates);
  if (preferredRoleCandidates.length > 0) {
    return preferredRoleCandidates;
  }

  const desiredSkillCandidates = resolveDesiredSkillCandidates(issue, candidates);
  if (preferredRole === "security") {
    return desiredSkillCandidates.length > 0 ? desiredSkillCandidates : [];
  }
  if (preferredRole && desiredSkillCandidates.length > 0) {
    return desiredSkillCandidates;
  }

  const issueText = buildIssueRoutingText(issue);
  const signals = classifyIssueSignals(issueText);
  const descriptionSignals = classifyIssueSignals(normalizeText(issue.description));
  const engineerCandidates = candidates.filter(isEngineerCandidate);
  const qaCandidates = candidates.filter(isQaCandidate);
  const leadCandidates = candidates.filter(isLeadCandidate);
  const onboardingCandidates = candidates.filter(isOnboardingCandidate);
  const securityCandidates = candidates.filter(isSecurityCandidate);
  const appEngineerCandidates = engineerCandidates.filter(isAppEngineerCandidate);
  const webEngineerCandidates = engineerCandidates.filter(isWebEngineerCandidate);
  const platformEngineerCandidates = engineerCandidates.filter(isPlatformEngineerCandidate);

  if (preferredRole === "qa") return qaCandidates;
  if (preferredRole === "pm" && onboardingCandidates.length > 0) return onboardingCandidates;
  if (preferredRole === "designer") return candidates.filter((candidate) => normalizeText(candidate.role) === "designer");
  if (preferredRole === "researcher" && leadCandidates.length > 0) return leadCandidates;
  if (preferredRole === "engineer" && engineerCandidates.length > 0) return engineerCandidates;
  if (preferredRole === "security" && securityCandidates.length > 0) return securityCandidates;

  if (signals.isQaLikeIssue || descriptionSignals.isQaLikeIssue) {
    return qaCandidates;
  }

  if (signals.isEngineeringIssue) {
    if (descriptionSignals.isWebLikeEngineeringIssue) {
      return webEngineerCandidates.length > 0 ? webEngineerCandidates : engineerCandidates;
    }
    if (descriptionSignals.isPlatformLikeEngineeringIssue) {
      return platformEngineerCandidates.length > 0 ? platformEngineerCandidates : engineerCandidates;
    }
    if (signals.isAppLikeEngineeringIssue) {
      return appEngineerCandidates.length > 0 ? appEngineerCandidates : engineerCandidates;
    }
    if (signals.isWebLikeEngineeringIssue) {
      return webEngineerCandidates.length > 0 ? webEngineerCandidates : engineerCandidates;
    }
    if (signals.isPlatformLikeEngineeringIssue) {
      return platformEngineerCandidates.length > 0 ? platformEngineerCandidates : engineerCandidates;
    }
    return engineerCandidates;
  }

  if (signals.isLeadLikeIssue) {
    return leadCandidates.length > 0 ? leadCandidates : candidates;
  }
  if (signals.isOnboardingLikeIssue) {
    return onboardingCandidates.length > 0 ? onboardingCandidates : candidates;
  }

  return candidates;
}

export function pickOperationsAssignmentCandidate(input: {
  issue: IssueRoutingIssue;
  openAssignedIssues: OpenAssignedIssueForRouting[];
  availableCandidates: OperationsAssignmentCandidate[];
  pausedFallbackCandidates: OperationsAssignmentCandidate[];
  excludeAgentId?: string | null;
  allowPausedFallback?: boolean;
}) {
  const sameProjectCounts = new Map<string, number>();
  for (const candidateIssue of input.openAssignedIssues) {
    if (!candidateIssue.assigneeAgentId) continue;
    if (candidateIssue.projectId !== input.issue.projectId) continue;
    sameProjectCounts.set(
      candidateIssue.assigneeAgentId,
      (sameProjectCounts.get(candidateIssue.assigneeAgentId) ?? 0) + 1,
    );
  }

  const issueText = buildIssueRoutingText(input.issue);
  const signals = classifyIssueSignals(issueText);
  const descriptionSignals = classifyIssueSignals(normalizeText(input.issue.description));
  const healthyCandidates = input.availableCandidates.filter((candidate) => candidate.status !== "error");
  let baseCandidatePool = healthyCandidates.length > 0 ? healthyCandidates : input.availableCandidates;
  if (baseCandidatePool.length === 0 && input.allowPausedFallback) {
    const pausedFallbackHealthyCandidates = input.pausedFallbackCandidates.filter((candidate) => candidate.status !== "error");
    baseCandidatePool =
      pausedFallbackHealthyCandidates.length > 0
        ? pausedFallbackHealthyCandidates
        : input.pausedFallbackCandidates;
  }

  const isReadyCandidate = (candidate: Pick<OperationsAssignmentCandidate, "status">) => (
    isAgentAssignableStatus(candidate.status)
  );
  const specializationSourcePool = input.allowPausedFallback
    ? input.pausedFallbackCandidates
    : input.availableCandidates;
  const strictWorkflowLaneCandidates = resolveStrictWorkflowLaneCandidates(input.issue, specializationSourcePool);
  if (strictWorkflowLaneCandidates) {
    baseCandidatePool = pickReadySpecialists(strictWorkflowLaneCandidates, isReadyCandidate);
    if (baseCandidatePool.length === 0) return null;
  }

  const preferredRole = normalizeText(input.issue.preferredRole);
  const preferredRoleCandidates = resolvePreferredRoleCandidates(input.issue, specializationSourcePool);
  const desiredSkillCandidates = resolveDesiredSkillCandidates(input.issue, specializationSourcePool);
  const qaCandidates = specializationSourcePool.filter((candidate) => (
    candidate.role === "qa" || QA_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
  ));

  if (!strictWorkflowLaneCandidates && preferredRole === "security" && preferredRoleCandidates.length === 0 && desiredSkillCandidates.length === 0) {
    return null;
  }
  if (strictWorkflowLaneCandidates) {
    // Governed workflow lanes must stay on the exact role selected above.
  } else if (preferredRole === "qa") {
    baseCandidatePool = pickReadySpecialists(qaCandidates, isReadyCandidate);
    if (baseCandidatePool.length === 0) return null;
  } else if (preferredRoleCandidates.length > 0) {
    baseCandidatePool = pickReadySpecialists(preferredRoleCandidates, isReadyCandidate);
  } else if (desiredSkillCandidates.length > 0) {
    baseCandidatePool = pickReadySpecialists(desiredSkillCandidates, isReadyCandidate);
  } else if (signals.isQaLikeIssue || descriptionSignals.isQaLikeIssue) {
    const qaPool = pickReadySpecialists(qaCandidates, isReadyCandidate);
    if (qaPool.length === 0) return null;
    baseCandidatePool = qaPool;
  } else if (signals.isEngineeringIssue) {
    const engineerCandidates = specializationSourcePool.filter((candidate) => candidate.role === "engineer");

    const appEngineerCandidates = engineerCandidates.filter((candidate) => (
      APP_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const webEngineerCandidates = engineerCandidates.filter((candidate) => (
      WEB_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const platformEngineerCandidates = engineerCandidates.filter((candidate) => (
      PLATFORM_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const hasExplicitWebIntent = descriptionSignals.isWebLikeEngineeringIssue;
    const hasExplicitPlatformIntent = descriptionSignals.isPlatformLikeEngineeringIssue;

    const readyEngineers = engineerCandidates.filter(isReadyCandidate);
    if (engineerCandidates.length === 0) return null;
    if (readyEngineers.length === 0) return null;

    if (hasExplicitWebIntent) {
      baseCandidatePool = pickReadySpecialists(webEngineerCandidates, isReadyCandidate);
    } else if (hasExplicitPlatformIntent) {
      baseCandidatePool = pickReadySpecialists(platformEngineerCandidates, isReadyCandidate);
    } else if (signals.isAppLikeEngineeringIssue) {
      baseCandidatePool = pickReadySpecialists(appEngineerCandidates, isReadyCandidate);
    } else if (signals.isWebLikeEngineeringIssue) {
      baseCandidatePool = pickReadySpecialists(webEngineerCandidates, isReadyCandidate);
    } else if (signals.isPlatformLikeEngineeringIssue) {
      baseCandidatePool = pickReadySpecialists(platformEngineerCandidates, isReadyCandidate);
    } else {
      baseCandidatePool = readyEngineers;
    }
  }

  const preferredCandidatePool = input.excludeAgentId
    ? baseCandidatePool.filter((candidate) => candidate.id !== input.excludeAgentId)
    : baseCandidatePool;
  const candidatePool = preferredCandidatePool.length > 0 ? preferredCandidatePool : baseCandidatePool;
  if (candidatePool.length === 0) return null;

  const desiredSkills = normalizeSkills(input.issue.desiredSkills ?? []);
  const ranked = candidatePool
    .map((candidate) => {
      const sameProjectLoad = sameProjectCounts.get(candidate.id) ?? 0;
      const openAssignedIssueCount = Math.max(0, candidate.openAssignedIssueCount ?? 0);
      const descriptorText = buildCandidateDescriptorText(candidate);
      const candidateSkills = normalizeSkills(candidate.desiredSkills ?? []);
      const skillMatches = desiredSkills.filter((skill) => candidateSkills.includes(skill)).length;

      let score = 0;
      score += Math.min(sameProjectLoad, 2) * 12;
      score -= openAssignedIssueCount * 18;

      if (candidate.status === "idle") score += 25;
      else if (candidate.status === "running") score += 8;
      else if (candidate.status === "error") score -= 200;

      if (preferredRole) {
        if (normalizeText(candidate.role) === preferredRole) score += 260;
        else if (preferredRole === "security") score -= 200;
        else score -= 35;
      }

      if (skillMatches > 0) {
        score += Math.min(skillMatches, 2) * 90;
      }

      if (signals.isQaLikeIssue) {
        if (candidate.role === "qa" || QA_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (signals.isLeadLikeIssue) {
        if (candidate.role === "researcher" || LEAD_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (signals.isOnboardingLikeIssue) {
        if (candidate.role === "pm" || ONBOARDING_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (candidate.role === "engineer" || ENGINEERING_CANDIDATE_PATTERN.test(descriptorText)) {
        score += 140;
      } else if (!preferredRole) {
        score -= 70;
      }

      return { candidate, score, openAssignedIssueCount };
    })
    .sort(
      (a, b) =>
        b.score - a.score
        || a.openAssignedIssueCount - b.openAssignedIssueCount
        || a.candidate.name.localeCompare(b.candidate.name)
        || a.candidate.id.localeCompare(b.candidate.id),
    );

  return ranked[0]?.candidate ?? null;
}
