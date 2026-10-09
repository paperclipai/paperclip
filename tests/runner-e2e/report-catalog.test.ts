import { renderPublicCampaignSummary } from "./public-summary-image.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { discoverReportCatalog } from "./report-catalog.js";
import { buildRunnerCampaign } from "./history.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import type { RunnerE2EResult } from "./types.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const id = "branch-only-chat.branch-provider.local.conversation";
const missingId = "branch-only-chat.branch-provider.local.reset";
function result(): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    executionId: id,
    suiteId: "branch-only-chat",
    suiteDefinitionHash: "branch-definition",
    profileId: "branch-provider",
    environmentId: "local",
    caseId: "conversation",
    provider: '<img src=x onerror="alert(1)">',
    model: "branch-model",
    runtimeMode: "native",
    attempt: 1,
    status: "passed",
    cleanup: "passed",
    durationMs: 1000,
    startedAt: "2026-09-11T21:00:00.000Z",
    finishedAt: "2026-09-11T21:00:01.000Z",
    screenshots: [
      {
        id: "final-state",
        label: '<script>alert("label")</script>',
        file: "final-state.png",
        publication: "public-runner-fixture",
      },
    ],
  };
}
function campaign(results: RunnerE2EResult[] = [result()]) {
  return buildRunnerCampaign({
    campaignId: "branch-campaign",
    generatedAt: "2026-09-11T21:01:00.000Z",
    expected: [id, missingId],
    results,
  });
}

