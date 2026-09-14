import { describe, expect, it } from "vitest";
import { runnerE2ESummaryLinks } from "./summary-links.js";

describe("runner E2E summary links", () => {
  it("builds exact public, workflow, and artifact links", () => {
    expect(
      runnerE2ESummaryLinks({
        campaignId: "gha-34026735033-1",
        workflowRunUrl:
          "https://github.com/paperclipai/paperclip/actions/runs/34026735033",
        historyPublicBaseUrl: "https://reports.example.test///",
        historyPrefix: "/runner-e2e/",
      }),
    ).toEqual([
      {
        kind: "campaign",
        label: "Open the exact interactive campaign report",
        url: "https://reports.example.test/runner-e2e/campaigns/gha-34026735033-1/index.html",
        note: "available after the history publisher finishes",
      },
      {
        kind: "workflow",
        label: "Open the workflow run and per-cell job logs",
        url: "https://github.com/paperclipai/paperclip/actions/runs/34026735033",
      },
      {
        kind: "artifacts",
        label: "Download the merged report and per-cell evidence",
        url: "https://github.com/paperclipai/paperclip/actions/runs/34026735033#artifacts",
        note: "GitHub access required; retained for 30 days",
      },
    ]);
  });

  it("omits unsafe or incomplete destinations", () => {
    expect(
      runnerE2ESummaryLinks({
        campaignId: "../other-campaign",
        workflowRunUrl: "https://token@example.test/actions/runs/1",
        historyPublicBaseUrl: "http://reports.example.test",
        historyPrefix: "runner-e2e",
      }),
    ).toEqual([]);
    expect(
      runnerE2ESummaryLinks({
        campaignId: "gha-1-1",
        workflowRunUrl: null,
        historyPublicBaseUrl: null,
        historyPrefix: null,
      }),
    ).toEqual([]);
    expect(
      runnerE2ESummaryLinks({
        campaignId: "gha-1-1",
        workflowRunUrl: null,
        historyPublicBaseUrl: "https://reports.example.test",
        historyPrefix: "runner-e2e#other",
      }),
    ).toEqual([]);
  });
});
