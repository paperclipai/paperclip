import { describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { buildRunnerCampaign, campaignHistoryRecord, emptyRunnerHistory, mergeRunnerHistory } from "./history.js";
import { renderRunnerHistoryIndex } from "./history-index.js";
import { renderReportShell, reportHistoryHref } from "./report-navigation.js";

describe("evaluation report navigation", () => {
  it("never gives global pages a campaign suite tree or campaign selector", () => {
    const campaign = buildRunnerCampaign({campaignId:"global-fixture",generatedAt:"2026-10-20T12:00:00Z",expected:[runnerMatrix[0]!.id],results:[]});
    const history = mergeRunnerHistory(null,campaignHistoryRecord(campaign,"https://reports.example.test/runner-e2e"));
    const page = renderRunnerHistoryIndex(history);
    const sidebar = page.slice(page.indexOf('<aside '), page.indexOf('</aside>'));
    expect(sidebar).toContain("Overview");
    expect(sidebar).toContain("Needs attention");
    expect(sidebar).toContain("Campaign history");
    expect(sidebar).not.toContain("Suites");
    expect(page).not.toContain('aria-label="Campaign suites"');
    expect(page).not.toContain('data-nav-campaign aria-label="Campaign"');
  });

  it("lists cases once within selected suites while keeping every execution and missing result", () => {
    const first = runnerMatrix.find(row => row.suite.id === "everyday-workflows")!;
    const variants = runnerMatrix.filter(row => row.suite.id === first.suite.id && row.task.id === first.task.id);
    const page = renderRunnerE2EDashboard({
      title: "Selected campaign", generatedAt: "2026-10-20T12:00:00Z",
      expected: variants.map(row => row.id), catalog: runnerMatrix, entries: [],
    });
    const sidebar = page.slice(page.indexOf('<aside '), page.indexOf('</aside>'));
    expect(sidebar.match(/data-nav-case=/g)).toHaveLength(1);
    expect(sidebar.match(/data-nav-suite=/g)).toHaveLength(1);
    expect(sidebar).not.toContain('data-nav-suite="core-compatibility"');
    expect(page.match(/class="case case-missing"/g)).toHaveLength(variants.length);
    for(const row of variants) expect(page).toContain(`id="execution-${row.id}"`);
    expect(page).toContain('aria-label="Execution configurations"');
  });

  it("escapes campaign labels and derives the global history link from the actual report location", () => {
    const page = renderReportShell({campaignId:'<script>alert("x")</script>', catalog:[]});
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
    const history = emptyRunnerHistory();
    history.campaigns = [{campaignId:"campaign-a",publicUrl:"/custom/reports/campaigns/campaign-a/"} as typeof history.campaigns[number]];
    expect(reportHistoryHref(history,"campaign-a")).toBe("/custom/reports/");
    expect(reportHistoryHref(undefined,"campaign-a")).toBe("../../");
  });
});
