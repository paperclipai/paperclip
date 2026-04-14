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
    normalizeText(issue.identifier),
    normalizeText(issue.title),
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildCandidateDescriptorText(candidate: Pick<OperationsAssignmentCandidate, "name" | "title">): string {
  return [normalizeText(candidate.name), normalizeText(candidate.title)].filter(Boolean).join(" ");
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
    if (engineerCandidates.length === 0) return null;

    const readyEngineers = engineerCandidates.filter(isReadyCandidate);
    if (readyEngineers.length === 0) return null;

    const appEngineerCandidates = engineerCandidates.filter((candidate) => (
      APP_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const webEngineerCandidates = engineerCandidates.filter((candidate) => (
      WEB_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));
    const platformEngineerCandidates = engineerCandidates.filter((candidate) => (
      PLATFORM_ENGINEER_CANDIDATE_PATTERN.test(buildCandidateDescriptorText(candidate))
    ));

    const preferReadySpecialists = (specialists: OperationsAssignmentCandidate[]) => {
      const readySpecialists = specialists.filter(isReadyCandidate);
      return readySpecialists.length > 0 ? readySpecialists : readyEngineers;
    };

    if (signals.isAppLikeEngineeringIssue) {
      baseCandidatePool = preferReadySpecialists(appEngineerCandidates);
    } else if (signals.isWebLikeEngineeringIssue) {
      baseCandidatePool = preferReadySpecialists(webEngineerCandidates);
    } else if (signals.isPlatformLikeEngineeringIssue) {
      baseCandidatePool = preferReadySpecialists(platformEngineerCandidates);
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
