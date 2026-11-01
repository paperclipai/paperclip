import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { journeyRequiredChecks } from "./success-contract.js";

vi.mock("@playwright/test", () => ({ chromium: { launch: async () => ({
  newContext: async () => ({ setDefaultTimeout() {}, pages: () => [] }), close: async () => {},
}) }, expect: {} }));
vi.mock("./clarification-flow.js", () => ({ runClarificationJourney: async (_context: unknown, _session: unknown,
  _campaignId: unknown, evidence: { checks: Array<{ id: string; passed: boolean }> }) => {
  evidence.checks.push(...journeyRequiredChecks["question-answer-resume"]!.map(id => ({ id, passed: true })));
} }));
vi.mock("../dashboard-regenerate.js", () => ({ regenerateRunnerDashboard: async ({ outputDirectory }: { outputDirectory: string }) => {
  await Promise.all(["index.html", "dashboard.html"].map(file => writeFile(path.join(outputDirectory, file), "dashboard")));
} }));
import { launchProductJourneys } from "./launch.js";

const roots: string[] = [];
afterEach(async () => { process.exitCode = 0; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function campaign(count: number, omitReceipt = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clarification-collection-")); roots.push(root);
  const module = path.join(root, "provider.mjs"), output = path.join(root, "report");
  const runIds = Array.from({ length: count }, (_, i) => `bound-run-${i}`);
  const receipts = omitReceipt ? [] : [{ journeyId: "question-answer-resume", runIds,
    usage: { runs: runIds.map(runId => ({ runId, usage: { costUsd: 0.01 } })) } }];
  await writeFile(module, `
const identity = { kind: 'cloud', targetId: 'qa', origin: 'https://qa.example.test', commit: '${"a".repeat(40)}', cloudRelease: 'v1', runtimeImage: 'image', configurationHash: 'config' };
const context = { identity, company: { id: 'company', issuePrefix: 'QA' }, user: { id: 'board', name: 'QA' },
  api: { origin: identity.origin }, startingState: 'recipe', capabilities: ['company', 'board-user', 'task-write', 'agent'],
  agent: { id: 'agent', name: 'QA', provider: 'opencode', model: 'model', runtimeMode: 'native' }, environmentId: 'daytona',
  page: { url: () => identity.origin + '/QA/issues/QA-1', locator: () => ({ waitFor: async () => {}, isVisible: async () => true, screenshot: async () => {} }) } };
export const provider = { version: 1, async acquire() { return {
  async authenticate() {}, async prepare() { return context; }, async identity() { return identity; },
  async collect() { return ${JSON.stringify(receipts)}; }, async own() {}, async release() { return 'released'; }, async stop() {}
}; } };`);
  const file = path.join(root, "target.json");
  await writeFile(file, JSON.stringify({ version: 1, id: "qa", mode: "existing-cloud", adapterModule: module,
    journeys: ["question-answer-resume"], executionEnvironment: "daytona", baseline: { features: {}, connections: [] },
    limits: { durationMs: 60_000, modelBudgetCents: 100, maxRuns: 3 } }));
  await launchProductJourneys(["--target-config", file, "--output", output], path.resolve(import.meta.dirname, "../../.."));
  return JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8")).results[0];
}

it.each([1, 2, 3])("collects a successful clarification journey with %i native work runs", async count => {
  const result = await campaign(count);
  expect(result).toMatchObject({ status: "passed", cleanup: "passed", productJourney: { outcome: "passed" } });
  expect(result.runIds).toHaveLength(count);
  expect(result.productJourney.phases).toContainEqual({ phase: "collection", outcome: "passed" });
  expect(result.usage.runs).toHaveLength(count);
});
it.each([0, 4])("rejects a clarification collection with %i native work runs", async count => {
  const result = await campaign(count);
  expect(result).toMatchObject({ status: "failed", error: "paid_journey_receipt_missing" });
  expect(result.runIds).toHaveLength(count);
});
it("rejects a passing story when its provider omits collection entirely", async () => {
  expect(await campaign(1, true)).toMatchObject({ status: "failed", error: "paid_journey_receipt_missing" });
});
