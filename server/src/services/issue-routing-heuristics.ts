const QA_LIKE_ISSUE_PATTERN = /\bqa|release|audit|verify|test\b/;
const LEAD_LIKE_ISSUE_PATTERN = /\blead|restaurant|prospect|sheet\b/;
const ONBOARDING_LIKE_ISSUE_PATTERN = /\bonboard|onboarding|go[- ]?live|activation|rollout|intake|implementation\b/;

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

export type IssueRoutingIssue = {
  id?: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  projectId?: string | null;
  projectName?: string | null;
};

export type OperationsAssignmentCandidate = {
  id: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  status: string | null;
};

export type OpenAssignedIssueForRouting = {
  assigneeAgentId: string | null;
  projectId: string | null;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
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

export function resolveEligibleOperationsAssignmentCandidates(
  issue: IssueRoutingIssue,
  candidates: OperationsAssignmentCandidate[],
) {
  const issueText = buildIssueRoutingText(issue);
  const signals = classifyIssueSignals(issueText);
  const descriptionSignals = classifyIssueSignals(normalizeText(issue.description));
  const engineerCandidates = candidates.filter(isEngineerCandidate);
  const qaCandidates = candidates.filter(isQaCandidate);
  const leadCandidates = candidates.filter(isLeadCandidate);
  const onboardingCandidates = candidates.filter(isOnboardingCandidate);
  const appEngineerCandidates = engineerCandidates.filter(isAppEngineerCandidate);
  const webEngineerCandidates = engineerCandidates.filter(isWebEngineerCandidate);
  const platformEngineerCandidates = engineerCandidates.filter(isPlatformEngineerCandidate);

  if (signals.isEngineeringIssue) {
    if (descriptionSignals.isQaLikeIssue) {
      return qaCandidates.length > 0 ? qaCandidates : engineerCandidates;
    }
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

  if (signals.isQaLikeIssue) {
    return qaCandidates.length > 0 ? qaCandidates : candidates;
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
    candidate.status !== "error" &&
    candidate.status !== "paused" &&
    candidate.status !== "terminated" &&
    candidate.status !== "pending_approval"
  );
  const specializationSourcePool = input.allowPausedFallback
    ? input.pausedFallbackCandidates
    : input.availableCandidates;

  if (signals.isEngineeringIssue) {
    const engineerCandidates = specializationSourcePool.filter((candidate) => candidate.role === "engineer");
    const qaCandidates = specializationSourcePool.filter((candidate) => (
      candidate.role === "qa" || QA_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));

    const appEngineerCandidates = engineerCandidates.filter((candidate) => (
      APP_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const webEngineerCandidates = engineerCandidates.filter((candidate) => (
      WEB_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const platformEngineerCandidates = engineerCandidates.filter((candidate) => (
      PLATFORM_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const hasExplicitQaIntent = descriptionSignals.isQaLikeIssue;
    const hasExplicitWebIntent = descriptionSignals.isWebLikeEngineeringIssue;
    const hasExplicitPlatformIntent = descriptionSignals.isPlatformLikeEngineeringIssue;

    const readyEngineers = engineerCandidates.filter(isReadyCandidate);
    if (engineerCandidates.length === 0 && !hasExplicitQaIntent) return null;
    if (readyEngineers.length === 0 && !hasExplicitQaIntent) return null;

    if (hasExplicitQaIntent) {
      const qaPool = pickReadySpecialists(qaCandidates, isReadyCandidate);
      baseCandidatePool = qaPool.length > 0 ? qaPool : (readyEngineers.length > 0 ? readyEngineers : qaCandidates);
    } else if (hasExplicitWebIntent) {
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

  const ranked = candidatePool
    .map((candidate) => {
      const sameProjectLoad = sameProjectCounts.get(candidate.id) ?? 0;
      let score = Math.min(sameProjectLoad, 2) * 20;
      const descriptorText = buildCandidateDescriptorText(candidate);

      if (candidate.status === "idle") score += 25;
      else if (candidate.status === "running") score += 10;
      else if (candidate.status === "error") score -= 200;

      if (signals.isQaLikeIssue) {
        if (candidate.role === "qa" || QA_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (signals.isLeadLikeIssue) {
        if (candidate.role === "researcher" || LEAD_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (signals.isOnboardingLikeIssue) {
        if (candidate.role === "pm" || ONBOARDING_CANDIDATE_PATTERN.test(descriptorText)) score += 120;
      } else if (candidate.role === "engineer" || ENGINEERING_CANDIDATE_PATTERN.test(descriptorText)) {
        score += 140;
      } else {
        score -= 80;
      }

      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  return ranked[0]?.candidate ?? null;
}
