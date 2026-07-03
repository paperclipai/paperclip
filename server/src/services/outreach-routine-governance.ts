export interface OutreachRoutineGovernanceConfig {
  companyId: string;
  operationsProjectId: string;
  outreachProjectId: string;
  automateLabelId: string;
  outreachLabelId: string;
  contentLabelId?: string | null;
  ceoAgentId: string;
  outreachManagerAgentId: string;
  outreachDirectReportAgentIds: string[];
}

export const OUTREACH_ROUTINE_GOVERNANCE_CONFIG_ENV = "OUTREACH_ROUTINE_GOVERNANCE_CONFIG";

const EXEMPT_TITLE_PREFIXES = [
  "Review productivity for",
  "[HOT LEAD]",
  "[INDUSTRY INTEL]",
  "Content idea:",
];

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonEmptyStringArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  const items = value.map(nonEmptyString).filter((item): item is string => Boolean(item));
  return items.length === value.length ? items : null;
}

export function parseOutreachRoutineGovernanceConfig(raw: string | undefined = process.env[OUTREACH_ROUTINE_GOVERNANCE_CONFIG_ENV]) {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${OUTREACH_ROUTINE_GOVERNANCE_CONFIG_ENV} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${OUTREACH_ROUTINE_GOVERNANCE_CONFIG_ENV} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const config = {
    companyId: nonEmptyString(record.companyId),
    operationsProjectId: nonEmptyString(record.operationsProjectId),
    outreachProjectId: nonEmptyString(record.outreachProjectId),
    automateLabelId: nonEmptyString(record.automateLabelId),
    outreachLabelId: nonEmptyString(record.outreachLabelId),
    contentLabelId: record.contentLabelId == null ? null : nonEmptyString(record.contentLabelId),
    ceoAgentId: nonEmptyString(record.ceoAgentId),
    outreachManagerAgentId: nonEmptyString(record.outreachManagerAgentId),
    outreachDirectReportAgentIds: nonEmptyStringArray(record.outreachDirectReportAgentIds),
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== "contentLabelId" && (value == null || (Array.isArray(value) && value.length === 0)))
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`${OUTREACH_ROUTINE_GOVERNANCE_CONFIG_ENV} missing required field(s): ${missing.join(", ")}`);
  }
  return config as OutreachRoutineGovernanceConfig;
}

export function standardOutreachReviewPolicy(reviewerAgentId: string): Record<string, unknown> {
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

export function isOutreachRoutineIssue(
  config: OutreachRoutineGovernanceConfig | null,
  input: {
    companyId: string;
    title: string;
    assigneeAgentId?: string | null;
  },
) {
  if (!config) return false;
  if (input.companyId !== config.companyId) return false;
  if (isOutreachGovernanceExemptTitle(input.title)) return false;
  if (input.assigneeAgentId === config.outreachManagerAgentId) return true;
  if (input.assigneeAgentId && new Set(config.outreachDirectReportAgentIds).has(input.assigneeAgentId)) return true;
  return /outreach manager/i.test(input.title);
}

export function resolveOutreachRoutineGovernance(input: {
  companyId: string;
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  config?: OutreachRoutineGovernanceConfig | null;
}) {
  const config = input.config ?? parseOutreachRoutineGovernanceConfig();
  if (!config) return null;
  if (!isOutreachRoutineIssue(config, input)) return null;

  const text = `${input.title}\n${input.description ?? ""}`.toLowerCase();
  const isOrgProcess = /\b(self-improvement|self improvement|automation|automate|executionpolicy scan|policy scan|governance|audit)\b/.test(text);
  const title = input.title.toLowerCase();
  const isLinkedInContent = /\blinkedin\b/.test(title) && /\b(content|publish|post)\b/.test(title);
  const reviewerAgentId = input.assigneeAgentId === config.outreachManagerAgentId || /outreach manager/i.test(input.title)
    ? config.ceoAgentId
    : config.outreachManagerAgentId;

  return {
    projectId: isOrgProcess ? config.operationsProjectId : config.outreachProjectId,
    labelIds: [
      ...(isOrgProcess ? [config.automateLabelId] : []),
      config.outreachLabelId,
      ...(isLinkedInContent && config.contentLabelId ? [config.contentLabelId] : []),
    ],
    executionPolicy: standardOutreachReviewPolicy(reviewerAgentId),
  };
}
