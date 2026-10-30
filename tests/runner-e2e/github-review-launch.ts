import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { ConnectionBlock, ConnectionFailure } from "./connection-config.js";
import { ConnectionApi, verifyConnectionTarget } from "./connection-target.js";
import { openConnectionBrowser, withConnectionCampaignCancellation } from "./connection-launch.js";
import { createPrivateJourneyRepository, ensureGitHubJourneyLogin, closeOwnedGitHubPullRequest, awaitJourneyCondition, observeGitHubJourneyAccount, isGitHubJourneyEvidencePage } from "./github-review-browser.js";
import { loadGitHubReviewJourneyConfig } from "./github-review-config.js";
import { gradeGitHubReviewJourney, type GitHubReviewJourneyEvidence } from "./github-review-evidence.js";
import { runGitHubReviewFlow } from "./github-review-flow.js";
import { captureOwnedGitHubApp, readOwnedGitHubReviewRuns, stopOwnedGitHubReviewRun, type GitHubJourneyResources } from "./github-review-ownership.js";
import { JourneyDependencyError, resolveJourneyCredential } from "./journey-dependencies.js";
import { sanitizeJson, assertSecretFree } from "./redaction.js";
import { writeGitHubReviewReport } from "./github-review-report.js";
import { summarizeExecutionBilling, buildRuntimeUsage } from "./billing.js";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

