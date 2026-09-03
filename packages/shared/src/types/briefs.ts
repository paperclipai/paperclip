export interface BriefsOverviewWarning {
  code: "built_in_agent_paused";
  key: string;
  agentId: string;
  message: string;
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
  status: "ready" | "paused";
  generatedAt: string;
  agent: BriefsOverviewAgent;
  warning: BriefsOverviewWarning | null;
  summaryItems: BriefsOverviewSummaryItem[];
}
