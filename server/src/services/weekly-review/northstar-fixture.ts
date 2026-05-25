import type {
  LocalAdapterAssuranceType,
  WeeklyReviewFindingCategory,
  WeeklyReviewFindingSeverity,
} from "@paperclipai/shared";

export interface NorthstarExpectedFinding {
  stableId: `NSR-F0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  category: WeeklyReviewFindingCategory;
  severity: WeeklyReviewFindingSeverity;
  workstream: string;
  title: string;
}

export interface NorthstarDesiredModelPolicy {
  selectedProfile: "primary";
  selectedModel: string | null;
  requiredModel: string | null;
  assuranceSource: "desired_fixture_policy";
  cheapProfileAllowedForLowRiskWork: boolean;
}

export interface NorthstarFixtureAgent {
  key: string;
  name: string;
  title: string;
  workstream: string;
  adapterType: LocalAdapterAssuranceType;
  modelPolicy: NorthstarDesiredModelPolicy;
}

export const NORTHSTAR_EXPECTED_FINDINGS: ReadonlyArray<Readonly<NorthstarExpectedFinding>> = Object.freeze([
  Object.freeze({
    stableId: "NSR-F01",
    category: "decision_blocker",
    severity: "critical",
    workstream: "Operations",
    title: "Support handoff owner missing blocks broad rollout",
  }),
  Object.freeze({
    stableId: "NSR-F02",
    category: "action_required",
    severity: "high",
    workstream: "Governance",
    title: "Approve limited pilot rollout",
  }),
  Object.freeze({
    stableId: "NSR-F03",
    category: "action_required",
    severity: "high",
    workstream: "Operations",
    title: "Assign Support/Ops Lead owner",
  }),
  Object.freeze({
    stableId: "NSR-F04",
    category: "evidence_gap",
    severity: "high",
    workstream: "Research & Insights",
    title: "Research brief has one unsupported customer-segment claim",
  }),
  Object.freeze({
    stableId: "NSR-F05",
    category: "stale_item",
    severity: "medium",
    workstream: "Operations",
    title: "Operations runbook update is stale and still blocks support handoff",
  }),
  Object.freeze({
    stableId: "NSR-F06",
    category: "budget_signal",
    severity: "medium",
    workstream: "Budget",
    title: "Budget warning from citation-validation retries and prototype implementation spend",
  }),
  Object.freeze({
    stableId: "NSR-F07",
    category: "quality_signal",
    severity: "medium",
    workstream: "Research & Insights",
    title: "Research summarization run failed validation",
  }),
  Object.freeze({
    stableId: "NSR-F08",
    category: "win_context",
    severity: "low",
    workstream: "Product Delivery",
    title: "Cited weekly inbox digest prototype is ready for limited pilot",
  }),
]);

export function buildNorthstarFixturePlan() {
  return {
    company: {
      name: "Northstar Labs",
      issuePrefix: "NSR",
      goal: "Operate a small AI product and research studio with reliable weekly delivery, support, and governance.",
    },
    agents: [
      agent("ceo", "CEO", "Governance", "claude_local", {}),
      agent("product-lead", "Product Lead", "Governance", "claude_local", {}),
      agent("engineering-lead", "Engineering Lead", "Product Delivery", "codex_local", {}),
      agent("research-insights-lead", "Research & Insights Lead", "Research & Insights", "agy_local", {
        selectedModel: "gemini-3.5-flash",
        requiredModel: "gemini-3.5-flash",
      }),
      agent("support-ops-lead", "Support/Ops Lead", "Operations", "claude_local", {}),
      agent("finance-ops-analyst", "Finance/Ops Analyst", "Budget", "claude_local", {}),
    ],
    expectedFindings: NORTHSTAR_EXPECTED_FINDINGS.map((finding) => ({ ...finding })),
  };
}

function agent(
  key: string,
  title: string,
  workstream: string,
  adapterType: LocalAdapterAssuranceType,
  modelPolicyOverrides: Partial<NorthstarDesiredModelPolicy>,
): NorthstarFixtureAgent {
  return {
    key,
    name: title,
    title,
    workstream,
    adapterType,
    modelPolicy: {
      selectedProfile: "primary",
      selectedModel: null,
      requiredModel: null,
      assuranceSource: "desired_fixture_policy",
      cheapProfileAllowedForLowRiskWork: true,
      ...modelPolicyOverrides,
    },
  };
}
