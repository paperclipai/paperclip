import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { buildRunnerCampaign, campaignHistoryRecord, emptyRunnerHistory } from "./history.js";
import { fullSuiteSelection, historyBrowserCampaign, historyBrowserJson, historySuiteCatalog, historySuiteCoverage } from "./history-browser.js";
import { refreshHistoryIndex } from "./history-refresh.js";
import type { RunnerE2EResult } from "./types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fixture() {
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: "app-basics.browser.daytona.create",
    suiteId: "app-basics", suiteDefinitionHash: "recorded-definition", profileId: "browser", environmentId: "daytona", caseId: "create",
    provider: null, model: null, runtimeMode: "none", targetUrl: "https://qa.test.paperclip.app/", attempt: 1,
    status: "passed", cleanup: "passed", startedAt: "2026-10-27T12:00:00Z", finishedAt: "2026-10-27T12:00:01Z", durationMs: 1000 };
  const campaign = buildRunnerCampaign({ campaignId: "qa-unchanged", generatedAt: result.finishedAt, expected: [result.executionId], results: [result] });
  return { result, campaign, record: campaignHistoryRecord(campaign, "https://reports.example.test/e2e") };
}

describe("E2E history organization", () => {
  it("includes unrun catalog suites and historical suites in one catalog", () => {
    const history = { ...emptyRunnerHistory(), campaigns: [fixture().record] };
    const suites = historySuiteCatalog(history, runnerMatrix);
    expect(suites.find(suite => suite.id === "app-basics")).toMatchObject({ campaignCount: 1 });
    expect(suites.find(suite => suite.id === "core-compatibility")).toMatchObject({ campaignCount: 0 });
    expect(new Set(suites.map(suite => suite.id)).size).toBe(suites.length);
  });

  it("uses the recorded full-selection verdict and denominator, independently of failures", () => {
    const suite = { ...fixture().record.suites[0]!, expected: 8, selected: 8, complete: true, passed: 5, failed: 3 };
    expect(fullSuiteSelection(suite)).toBe(true);
    expect(fullSuiteSelection({ ...suite, selected: 1, passed: 1, failed: 0 })).toBe(false);
    expect(fullSuiteSelection({ ...suite, complete: false })).toBe(false);
    expect(fullSuiteSelection({ ...suite, expected: 0, selected: 0 })).toBe(false);
    expect(historySuiteCoverage({ ...suite, executed: 8 })).toBe("full");
    expect(historySuiteCoverage({ ...suite, executed: 0 })).toBe("unfinished");
    expect(historySuiteCoverage({ ...suite, selected: 1 })).toBe("subset");
    expect(historySuiteCoverage({ ...suite, complete: false })).toBe("unknown");
  });

  it("records target and agent execution separately without inventing historical targets", () => {
    const { record } = fixture();
    expect(record.executions[0]).toMatchObject({ targetUrl: "https://qa.test.paperclip.app/", runtimeMode: "none", environmentId: "daytona" });
    const row = historyBrowserCampaign(record);
    expect(row.executions[0]).toMatchObject({ target: "https://qa.test.paperclip.app", environment: "daytona", provider: "__none__", model: "__none__" });
    delete record.executions[0]!.targetUrl;
    delete record.executions[0]!.runtimeMode;
    expect(historyBrowserCampaign(record).executions[0]).toMatchObject({ target: "__unknown__", model: "__unknown__" });
    record.executions[0]!.targetUrl = "https://user:secret@example.test";
    expect(historyBrowserCampaign(record).executions[0]!.target).toBe("__unknown__");
  });

  it("keeps public metadata inert inside the embedded JSON script", () => {
    const { record } = fixture(); record.source.ref = "</script><script>alert(1)</script>";
    const json = historyBrowserJson({ ...emptyRunnerHistory(), campaigns: [record] }, []);
    expect(json).not.toContain("<");
    expect(JSON.parse(json).campaigns[0].search).toContain(record.source.ref);
  });

  it("imports a reviewed QA measurement as an ordinary campaign and preserves original files and results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "e2e-history-refresh-")); temporary.push(root);
    const original = JSON.stringify(emptyRunnerHistory());
    const { campaign } = fixture(); const measured = JSON.stringify(campaign);
    await writeFile(path.join(root, "history.json"), original); await writeFile(path.join(root, "campaign.json"), measured);
    const output = path.join(root, "output");
    const history = await refreshHistoryIndex({ history: path.join(root, "history.json"), output, publicCampaign: path.join(root, "campaign.json"), publicUrl: "https://pages.paperclip.ing/evals-qa-basics/", preset: "qa-smoke" });
    expect(history.campaigns[0]).toMatchObject({ campaignId: campaign.campaignId, generatedAt: campaign.generatedAt, source: campaign.source,
      suites: campaign.suites, selected: campaign.selected, passed: campaign.passed, preset: "qa-smoke" });
    expect(await readFile(path.join(root, "history.json"), "utf8")).toBe(original);
    expect(await readFile(path.join(root, "campaign.json"), "utf8")).toBe(measured);
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain('data-index-preset-link="qa-smoke"');
    await expect(refreshHistoryIndex({ history: path.join(output, "history.json"), output, publicCampaign: path.join(root, "campaign.json"), publicUrl: "https://pages.paperclip.ing/evals-qa-basics/" })).rejects.toThrow("already exists");
  });

  it("refuses private Cloud bundles before creating a public history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "e2e-private-history-")); temporary.push(root);
    const { campaign } = fixture();
    campaign.results[0]!.productJourney = { privacy: "private" } as NonNullable<RunnerE2EResult["productJourney"]>;
    await writeFile(path.join(root, "history.json"), JSON.stringify(emptyRunnerHistory()));
    await writeFile(path.join(root, "private.json"), JSON.stringify(campaign));
    await expect(refreshHistoryIndex({ history: path.join(root, "history.json"), output: path.join(root, "output"),
      publicCampaign: path.join(root, "private.json"), publicUrl: "https://pages.paperclip.ing/private/" })).rejects.toThrow("Private Product E2E campaigns");
  });
});
