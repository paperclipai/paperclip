import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageEvidence } from "./evidence.js";
import { buildRunnerCampaign } from "./history.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { stageDashboardBrandAssets } from "./report-assets.js";
import { assertSecretFree, sanitizeJson } from "./redaction.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

/** Use the normal sanitizer, artifact manifest, validator, and dashboard. Raw
 * operator receipts stay in the private attempt; they are not auto-published. */
export async function writeAntigravityJourneyReport(input: {
  output: string; campaignId: string; result: RunnerE2EResult; resources: object;
  catalog: readonly MatrixExecution[]; secrets: readonly string[];
}) {
  const stage = await mkdtemp(path.join(os.tmpdir(), "antigravity-journey-report-"));
  const output = path.resolve(input.output);
  const evidenceDir = path.join(output, "evidence");
  const realOutput = await realpath(output);
  const save = async (root: string, name: string, value: unknown) => {
    const text = JSON.stringify(sanitizeJson(value, input.secrets), null, 2) + "\n";
    assertSecretFree(text, input.secrets, name);
    await writeFile(path.join(root, name), text, { mode: 0o600 });
  };
  try {
    await mkdir(path.join(stage, "snapshots"), { mode: 0o700 });
    const result = structuredClone(input.result);
    let finalStateStaged = false;
    for (const shot of result.screenshots ?? []) {
      const source = path.resolve(output, shot.file);
      if (!source.startsWith(`${output}${path.sep}`) || !/^[a-z0-9_-]+$/.test(shot.id) || path.extname(source) !== ".png") throw new Error("unsafe_journey_screenshot_reference");
      if (!(await realpath(source)).startsWith(`${realOutput}${path.sep}`)) throw new Error("unsafe_journey_screenshot_reference");
      const bytes = await readFile(source);
      if (shot.sha256 && createHash("sha256").update(bytes).digest("hex") !== shot.sha256) throw new Error("journey_screenshot_digest_mismatch");
      shot.file = `snapshots/${shot.id}.png`;
      await writeFile(path.join(stage, shot.file), bytes, { mode: 0o600 });
      if (result.status === "passed" && shot.id === "persisted" && result.antigravityJourney?.checkpoints.persisted === true) {
        await writeFile(path.join(stage, "final-state.png"), bytes, { mode: 0o600 });
        finalStateStaged = true;
      }
    }
    validateRetainedRunnerResult(result);
    if (result.status === "passed" && !finalStateStaged) throw new Error("journey_final_state_missing");
    await save(stage, "result.json", result);
    await save(stage, "snapshots/journey-resources.json", input.resources);
    await save(stage, "snapshots/journey-evidence.json", result.antigravityJourney);
    const manifest = await packageEvidence({ privateDir: stage, uploadDir: evidenceDir, secrets: input.secrets, expectPassScreenshot: false });
    if (manifest.leaks.length || manifest.missing.length) {
      result.status = "failed"; result.failureClass = "secret_leak"; result.error = "journey_evidence_packaging_failed";
      if (result.antigravityJourney) result.antigravityJourney.outcome = "failed";
    }
    await save(evidenceDir, "result.json", result);
    await save(evidenceDir, "evidence-manifest.json", manifest);
    const campaign = buildRunnerCampaign({ campaignId: input.campaignId, generatedAt: result.finishedAt, expected: [result.executionId], results: [result] });
    await save(output, "campaign.json", campaign);
    await save(output, "normalized-results.json", { ...campaign, results: [{ ...result, evidenceValid: !manifest.leaks.length && !manifest.missing.length, evidenceErrors: [] }] });
    await stageDashboardBrandAssets(output);
    const html = renderRunnerE2EDashboard({ title: "Google Antigravity setup and two-turn task", generatedAt: result.finishedAt, expected: [result.executionId], catalog: input.catalog, campaign,
      entries: [{ result, valid: !manifest.leaks.length && !manifest.missing.length, errors: [], evidenceBaseHref: "evidence" }] });
    assertSecretFree(html, input.secrets, "dashboard.html");
    await writeFile(path.join(output, "dashboard.html"), html, { mode: 0o600 });
    return result;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
