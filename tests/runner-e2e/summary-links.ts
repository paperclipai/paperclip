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
  publicCampaignBaseUrl: string | null | undefined;
}): RunnerE2ESummaryLink[] {
  const links: RunnerE2ESummaryLink[] = [];
  const campaignBase = safeHttpsUrl(input.publicCampaignBaseUrl);
  if (
    campaignBase &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.campaignId)
  ) {
    campaignBase.pathname = `${campaignBase.pathname.replace(/\/+$/, "")}/${encodeURIComponent(input.campaignId)}/index.html`;
    links.push({
      kind: "campaign",
      label: "Open the exact interactive campaign report",
      url: campaignBase.href,
      note: "available after the history publisher finishes",
    });
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
