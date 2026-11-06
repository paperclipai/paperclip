import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { abnormalFinalizationResult } from "./abnormal-finalization.js";
import { runnerMatrix } from "./catalog.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { packageEvidence } from "./evidence.js";
import { publicScreenshotPaths, prunePrivateHistoryEvidence } from "./history-publish.js";
import { buildRunnerCampaign } from "./history.js";
import { sanitizePrivateReporterArtifacts } from "./private-reporter-artifacts.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { screenshotWithholdingNotice, withholdPrivateScreenshots } from "./screenshot-privacy.js";
import type { RunnerE2EResult } from "./types.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function result(): RunnerE2EResult {
  const e = runnerMatrix.find(row => row.suite.id === "chat-features" && row.profile.id === "runner-opencode" && row.environment.id === "local")!;
  return { schema: "paperclip.runner-e2e.result/v2", executionId: e.id, suiteId: e.suite.id, suiteDefinitionHash: e.suiteDefinitionHash,
    attempt: 1, status: "failed", failureClass: "candidate_failure", profileId: e.profile.id, environmentId: e.environment.id, caseId: e.task.id,
    provider: e.profile.provider, model: e.profile.model, runtimeMode: e.profile.expectedRuntimeMode, startedAt: "2026-10-28T00:00:00.000Z",
    finishedAt: "2026-10-28T00:00:01.000Z", durationMs: 1000, cleanup: "passed",
    screenshots: [{ id: "failure", label: "Synthetic image", file: "failure.png", publication: "public-runner-fixture", sha256: createHash("sha256").update(png).digest("hex") }] };
}
it.each(["inner", "persisted", "reporter", "packaged"] as const)("retains %s privacy custody through cleanup and repeated clean finalization", finding => {
  const original = result();
  const held = withholdPrivateScreenshots(original, { innerSecretFinding: finding === "inner", persistedStateSecretFinding: finding === "persisted",
    reporterEvidenceWithheld: finding === "reporter", packagedEvidenceSecretFinding: finding === "packaged" });
  const wrapped = { ...abnormalFinalizationResult(held, new Error("packaging failed")), failureClass: "cleanup_failure" as const, cleanup: "failed" as const };
  const final = withholdPrivateScreenshots(wrapped);
  expect(final.screenshotPrivacy?.reasons).toHaveLength(1);
  expect(final.screenshotPrivacy).toEqual(held.screenshotPrivacy);
  expect(final.screenshots?.[0]).toEqual({ id: "failure", label: "Synthetic image", file: "failure.png", sha256: original.screenshots![0]!.sha256 });
  expect(original.screenshots![0]!.publication).toBe("public-runner-fixture");
  expect(final.status).toBe("failed"); expect(final.cleanup).toBe("failed");
  expect(screenshotWithholdingNotice(final)).toContain("original images remain private");
  expect(() => validateRetainedRunnerResult(final)).not.toThrow();
});
it("keeps clean behavior-failure screenshots publishable and rejects forged withholding metadata", () => {
  const original = result();
  expect(withholdPrivateScreenshots(original)).toBe(original);
  expect(screenshotWithholdingNotice(original)).toBeNull();
  const campaign = buildRunnerCampaign({ campaignId: "clean", generatedAt: original.finishedAt, expected: [original.executionId], results: [original] });
  expect([...publicScreenshotPaths(campaign)]).toHaveLength(1);
  for (const screenshotPrivacy of [{ withheld: false, reasons: ["inner-secret-finding"] }, { withheld: true, reasons: [] }, { withheld: true, reasons: ["arbitrary private text"] }])
    expect(() => validateRetainedRunnerResult({ ...original, screenshotPrivacy })).toThrow("screenshotPrivacy");
});
it.each(["redacted", "omitted"] as const)("withholds synthetic PNG after actual reporter %s even when packaged scans are empty", async disposition => {
  const root = await mkdtemp(path.join(os.tmpdir(), "screenshot-privacy-")); roots.push(root);
  const privateDir = path.join(root, "private"), packaged = path.join(root, "packaged");
  await mkdir(path.join(privateDir, "playwright-output"), { recursive: true });
  await writeFile(path.join(privateDir, "failure.png"), png);
  const secret = "synthetic-reporter-canary-only-2345";
  if (disposition === "redacted") await writeFile(path.join(privateDir, "playwright-output", "error-context.md"), `Synthetic field ${secret}`);
  else {
    await mkdir(path.join(privateDir, "blob-report"));
    await writeFile(path.join(root, "synthetic-report.txt"), secret);
    execFileSync("zip", ["-q", path.join(privateDir, "blob-report", "report.zip"), "synthetic-report.txt"], { cwd: root });
  }
  const issues = await sanitizePrivateReporterArtifacts(privateDir, [secret]);
  expect(issues).toMatchObject([{ disposition, reason: "exact secret value" }]);
  const original = result(), held = withholdPrivateScreenshots(original, { reporterEvidenceWithheld: issues.length > 0 });
  const final = { ...held, failureClass: "cleanup_failure" as const, cleanup: "failed" as const };
  await writeFile(path.join(privateDir, "result.json"), JSON.stringify(final));
  expect(await packageEvidence({ privateDir, uploadDir: packaged, secrets: [secret], expectPassScreenshot: false })).toMatchObject({ leaks: [], missing: [] });
  const stage = path.join(root, "public-stage"), base = `evidence/${final.executionId}/attempt-1`;
  await mkdir(path.join(stage, "evidence"), { recursive: true });
  await cp(packaged, path.join(stage, base), { recursive: true });
  const campaign = buildRunnerCampaign({ campaignId: "privacy-synthetic", generatedAt: final.finishedAt, expected: [final.executionId], results: [final] });
  await writeFile(path.join(stage, "normalized-results.json"), JSON.stringify(campaign));
  const allowed = publicScreenshotPaths(campaign);
  expect([...allowed]).toEqual([]);
  await prunePrivateHistoryEvidence(stage, allowed);
  await expect(readFile(path.join(stage, base, "failure.png"))).rejects.toThrow();
  expect(await readFile(path.join(privateDir, "failure.png"))).toEqual(png);
  expect(await readFile(path.join(packaged, "failure.png"))).toEqual(png);
  await regenerateRunnerDashboard({ bundle: stage });
  const html = await readFile(path.join(stage, "index.html"), "utf8");
  expect(html).toContain("Screenshots withheld after a privacy finding");
  expect(html).not.toContain(`data-gallery-href="${base}/failure.png"`);
});
