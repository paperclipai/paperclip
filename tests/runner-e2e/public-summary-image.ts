import path from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { runnerMatrix } from "./catalog.js";
import type { RunnerE2ECampaign } from "./types.js";

const MAX_PUBLIC_EXECUTION_DURATION_MS = 24 * 60 * 60 * 1_000;

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function durationLabel(durationMs: number) {
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function renderPublicCampaignSummary(campaign: RunnerE2ECampaign) {
  const catalogById = new Map(
    runnerMatrix.map((execution) => [execution.id, execution]),
  );
  const expectedIds = [
    ...new Set(
      campaign.expected.filter((executionId) => catalogById.has(executionId)),
    ),
  ];
  const expectedIdSet = new Set(expectedIds);
  const resultById = new Map(
    campaign.results
      .filter((result) => expectedIdSet.has(result.executionId))
      .map((result) => [result.executionId, result]),
  );
  const isPassed = (executionId: string) => {
    const result = resultById.get(executionId);
    return result?.status === "passed" && result.cleanup === "passed";
  };
  const passed = expectedIds.filter(isPassed).length;
  const durationMs = [...resultById.values()].reduce(
    (total, result) =>
      total +
      (Number.isFinite(result.durationMs) && result.durationMs >= 0
        ? Math.min(result.durationMs, MAX_PUBLIC_EXECUTION_DURATION_MS)
        : 0),
    0,
  );
  const suites = [
    ...new Map(
      runnerMatrix.map((execution) => [
        execution.suite.id,
        execution.suite.label,
      ]),
    ),
  ].map(([suiteId, label]) => {
    const selectedIds = expectedIds.filter(
      (executionId) => catalogById.get(executionId)?.suite.id === suiteId,
    );
    return {
      label,
      selected: selectedIds.length,
      passed: selectedIds.filter(isPassed).length,
    };
  });
  const rows = suites
    .filter((suite) => suite.selected > 0)
    .map(
      (suite) => `<div class="suite">
        <span>${html(suite.label)}</span>
        <strong>${suite.passed}/${suite.selected}</strong>
        <em>${suite.passed === suite.selected ? "Passed" : "Needs attention"}</em>
      </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { width: 1400px; min-height: 780px; margin: 0; padding: 70px; color: #11110f; background: #f4f1e8; font: 24px/1.35 ui-sans-serif, system-ui, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 42px; border-bottom: 2px solid #cbc6b8; }
    .brand { display: flex; align-items: center; gap: 16px; font-weight: 750; letter-spacing: -.03em; }
    .mark { width: 44px; height: 44px; display: grid; place-items: center; border: 3px solid #11110f; border-radius: 50%; font-size: 24px; }
    .campaign { color: #5f5b52; font: 600 18px/1.3 ui-monospace, monospace; }
    main { padding-top: 54px; }
    .eyebrow { margin: 0 0 10px; color: #676157; font: 700 16px/1.2 ui-monospace, monospace; letter-spacing: .09em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 66px; line-height: 1; letter-spacing: -.055em; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin: 46px 0; }
    .metric { padding: 26px; border: 2px solid #cbc6b8; border-radius: 18px; background: #fffdf7; }
    .metric strong, .metric span { display: block; }
    .metric strong { font: 750 44px/1 ui-monospace, monospace; }
    .metric span { margin-top: 10px; color: #676157; font-size: 16px; text-transform: uppercase; letter-spacing: .07em; }
    .suites { display: grid; gap: 12px; }
    .suite { display: grid; grid-template-columns: 1fr 120px 190px; align-items: center; padding: 17px 22px; border-top: 1px solid #cbc6b8; }
    .suite strong { font: 700 22px/1 ui-monospace, monospace; }
    .suite em { color: #676157; font-size: 17px; font-style: normal; text-align: right; }
    footer { margin-top: 44px; color: #676157; font-size: 15px; }
  </style>
</head>
<body>
  <header><div class="brand"><span class="mark">P</span><span>Paperclip</span></div><div class="campaign">Trusted history publication</div></header>
  <main>
    <p class="eyebrow">Runner full-stack E2E</p>
    <h1>Campaign summary</h1>
    <section class="metrics">
      <div class="metric"><strong>${passed}/${expectedIds.length}</strong><span>Known executions passed</span></div>
      <div class="metric"><strong>${expectedIds.length - passed}</strong><span>Failed or incomplete</span></div>
      <div class="metric"><strong>${html(durationLabel(durationMs))}</strong><span>Total test time</span></div>
    </section>
    <section class="suites">${rows}</section>
    <footer>Generated from fixed catalog labels and sanitized numeric/status fields. Provider output is never rendered here.</footer>
  </main>
</body>
</html>`;
}

export async function writePublicCampaignSummaryImage(
  campaign: RunnerE2ECampaign,
  output: string,
) {
  await mkdir(path.dirname(output), { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    env: {
      LANG: "C.UTF-8",
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.RUNNER_TEMP ?? "/tmp",
    },
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await context.setOffline(true);
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(renderPublicCampaignSummary(campaign), {
      waitUntil: "domcontentloaded",
    });
    await page.screenshot({
      path: output,
      type: "png",
      fullPage: true,
      animations: "disabled",
    });
    await context.close();
  } finally {
    await browser.close();
  }
}
