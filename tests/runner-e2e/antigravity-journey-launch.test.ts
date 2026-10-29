import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerMatrix } from "./catalog.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { parseAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { runAntigravityJourneyCampaign } from "./antigravity-journey-launch.js";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

const scenario = vi.hoisted(() => ({ config: undefined as any, authReads: 0, prepare: vi.fn(), flow: vi.fn(), close: vi.fn() }));
vi.mock("./antigravity-journey-config.js", async original => ({ ...await original<typeof import("./antigravity-journey-config.js")>(),
  loadAntigravityJourneyConfig: async () => scenario.config }));
vi.mock("./antigravity-journey-fixtures.js", async original => ({ ...await original<typeof import("./antigravity-journey-fixtures.js")>(),
  prepareAntigravityJourney: (...args: unknown[]) => scenario.prepare(...args) }));
vi.mock("./antigravity-journey-flow.js", () => ({ runAntigravityJourneyFlow: (...args: unknown[]) => scenario.flow(...args) }));
vi.mock("./connection-launch.js", () => ({
  withConnectionCampaignCancellation: (run: (signal: AbortSignal) => Promise<unknown>) => run(new AbortController().signal),
  openConnectionBrowser: async () => ({ close: scenario.close, context: {
    pages: () => [{ goto: async () => {}, isClosed: () => true }],
    request: { fetch: async () => {
      const status = ++scenario.authReads === 1 ? 401 : 200;
      return { ok: () => status === 200, status: () => status, json: async () => ({}) };
    } },
  } }),
}));
vi.mock("./connection-target.js", async original => ({ ...await original<typeof import("./connection-target.js")>(), connectionDelay: async () => {} }));

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputs: string[] = [];
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  originalExitCode = process.exitCode;
  scenario.authReads = 0; scenario.prepare.mockReset(); scenario.flow.mockReset(); scenario.close.mockReset();
  scenario.config = parseAntigravityJourneyConfig({ version: 1, setupId: "assisted-login-calibration", hosting: "self-hosted", executionEnvironment: "local",
    target: { mode: "attach", baseURL: "http://127.0.0.1:3104", expectedCommit: "a".repeat(40), deploymentMode: "authenticated",
      companyId: "11111111-1111-4111-8111-111111111111", environmentId: "22222222-2222-4222-8222-222222222222" },
    browser: { headed: true, channel: "chromium", freshness: "signed-in" },
    savedConnection: { id: "33333333-3333-4333-8333-333333333333", name: "Synthetic subscription", ownerUserId: "synthetic-operator" },
    candidate: { platform: "darwin", architecture: "arm64", nativeVersion: "1.4.3-paperclip.5", profileDigest: `sha256:${"b".repeat(64)}`, nativeClosureDigest: `sha256:${"c".repeat(64)}` },
    limits: { durationMs: 900_000, turnTimeoutMs: 300_000, maxRuns: 2, budgetCents: 100 } });
  scenario.prepare.mockResolvedValue({ identity: { commit: "a".repeat(40) }, company: { issuePrefix: "QA" },
    connection: { id: scenario.config.savedConnection.id, grantId: "synthetic-grant", ownerUserId: "synthetic-operator", isDefault: true, method: "subscription" }, accounting: {} });
});
afterEach(async () => {
  process.exitCode = originalExitCode;
  await Promise.all(outputs.splice(0).map(output => rm(output, { recursive: true, force: true })));
});

const executions = () => selectRunnerExecutions(parseRunnerSelectors(["--id", ANTIGRAVITY_JOURNEY_EXECUTION]), runnerMatrix);
it("blocks a measured attempt after assisted board login before agent or provider setup and retains a valid failed report", async () => {
  const output = await runAntigravityJourneyCampaign({ executions: executions(), catalog: runnerMatrix, repositoryRoot }); outputs.push(output);
  expect(scenario.prepare).not.toHaveBeenCalled(); expect(scenario.flow).not.toHaveBeenCalled();
  expect(scenario.authReads).toBe(2);
  const result = JSON.parse(await readFile(path.join(output, "evidence/result.json"), "utf8"));
  expect(result).toMatchObject({ status: "failed", error: "assisted_board_login_requires_fresh_case", runIds: [],
    antigravityJourney: { assisted: true, outcome: "blocked_target", phase: "board_authentication", turnEvidence: [] } });
  expect(result.antigravityJourney.agentId).toBeUndefined();
  expect(scenario.close).toHaveBeenCalledOnce();
});
it("allows assisted setup-only preflight to save board authentication without creating an agent or running a provider", async () => {
  const output = await runAntigravityJourneyCampaign({ executions: executions(), catalog: runnerMatrix, repositoryRoot, preflight: true }); outputs.push(output);
  expect(scenario.prepare).toHaveBeenCalledOnce(); expect(scenario.flow).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(path.join(output, "preflight.json"), "utf8"))).toMatchObject({ outcome: "ready", measured: false, providerPrompts: 0 });
  expect(scenario.close).toHaveBeenCalledOnce();
});
it("rejects explicit private Antigravity selection from paid matrix generation", () => {
  expect(executions()).toHaveLength(1);
  expect(() => buildMatrixJobs(executions())).toThrow("not admitted to paid CI matrix jobs");
});
