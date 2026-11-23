import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportTestOpsChat, TESTOPS_CHAT_EXECUTION } from "./testops-chat-export.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const binding = { runId: "123456", attempt: "1", workflowSha: "a".repeat(40), targetSha: "b".repeat(40) };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "testops-chat-export-")); directories.push(root);
  const report = path.join(root, "report"), output = path.join(root, "export");
  const screenshot = `evidence/${TESTOPS_CHAT_EXECUTION}/attempt-1/final-state.png`;
  await mkdir(path.dirname(path.join(report, screenshot)), { recursive: true });
  await writeFile(path.join(report, screenshot), png);
  const result = {
    schema: "paperclip.runner-e2e.result/v2", executionId: TESTOPS_CHAT_EXECUTION, suiteId: "chat-features", suiteDefinitionHash: "c".repeat(64),
    source: { sha: binding.targetSha, ref: "refs/heads/master", workflowRunUrl: `https://github.com/paperclipai/paperclip/actions/runs/${binding.runId}` },
    attempt: 1, status: "passed", cleanup: "passed", evidenceValid: true, runIds: ["synthetic-run"],
    profileId: "runner-opencode-deepseek-1017", environmentId: "local", caseId: "create-backlog", provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", runtimeMode: "native",
    startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", durationMs: 1000,
    matcherResults: [{ matcher: { kind: "json_path", path: "chat.saved-backlog", expected: true }, passed: true, detail: "Private diagnostic body" }],
    screenshots: [{ id: "final-state", label: "Fixture", file: "final-state.png", publication: "public-runner-fixture", sha256: digest(png) }],
    billing: { llm: { runCount: 1, runsWithTokenUsage: 1, runsWithReportedCost: 1, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, totalTokens: 120, reportedCostUsd: 0.01, costStatus: "reported" },
      runtime: { provider: "local", agentRunDurationMs: 1000, leaseDurationMs: null, leaseCount: 0, costStatus: "not_metered", costSource: "local_not_metered" },
      reportedCostUsd: 0.01, estimatedRuntimeCostUsd: 0, observedAndEstimatedCostUsd: null, complete: false },
    usage: { hiddenReasoning: "Do not export this provider body" }, unknownProviderBody: "Do not export this extra result field",
  };
  const campaign = { schema: "paperclip.runner-e2e.campaign/v2", campaignId: `gha-${binding.runId}-1`, expected: [TESTOPS_CHAT_EXECUTION], results: [result], retries: 0, generatedAt: result.finishedAt };
  const save = () => writeFile(path.join(report, "normalized-results.json"), JSON.stringify(campaign));
  await save(); return { report, output, result, campaign, save, screenshot };
}

it("exports the actual normalized result, marked PNG and bound hashes without opaque diagnostics", async () => {
  const f = await fixture(); await writeFile(path.join(f.report, "unapproved.log"), "private original");
  const receipt = await exportTestOpsChat(f.report, f.output, binding);
  const text = await readFile(path.join(f.output, "normalized-results.json"), "utf8"), projected = JSON.parse(text);
  expect(projected.results[0]).toMatchObject({ status: "passed", cleanup: "passed", provider: "opencode", model: f.result.model, runtimeMode: "native" });
  expect(projected.billing.llm.inputTokens).toBe(100); expect(projected.billing.testsWithCompleteBilling).toBe(0);
  expect(projected.complete).toBe(false);
  expect(text).not.toMatch(/Private diagnostic|hiddenReasoning|unknownProviderBody|Do not export/);
  expect(receipt.files.map(f => f.path).sort()).toEqual([f.screenshot, "junit.xml", "normalized-results.json"].sort());
  for (const file of receipt.files) expect(digest(await readFile(path.join(f.output, file.path)))).toBe(file.sha256);
  expect(JSON.parse(await readFile(path.join(f.output, "binding.json"), "utf8"))).toMatchObject({ ...binding, executionId: TESTOPS_CHAT_EXECUTION });
  expect(await readFile(path.join(f.output, "junit.xml"), "utf8")).toContain('failures="0"');
});

it("preserves a real failed grade and failed cleanup as failed JUnit", async () => {
  const f = await fixture(); f.result.status = "failed"; f.result.cleanup = "failed"; await f.save();
  await exportTestOpsChat(f.report, f.output, binding);
  expect(JSON.parse(await readFile(path.join(f.output, "normalized-results.json"), "utf8")).results[0]).toMatchObject({ status: "failed", cleanup: "failed" });
  expect(await readFile(path.join(f.output, "junit.xml"), "utf8")).toContain('failures="1"');
});

it.each(["selection", "source", "model", "retry", "evidence", "oracle", "cleanup", "run-count"])("rejects inconsistent %s before exporting a PASS", async kind => {
  const f = await fixture();
  if (kind === "selection") f.campaign.expected.push("other");
  if (kind === "source") f.result.source.sha = "d".repeat(40);
  if (kind === "model") f.result.model = "other/model";
  if (kind === "retry") f.result.attempt = 2;
  if (kind === "evidence") f.result.evidenceValid = false;
  if (kind === "oracle") f.result.matcherResults[0]!.passed = false;
  if (kind === "cleanup") f.result.cleanup = "failed";
  if (kind === "run-count") f.result.runIds.push("extra-run");
  await f.save(); await expect(exportTestOpsChat(f.report, f.output, binding)).rejects.toThrow();
  await expect(readFile(path.join(f.output, "binding.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["unmarked", "hash", "symlink"])("rejects %s screenshot evidence", async kind => {
  const f = await fixture();
  if (kind === "unmarked") f.result.screenshots[0]!.publication = "private";
  if (kind === "hash") f.result.screenshots[0]!.sha256 = "d".repeat(64);
  if (kind === "symlink") { const target = path.join(f.report, "original.png"); await writeFile(target, png); await rm(path.join(f.report, f.screenshot)); await symlink(target, path.join(f.report, f.screenshot)); }
  await f.save(); await expect(exportTestOpsChat(f.report, f.output, binding)).rejects.toThrow();
});

it("rejects a workflow replay and refuses to overwrite an existing export", async () => {
  const f = await fixture(); await expect(exportTestOpsChat(f.report, f.output, { ...binding, attempt: "2" })).rejects.toThrow();
  await exportTestOpsChat(f.report, f.output, binding);
  await expect(exportTestOpsChat(f.report, f.output, binding)).rejects.toMatchObject({ code: "EEXIST" });
});
