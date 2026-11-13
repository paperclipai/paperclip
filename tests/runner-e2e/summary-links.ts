import {
  runnerE2ECampaignPublicUrl,
  validateHistoryPublicDestination,
} from "./history-destination.js";

export interface RunnerE2ESummaryLink {
  kind: "campaign" | "workflow" | "artifacts";
  label: string;
  url: string;
  note?: string;
}

function safeHttpsUrl(value: string | null | undefined) {
  const input = value?.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function runnerE2ESummaryLinks(input: {
  campaignId: string;
  workflowRunUrl: string | null | undefined;
  historyPublicBaseUrl: string | null | undefined;
  historyPrefix: string | null | undefined;
}): RunnerE2ESummaryLink[] {
  const links: RunnerE2ESummaryLink[] = [];
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.campaignId)) {
    try {
      const destination = validateHistoryPublicDestination({
        publicBaseUrl: input.historyPublicBaseUrl?.trim() ?? "",
        prefix: input.historyPrefix?.trim() ?? "",
      });
      links.push({
        kind: "campaign",
        label: "Open the exact interactive campaign report",
        url: runnerE2ECampaignPublicUrl(destination, input.campaignId),
        note: "available after the history publisher finishes",
      });
    } catch {
      // Invalid or absent history configuration must not prevent report merging.
    }
  }

  const workflowRun = safeHttpsUrl(input.workflowRunUrl);
  if (workflowRun) {
    links.push({
      kind: "workflow",
      label: "Open the workflow run and per-cell job logs",
      url: workflowRun.href,
    });
    workflowRun.hash = "artifacts";
    links.push({
      kind: "artifacts",
      label: "Download the merged report and per-cell evidence",
      url: workflowRun.href,
      note: "GitHub access required; retained for 30 days",
    });
  }
  return links;
}
