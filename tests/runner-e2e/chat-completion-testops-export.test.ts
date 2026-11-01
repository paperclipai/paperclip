import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { exportCompletionPilot } from "./chat-completion-testops-export.js";
import { exportPilotAllure } from "./chat-completion-testops-results.mjs";
import { cases, targetSha, evidencePolicy, hash } from "./chat-completion-testops-contract.mjs";
import { authorizeManualPrivateEvidence } from "./manual-private-retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const binding = { runId: "123456", attempt: "1", workflowSha: "a".repeat(40), targetSha };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "chat-completion-export-"))); roots.push(root);
  const report = path.join(root, "report"), output = path.join(root, "projection"), allure = path.join(root, "allure");
  const results = cases.map(row => ({
    schema: "paperclip.runner-e2e.result/v2", executionId: row.executionId, suiteId: "chat-features", suiteDefinitionHash: "c".repeat(64),
    source: { sha: targetSha, ref: "refs/heads/codex/chat-catalog-master-integration", workflowRunUrl: `https://github.com/paperclipai/paperclip/actions/runs/${binding.runId}` },
    attempt: 1, status: "passed", cleanup: "passed", evidenceValid: true,
    runIds: Array.from({ length: row.maximumRuns }, (_, i) => `synthetic-${row.key}-${i}`),
    profileId: "runner-opencode", environmentId: "local", caseId: row.scenario, provider: "opencode",
    model: "openrouter/deepseek/deepseek-v4.1-flash-1017", runtimeMode: "native",
    startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:01Z", durationMs: 1000,
    matcherResults: Array.from({ length: row.checks }, (_, i) => ({ matcher: { kind: "json_path", path: `fixture.check-${i}`, expected: true }, passed: true, detail: "OPAQUE_PROVIDER_BODY" })),
    screenshots: [], usage: { hiddenReasoning: "PRIVATE_REASONING_MUST_NOT_EXPORT" }, unknownField: "PRIVATE_PROVIDER_EXTRA",
  }));
  for (const row of cases) {
    const file = path.join(report, "evidence", row.executionId, "attempt-1", "final-state.png");
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, png);
  }
  const campaign = { schema: "paperclip.runner-e2e.campaign/v2", campaignId: `gha-${binding.runId}-1`,
    generatedAt: results[0]!.finishedAt, expected: cases.map(row => row.executionId), results, retries: 0 };
  const selected = { schema: "paperclip.chat-completion-testops-selection/v1", ...binding, projectId: 1,
    planId: 10, jobId: 11, launchId: 12, allureJobRunId: "77", cases: cases.map((row, i) => ({ ...row, caseId: 100 + i })) };
  const save = () => writeFile(path.join(report, "normalized-results.json"), JSON.stringify(campaign));
  await save(); return { root, report, output, allure, campaign, results, selected, save };
}

it("converts three original cases into three exact TestOps outcomes with all 35 checks and private-evidence receipts", async () => {
  const f = await fixture(); await writeFile(path.join(f.report, "private-provider.log"), "PRIVATE_LOG_MUST_NOT_EXPORT");
  await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  const projected = await readFile(path.join(f.output, "normalized-results.json"), "utf8");
  expect(projected).not.toMatch(/PRIVATE_|OPAQUE_PROVIDER_BODY|publication/);
  expect((await readdir(f.output)).sort()).toEqual(["binding.json", "junit.xml", "normalized-results.json"]);
  const receipt = JSON.parse(await readFile(path.join(f.output, "binding.json"), "utf8"));
  expect(receipt.privateEvidence.every((row: { finalScreenshot: { sha256: string } }) => /^[a-f0-9]{64}$/.test(row.finalScreenshot.sha256))).toBe(true);
  const exported = await exportPilotAllure(f.output, f.allure, binding, f.selected);
  expect(exported.map(row => row.caseId)).toEqual([100, 101, 102]);
  expect(exported.every(row => row.status === "passed" && row.attachments.length === 2)).toBe(true);
  const names = (await readdir(f.allure)).filter(name => name.endsWith("-result.json")); expect(names).toHaveLength(3);
  const rendered = await Promise.all(names.map(async name => JSON.parse(await readFile(path.join(f.allure, name), "utf8"))));
  expect(rendered.reduce((sum, row) => sum + row.steps.length, 0)).toBe(35);
  expect(rendered.map(row => row.fullName).sort()).toEqual(cases.map(row => row.fullName).sort());
  expect(rendered.every(row => row.start === Date.parse(f.results[0]!.startedAt))).toBe(true);
  expect(rendered.flatMap(row => row.labels.filter((label: { name: string }) => label.name === "AS_ID").map((label: { value: string }) => label.value)).sort()).toEqual(["100", "101", "102"]);
});

it("uses the unchanged evidence authority owner for the authenticated exact selection", async () => {
  const f = await fixture();
  const policy = evidencePolicy(f.selected, binding, "77");
  const identity = { ...binding, executionIds: f.campaign.expected };
  const admitted = authorizeManualPrivateEvidence(identity, JSON.stringify(policy));
  expect(admitted).toMatchObject({ targetSha, executionIds: f.campaign.expected, protocol: "paperclip.manual-private-evidence/v1" });
  expect(() => authorizeManualPrivateEvidence({ ...identity, executionIds: ["chat-features.runner-opencode.local.foreign"] }, JSON.stringify(policy))).toThrow();
  expect(() => authorizeManualPrivateEvidence({ ...identity, targetSha: "b".repeat(40) }, JSON.stringify(policy))).toThrow();
});