export async function runGitHubReviewCampaign(input: { executions: readonly MatrixExecution[]; catalog: readonly MatrixExecution[]; configFile?: string; repositoryRoot: string; provisionRepository?: boolean }) {
  if (input.executions.length !== 1 || input.executions[0]!.task.flow !== "github_review_journey") throw new ConnectionFailure("Select exactly one GitHub review journey cell separately.");
  if (process.env.PAPERCLIP_E2E_OPERATIONS_MANIFEST) throw new ConnectionFailure("GitHub review journey has no budgeted routing qualification");
  return withConnectionCampaignCancellation(async campaignSignal => {
    const deadline = new AbortController();
    const signal = AbortSignal.any([campaignSignal, deadline.signal]);
    const execution = input.executions[0]!;
    const startedAt = new Date().toISOString();
    const nonce = randomBytes(5).toString("hex");
    const campaignId = `github-review-${startedAt.replace(/[:.]/g, "-")}-${nonce}`;
    const output = path.join(input.repositoryRoot, "tests/runner-e2e/results", campaignId);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const secrets: string[] = [];
    const save = async (name: string, value: unknown) => {
      const text = JSON.stringify(sanitizeJson(value, secrets), null, 2) + "\n";
      assertSecretFree(text, secrets, name); await writeFile(path.join(output, name), text, { mode: 0o600 });
    };
    const evidence: GitHubReviewJourneyEvidence = { version: 1, setupId: "unresolved", hosting: "self-hosted", targetCommit: null, assisted: false,
      outcome: "running", phase: "configuration", dependencies: [], checkpoints: {}, cleanup: { endpoint: true, pullRequest: true, branch: true, app: true } };
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repositoryRoot, encoding: "utf8" }).trim();
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: execution.id, suiteId: execution.suite.id, suiteDefinitionHash: execution.suiteDefinitionHash,
      source: { sha, ref: "working-tree", workflowRunUrl: null }, attempt: 1, status: "failed", profileId: execution.profile.id, environmentId: execution.environment.id, caseId: execution.task.id,
      provider: execution.profile.provider, model: execution.profile.model, runtimeMode: "native", startedAt, finishedAt: startedAt, durationMs: 0, cleanup: "not_started", githubReviewJourney: evidence, screenshots: [] };
    const resources: GitHubJourneyResources = { branch: `codex/ponytail-eval-${nonce}`, appName: `Ponytail QA ${nonce}`, runIds: [] };
    let browser: Awaited<ReturnType<typeof openConnectionBrowser>> | undefined;
    let api: ConnectionApi | undefined; let github: Page | undefined; let page: Page | undefined;
    let config: Awaited<ReturnType<typeof loadGitHubReviewJourneyConfig>> | undefined;
    const checkpoint = async (id: string) => { evidence.phase = id; await save("progress.json", { executionId: execution.id, ...evidence }); };
    const abort = () => { for (const tab of browser?.context.pages() ?? []) void tab.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let repositoryCreated = false;
    try {
      config = await loadGitHubReviewJourneyConfig(input.configFile);
      timer = setTimeout(() => deadline.abort(), config.deadlineMs);
      const authentication = config.authentication ? await import(pathToFileURL(config.authentication.module).href) : undefined;
      if (config.executionEnvironment !== execution.environment.id) throw new ConnectionBlock("blocked_target", "selected_execution_environment_mismatch");
      evidence.setupId = config.setupId; evidence.hosting = config.hosting;
      result.provider = config.agent.provider; result.model = config.agent.model; result.runtimeMode = config.agent.runtimeMode;
      evidence.definitionHash = createHash("sha256").update(execution.suiteDefinitionHash).update(JSON.stringify({ setup: config.setupId, hosting: config.hosting, agent: config.agent, repository: config.github.repository, login: config.github.login })).digest("hex");
      const common = { ...config, models: {}, routes: {}, credentials: {}, budgetCents: 1, maxRuns: config.maximumRuns, turnTimeoutMs: config.deadlineMs, retainCompany: true };
      const username = await resolveJourneyCredential(config.github.username, { signal, registerSecret: value => secrets.push(value) });
      evidence.dependencies.push({ alias: "github-user", consumer: "browser", status: "ready", source: config.github.username.source });
      evidence.dependencies.push({ alias: "review-agent-provider", consumer: "product-agent", status: "unverified", source: "product-connection" });
      evidence.checkpoints.dependencies = true;
      browser = await openConnectionBrowser(common, input.repositoryRoot, config.target.baseURL);
      page = await browser.context.newPage();
      github = await browser.context.newPage();
      await checkpoint("github_authentication");
      await github.goto(`https://github.com/${config.github.repository}`);
      if (authentication?.authenticateGitHubJourneyUser) {
        await authentication.authenticateGitHubJourneyUser({ page: github, configFile: config.authentication!.configFile, signal,
          deadlineAt: Date.now() + config.browser.loginTimeoutMs, registerSecret: (value: string) => secrets.push(value), checkpoint: (id: string) => checkpoint(id) });
      }
      await ensureGitHubJourneyLogin({ page: github, config, username, signal, checkpoint: async id => { evidence.assisted = true; await checkpoint(id); },
        ...(config.github.password ? { password: () => resolveJourneyCredential(config!.github.password!, { signal, registerSecret: value => secrets.push(value) }) } : {}) });
      if (input.provisionRepository) {
        // Bootstrap is intentionally not graded as a setup-and-review attempt.
        await createPrivateJourneyRepository(github, config.github.repository);
        await save("repository-receipt.json", { version: 1, repository: config.github.repository, visibility: "private", createdAt: new Date().toISOString(), retained: true });
        repositoryCreated = true;
        console.log("[github-review-journey] Private reusable QA repository created; receipt saved. Run the journey separately.");
        return output;
      }
      // Authentication adapters can finish at GitHub home. Re-enter the declared
      // repository before checking its visibility and preparing the measured PR.
      await checkpoint("github_repository");
      await github.goto(`https://github.com/${config.github.repository}`);
      await expect(github.getByText("Private", { exact: true }).first()).toBeVisible();
      await checkpoint("paperclip_authentication");
      await page.goto(config.target.baseURL);
      if (config.authentication) {
        if (typeof authentication?.authenticateGitHubJourney !== "function") throw new ConnectionBlock("blocked_target", "invalid_journey_authentication_adapter");
        await authentication.authenticateGitHubJourney({ page, origin: config.target.baseURL, configFile: config.authentication.configFile, signal,
          deadlineAt: Date.now() + config.browser.loginTimeoutMs, registerSecret: (value: string) => secrets.push(value) });
      }
      api = new ConnectionApi(browser.context.request, config.target.baseURL);
      await checkpoint("awaiting_board_login");
      await awaitJourneyCondition(async () => { try { await api!.get(`/api/companies/${config!.target.companyId}`); return true; } catch { return false; } }, config.browser.loginTimeoutMs, "paperclip_login_required", signal);
      const identity = await verifyConnectionTarget(config.target.baseURL, common, browser.context.request);
      evidence.targetCommit = identity.commit; evidence.checkpoints.target = true;
      await runGitHubReviewFlow({ page, github, githubUsername: config.github.account, api, config, resources, evidence, signal,
        phase: checkpoint, persistResources: () => save("owned-resources.json", resources),
        ...(typeof authentication?.authenticateGitHubJourneyRegistration === "function" ? {
          authenticateRegistration: (tab: Page) => authentication.authenticateGitHubJourneyRegistration({ page: tab,
            configFile: config!.authentication!.configFile, expectedAccount: config!.github.account, signal,
            deadlineAt: Date.now() + Math.min(config!.browser.loginTimeoutMs, 120_000),
            registerSecret: (value: string) => secrets.push(value), checkpoint: (id: string) => checkpoint(id) }),
        } : {}),
        recordRegistrationBoundary: boundary => save("github-registration-boundary.json", boundary), checkpoint: async (id, tab) => {
        evidence.checkpoints[id] = true;
        // Authentication pages and forms are deliberately never captured.
        const consentUrl = new URL(tab.url());
        const appCreation = id === "app_creation_consent" && consentUrl.origin === "https://github.com"
          && await tab.getByRole("button", { name: new RegExp(`^Create GitHub App(?: for ${config!.github.appOwner})?$`) }).isVisible();
        if (id === "app_creation_consent") await save("app-creation-boundary.json", { origin: consentUrl.origin, path: consentUrl.pathname });
        if ((appCreation || isGitHubJourneyEvidencePage(tab.url(), config!.target.baseURL, config!.github.repository, resources.appSlug))
          && !await tab.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count()) {
          const file = `${id}.png`; const bytes = await tab.screenshot({ path: path.join(output, file) });
          result.screenshots!.push({ id, label: id.replaceAll("_", " "), file, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        await checkpoint(id);
        await save("owned-resources.json", resources);
      } });
      await verifyConnectionTarget(config.target.baseURL, common, browser.context.request);
      result.issueId = resources.issueId; evidence.outcome = "passed";
      result.status = "passed";
    } catch (error) {
      evidence.outcome = error instanceof ConnectionBlock ? error.reason : error instanceof JourneyDependencyError ? "missing_credential" : "failed";
      result.error = error instanceof ConnectionBlock ? error.code : error instanceof JourneyDependencyError ? error.code : error instanceof ConnectionFailure ? error.message : `${evidence.phase}_failed`;
      result.failureClass = evidence.outcome === "failed" ? "candidate_failure" : "permanent_infrastructure";
      const frame = error instanceof Error ? error.stack?.match(/(?:github-review-(?:browser|flow|launch)|qa-authentication|github-authentication)\.(?:ts|mjs):\d+:\d+/)?.[0] : undefined;
      if (frame) result.error += ` (${frame})`;
      await save("attempt-error.json", { error: result.error, outcome: evidence.outcome, phase: evidence.phase });
      await save("progress.json", { executionId: execution.id, ...evidence });
      await save("owned-resources.json", resources);
      if (github && config && !github.isClosed()) {
        const url = new URL(github.url());
        await save("github-boundary.json", { origin: url.origin, path: url.pathname });
        const repositoryPath = config.github.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pull = new RegExp(`^/${repositoryPath}/pull/(\\d+)$`).exec(url.pathname);
        const title = `Ponytail precision eval ${resources.branch}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!resources.pullNumber && pull && url.origin === "https://github.com"
          && await github.getByRole("heading", { name: new RegExp(`^${title}(?:\\s|$)`) }).first().isVisible()
          && await github.getByRole("link", { name: resources.branch, exact: true }).first().isVisible()) {
          resources.pullNumber = Number(pull[1]); evidence.cleanup.pullRequest = false;
          await save("owned-resources.json", resources);
        }
        if (url.origin === "https://github.com" && url.pathname === `/${config.github.repository}`
          && !await github.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count()) {
          await save("github-controls.json", { headings: await github.getByRole("heading").allTextContents(), buttons: await github.getByRole("button").allTextContents() });
          const bytes = await github.screenshot({ path: path.join(output, "github-failure.png") }).catch(() => null);
          if (bytes) result.screenshots!.push({ id: "github-failure", label: evidence.phase, file: "github-failure.png", sha256: createHash("sha256").update(bytes).digest("hex") });
        }
      }
      if (page && config && !page.isClosed() && new URL(page.url()).origin === config.target.baseURL
        && !/login|auth/.test(new URL(page.url()).pathname) && !await page.locator('input[type="password"]:visible,input[autocomplete="one-time-code"]:visible').count()) {
        const bytes = await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => null);
        if (bytes) result.screenshots!.push({ id: "failure", label: evidence.phase, file: "failure.png", sha256: createHash("sha256").update(bytes).digest("hex") });
        await save("failure-controls.json", { phase: evidence.phase,
          buttons: await page.getByRole("button").allTextContents().catch(() => []),
          headings: await page.getByRole("heading").allTextContents().catch(() => []) });
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const cleanupSignal = AbortSignal.timeout(Math.min(config?.browser.loginTimeoutMs ?? 180_000, 600_000));
      const cleanupErrors: string[] = [];
      if (resources.endpointId && api) {
        evidence.cleanup.endpoint = false;
        try {
          const owned = await api.get(`/api/chat-endpoints/${resources.endpointId}`);
          if (owned.companyId !== config!.target.companyId || owned.assignedAgentId !== config!.agent.id) throw new ConnectionFailure("cleanup_endpoint_owner_mismatch");
          if (owned.botExternalId) {
            evidence.cleanup.app = false;
            try {
              if (!captureOwnedGitHubApp(resources, owned, config!)) cleanupErrors.push("owned_app_identity_unconfirmed");
            } catch { cleanupErrors.push("owned_app_binding_mismatch"); }
          }
          if (resources.issueId) {
            const issue = await api.get(`/api/issues/${resources.issueId}`);
            if (issue.companyId !== config!.target.companyId || issue.assigneeAgentId !== config!.agent.id) throw new ConnectionFailure("cleanup_issue_owner_mismatch");
            const boundRuns = await readOwnedGitHubReviewRuns(api, { companyId: config!.target.companyId, agentId: config!.agent.id, issueId: resources.issueId });
            resources.runIds = [...new Set([...resources.runIds, ...boundRuns.map(run => run.id)])];
          }
          await save("owned-resources.json", resources);
          await api.post(`/api/chat-endpoints/${resources.endpointId}/setup`, { action: "remove" });
          for (const runId of resources.runIds) {
            if (!resources.issueId) throw new ConnectionFailure("cleanup_run_issue_missing");
            await stopOwnedGitHubReviewRun(api, runId, { companyId: config!.target.companyId, agentId: config!.agent.id, issueId: resources.issueId }, cleanupSignal);
          }
          if (resources.issueId && result.status !== "passed") {
            const issue = await api.get(`/api/issues/${resources.issueId}`);
            if (issue.companyId !== config!.target.companyId || issue.assigneeAgentId !== config!.agent.id) throw new ConnectionFailure("cleanup_issue_owner_mismatch");
            if (!["done", "cancelled"].includes(issue.status)) {
              await api.patch(`/api/issues/${issue.id}`, { status: "cancelled" });
              if ((await api.get(`/api/issues/${issue.id}`)).status !== "cancelled") throw new ConnectionFailure("owned_task_settlement_unconfirmed");
              await save("owned-task-cleanup.json", { issueId: issue.id, previousStatus: issue.status, status: "cancelled", reason: "failed_attempt" });
            }
          }
          evidence.cleanup.endpoint = (await api.get(`/api/chat-endpoints/${resources.endpointId}`)).status === "archived";
        } catch { cleanupErrors.push("endpoint_cleanup_failed"); }
      }
      if (resources.pullNumber && github && config) {
        evidence.cleanup.pullRequest = false; evidence.cleanup.branch = false;
        try {
          if (github.isClosed() && browser) github = await browser.context.newPage();
          await github.goto(`https://github.com/${config.github.repository}/pull/${resources.pullNumber}`);
          if ((await observeGitHubJourneyAccount(github)).toLowerCase() !== config.github.account.toLowerCase()) throw new ConnectionFailure("cleanup_github_account_mismatch");
          await closeOwnedGitHubPullRequest(github);
          evidence.cleanup.pullRequest = true; evidence.cleanup.branch = true;
        } catch { cleanupErrors.push("pull_request_cleanup_failed"); }
      } else if (!evidence.cleanup.branch && github && config) {
        try {
          if (github.isClosed() && browser) github = await browser.context.newPage();
          await github.goto(`https://github.com/${config.github.repository}`);
          const repository = await github.request.get(`https://github.com/${config.github.repository}`, { maxRedirects: 0 });
          const branch = await github.request.get(`https://github.com/${config.github.repository}/tree/${resources.branch}`, { maxRedirects: 0 });
          evidence.cleanup.branch = repository.status() === 200 && branch.status() === 404
            && (await observeGitHubJourneyAccount(github)).toLowerCase() === config.github.account.toLowerCase();
          if (!evidence.cleanup.branch) cleanupErrors.push("owned_branch_cleanup_required");
        } catch { cleanupErrors.push("owned_branch_cleanup_unconfirmed"); }
      }
      if (evidence.checkpoints.app_created || resources.appId || !evidence.cleanup.app) {
        evidence.cleanup.app = false;
        // App deletion is an explicit human action; never delete by an inferred name/URL.
        if (resources.appSettingsUrl && github && config && new URL(resources.appSettingsUrl).origin === "https://github.com") {
          try {
            if (github.isClosed() && browser) github = await browser.context.newPage();
            await github.goto(resources.appSettingsUrl);
            await github.bringToFront();
            console.log(`[github-review-journey] Remove only the disposable App named ${resources.appName} in the QA browser. The shared repository and existing user/provider credentials must remain.`);
            await awaitJourneyCondition(async () => {
              const response = await github!.request.get(resources.appSettingsUrl!, { maxRedirects: 0, timeout: 15_000 });
              if (response.status() !== 404) return false;
              if ((await observeGitHubJourneyAccount(github!)).toLowerCase() !== config!.github.account.toLowerCase()) throw new ConnectionFailure("cleanup_github_account_mismatch");
              return true;
            }, Math.min(config.browser.loginTimeoutMs, 600_000), "owned_app_cleanup_required", cleanupSignal);
            evidence.cleanup.app = true;
          } catch { cleanupErrors.push("app_cleanup_unconfirmed"); }
        } else cleanupErrors.push("app_cleanup_unconfirmed");
      }
      result.runIds = resources.runIds;
      await save("owned-resources.json", resources);
      if (api && resources.issueId && config) {
        try {
          const runs = await readOwnedGitHubReviewRuns(api, { companyId: config.target.companyId, agentId: config.agent.id, issueId: resources.issueId });
          result.runtimeUsage = buildRuntimeUsage({ environmentId: execution.environment.id, runs, fallbackFinishedAt: new Date().toISOString() });
          result.billing = summarizeExecutionBilling({ ...result, usage: { runs: runs.map(r => ({ usage: r.usageJson })) } });
        } catch { /* Missing billing remains unavailable; never substitute zero. */ }
      }
      if (result.billing) { result.billing.complete = false; result.billing.llm.costStatus = "partial"; }
      await browser?.close().catch(() => cleanupErrors.push("browser_cleanup_failed"));
      result.cleanup = cleanupErrors.length || !Object.values(evidence.cleanup).every(Boolean) ? "failed" : "passed";
      if (result.cleanup === "failed") { result.status = "failed"; result.failureClass = "cleanup_failure"; result.error = [result.error, ...cleanupErrors].filter(Boolean).join("; "); }
      result.finishedAt = new Date().toISOString(); result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
      result.matcherResults = gradeGitHubReviewJourney(evidence);
      if (!input.provisionRepository && result.status === "passed" && !result.matcherResults.every(check => check.passed)) {
        result.status = "failed"; evidence.outcome = "failed"; result.failureClass = "candidate_failure"; result.error = "required_journey_evidence_missing";
      }
      if (!input.provisionRepository) {
        const reported = await writeGitHubReviewReport({ output, campaignId, result, resources, catalog: input.catalog, secrets });
        if (reported.status !== "passed" || reported.cleanup !== "passed") process.exitCode = 1;
      } else {
        await save("bootstrap-result.json", { created: repositoryCreated, outcome: repositoryCreated ? "passed" : evidence.outcome, error: result.error });
        if (!repositoryCreated) process.exitCode = 1;
      }
      await save("progress.json", evidence);
      console.log(`[github-review-journey] ${evidence.outcome}; report directory: ${output}`);
    }
    return output;
  });
}