describe("trusted report catalog discovery", () => {
  it("aggregates unknown suites and renders their cases, missing results, and screenshot gallery", () => {
    const summary = campaign();
    expect(summary.suites).toEqual([
      expect.objectContaining({
        suiteId: "branch-only-chat",
        selected: 2,
        executed: 1,
        passed: 1,
        failed: 1,
        complete: false,
      }),
    ]);
    const page = renderRunnerE2EDashboard({
      title: "Report",
      generatedAt: summary.generatedAt,
      expected: summary.expected,
      catalog: [],
      campaign: summary,
      entries: [
        {
          result: result(),
          valid: true,
          errors: [],
          evidenceBaseHref: `evidence/${id}/attempt-1`,
          evidenceFiles: ["final-state.png"],
        },
      ],
    });
    expect(page).toContain('id="suite-branch-only-chat"');
    expect(page).toContain('class="suite-summary"');
    expect(page).toContain(`data-execution-id="${id}"`);
    expect(page).toContain(`data-execution-id="${missingId}"`);
    expect(page).toContain('class="case case-missing"');
    expect(page).toContain("No result artifact was uploaded");
    expect(page).toContain(
      `data-gallery-href="evidence/${id}/attempt-1/final-state.png"`,
    );
    expect(page).toContain("View gallery · 1");
    expect(page).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(page).not.toContain("<img src=x");
    expect(page).not.toContain('<script>alert("label")</script>');
  });

  it("renders selected branch suites in the public summary image without provider content", () => {
    const page = renderPublicCampaignSummary(campaign());
    expect(page).toContain("<strong>1/2</strong>");
    expect(page).toContain("<span>branch-only-chat</span>");
    expect(page).not.toContain("<strong>0/0</strong>");
    expect(page).not.toContain("onerror");
    expect(page).not.toContain("branch-model");
  });

  it("retains ordinary catalog metadata and marks no-results branch selections failed", () => {
    const catalog = discoverReportCatalog({
      catalog: runnerMatrix,
      expected: [runnerMatrix[0]!.id],
      results: [],
    });
    expect(catalog).toEqual(runnerMatrix);
    expect(catalog[0]).toBe(runnerMatrix[0]);
    expect(campaign([])).toMatchObject({
      selected: 2,
      executed: 0,
      passed: 0,
      failed: 2,
      suites: [
        expect.objectContaining({ suiteId: "branch-only-chat", failed: 2 }),
      ],
    });
  });

  it("uses known profile metadata in a new suite and rejects forged identities", () => {
    const known = runnerMatrix[0]!;
    const knownProfileId = `branch-only-chat.${known.profile.id}.${known.environment.id}.conversation`;
    expect(
      discoverReportCatalog({
        catalog: runnerMatrix,
        expected: [knownProfileId],
        results: [],
      }).at(-1)?.profile,
    ).toBe(known.profile);
    expect(() =>
      discoverReportCatalog({
        catalog: [],
        expected: [id],
        results: [{ ...result(), suiteId: "forged-suite" }],
      }),
    ).toThrow("Result identity does not match");
    expect(() =>
      discoverReportCatalog({
        catalog: [],
        expected: ["../../private"],
        results: [],
      }),
    ).toThrow("Invalid report execution identity");
    expect(() =>
      discoverReportCatalog({ catalog: [], expected: [id, id], results: [] }),
    ).toThrow("must be unique");
  });

  it("regenerates branch-only cards and gallery from persisted JSON using trusted code", async () => {
    const bundle = await mkdtemp(
      path.join(os.tmpdir(), "branch-report-regenerate-"),
    );
    temporary.push(bundle);
    const evidence = path.join(bundle, "evidence", id, "attempt-1");
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, "final-state.png"), "fixture");
    await writeFile(
      path.join(bundle, "normalized-results.json"),
      JSON.stringify({ ...campaign(), suites: [] }),
    );
    await regenerateRunnerDashboard({ bundle, historyFile: null });
    const page = await readFile(path.join(bundle, "index.html"), "utf8");
    expect(page).toContain(`data-execution-id="${id}"`);
    expect(page).toContain(`data-execution-id="${missingId}"`);
    expect(page).toContain(
      `data-gallery-href="evidence/${id}/attempt-1/final-state.png"`,
    );
    const normalized = JSON.parse(
      await readFile(path.join(bundle, "normalized-results.json"), "utf8"),
    );
    expect(normalized.suites).toEqual([
      expect.objectContaining({
        suiteId: "branch-only-chat",
        selected: 2,
        passed: 1,
        failed: 1,
      }),
    ]);
  });

  it("generates an explicit failed result with the correct unknown identity when no artifact exists", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "branch-report-missing-"),
    );
    temporary.push(root);
    const out = path.join(root, "merged");
    const repo = path.resolve(import.meta.dirname, "../..");
    await promisify(execFile)(
      process.execPath,
      [
        path.join(repo, "cli/node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "tests/runner-e2e/report.ts"),
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
          PAPERCLIP_RUNNER_E2E_REPORT_OUT: out,
          PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([missingId]),
        },
      },
    ).catch((error: { code?: number }) => {
      if (error.code !== 1) throw error;
    });
    const normalized = JSON.parse(
      await readFile(path.join(out, "normalized-results.json"), "utf8"),
    );
    expect(normalized.results).toEqual([
      expect.objectContaining({
        executionId: missingId,
        suiteId: "branch-only-chat",
        profileId: "branch-provider",
        caseId: "reset",
        attempt: 0,
        status: "failed",
      }),
    ]);
    expect(normalized.suites).toEqual([
      expect.objectContaining({
        suiteId: "branch-only-chat",
        failed: 1,
        executed: 0,
      }),
    ]);
    expect(await readFile(path.join(out, "index.html"), "utf8")).toContain(
      `data-execution-id="${missingId}"`,
    );
  });
  it.each([
    "1/../../../escape",
    "<img src=x onerror=alert(1)>",
    -1,
    1.5,
    Infinity,
  ])("rejects malformed attempts before report staging: %s", (attempt) => {
    expect(() =>
      campaign([{ ...result(), attempt } as RunnerE2EResult]),
    ).toThrow("result.attempt");
  });

  it("validates nested timing and billing fields before rendering", () => {
    const malicious = {
      ...result(),
      turnTimings: [{ turn: "<script>alert(1)</script>" }],
    } as unknown as RunnerE2EResult;
    expect(() => campaign([malicious])).toThrow("result.turnTimings[0].turn");
    const measured = campaign().results[0]!;
    expect(() =>
      campaign([
        {
          ...measured,
          billing: {
            ...measured.billing!,
            llm: {
              ...measured.billing!.llm,
              runCount: "<img>" as unknown as number,
            },
          },
        },
      ]),
    ).toThrow("result.billing.llm.runCount");
  });

  it("does not certify a same-sized replacement matrix or changed suite definition", () => {
    const known = runnerMatrix.filter(
      (entry) => entry.suite.id === runnerMatrix[0]!.suite.id,
    );
    const receipts = known.map((entry) => ({
      ...result(),
      executionId: entry.id,
      suiteId: entry.suite.id,
      suiteDefinitionHash: entry.suiteDefinitionHash,
      profileId: entry.profile.id,
      environmentId: entry.environment.id,
      caseId: entry.task.id,
    }));
    const build = (results: RunnerE2EResult[]) =>
      buildRunnerCampaign({
        campaignId: "matrix-proof",
        generatedAt: result().finishedAt,
        expected: results.map((item) => item.executionId),
        results,
      });
    expect(build(receipts).suites[0]!.complete).toBe(true);
    const replacement = receipts.map((item, index) =>
      index
        ? item
        : {
            ...item,
            caseId: "replacement",
            executionId: item.executionId.replace(/[^.]+$/, "replacement"),
          },
    );
    expect(build(replacement).suites[0]!.complete).toBe(false);
    expect(
      build(
        receipts.map((item) => ({
          ...item,
          suiteDefinitionHash: "different-definition",
        })),
      ).suites[0]!.complete,
    ).toBe(false);
  });
});