it.each([1, 2, 3])("accepts a genuine project-work pass with %i declared provider runs through both export gates", async count => {
  const f = await fixture();
  f.results[2]!.runIds = Array.from({ length: count }, (_, i) => `project-work-${i}`); await f.save();
  await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  expect((await exportPilotAllure(f.output, f.allure, binding, f.selected))[2]!.status).toBe("passed");
});

it.each([0, 4])("rejects project-work outside its declared range: %i runs", async count => {
  const f = await fixture();
  f.results[2]!.runIds = Array.from({ length: count }, (_, i) => `project-work-${i}`); await f.save();
  await expect(exportCompletionPilot(f.report, f.output, binding, f.campaign.expected)).rejects.toThrow();
});

it.each([0, 4])("the upload consumer independently rejects %i project-work runs", async count => {
  const f = await fixture(); await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  const file = path.join(f.output, "normalized-results.json");
  const campaign = JSON.parse(await readFile(file, "utf8"));
  campaign.results[2].runIds = Array.from({ length: count }, (_, i) => `project-work-${i}`);
  const bytes = Buffer.from(JSON.stringify(campaign)); await writeFile(file, bytes);
  const receiptFile = path.join(f.output, "binding.json"), receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  Object.assign(receipt.files.find((row: { path: string }) => row.path === "normalized-results.json"), { bytes: bytes.length, sha256: hash(bytes) });
  await writeFile(receiptFile, JSON.stringify(receipt));
  await expect(exportPilotAllure(f.output, f.allure, binding, f.selected)).rejects.toThrow();
});

it("retains failed grading and failed cleanup as a failed TestOps result", async () => {
  const f = await fixture(); f.results[1]!.status = "failed"; f.results[1]!.cleanup = "failed";
  f.results[1]!.matcherResults[0]!.passed = false; await f.save();
  await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  const exported = await exportPilotAllure(f.output, f.allure, binding, f.selected);
  expect(exported.map(row => row.status)).toEqual(["passed", "failed", "passed"]);
  expect(await readFile(path.join(f.output, "junit.xml"), "utf8")).toContain('failures="1"');
});

it("records a failed case with unavailable private evidence without inventing an image", async () => {
  const f = await fixture(); f.results[0]!.status = "failed"; f.results[0]!.evidenceValid = false;
  await rm(path.join(f.report, "evidence", f.results[0]!.executionId, "attempt-1", "final-state.png"));
  await f.save(); await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  const receipt = JSON.parse(await readFile(path.join(f.output, "binding.json"), "utf8"));
  expect(receipt.privateEvidence[0]).toMatchObject({ requiredEvidenceComplete: false, finalScreenshot: null });
  expect((await exportPilotAllure(f.output, f.allure, binding, f.selected))[0]!.status).toBe("failed");
});

it.each(["unexpected.png", "media"])("rejects private media added to the public artifact: %s", async name => {
  const f = await fixture(); await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  if (name === "media") await mkdir(path.join(f.output, name));
  else await writeFile(path.join(f.output, name), png);
  await expect(exportPilotAllure(f.output, f.allure, binding, f.selected)).rejects.toThrow();
});

it.each(["wrong-source", "wrong-workflow-run", "wrong-model", "retry", "missing-check", "failed-check", "cleanup", "run-count", "missing-image", "symlink"])("rejects %s before exporting a pass", async kind => {
  const f = await fixture(), first = f.results[0]!;
  if (kind === "wrong-source") first.source.sha = "b".repeat(40);
  if (kind === "wrong-workflow-run") first.source.workflowRunUrl += "9";
  if (kind === "wrong-model") first.model = "other/model";
  if (kind === "retry") first.attempt = 2;
  if (kind === "missing-check") first.matcherResults.pop();
  if (kind === "failed-check") first.matcherResults[0]!.passed = false;
  if (kind === "cleanup") first.cleanup = "failed";
  if (kind === "run-count") first.runIds.push("unexpected-run");
  const file = path.join(f.report, "evidence", first.executionId, "attempt-1", "final-state.png");
  if (kind === "missing-image") await rm(file);
  if (kind === "symlink") { await rm(file); const other = path.join(f.root, "unowned.png"); await writeFile(other, png); await symlink(other, file); }
  await f.save(); await expect(exportCompletionPilot(f.report, f.output, binding, f.campaign.expected)).rejects.toThrow();
  await expect(readFile(path.join(f.output, "binding.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses foreign selection and corrupt uploaded projection bytes", async () => {
  const f = await fixture(); await exportCompletionPilot(f.report, f.output, binding, f.campaign.expected);
  f.selected.cases[0]!.caseId = 999; f.selected.cases[0]!.fullName = "foreign.Case";
  await expect(exportPilotAllure(f.output, f.allure, binding, f.selected)).rejects.toThrow();
  f.selected.cases[0] = { ...cases[0]!, caseId: 100 };
  await writeFile(path.join(f.output, "normalized-results.json"), "{}");
  await expect(exportPilotAllure(f.output, f.allure, binding, f.selected)).rejects.toThrow();
});
