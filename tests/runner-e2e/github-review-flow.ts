import { expect, type Page } from "@playwright/test";
import type { GitHubTaskReview } from "../../packages/shared/src/types/chat-github.js";
import type { GitHubRepositoryPage } from "../../packages/shared/src/types/chat-channels.js";
import { ConnectionBlock, ConnectionFailure } from "./connection-config.js";
import { ConnectionApi } from "./connection-target.js";
import { assertGitHubJourneyCheck, assertGitHubJourneyTaskDone, awaitJourneyCondition, createGitHubJourneyPullRequest, enterGitHubJourneyCompany, observeGitHubHead, selectGitHubJourneyRepository, waitForGitHubRegistrationControl, type GitHubRegistrationBoundary } from "./github-review-browser.js";
import { githubCartFixture, hasOnlyOpenedAutomaticReview, matchesGitHubJourneyEnvironment, retainGitHubReview, verifyGitHubReview, verifyGitHubReviewRun, type GitHubReviewJourneyEvidence } from "./github-review-evidence.js";
import type { GitHubReviewJourneyConfig } from "./github-review-config.js";
import { captureOwnedGitHubApp, readOwnedGitHubReviewRuns, type GitHubJourneyResources } from "./github-review-ownership.js";
import { attendGitHubJourneyAction } from "./github-review-attendance.js";

