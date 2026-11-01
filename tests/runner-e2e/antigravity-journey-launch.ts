import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { ANTIGRAVITY_JOURNEY_MODEL, antigravityConnectionConfig, loadAntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { gradeAntigravityJourney, type AntigravityJourneyEvidence } from "./antigravity-journey-evidence.js";
import { cleanupAntigravityJourney, isAntigravityRunAccountingSettled, observeAntigravityRun, parseAntigravityOwnedResources, prepareAntigravityJourney, type AntigravityJourneyResources, type AntigravityProcessObservers } from "./antigravity-journey-fixtures.js";
import { runAntigravityJourneyFlow } from "./antigravity-journey-flow.js";
import { writeAntigravityJourneyReport } from "./antigravity-journey-report.js";
import { buildRuntimeUsage, summarizeExecutionBilling } from "./billing.js";
import { ConnectionBlock, ConnectionFailure, assertPrivateFile } from "./connection-config.js";
import { openConnectionBrowser, withConnectionCampaignCancellation } from "./connection-launch.js";
import { ConnectionApi, connectionDelay, verifyConnectionTarget } from "./connection-target.js";
import { FixtureRegistry } from "./fixture-registry.js";
import { assertSecretFree, sanitizeJson } from "./redaction.js";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

export function createAntigravityResourceWriter(file: string) {
  let writes = Promise.resolve();
  return async (resources: AntigravityJourneyResources) => {
    const text = JSON.stringify(sanitizeJson(resources, []), null, 2) + "\n";
    assertSecretFree(text, [], "owned-resources.json");
    const next = writes.catch(() => {}).then(async () => {
      const directory = path.dirname(file), parent = await lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
        || (process.getuid && parent.uid !== process.getuid())) throw new ConnectionFailure("unsafe_antigravity_resource_directory");
      const existing = await lstat(file).catch(error => { if (error.code === "ENOENT") return; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)
        || (process.getuid && existing.uid !== process.getuid()))) throw new ConnectionFailure("unsafe_antigravity_resource_file");
      const temporary = path.join(directory, `.owned-resources-${randomBytes(12).toString("hex")}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
        const parentHandle = await open(directory, "r");
        try { await parentHandle.sync(); } finally { await parentHandle.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    writes = next;
    await next;
  };
}

type Row = Record<string, any>;
/** Known charges are an observed stop threshold. Missing subscription prices
 * stay unknown, and this does not install or weaken any product budget policy. */
export function antigravityKnownCostObservation(runs: readonly Row[], budgetCents: number) {
  const billing = summarizeExecutionBilling({ environmentId: "local", durationMs: 0, runIds: runs.map(run => run.id),
    usage: { runs: runs.map(run => ({ usage: run.usageJson })) } });
  const knownCostUsd = billing.llm.reportedCostUsd + (billing.llm.estimatedCostUsd ?? 0);
  const thresholdUsd = budgetCents / 100;
  return { budgetCents, knownCostUsd, costStatus: billing.llm.costStatus, priceCoverageComplete: billing.complete,
    hardCurrencyCap: false, exceeded: knownCostUsd - thresholdUsd > Number.EPSILON * Math.max(1, knownCostUsd) };
}
async function sourceProvenance(repositoryRoot: string, suiteDefinitionHash: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 });
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean)
    .filter(file => /^(?:packages|server|ui|cli|tests|doc|maps|rules)\//.test(file) && /\.(?:md|ts|tsx|js|mjs|cjs|json|toml|rs|yaml|yml|sh|py|sql|css|html)$/.test(file)).sort();
  const hash = createHash("sha256"); let count = 0;
  for (const file of untracked) {
    const absolute = path.resolve(repositoryRoot, file);
    if (!absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) throw new ConnectionFailure("unsafe_source_provenance_path");
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new ConnectionFailure("untracked_source_provenance_unavailable");
    hash.update(file).update("\0").update(await readFile(absolute)).update("\0"); count++;
  }
  return { head: git(["rev-parse", "HEAD"]).toString("utf8").trim(), trackedDiffSha256: createHash("sha256").update(git(["diff", "--binary", "HEAD"])).digest("hex"),
    untrackedSourceSha256: hash.digest("hex"), untrackedSourceFileCount: count, suiteDefinitionHash, dirty: git(["status", "--porcelain"]).length > 0 };
}
export async function runAntigravityJourneyCampaign(input: {
  executions: readonly MatrixExecution[]; catalog: readonly MatrixExecution[]; configFile?: string; repositoryRoot: string;
  preflight?: boolean; recoverFile?: string;
}) {
  if (input.executions.length !== 1 || input.executions[0]!.id !== ANTIGRAVITY_JOURNEY_EXECUTION)
    throw new ConnectionFailure("Select exactly the registered Antigravity journey cell separately");
  if (process.env.PAPERCLIP_E2E_OPERATIONS_MANIFEST) throw new ConnectionFailure("Antigravity journey has no budgeted routing qualification");
  if (input.preflight && input.recoverFile) throw new ConnectionFailure("Preflight and recovery are separate operations");
  const config = await loadAntigravityJourneyConfig(input.configFile);
  return withConnectionCampaignCancellation(async campaignSignal => {
    const execution = input.executions[0]!;
    const startedAt = new Date().toISOString(), nonce = randomBytes(6).toString("hex");
    const campaignId = `antigravity-journey-${startedAt.replace(/[:.]/g, "-")}-${nonce}`;
    const output = path.join(input.repositoryRoot, "tests/runner-e2e/results", campaignId);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const provenance = await sourceProvenance(input.repositoryRoot, execution.suiteDefinitionHash);
    const save = async (name: string, value: unknown) => {
      const text = JSON.stringify(sanitizeJson(value, []), null, 2) + "\n";
      assertSecretFree(text, [], name); await writeFile(path.join(output, name), text, { mode: 0o600 });
    };
    const deadline = new AbortController(), signal = AbortSignal.any([campaignSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), config.limits.durationMs);
    const evidence: AntigravityJourneyEvidence = { version: 1, setupId: config.setupId, hosting: "self-hosted", targetCommit: null,
      phase: "configuration", outcome: "running", assisted: false, privacy: "private", authentication: "saved-subscription", model: ANTIGRAVITY_JOURNEY_MODEL,
      companyId: config.target.companyId, connectionId: config.savedConnection.id, checkpoints: {}, turnEvidence: [],
      cleanup: { agent: true, runs: true, connectionPreserved: false } };
    const resources: AntigravityJourneyResources = { version: 1, executionId: execution.id, origin: config.target.baseURL,
      companyId: config.target.companyId, environmentId: config.target.environmentId, connectionId: config.savedConnection.id,
      agentName: `Antigravity QA ${nonce}`, runIds: [], retained: false, setupProbe: "not_started", processes: {}, sourceProvenance: provenance };
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: execution.id, suiteId: execution.suite.id,
      suiteDefinitionHash: execution.suiteDefinitionHash, source: { sha: provenance.head,
        ref: `${execFileSync("git", ["branch", "--show-current"], { cwd: input.repositoryRoot, encoding: "utf8" }).trim()}${provenance.dirty ? " (working tree)" : ""}`, workflowRunUrl: null }, attempt: 1, status: "failed", profileId: execution.profile.id, environmentId: execution.environment.id,
      caseId: execution.task.id, provider: "acpx", model: ANTIGRAVITY_JOURNEY_MODEL, runtimeMode: "native", startedAt, finishedAt: startedAt,
      durationMs: 0, cleanup: "not_started", antigravityJourney: evidence, screenshots: [] };
    const observed = new Map<string, Row>(), observers: AntigravityProcessObservers = new Map();
    let browser: Awaited<ReturnType<typeof openConnectionBrowser>> | undefined;
    let fixtures: Awaited<ReturnType<FixtureRegistry["setupAll"]>> | undefined;
    let api: ConnectionApi | undefined;
    let operationOnly = Boolean(input.preflight || input.recoverFile), operationPassed = false;
    const assertActive = () => { if (signal.aborted) throw new ConnectionBlock("blocked_target", campaignSignal.aborted ? "test_interrupted" : "journey_deadline_reached"); };
    const writeResources = createAntigravityResourceWriter(path.join(output, "owned-resources.json"));
    const persistResources = () => writeResources(resources);
    let finalizationFailed = false;
    const retainFinalizationFailure = (code: string, ownershipCleanup = false) => {
      finalizationFailed = true;
      result.status = "failed";
      if (!result.error?.split("; ").includes(code)) result.error = `${result.error ? `${result.error}; ` : ""}${code}`;
      if (ownershipCleanup) {
        result.cleanup = "failed"; evidence.outcome = "failed"; result.failureClass = "cleanup_failure";
        resources.retained = Boolean(resources.agentId || resources.agentCreationRequest);
      } else result.failureClass ??= "permanent_infrastructure";
    };
    // Mutation-bound journal writes remain strict. Only failure-path retries are best effort.
    const persistAfterFailure = async () => {
      try { await persistResources(); }
      catch { retainFinalizationFailure("resource_journal_failed", true); }
    };
    const captureRun = async (run: Row) => {
      if (typeof run.id !== "string" || run.companyId !== resources.companyId || run.agentId !== resources.agentId)
        throw new ConnectionFailure("observed_run_owner_mismatch");
      observed.set(run.id, run);
      // Preserve only accounting fields, before teardown can purge public rows.
      // This also runs after the attempt deadline while cleanup settles work.
      await save("run-usage-observations.json", { version: 1, runs: [...observed.values()].map(row => ({
        id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status,
        startedAt: row.startedAt ?? null, finishedAt: row.finishedAt ?? null,
        costAccountingPending: row.costAccountingPending ?? null, usageJson: row.usageJson ?? null,
      })) });
    };
    const abort = () => { for (const page of browser?.context.pages() ?? []) void page.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      assertActive();
      await save("setup.json", { version: 1, setupId: config.setupId, hosting: config.hosting, executionEnvironment: config.executionEnvironment,
        target: config.target, candidate: config.candidate, limits: config.limits, authentication: "saved-subscription", realProductAgent: true, sourceProvenance: provenance,
        costBoundary: { budgetCents: config.limits.budgetCents, mode: "observed-known-cost-stop", hardCurrencyCap: false,
          productBudgetPolicy: "inherited-unchanged", missingSubscriptionPrices: "unknown", maximumTaskRuns: 2, attempts: 1 },
        configSha256: createHash("sha256").update(JSON.stringify(config)).digest("hex"), browser: { freshness: config.browser.freshness, accountAlias: config.browser.accountAlias } });
      await persistResources();
      browser = await openConnectionBrowser(antigravityConnectionConfig(config), input.repositoryRoot, config.target.baseURL);
      const page = browser.context.pages()[0] ?? await browser.context.newPage();
      await page.goto(config.target.baseURL);
      api = new ConnectionApi(browser.context.request, config.target.baseURL);
      evidence.phase = "board_authentication";
      const loginDeadline = Date.now() + config.browser.loginTimeoutMs;
      while (true) {
        assertActive();
        try { await api.get("/api/auth/get-session"); break; }
        catch (error) {
          if (!(error instanceof ConnectionFailure) || !["api_status_401", "api_status_403"].includes(error.message)) throw error;
          if (!config.browser.headed || Date.now() >= loginDeadline) throw new ConnectionBlock("awaiting_user", "board_login_required");
          if (!evidence.assisted) {
            evidence.assisted = true;
            console.log("[antigravity-agent-journey] Complete board sign-in in the dedicated QA browser; no Google provider login is measured.");
            await save("progress.json", evidence);
          }
          await connectionDelay(1000);
        }
      }
      if (evidence.assisted && !operationOnly) throw new ConnectionBlock("blocked_target", "assisted_board_login_requires_fresh_case");
      evidence.phase = "preflight";
      if (input.recoverFile) {
        evidence.phase = "recovery";
        // Recovery must still stop owned work after admission expires or a
        // budget becomes blocked. It needs authenticated target identity only.
        await verifyConnectionTarget(api.origin, antigravityConnectionConfig(config), api.request);
        if (process.platform !== "darwin" || process.arch !== "arm64") throw new ConnectionBlock("blocked_target", "same_host_darwin_arm64_required");
        await assertPrivateFile(input.recoverFile);
        const owned = parseAntigravityOwnedResources(JSON.parse(await readFile(input.recoverFile, "utf8")), config);
        Object.assign(resources, owned);
        await persistResources();
        await cleanupAntigravityJourney({ api, config, resources, cleanup: evidence.cleanup, persistResources, observers, captureRun });
        await save("recovery.json", { version: 1, outcome: "released", cleanup: evidence.cleanup, sourceReceipt: createHash("sha256").update(await readFile(input.recoverFile)).digest("hex") });
        operationPassed = true; console.log(`[antigravity-agent-journey] Owned resource recovery complete: ${output}`); return output;
      }
      const registry = new FixtureRegistry();
      registry.register({ id: "antigravity-existing-state", setup: () => prepareAntigravityJourney(api!, config) });
      if (!operationOnly) registry.register({ id: "antigravity-owned-resources", dependencies: ["antigravity-existing-state"], setup: async () => resources,
        teardown: () => cleanupAntigravityJourney({ api: api!, config, resources, cleanup: evidence.cleanup, persistResources, observers, captureRun }) });
      fixtures = await registry.setupAll();
      const prepared = fixtures.values.get("antigravity-existing-state") as Awaited<ReturnType<typeof prepareAntigravityJourney>>;
      evidence.targetCommit = prepared.identity.commit;
      evidence.checkpoints.target = true; evidence.checkpoints.dependencies = true; evidence.cleanup.connectionPreserved = true;
      await save("preflight.json", { version: 1, outcome: "ready", setupId: config.setupId, measured: false, providerPrompts: 0,
        targetCommit: prepared.identity.commit, actor: "browser_operator", savedConnection: { id: prepared.connection.id, grantId: prepared.connection.grantId,
          ownerUserId: prepared.connection.ownerUserId, isDefault: prepared.connection.isDefault, method: prepared.connection.method },
        accounting: prepared.accounting, candidate: config.candidate });
      if (input.preflight) { operationPassed = true; console.log(`[antigravity-agent-journey] Read-only preflight ready: ${output}`); return output; }
      const observeRun = async (run: Row) => {
        assertActive();
        await captureRun(run); observeAntigravityRun(resources, run, observers); await persistResources();
        if (observed.size > config.limits.maxRuns) throw new ConnectionFailure("provider_run_limit_exceeded");
        const cost = antigravityKnownCostObservation([...observed.values()], config.limits.budgetCents);
        await save("known-cost.json", cost);
        if (cost.exceeded) throw new ConnectionBlock("blocked_target", "observed_known_cost_limit_exceeded");
      };
      await runAntigravityJourneyFlow({ page, api, config, prepared, resources, evidence, assertActive, persistResources, observeRun,
        beforeAdmission: async () => {
          assertActive();
          // Read any settled accounting update before admitting the next UI turn.
          for (const runId of observed.keys()) await observeRun(await api!.get<Row>(`/api/heartbeat-runs/${runId}`));
        }, phase: async id => { assertActive(); evidence.phase = id; await save("progress.json", evidence); },
        checkpoint: async (id, tab) => {
          evidence.phase = id; evidence.checkpoints[id] = true;
          const url = new URL(tab.url());
          if (url.origin === config.target.baseURL && url.pathname.startsWith(`/${prepared.company.issuePrefix}/`)
            && !await tab.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count()) {
            const file = `${id}.png`, bytes = await tab.screenshot({ path: path.join(output, file) });
            result.screenshots!.push({ id, label: id.replaceAll("_", " "), file, sha256: createHash("sha256").update(bytes).digest("hex") });
          }
          await save("progress.json", evidence); await persistResources();
        } });
      result.issueId = resources.issueId;
      evidence.outcome = "passed"; result.status = "passed";
    } catch (caught) {
      const error = signal.aborted ? new ConnectionBlock("blocked_target", campaignSignal.aborted ? "test_interrupted" : "journey_deadline_reached") : caught;
      evidence.outcome = error instanceof ConnectionBlock ? error.reason : "failed";
      result.failureClass = error instanceof ConnectionBlock ? "permanent_infrastructure" : "candidate_failure";
      if (resources.setupProbe === "pending") resources.setupProbe = "retirement_unconfirmed";
      if (evidence.phase === "recovery") { result.cleanup = "failed"; result.failureClass = "cleanup_failure"; resources.retained = Boolean(resources.agentId || resources.agentCreationRequest); }
      result.error = error instanceof ConnectionBlock ? error.code : error instanceof ConnectionFailure ? error.message
        : error instanceof Error && /^antigravity_evidence_[a-z0-9_]+$/.test(error.message) ? error.message : `${evidence.phase}_failed`;
      let failureScreenshot = false;
      const failedPage = browser?.context.pages()[0];
      if (failedPage && !failedPage.isClosed()) {
        try {
          const url = new URL(failedPage.url());
          if (url.origin === config.target.baseURL && url.pathname.startsWith("/")
            && !await failedPage.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count()) {
            const file = "failure.png", bytes = await failedPage.screenshot({ path: path.join(output, file) });
            result.screenshots!.push({ id: "failure", label: `Failed at ${evidence.phase.replaceAll("_", " ")}`, file, sha256: createHash("sha256").update(bytes).digest("hex") });
            failureScreenshot = true;
          }
        } catch { /* Preserve the primary failure even when the browser is unavailable. */ }
      }
      const sourceLocation = error instanceof Error ? error.stack?.match(/antigravity-journey-(?:flow|ui)\.ts:\d+:\d+/u)?.[0] : undefined;
      try { await save("attempt-error.json", { error: result.error, phase: evidence.phase, outcome: evidence.outcome, sourceLocation, failureScreenshot }); }
      catch { retainFinalizationFailure("journey_error_diagnostic_write_failed"); }
      await persistAfterFailure();
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      try {
        try { await fixtures?.teardown(); if (result.cleanup !== "failed") result.cleanup = "passed"; }
        catch (error) {
          const code = error instanceof AggregateError && error.errors[0] instanceof ConnectionFailure ? error.errors[0].message : "fixture_cleanup_failed";
          retainFinalizationFailure(code, true);
          await persistAfterFailure();
        }
      } finally {
        try { await browser?.close(); }
        catch { retainFinalizationFailure("qa_browser_cleanup_failed", true); }
      }
      result.finishedAt = new Date().toISOString(); result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
      result.issueId = resources.issueId;
      try { await save("progress.json", evidence); }
      catch { retainFinalizationFailure("journey_progress_write_failed"); }
      if (operationOnly) {
        if (!operationPassed || result.cleanup === "failed" || finalizationFailed) process.exitCode = 1;
      } else {
        result.runIds = [...new Set([...resources.runIds, ...observed.keys()])];
        const runs = result.runIds.map(id => observed.get(id) ?? { id });
        result.usage = { runs: runs.map(run => ({ usage: !run.usageJson ? null
          : !isAntigravityRunAccountingSettled(run)
            ? { ...run.usageJson, accountingReceiptReady: false } : run.usageJson })) };
        result.runtimeUsage = buildRuntimeUsage({ environmentId: execution.environment.id, runs, fallbackFinishedAt: result.finishedAt });
        result.billing = summarizeExecutionBilling(result);
        result.matcherResults = gradeAntigravityJourney(evidence);
        if (result.status === "passed" && !result.matcherResults.every(check => check.passed)) {
          result.status = "failed"; evidence.outcome = "failed"; result.failureClass = "candidate_failure"; result.error = "antigravity_journey_proof_incomplete";
        }
        const primary = structuredClone(result);
        try { await save("attempt-result.json", primary); }
        catch { retainFinalizationFailure("journey_attempt_result_write_failed"); }
        const presentation = structuredClone(result);
        try {
          const packaged = await writeAntigravityJourneyReport({ output, campaignId, result, resources, catalog: input.catalog, secrets: [] });
          if (packaged.status !== "passed" || packaged.cleanup !== "passed") process.exitCode = 1;
          console.log(`[antigravity-agent-journey] ${packaged.status}: ${path.join(output, "dashboard.html")}`);
        } catch {
          process.exitCode = 1;
          const code = "journey_report_packaging_failed";
          let retainedFailure = false;
          try {
            // Keep partially written normal evidence before replacing its
            // presentation grade with an explicit packaging failure.
            const sources: Record<string, string> = {};
            let manifest: Row = {};
            for (const name of ["result.json", "evidence-manifest.json"]) {
              const bytes = await readFile(path.join(output, "evidence", name)).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
              if (!bytes) continue;
              await writeFile(path.join(output, `packaging-source-${name}`), bytes, { mode: 0o600 });
              sources[name] = createHash("sha256").update(bytes).digest("hex");
              if (name === "evidence-manifest.json") {
                try {
                  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
                } catch { /* Retain malformed source bytes; packaging remains failed. */ }
              }
            }
            const failed: RunnerE2EResult = { ...presentation, status: "failed",
              failureClass: presentation.failureClass ?? "permanent_infrastructure",
              error: `${presentation.error ? `${presentation.error}; ` : ""}${code}` };
            await mkdir(path.join(output, "evidence"), { recursive: true, mode: 0o700 });
            await save("evidence/result.json", failed);
            await save("evidence/evidence-manifest.json", { ...manifest,
              files: Array.isArray(manifest.files) ? [...new Set([...manifest.files, "result.json"])] : ["result.json"],
              leaks: Array.isArray(manifest.leaks) ? manifest.leaks : [],
              missing: [...new Set([...(Array.isArray(manifest.missing) ? manifest.missing : []), code])] });
            await save("packaging-error.json", { version: 1, code, sources,
              primary: { status: primary.status, error: primary.error ?? null, failureClass: primary.failureClass ?? null,
                outcome: primary.antigravityJourney?.outcome, cleanup: primary.cleanup },
              presentationOnlyRecovery: true });
            retainedFailure = true;
          } catch { /* Disk or permission failure cannot replace the primary outcome or the failed exit code. */ }
          console.log(`[antigravity-agent-journey] failed: ${code}; ${retainedFailure ? "retained evidence/result.json" : "retained diagnostics unavailable"}: ${output}`);
        }
      }
    }
    return output;
  });
}
