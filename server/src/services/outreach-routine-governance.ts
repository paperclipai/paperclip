export const RR_COMPANY_ID = "0fabe377-3008-4cde-96ad-b1ae5eb5e469";
export const RR_OPERATIONS_PROJECT_ID = "8e99b255-02f1-401d-ab06-93cc8dc15552";
export const RR_OUTREACH_GO_LIVE_PROJECT_ID = "202c77b2-e2d0-4030-a416-e41fcf246a3e";
export const RR_AUTOMATE_LABEL_ID = "519fc58e-0411-4b5d-bdeb-02fb637e4f8f";
export const RR_OUTREACH_LABEL_ID = "7f4ac6f1-6e9e-472d-a751-899b6a0c16d1";
export const RR_CONTENT_LABEL_ID = "6c443851-fe4f-44e9-b11f-a4e2b9a4cbcd";
export const RR_CEO_AGENT_ID = "ce56f1d2-941d-42b1-a54b-fc99897d6e9e";
export const RR_OUTREACH_MANAGER_AGENT_ID = "c100bafe-c428-4e55-be99-0ec4ebaa32a0";

const RR_OUTREACH_DIRECT_REPORT_AGENT_IDS = new Set([
  "e7651b93-a8ca-4c74-8ac0-2003678abb77",
  "431f481e-ee9a-4bac-a38a-8076db805f09",
  "a4a8d13b-3f28-49fb-b16e-78e5ba5a57f3",
  "6962d181-7524-4a9b-a1a2-de5e7de1f7f1",
  "e27b046d-6518-492c-99d6-d10ad8cdea63",
  "7fd12a67-5597-4eba-ae75-e4c2aea9cb7c",
]);

const EXEMPT_TITLE_PREFIXES = [
  "Review productivity for",
  "[HOT LEAD]",
  "[INDUSTRY INTEL]",
  "Content idea:",
];

function standardReviewPolicy(reviewerAgentId: string): Record<string, unknown> {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      },
    ],
  };
}

export function isOutreachGovernanceExemptTitle(title: string) {
  return EXEMPT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
}

export function isRrOutreachRoutineIssue(input: {
  companyId: string;
  title: string;
  assigneeAgentId?: string | null;
}) {
  if (input.companyId !== RR_COMPANY_ID) return false;
  if (isOutreachGovernanceExemptTitle(input.title)) return false;
  if (input.assigneeAgentId === RR_OUTREACH_MANAGER_AGENT_ID) return true;
  if (input.assigneeAgentId && RR_OUTREACH_DIRECT_REPORT_AGENT_IDS.has(input.assigneeAgentId)) return true;
  return /outreach manager/i.test(input.title);
}

export function resolveRrOutreachRoutineGovernance(input: {
  companyId: string;
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
}) {
  if (!isRrOutreachRoutineIssue(input)) return null;

  const text = `${input.title}\n${input.description ?? ""}`.toLowerCase();
  const isOrgProcess = /\b(self-improvement|self improvement|automation|automate|executionpolicy scan|policy scan|governance|audit)\b/.test(text);
  const title = input.title.toLowerCase();
  const isLinkedInContent = /\blinkedin\b/.test(title) && /\b(content|publish|post)\b/.test(title);
  const reviewerAgentId = input.assigneeAgentId === RR_OUTREACH_MANAGER_AGENT_ID || /outreach manager/i.test(input.title)
    ? RR_CEO_AGENT_ID
    : RR_OUTREACH_MANAGER_AGENT_ID;

  return {
    projectId: isOrgProcess ? RR_OPERATIONS_PROJECT_ID : RR_OUTREACH_GO_LIVE_PROJECT_ID,
    labelIds: [
      ...(isOrgProcess ? [RR_AUTOMATE_LABEL_ID] : []),
      RR_OUTREACH_LABEL_ID,
      ...(isLinkedInContent ? [RR_CONTENT_LABEL_ID] : []),
    ],
    executionPolicy: standardReviewPolicy(reviewerAgentId),
  };
}
