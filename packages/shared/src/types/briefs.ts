export interface BriefsOverviewWarning {
  code: "built_in_agent_paused" | "built_in_agent_unavailable";
  key: string;
  agentId: string;
  message: string;
  status: string;
  pauseReason: string | null;
}

export interface BriefsOverviewAgent {
  id: string;
  name: string;
  status: string;
  adapterType: string;
}

export interface BriefsOverviewSummaryItem {
  label: string;
  value: string;
  detail?: string;
}

export interface BriefsOverview {
  featureKey: "briefs";
  status: "ready" | "paused" | "unavailable";
  generatedAt: string;
  agent: BriefsOverviewAgent;
  warning: BriefsOverviewWarning | null;
  summaryItems: BriefsOverviewSummaryItem[];
}
