export const PLUGIN_ID = "consultadd-govbids-pipeline";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  dailyScan: "daily-opportunity-scan",
} as const;

export const TOOL_NAMES = {
  searchOpportunities: "search-opportunities",
  scoreOpportunity: "score-opportunity",
  pushToHubspot: "push-to-hubspot",
  getOpportunitySummary: "get-opportunity-summary",
} as const;

export const STATE_KEYS = {
  lastCapturedDate: "last-captured-date",
  lastRunStats: "last-run-stats",
  monthlyApiCalls: "monthly-api-calls",
} as const;
