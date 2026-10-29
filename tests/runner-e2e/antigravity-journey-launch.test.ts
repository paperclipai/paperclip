import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runnerMatrix } from "./catalog.js";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { parseAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { createAntigravityResourceWriter, runAntigravityJourneyCampaign } from "./antigravity-journey-launch.js";
import type { AntigravityJourneyResources } from "./antigravity-journey-fixtures.js";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { ConnectionFailure } from "./connection-config.js";

const scenario = vi.hoisted(() => ({ config: undefined as any, authReads: 0, prepare: vi.fn(), flow: vi.fn(), close: vi.fn(), cleanup: vi.fn(), reportOutput: "", failBranding: false }));
const journalFs = vi.hoisted(() => ({ directory: "", fault: "", events: [] as string[], snapshots: [] as unknown[],
  gate: undefined as { entered(): void; wait: Promise<void>; used: boolean } | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  const owned = (file: unknown) => typeof file === "string" && journalFs.directory !== "" && file.startsWith(`${journalFs.directory}/`);
  const fail = (stage: string) => {
    if (journalFs.fault !== stage) return false;
    journalFs.fault = "";
    return true;
  };
  const recordWrite = async (data: unknown) => {
    journalFs.events.push("write");
    journalFs.snapshots.push(JSON.parse(String(data)));
    if (journalFs.gate && !journalFs.gate.used) {
      journalFs.gate.used = true;
      journalFs.gate.entered();
      await journalFs.gate.wait;
    }
  };
  return { ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (owned(args[0])) {
        await recordWrite(args[1]);
        if (fail("write")) {
          await actual.writeFile(args[0], '{"interrupted":', args[2]);
          throw new Error("fixture journal write failed");
        }
      }
      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const directory = args[0] === journalFs.directory;
      if (!directory && !owned(args[0])) return handle;
      journalFs.events.push(directory ? "directory-open" : "file-open");
      return new Proxy(handle, { get(target, key) {
        if (key === "writeFile") return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          await recordWrite(writeArgs[0]);
          if (fail("write")) {
            await target.writeFile('{"interrupted":');
            throw new Error("fixture journal write failed");
          }
          return target.writeFile(...writeArgs);
        };
        if (key === "sync") return async () => {
          const stage = directory ? "directory-sync" : "file-sync";
          journalFs.events.push(stage);
          if (fail(stage)) throw new Error(`fixture journal ${stage} failed`);
          return target.sync();
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (owned(args[1])) {
        journalFs.events.push("rename");
        if (fail("rename")) throw new Error("fixture journal rename failed");
      }
      return actual.rename(...args);
    },
  };
});
vi.mock("./antigravity-journey-config.js", async original => ({ ...await original<typeof import("./antigravity-journey-config.js")>(),
  loadAntigravityJourneyConfig: async () => scenario.config }));
vi.mock("./antigravity-journey-fixtures.js", async original => ({ ...await original<typeof import("./antigravity-journey-fixtures.js")>(),
  prepareAntigravityJourney: (...args: unknown[]) => scenario.prepare(...args),
  cleanupAntigravityJourney: (...args: unknown[]) => scenario.cleanup(...args) }));
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
vi.mock("./antigravity-journey-report.js", async original => {
  const actual = await original<typeof import("./antigravity-journey-report.js")>();
  return { ...actual, writeAntigravityJourneyReport: async (input: Parameters<typeof actual.writeAntigravityJourneyReport>[0]) => {
    scenario.reportOutput = input.output;
    return actual.writeAntigravityJourneyReport(input);
  } };
});
vi.mock("./report-assets.js", async original => {
  const actual = await original<typeof import("./report-assets.js")>();
  return { ...actual, stageDashboardBrandAssets: async (...args: Parameters<typeof actual.stageDashboardBrandAssets>) => {
    if (scenario.failBranding) throw new Error("fixture late branding failure");
    return actual.stageDashboardBrandAssets(...args);
  } };
});

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const outputs: string[] = [];
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  journalFs.directory = ""; journalFs.fault = ""; journalFs.events = []; journalFs.snapshots = []; journalFs.gate = undefined;
  originalExitCode = process.exitCode;
  scenario.authReads = 0; scenario.prepare.mockReset(); scenario.flow.mockReset(); scenario.close.mockReset();
  scenario.cleanup.mockReset();
  scenario.reportOutput = "";
  scenario.failBranding = false;
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
  await Promise.all([...new Set([...outputs.splice(0), scenario.reportOutput].filter(Boolean))].map(output => rm(output, { recursive: true, force: true })));
});

const executions = () => selectRunnerExecutions(parseRunnerSelectors(["--id", ANTIGRAVITY_JOURNEY_EXECUTION]), runnerMatrix);
async function resourceJournal() {
  const directory = await mkdtemp(path.join(tmpdir(), "antigravity-owned-journal-"));
  outputs.push(directory);
  const file = path.join(directory, "owned-resources.json");
  const resources: AntigravityJourneyResources = { version: 1, executionId: ANTIGRAVITY_JOURNEY_EXECUTION,
    origin: scenario.config.target.baseURL, companyId: scenario.config.target.companyId, environmentId: scenario.config.target.environmentId,
    connectionId: scenario.config.savedConnection.id, agentName: "Antigravity QA abcdef123456", runIds: [], retained: false,
    setupProbe: "not_started", processes: {} };
  await writeFile(file, JSON.stringify(resources), { mode: 0o600 });
  journalFs.directory = directory;
  return { directory, file, resources, persist: createAntigravityResourceWriter(file) };
}
it.each(["write", "file-sync", "rename"])("preserves the previous real ownership journal when replacement %s fails", async fault => {
  const f = await resourceJournal();
  const previous = await readFile(f.file, "utf8");
  f.resources.agentId = "66666666-6666-4666-8666-666666666666";
  journalFs.fault = fault;
  await expect(f.persist(f.resources)).rejects.toThrow(`fixture journal ${fault} failed`);
  expect(await readFile(f.file, "utf8")).toBe(previous);
  expect(await readdir(f.directory)).toEqual(["owned-resources.json"]);
  await f.persist(f.resources);
  expect(JSON.parse(await readFile(f.file, "utf8")).agentId).toBe(f.resources.agentId);
});
it("requires private synced replacement and directory sync before ownership journaling succeeds", async () => {
  const f = await resourceJournal();
  await f.persist(f.resources);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(journalFs.events).toEqual(["file-open", "write", "file-sync", "rename", "directory-open", "directory-sync"]);
  journalFs.fault = "directory-sync";
  f.resources.agentId = "66666666-6666-4666-8666-666666666666";
  await expect(f.persist(f.resources)).rejects.toThrow("fixture journal directory-sync failed");
  expect(JSON.parse(await readFile(f.file, "utf8")).agentId).toBe(f.resources.agentId);
  expect(await readdir(f.directory)).toEqual(["owned-resources.json"]);
});
it("serializes real ownership replacements and captures each snapshot before later mutations", async () => {
  const f = await resourceJournal();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  journalFs.gate = { entered, wait: new Promise<void>(resolve => { release = resolve; }), used: false };
  const first = f.persist(f.resources);
  await waiting;
  const pending = (await readdir(f.directory)).filter(file => file !== "owned-resources.json");
  const pendingModes = await Promise.all(pending.map(async file => (await stat(path.join(f.directory, file))).mode & 0o777));
  f.resources.agentId = "66666666-6666-4666-8666-666666666666";
  const second = f.persist(f.resources);
  f.resources.issueId = "88888888-8888-4888-8888-888888888888";
  const third = f.persist(f.resources);
  release();
  await Promise.all([first, second, third]);
  expect(pending).toHaveLength(1);
  expect(pendingModes).toEqual([0o600]);
  expect(journalFs.snapshots).toHaveLength(3);
  expect(journalFs.snapshots[0]).not.toHaveProperty("agentId");
  expect(journalFs.snapshots[1]).toMatchObject({ agentId: f.resources.agentId });
  expect(journalFs.snapshots[1]).not.toHaveProperty("issueId");
  expect(journalFs.snapshots[2]).toMatchObject({ agentId: f.resources.agentId, issueId: f.resources.issueId });
  expect(JSON.parse(await readFile(f.file, "utf8"))).toMatchObject({ agentId: f.resources.agentId, issueId: f.resources.issueId });
  expect(journalFs.events).toEqual(Array.from({ length: 3 }, () => ["file-open", "write", "file-sync", "rename", "directory-open", "directory-sync"]).flat());
});
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
it.each(["cancelled", "interrupted", "timed_out"])("packages settled %s usage captured during cleanup before public run rows are purged", async terminalStatus => {
  scenario.authReads = 1;
  const first = "44444444-4444-4444-8444-444444444444", discovered = "55555555-5555-4555-8555-555555555555";
  const agentId = "66666666-6666-4666-8666-666666666666";
  const issueId = "88888888-8888-4888-8888-888888888888";
  const run = (id: string, cost: number) => ({ id, agentId, issueId, companyId: scenario.config.target.companyId,
    status: terminalStatus, costAccountingPending: false, usageJson: { inputTokens: 100, outputTokens: 20, costUsd: cost },
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" });
  scenario.flow.mockImplementationOnce(async ({ resources, observeRun }) => {
    resources.agentId = agentId;
    resources.issueId = issueId;
    await observeRun({ ...run(first, 0.01), status: "running", costAccountingPending: true });
    throw new Error("fixture interrupted turn");
  });
  scenario.cleanup.mockImplementationOnce(async input => {
    input.resources.runIds.push(discovered);
    await input.captureRun(run(first, 0.6));
    await input.captureRun(run(discovered, 0.4));
    Object.assign(input.cleanup, { agent: true, runs: true, connectionPreserved: true });
  });
  const output = await runAntigravityJourneyCampaign({ executions: executions(), catalog: runnerMatrix, repositoryRoot }); outputs.push(output);
  const result = JSON.parse(await readFile(path.join(output, "evidence/result.json"), "utf8"));
  expect(result.runIds).toEqual([first, discovered]);
  expect(result.issueId).toBe(issueId);
  expect(result.billing.llm.reportedCostUsd).toBe(1);
  expect(result.runtimeUsage.agentRunDurationMs).toBe(2000);
  expect(result.cleanup).toBe("passed");
  expect(result.status).toBe("failed");
  expect(result.usage.runs.every((row: any) => row.usage.accountingReceiptReady !== false)).toBe(true);
  expect(JSON.parse(await readFile(path.join(output, "run-usage-observations.json"), "utf8")).runs).toHaveLength(2);
});
it("retains cleanup-discovered run identities with unknown usage when their public rows are unavailable", async () => {
  scenario.authReads = 1;
  const missing = "77777777-7777-4777-8777-777777777777";
  scenario.flow.mockImplementationOnce(async ({ resources }) => { resources.agentId = "66666666-6666-4666-8666-666666666666"; throw new Error("fixture interruption"); });
  scenario.cleanup.mockImplementationOnce(async ({ resources }) => { resources.runIds.push(missing); throw new Error("fixture run unavailable"); });
  const output = await runAntigravityJourneyCampaign({ executions: executions(), catalog: runnerMatrix, repositoryRoot }); outputs.push(output);
  const result = JSON.parse(await readFile(path.join(output, "evidence/result.json"), "utf8"));
  expect(result.runIds).toEqual([missing]);
  expect(result.usage.runs).toEqual([{ usage: null }]);
  expect(result.billing.complete).toBe(false);
  expect(result.runtimeUsage.agentRunDurationMs).toBeNull();
  expect(result.cleanup).toBe("failed");
});
it.each(["missing_screenshot", "late_assets"])("preserves the primary failure and accounting when real report packaging fails at %s", async failure => {
  scenario.authReads = 1;
  const run = { id: "44444444-4444-4444-8444-444444444444", agentId: "66666666-6666-4666-8666-666666666666",
    companyId: scenario.config.target.companyId, status: "failed", costAccountingPending: false,
    usageJson: { inputTokens: 100, outputTokens: 20, costUsd: 0.25 }, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z" };
  scenario.flow.mockImplementationOnce(async ({ resources, observeRun, checkpoint }) => {
    resources.agentId = run.agentId;
    await observeRun(run);
    if (failure === "missing_screenshot") await checkpoint("ordinary_picker", { url: () => `${scenario.config.target.baseURL}/QA/agents`,
      locator: () => ({ count: async () => 0 }), screenshot: async () => Buffer.from("fixture screenshot was not saved") });
    throw new ConnectionFailure("fixture_primary_failure");
  });
  scenario.failBranding = failure === "late_assets";
  scenario.cleanup.mockImplementationOnce(async ({ cleanup }) => Object.assign(cleanup, { agent: true, runs: true, connectionPreserved: true }));
  const output = await runAntigravityJourneyCampaign({ executions: executions(), catalog: runnerMatrix, repositoryRoot }); outputs.push(output);
  expect(process.exitCode).toBe(1);
  const source = JSON.parse(await readFile(path.join(output, "attempt-result.json"), "utf8"));
  const retained = JSON.parse(await readFile(path.join(output, "evidence/result.json"), "utf8"));
  expect(source).toMatchObject({ status: "failed", cleanup: "passed", failureClass: "candidate_failure", error: "fixture_primary_failure",
    antigravityJourney: { outcome: "failed" }, billing: { llm: { reportedCostUsd: 0.25 } } });
  expect(retained).toMatchObject({ status: "failed", cleanup: "passed", failureClass: "candidate_failure",
    error: "fixture_primary_failure; journey_report_packaging_failed" });
  for (const key of ["usage", "runtimeUsage", "billing", "screenshots", "antigravityJourney"]) expect(retained[key]).toEqual(source[key]);
  expect(JSON.parse(await readFile(path.join(output, "attempt-error.json"), "utf8")).error).toBe("fixture_primary_failure");
  expect(JSON.parse(await readFile(path.join(output, "packaging-error.json"), "utf8"))).toMatchObject({ code: "journey_report_packaging_failed",
    primary: { status: "failed", error: "fixture_primary_failure", outcome: "failed" } });
  if (failure === "late_assets") {
    expect(JSON.parse(await readFile(path.join(output, "packaging-source-result.json"), "utf8"))).toMatchObject({ error: "fixture_primary_failure" });
    expect(JSON.parse(await readFile(path.join(output, "packaging-source-evidence-manifest.json"), "utf8")).missing).toEqual([]);
  }
  const env = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  Object.assign(env, { PAPERCLIP_RUNNER_E2E_REPORT_ROOT: output, PAPERCLIP_RUNNER_E2E_REPORT_OUT: path.join(output, "rebuilt"),
    PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([ANTIGRAVITY_JOURNEY_EXECUTION]), PAPERCLIP_E2E_CAMPAIGN_ID: path.basename(output) });
  const rebuilt = spawnSync(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", "tests/runner-e2e/report.ts"], { cwd: repositoryRoot, env, timeout: 25_000, encoding: "utf8" });
  expect(rebuilt.status).toBe(1);
  const normalized = JSON.parse(await readFile(path.join(output, "rebuilt/normalized-results.json"), "utf8")).results[0];
  expect(normalized).toMatchObject({ status: "failed", cleanup: "passed", error: retained.error, usage: retained.usage, runtimeUsage: retained.runtimeUsage });
  expect(normalized.billing.llm.reportedCostUsd).toBe(0.25);
});