export async function runGitHubReviewFlow(input: {
  page: Page; github: Page; githubUsername: string; api: ConnectionApi; config: GitHubReviewJourneyConfig; resources: GitHubJourneyResources;
  evidence: GitHubReviewJourneyEvidence; signal: AbortSignal;
  checkpoint(id: keyof GitHubReviewJourneyEvidence["checkpoints"], page: Page): Promise<void>;
  phase(id: string): Promise<void>;
  persistResources(): Promise<void>;
  recordRegistrationBoundary?(boundary: GitHubRegistrationBoundary): Promise<void>;
  authenticateRegistration?(page: Page): Promise<void>;
}) {
  const { page, github, api, config, resources, evidence } = input;
  const capabilities = await api.get('/api/instance/settings/experimental');
  if (capabilities.enableGitHubReviewBots !== true) throw new ConnectionBlock("blocked_target", "github_review_capability_unavailable");
  const company = await api.get(`/api/companies/${config.target.companyId}`);
  const agent = await api.get(`/api/agents/${config.agent.id}`);
  if (company.id !== config.target.companyId || agent.companyId !== company.id || agent.name !== config.agent.name || !["idle", "running"].includes(agent.status)) throw new ConnectionBlock("blocked_target", "configured_review_agent_unavailable");
  const environment = await api.get(`/api/environments/${config.target.environmentId}`);
  // Inheritance and task trust policy can select the environment without an
  // agent override. Validate the declared target now; the actual run binding
  // remains authoritative after dispatch.
  if (environment.status !== "active"
    || !matchesGitHubJourneyEnvironment(environment, config.target.environmentId, config.executionEnvironment)) throw new ConnectionBlock("blocked_target", "configured_review_environment_mismatch");
  // The profile is explicit about the provider/model it claims to qualify.
  if (JSON.stringify(agent.adapterConfig ?? {}).includes(config.agent.model) === false) throw new ConnectionBlock("blocked_target", "configured_agent_model_mismatch");
  // Record effective accounting prerequisites without granting or changing them.
  try {
    const budgets = await api.get(`/api/companies/${company.id}/budgets/overview`);
    evidence.budgetPolicies = budgets.policies.filter((p: any) => p.isActive && (p.scopeType === "company" || (p.scopeType === "agent" && p.scopeId === agent.id)))
      .map((p: any) => ({ scopeType: p.scopeType, amount: p.amount, hardStopEnabled: p.hardStopEnabled, unpricedUsagePolicy: p.unpricedUsagePolicy }));
    evidence.budgetPolicyRead = "verified";
  } catch { evidence.budgetPolicyRead = "unavailable"; }
  await enterGitHubJourneyCompany(page, api.origin, company);
  await input.checkpoint("agent", page);
  await input.phase("connector_navigation");
  await page.getByRole("link", { name: "Connectors", exact: true }).click();
  const botCard = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "GitHub Code Review Bot", exact: true }) });
  await botCard.getByRole("button", { name: /^(?:Connect|Add connection) GitHub Code Review Bot$/ }).click();
  await page.getByRole("button", { name: /Select agent/ }).click();
  await page.getByRole("button", { name: `Select ${config.agent.name}`, exact: true }).click();
  const creation = page.waitForResponse(r => new URL(r.url()).pathname === `/api/companies/${company.id}/chat-endpoints` && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const response = await creation;
  if (!response.ok()) throw new ConnectionFailure("endpoint_creation_failed");
  const endpoint = await response.json();
  if (endpoint.companyId !== company.id || endpoint.assignedAgentId !== agent.id || endpoint.provider !== "github") throw new ConnectionFailure("created_endpoint_binding_mismatch");
  resources.endpointId = endpoint.id;
  evidence.cleanup.endpoint = false;
  await input.persistResources();
  // Check the declared existing-user prerequisite before creating an external
  // App. A missing fixture must not leave an unnecessary GitHub installation.
  const existingAccounts = await api.get<Array<{ connectionId: string; status: string; enabled: boolean; login: string | null }>>(`/api/chat-endpoints/${endpoint.id}/github/personal-connections`);
  const expectedAccounts = existingAccounts.filter(a => a.status === "active" && a.enabled && a.login?.toLowerCase() === input.githubUsername.toLowerCase());
  if (expectedAccounts.length !== 1) throw new ConnectionBlock("blocked_target", "dedicated_github_user_connection_required");
  await input.phase("github_app_registration");
  if (config.github.ownerType === "organization") {
    await page.getByLabel("GitHub account", { exact: true }).selectOption("organization");
    await page.getByLabel("Organization", { exact: true }).fill(config.github.appOwner);
  }
  await page.getByLabel("App name", { exact: true }).fill(resources.appName);
  await page.getByRole("button", { name: "Continue to GitHub", exact: true }).click();
  // Manifest flow navigates the same tab. External App grants remain attended.
  evidence.assisted = true;
  await awaitJourneyCondition(async () => new URL(page.url()).hostname === "github.com", 30_000, "github_manifest_handoff_missing", input.signal);
  const createApp = await waitForGitHubRegistrationControl(page, config.github.appOwner, config.browser.loginTimeoutMs,
    input.recordRegistrationBoundary, input.authenticateRegistration ? () => input.authenticateRegistration!(page) : undefined);
  await page.bringToFront();
  await input.checkpoint("app_creation_consent", page);
  console.log(`[github-review-journey] Authorize creation of only ${resources.appName} in the dedicated QA browser. Install it only on ${config.github.repository}.`);
  await attendGitHubJourneyAction({ control: createApp, action: "create-app", appName: resources.appName, signal: input.signal, timeoutMs: config.browser.loginTimeoutMs });
  await input.phase("github_repository_installation");
  await awaitJourneyCondition(async () => await page.getByRole("radio", { name: /Only select repositories/i }).isVisible(), config.browser.loginTimeoutMs, "github_app_creation_consent_required", input.signal);
  await awaitJourneyCondition(async () => captureOwnedGitHubApp(resources, await api.get(`/api/chat-endpoints/${endpoint.id}`), config), 30_000, "created_github_app_identity_unavailable", input.signal, "failed");
  await input.checkpoint("app_created", page);
  await selectGitHubJourneyRepository(page, config.github.repository);
  await input.checkpoint("repository_scope", page);
  await page.bringToFront();
  console.log(`[github-review-journey] The installation selects only ${config.github.repository}. Confirm Install in the QA browser.`);
  await attendGitHubJourneyAction({ control: page.getByRole("button", { name: "Install", exact: true }), action: "install-app", appName: resources.appName, signal: input.signal, timeoutMs: config.browser.loginTimeoutMs });
  await awaitJourneyCondition(async () => new URL(page.url()).origin === api.origin, config.browser.loginTimeoutMs, "github_installation_consent_required", input.signal);
  const savedAccount = page.getByLabel("Existing GitHub connection", { exact: true });
  await input.phase("github_identity_binding");
  // Returning to the tenant can precede signed-webhook verification and the
  // asynchronously loaded identity choices. Wait for a usable wizard state.
  await awaitJourneyCondition(async () => await savedAccount.isVisible()
    || await page.getByRole("button", { name: "Connect my GitHub account", exact: true }).isVisible()
    || await page.getByRole("button", { name: "Confirm my account", exact: true }).isVisible()
    || await page.getByRole("button", { name: "Done", exact: true }).isVisible(),
  120_000, "github_identity_or_connection_state_missing", input.signal, "failed");
  if (await savedAccount.isVisible()) {
    // Select only a single already configured account; ambiguity never picks a stranger's login.
    const accounts = await api.get<Array<{ connectionId: string; status: string; enabled: boolean; login: string | null }>>(`/api/chat-endpoints/${endpoint.id}/github/personal-connections`);
    const active = accounts.filter(a => a.status === "active" && a.enabled && a.login?.toLowerCase() === input.githubUsername.toLowerCase());
    if (active.length !== 1) throw new ConnectionBlock("blocked_target", "dedicated_github_user_connection_required");
    await savedAccount.selectOption(active[0]!.connectionId);
    await page.getByRole("button", { name: "Check my account", exact: true }).click();
    await expect(page.getByText(`GitHub account: ${input.githubUsername}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm my account", exact: true }).click();
  } else if (await page.getByRole("button", { name: "Confirm my account", exact: true }).isVisible()) {
    await expect(page.getByText(`Connect GitHub account ${input.githubUsername} to your Paperclip account.`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm my account", exact: true }).click();
  } else if (await page.getByRole("button", { name: "Connect my GitHub account", exact: true }).isVisible()) {
    throw new ConnectionBlock("blocked_target", "saved_github_user_connection_required");
  }
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await input.checkpoint("identity", page);
  await input.phase("review_configuration");
  const configuredEndpoint = await api.get(`/api/chat-endpoints/${endpoint.id}`);
  const repositories = await api.get<GitHubRepositoryPage>(`/api/chat-endpoints/${endpoint.id}/github/repositories?limit=100&offset=0`);
  if (configuredEndpoint.status !== "active" || configuredEndpoint.assignedAgentId !== config.agent.id
    || repositories.totalCount !== 1 || repositories.enabledCount !== 1
    || repositories.items.length !== 1 || !repositories.items[0]!.enabled
    || repositories.items[0]!.label !== config.github.repository) throw new ConnectionFailure("installation_repository_scope_mismatch");
  if (!captureOwnedGitHubApp(resources, configuredEndpoint, config)) throw new ConnectionFailure("created_github_app_identity_unavailable");
  const editor = page.getByRole("textbox", { name: "Agent instructions", exact: true });
  await editor.fill("/");
  await page.getByRole("button", { name: new RegExp(`/${config.agent.skill}.*SKILL`, "i") }).click();
  await editor.press("End");
  await page.keyboard.type("\nReview this pull request using the selected review skill. Post findings and a numeric rating out of 5. Review only; do not modify repository files.");
  const automatic = page.getByRole("switch", { name: "Run automatically", exact: true });
  if (await automatic.getAttribute("aria-checked") !== "true") await automatic.click();
  for (const label of ["New pull request", "Updated commits", "Reopened", "Ready for review"]) await page.getByRole("checkbox", { name: label, exact: true }).setChecked(label === "New pull request");
  await page.getByRole("checkbox", { name: "New issues", exact: true }).setChecked(false);
  await page.getByLabel("Passing score", { exact: true }).fill("5");
  const savedConfiguration = page.waitForResponse(r => new URL(r.url()).pathname === `/api/chat-endpoints/${endpoint.id}/github/configuration` && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  if (!(await savedConfiguration).ok()) throw new ConnectionFailure("review_configuration_save_failed");
  await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
  const record = await api.get(`/api/chat-endpoints/${endpoint.id}/github/configuration`);
  const policy = record.configuration.defaults;
  if (policy.invocation === "mentions_only") throw new ConnectionFailure("saved_review_invocation_mismatch");
  if (!hasOnlyOpenedAutomaticReview(policy)) throw new ConnectionFailure("saved_review_events_mismatch");
  if (policy.ratingThreshold !== 5) throw new ConnectionFailure("saved_review_threshold_mismatch");
  if (!policy.instructions.includes(config.agent.skill)) throw new ConnectionFailure("saved_review_skill_mismatch");
  await input.checkpoint("configuration_saved", page);
  await page.reload();
  await expect(editor).toContainText(config.agent.skill);
  await input.checkpoint("configuration_reloaded", page);
  await input.checkpoint("skill_binding", page);
  // A branch can persist even if PR submission or navigation later fails.
  evidence.cleanup.branch = false;
  await input.persistResources();
  resources.pullNumber = await createGitHubJourneyPullRequest({ page: github, branch: resources.branch, title: `Ponytail precision eval ${resources.branch}`, contents: githubCartFixture });
  evidence.cleanup.pullRequest = false;
  await input.persistResources();
  await input.checkpoint("pr_created", github);
  const headSha = await observeGitHubHead(github);
  await page.getByRole("link", { name: "Reviews", exact: true }).click();
  let review: GitHubTaskReview | undefined;
  await awaitJourneyCondition(async () => {
    const rows = await api.get<GitHubTaskReview[]>(`/api/chat-endpoints/${endpoint.id}/github/reviews`);
    const matches = rows.filter(r => r.repository === config.github.repository && r.pullNumber === resources.pullNumber && r.headSha === headSha && r.event.event === "opened");
    if (matches.length > 1) throw new ConnectionFailure("duplicate_automatic_review");
    review = matches[0]; return Boolean(review);
  }, config.deadlineMs, "automatic_review_missing", input.signal, "failed");
  resources.issueId = review!.issueId;
  await page.getByRole("link").filter({ hasText: `#${resources.pullNumber}` }).click();
  await input.checkpoint("automatic_task", page);
  await awaitJourneyCondition(async () => {
    review = await api.get(`/api/chat-endpoints/${endpoint.id}/github/reviews/${review!.id}`);
    const runs = await readOwnedGitHubReviewRuns(api, { companyId: company.id, agentId: agent.id, issueId: review!.issueId });
    resources.runIds = runs.map(r => r.id);
    if (resources.runIds.length > config.maximumRuns) throw new ConnectionFailure("review_run_limit_exceeded");
    if (["error", "incomplete", "superseded", "manual_required"].includes(review!.state)) throw new ConnectionFailure("review_terminal_failure");
    return review!.state === "completed";
  }, config.deadlineMs, "review_completion_timeout", input.signal, "failed");
  await input.phase("review_execution_completion");
  evidence.review = retainGitHubReview(review!);
  let issue: any; let completedRun: any;
  // Submitting the assessment can precede publication and the agent's final
  // task completion. A completed review record is not a settled heartbeat run.
  await awaitJourneyCondition(async () => {
    review = await api.get(`/api/chat-endpoints/${endpoint.id}/github/reviews/${review!.id}`);
    evidence.review = retainGitHubReview(review!);
    const runs = await readOwnedGitHubReviewRuns(api, { companyId: company.id, agentId: agent.id, issueId: review!.issueId });
    resources.runIds = runs.map(r => r.id);
    if (resources.runIds.length > config.maximumRuns) throw new ConnectionFailure("review_run_limit_exceeded");
    issue = await api.get(`/api/issues/${review!.issueId}`);
    completedRun = review!.runId ? await api.get(`/api/heartbeat-runs/${review!.runId}`) : undefined;
    evidence.execution = { reviewId: review!.id, issueId: review!.issueId, runId: review!.runId,
      runStatus: completedRun?.status, issueStatus: issue.status, runtimeMode: completedRun?.runtimeMode,
      environmentId: completedRun?.contextSnapshot?.paperclipEnvironment?.id,
      provider: completedRun?.runnerProfileJson?.nativeExecutionInput?.provider?.kind,
      model: completedRun?.runnerProfileJson?.nativeExecutionInput?.provider?.model };
    if (completedRun && (completedRun.companyId !== company.id || completedRun.agentId !== agent.id
      || completedRun.issueId !== review!.issueId)) throw new ConnectionFailure("review_run_owner_mismatch");
    if (completedRun && ["failed", "timed_out", "cancelled", "interrupted"].includes(completedRun.status)) throw new ConnectionFailure("review_run_terminal_failure");
    return completedRun?.status === "succeeded" && issue.status === "done";
  }, config.deadlineMs, "review_execution_completion_timeout", input.signal, "failed");
  if (!verifyGitHubReviewRun(completedRun, { runId: review!.runId, companyId: company.id, agentId: agent.id, issueId: review!.issueId,
    runtimeMode: config.agent.runtimeMode, environmentId: config.target.environmentId, executionEnvironment: config.executionEnvironment,
    environment: await api.get(`/api/environments/${config.target.environmentId}`), provider: config.agent.provider, model: config.agent.model })) throw new ConnectionFailure("review_run_binding_mismatch");
  evidence.dependencies.find(d => d.alias === "review-agent-provider")!.status = "ready";
  if (!verifyGitHubReview({ review: review!, issue, companyId: company.id, endpointId: endpoint.id, issueId: review!.issueId, repository: config.github.repository,
    pullNumber: resources.pullNumber, headSha, agentId: agent.id })) throw new ConnectionFailure("review_oracle_failed");
  evidence.score = review!.assessment!.score; evidence.conclusion = review!.conclusion!;
  await input.checkpoint("review_completed", page);
  await github.reload();
  await expect(github.getByText(`${evidence.score}/5`, { exact: false }).first()).toBeVisible();
  await expect(github.getByText(/precision|decimal|floating|cents/i).first()).toBeVisible();
  await input.checkpoint("github_delivery", github);
  const inline = github.locator(".review-thread-component")
    .filter({ has: github.getByRole("link", { name: "cart-total.js", exact: true }) })
    .filter({ has: github.locator(".review-comment .comment-body").filter({ hasText: /precision|decimal|floating|cents/i }) }).first();
  await expect(inline).toBeVisible();
  await expect(inline.locator(`.review-comment a[href="/apps/${resources.appSlug}"]`).first()).toBeVisible();
  const fileUrl = new URL(await inline.getByRole("link", { name: "cart-total.js", exact: true }).getAttribute("href") ?? "", "https://github.com");
  const commentUrl = new URL(await inline.locator('a[href^="#discussion_r"]').first().getAttribute("href") ?? "", github.url());
  if (fileUrl.origin !== "https://github.com" || fileUrl.pathname !== `/${config.github.repository}/pull/${resources.pullNumber}/files/${headSha}`
    || commentUrl.origin !== "https://github.com" || commentUrl.pathname !== `/${config.github.repository}/pull/${resources.pullNumber}`
    || !/^#discussion_r\d+$/.test(commentUrl.hash)) throw new ConnectionFailure("inline_publication_binding_mismatch");
  evidence.inlinePublication = { url: commentUrl.href, fileUrl: fileUrl.href, path: "cart-total.js", author: resources.appSlug!,
    text: await inline.locator(".review-comment .comment-body").filter({ hasText: /precision|decimal|floating|cents/i }).first().innerText() };
  await inline.scrollIntoViewIfNeeded();
  await input.checkpoint("github_inline_delivery", github);
  await input.phase("github_check_projection");
  if (!review!.checkUrl) throw new ConnectionFailure("github_check_reference_missing");
  const checkPopup = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Check", exact: true }).click();
  const check = await checkPopup;
  await assertGitHubJourneyCheck(check, { repository: config.github.repository, url: review!.checkUrl, headSha, score: evidence.score });
  await input.checkpoint("check_projection", check);
  await input.phase("task_done");
  await page.getByRole("link", { name: "Paperclip task", exact: true }).click();
  await assertGitHubJourneyTaskDone(page);
  await input.checkpoint("task_done", page);
  await input.phase("persisted");
  await page.reload(); await github.reload();
  await assertGitHubJourneyTaskDone(page);
  await expect(github.getByText(`${evidence.score}/5`, { exact: false }).first()).toBeVisible();
  await input.checkpoint("persisted", page);
}
