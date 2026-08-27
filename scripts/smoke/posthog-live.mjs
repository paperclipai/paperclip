#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSanitizedEvidence,
  extractProjectSummary,
  parsePosthogLiveArguments,
  parseSanitizedAgentProof,
  PosthogLivePreflightError,
  preflightFailureMessage,
  preparePosthogLiveSmoke,
} from "./posthog-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const PROJECT_GET = "project-get";
const PROJECT_SETTINGS_UPDATE = "project-settings-update";
const EXCLUDED_PROJECT_SWITCHERS = new Set(["switch-project", "switch-organization"]);
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

class SmokeFailure extends Error {
  constructor(checkpoint, code) {
    super(`${checkpoint}:${code}`);
    this.name = "SmokeFailure";
    this.checkpoint = checkpoint;
    this.code = code;
  }
}

function fail(checkpoint, code) {
  throw new SmokeFailure(checkpoint, code);
}

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value[key])) return value[key];
  return [];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function screenshotFile(outputDirectory, name) {
  return path.join(outputDirectory, name);
}

function safeConnectionConfig(connection, expectedProjectId) {
  const methodConfig = connection?.config?.methodConfig;
  if (!methodConfig || typeof methodConfig !== "object" || Array.isArray(methodConfig)) {
    fail("C.connection-detail", "method_config_missing");
  }
  if (connection.config?.connectionMethodKey !== "mcp-oauth") {
    fail("C.connection-detail", "oauth_method_not_recorded");
  }
  if (String(methodConfig.projectId ?? "") !== expectedProjectId) {
    fail("C.connection-detail", "wrong_project_pin");
  }
  if (methodConfig.readOnly !== false || methodConfig.mode !== "tools") {
    fail("C.connection-detail", "unexpected_posthog_scope");
  }
  if ((methodConfig.features ?? "") !== "" || (methodConfig.tools ?? "") !== "") {
    fail("C.connection-detail", "unexpected_tool_filter");
  }
  if (!connection.config?.oauth?.connectedAt) {
    fail("B.oauth-callback", "oauth_not_connected");
  }
}

function assertNoCredentialMaterial(value, secrets, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) fail(checkpoint, "credential_material_visible");
  }
  if (/[?&](?:code|state|access_token|refresh_token)=/i.test(serialized)) {
    fail(checkpoint, "oauth_query_material_visible");
  }
  const forbiddenValueKey = /^(?:password|accessToken|access_token|refreshToken|refresh_token|oauthCode|oauth_code|clientSecret|client_secret|cookie|authorizationHeader)$/i;
  const visit = (candidate, seen = new Set()) => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      if (forbiddenValueKey.test(key) && child !== null && child !== "") {
        fail(checkpoint, "raw_credential_field_visible");
      }
      visit(child, seen);
    }
  };
  visit(value);
}

async function apiJson(request, baseUrl, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    response = await request.fetch(new URL(pathname, baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { accept: "application/json" },
      timeout: 30_000,
    });
  } catch {
    fail(checkpoint, "request_failed");
  }
  if (!expectedStatuses.includes(response.status())) {
    fail(checkpoint, `http_${response.status()}`);
  }
  try {
    return await response.json();
  } catch {
    fail(checkpoint, "invalid_json");
  }
}

async function waitFor(checkpoint, fn, { timeoutMs = 120_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail(checkpoint, "timed_out");
  return lastValue;
}

async function expectVisible(locator, checkpoint, code, timeout = 30_000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
  } catch {
    fail(checkpoint, code);
  }
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: false }).filter({ visible: true }).first();
    if (await button.count()) {
      try {
        await button.click({ timeout: 2_000 });
        return true;
      } catch {
        // Provider pages often replace their form between locator creation and
        // click. The next loop re-reads the current DOM.
      }
    }
  }
  return false;
}

async function completePosthogAuthorization(page, config) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("B.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin && current.pathname.includes("/apps/")) return;

    const emailInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
    if (await emailInput.count()) {
      const currentValue = await emailInput.inputValue().catch(() => "");
      if (!currentValue) await emailInput.fill(config.email);
    }

    const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').filter({ visible: true }).first();
    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(config.password);
      await clickVisibleButton(page, [/^sign in$/i, /^log in$/i, /^continue$/i, /sign in with email/i]);
    } else if (await emailInput.count()) {
      await clickVisibleButton(page, [/^continue$/i, /^next$/i, /continue with email/i, /sign in with email/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^sign in$/i,
        /^log in$/i,
      ]);
    }
    await page.waitForTimeout(500);
  }
  fail("B.oauth-callback", "provider_authorization_timed_out");
}

async function safeScreenshot(page, outputPath, config, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.password) || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [page.getByText(config.email, { exact: false })],
  });
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const projectGet = active.find((entry) => entry.toolName === PROJECT_GET);
  const projectSettings = active.find((entry) => entry.toolName === PROJECT_SETTINGS_UPDATE);
  if (!projectGet || !projectGet.isReadOnly) fail(checkpoint, "project_get_missing_or_not_read_only");
  if (!projectSettings || projectSettings.isReadOnly) fail(checkpoint, "project_settings_update_missing_or_not_write");
  for (const excluded of EXCLUDED_PROJECT_SWITCHERS) {
    if (active.some((entry) => entry.toolName === excluded)) fail(checkpoint, `excluded_${excluded}_present`);
  }
  return { active, projectGet, projectSettings };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const { active } = catalogFacts(catalog, "C.catalog-policy");
  const enabledCatalogEntryIds = active.filter((entry) => entry.isReadOnly).map((entry) => entry.id);
  await apiJson(
    request,
    config.baseUrl,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds,
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: active.filter((entry) => entry.status === "quarantined").map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "C.catalog-policy",
  );
  await apiJson(
    request,
    config.baseUrl,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "C.agent-install",
  );
}

async function cleanupConnection(request, config, companyId, connectionId, connectionName) {
  const removed = await apiJson(
    request,
    config.baseUrl,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  if (!receipt
    || receipt.installsRemoved < 1
    || receipt.appProfileBindingsRemoved < 1
    || receipt.credentialRefsCleared + receipt.secretsRevoked < 1
    || !["deleted", "archived"].includes(receipt.appProfile)) {
    fail("F.cleanup", "incomplete_removal_receipt");
  }

  const connectionsResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  const remaining = asArray(connectionsResponse, "connections").filter(
    (connection) => connection.name === connectionName && connection.status !== "archived",
  );
  if (remaining.length > 0) fail("F.cleanup-verification", "test_connection_remains");

  const profilesResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profilesResponse, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pendingResponse = await apiJson(
    request,
    config.baseUrl,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pendingResponse, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    credentialsTornDown: receipt.credentialRefsCleared + receipt.secretsRevoked > 0,
    accessBindingsRemoved: receipt.appProfileBindingsRemoved,
    installsRemoved: receipt.installsRemoved,
    appProfile: receipt.appProfile,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `PostHog live self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.POSTHOG_EVIDENCE_DIR
    ? path.resolve(process.env.POSTHOG_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `posthog-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "posthog_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, projectId: config.projectId },
    connection: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;

  try {
    browser = await chromium.launch({ headless: process.env.POSTHOG_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();

    await page.goto(new URL("/auth?next=/", config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.locator("#email"), "A.paperclip-login", "email_field_missing");
    await page.locator("#email").fill(config.email);
    await page.locator("#password").fill(config.password);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);
    await page.waitForURL((url) => url.pathname !== "/auth", { timeout: 30_000 }).catch(() => {
      fail("A.paperclip-login", "login_redirect_missing");
    });

    const companiesResponse = await apiJson(context.request, config.baseUrl, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companiesResponse, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;

    const agentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "C.agent-scope",
    );
    const agent = asArray(agentsResponse, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("C.agent-scope", "codex_coder_pro_missing");

    const setupUrl = new URL(`/${TARGET_COMPANY_PREFIX}/apps/connect?byo=1&appKey=posthog&stage=setup`, config.baseUrl);
    await page.goto(setupUrl.toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByRole("heading", { name: "Connect PostHog" }), "A.setup-route", "posthog_setup_missing");
    await expectVisible(page.getByRole("button", { name: "Sign in with PostHog" }), "A.setup-route", "oauth_method_missing");
    await expectVisible(page.getByRole("button", { name: "Use a personal API key" }), "A.setup-route", "api_key_method_missing");

    await page.getByRole("button", { name: "Sign in with PostHog" }).click();
    const nameInput = page.locator('input[placeholder="My app"]');
    await nameInput.fill(connectionName);
    await page.locator('input[placeholder="12345"]').fill(config.projectId);
    const readOnlyScope = page.locator("div").filter({ hasText: /^Read-only mode/ }).filter({ has: page.getByRole("switch") }).first();
    const readOnlySwitch = readOnlyScope.getByRole("switch");
    if (await readOnlySwitch.getAttribute("aria-checked") !== "false") fail("B.oauth-setup", "read_only_default_changed");
    await page.getByText("Advanced", { exact: true }).click();
    const featuresInput = page.locator("label", { hasText: "Feature groups" }).locator("..").locator("textarea");
    const toolsInput = page.locator("label", { hasText: "Individual tools" }).locator("..").locator("textarea");
    if (await featuresInput.inputValue() !== "" || await toolsInput.inputValue() !== "") {
      fail("B.oauth-setup", "tool_filters_not_blank");
    }
    const responseMode = page.locator("label", { hasText: "Tool response mode" }).locator("..").locator("select");
    if (await responseMode.inputValue() !== "tools") fail("B.oauth-setup", "individual_tools_mode_not_selected");

    const connectResponsePromise = page.waitForResponse((response) => {
      const target = new URL(response.url());
      return response.request().method() === "POST"
        && target.pathname === `/api/companies/${companyId}/tools/apps/connect`;
    });
    await page.getByRole("button", { name: "Continue to sign in" }).click();
    const connectResponse = await connectResponsePromise;
    if (!connectResponse.ok()) fail("B.oauth-start", `http_${connectResponse.status()}`);
    let connectResult;
    try {
      connectResult = await connectResponse.json();
    } catch {
      fail("B.oauth-start", "invalid_json");
    }
    connectionId = connectResult.connectionId;
    if (typeof connectionId !== "string" || !connectionId) fail("B.oauth-start", "connection_id_missing");

    await completePosthogAuthorization(page, config);
    const cleanSetupPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/setup`;
    await page.goto(new URL(cleanSetupPath, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("PostHog connected", { exact: true }), "B.oauth-callback", "connected_state_missing", 45_000);

    let connection = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    safeConnectionConfig(connection, config.projectId);
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      name: connectionName,
      authentication: "oauth",
      projectId: config.projectId,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    const connectedShot = "01-connected-setup.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    let catalogResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/catalog`,
      undefined,
      "C.catalog-policy",
    );
    let catalog = asArray(catalogResponse, "catalog");
    let facts = catalogFacts(catalog, "C.catalog-policy");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    const health = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "C.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("C.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "C.catalog-refresh",
    );
    catalog = asArray(refreshed, "catalog");
    facts = catalogFacts(catalog, "C.catalog-refresh");
    await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    connection = await apiJson(context.request, config.baseUrl, "GET", `/api/tool-connections/${connectionId}`, undefined, "C.connection-detail");
    safeConnectionConfig(connection, config.projectId);
    if (connection.status !== "active" || connection.healthStatus !== "healthy") {
      fail("C.connection-detail", "connection_not_active_and_healthy");
    }
    assertNoCredentialMaterial(connection, [config.password], "C.connection-detail");
    summary.connection.status = connection.status;
    summary.connection.healthStatus = connection.healthStatus;

    const uniqueConnections = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "C.connection-detail",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("C.connection-detail", "duplicate_connection_detected");
    }

    const installs = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "C.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("C.agent-install", "install_not_agent_only");
    }

    const testAgents = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "C.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const projectGetAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_GET);
    const projectSettingsAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === PROJECT_SETTINGS_UPDATE);
    if (projectGetAccess?.decision !== "allowed" || projectSettingsAccess?.decision !== "off") {
      fail("C.effective-policy", "unexpected_effective_decision");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      projectGet: { catalogEntryId: facts.projectGet.id, toolName: PROJECT_GET, decision: "allowed" },
      projectSettingsUpdate: { catalogEntryId: facts.projectSettings.id, toolName: PROJECT_SETTINGS_UPDATE, decision: "off" },
      excludedToolsAbsent: [...EXCLUDED_PROJECT_SWITCHERS],
      accessAgentId: agent.id,
      installAgentId: agent.id,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("Who can use it", { exact: true }), "C.permissions-ui", "permissions_panel_missing");
    const projectGetPermission = page.locator(`[data-action-id="${facts.projectGet.id}"] select`);
    const projectSettingsPermission = page.locator(`[data-action-id="${facts.projectSettings.id}"] select`);
    await expectVisible(projectGetPermission, "C.permissions-ui", "project_get_permission_missing");
    await expectVisible(projectSettingsPermission, "C.permissions-ui", "project_settings_permission_missing");
    if (await projectGetPermission.inputValue() !== "allowed" || await projectSettingsPermission.inputValue() !== "off") {
      fail("C.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-scoped-permissions.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByLabel("Choose which agent to test as"), "D.test-panel", "agent_picker_missing");
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(PROJECT_GET);
    const projectGetTitle = facts.projectGet.title ?? facts.projectGet.toolName;
    const actionRow = page.locator("button").filter({ hasText: projectGetTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "project_get_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");

    const boardTestStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.project-get", `http_${testCallResponse.status()}`);
    let testCall;
    try {
      testCall = await testCallResponse.json();
    } catch {
      fail("D.project-get", "invalid_json");
    }
    let testCallInput;
    try {
      testCallInput = testCallResponse.request().postDataJSON();
    } catch {
      fail("D.project-get", "request_body_unavailable");
    }
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== PROJECT_GET
      || !testCallInput.parameters
      || typeof testCallInput.parameters !== "object"
      || Array.isArray(testCallInput.parameters)
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.project-get", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.project-get", "gateway_call_not_allowed");
    }
    const boardProject = extractProjectSummary(testCall.result, config.projectId);
    if (!boardProject?.name) fail("D.project-get", "project_result_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.project-get", "success_result_missing");
    const boardShot = "03-board-project-get.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.projectGet.id,
      toolName: PROJECT_GET,
      invocationId: testCall.invocationId,
      decision: testCall.decision,
      httpStatus: testCallResponse.status(),
      resultStatus: "succeeded",
      project: boardProject,
      durationMs: Date.now() - boardTestStartedAt,
    };

    const parentIssueId = process.env.POSTHOG_PROOF_PARENT_ISSUE_ID || process.env.PAPERCLIP_TASK_ID;
    if (!parentIssueId) fail("E.create-proof-issue", "parent_issue_id_missing");
    const child = await apiJson(
      context.request,
      config.baseUrl,
      "POST",
      `/api/issues/${parentIssueId}/children`,
      {
        title: `PostHog installed-tool proof ${startedAt.toISOString()}`,
        description: [
          "Invoke exactly one installed PostHog action: the read-only upstream `project-get` tool, with an empty `{}` input.",
          `Verify the returned project ID is exactly ${config.projectId} and make no PostHog mutations.`,
          "Then post exactly one JSON object with keys `projectId`, `projectName`, and `invocationId` (the Paperclip invocation ID), and mark this issue done.",
          "Do not report tokens, cookies, authorization data, request headers, raw tool payloads, or any other fields.",
        ].join("\n\n"),
        status: "todo",
        workMode: "standard",
        priority: "medium",
        assigneeAgentId: agent.id,
        acceptanceCriteria: [
          `The installed PostHog project-get action returns project ${config.projectId}.`,
          "The comment contains only sanitized project ID/name and Paperclip invocation ID.",
          "No mutation is attempted.",
        ],
      },
      "E.create-proof-issue",
      [201],
    );
    if (child.status !== "todo") fail("E.create-proof-issue", "child_not_created_todo");
    const observedStatuses = new Set(["todo"]);
    const finishedChild = await waitFor("E.fresh-agent-run", async () => {
      const issue = await apiJson(context.request, config.baseUrl, "GET", `/api/issues/${child.id}`, undefined, "E.fresh-agent-run");
      observedStatuses.add(issue.status);
      if (["blocked", "cancelled"].includes(issue.status)) fail("E.fresh-agent-run", `child_${issue.status}`);
      return issue.status === "done" ? issue : null;
    }, {
      timeoutMs: Number(process.env.POSTHOG_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
      intervalMs: 3_000,
    });
    if (!finishedChild.startedAt || !finishedChild.completedAt) fail("E.fresh-agent-run", "transition_timestamps_missing");

    const commentsResponse = await apiJson(
      context.request,
      config.baseUrl,
      "GET",
      `/api/issues/${child.id}/comments`,
      undefined,
      "E.agent-proof-comment",
    );
    const comments = asArray(commentsResponse, "comments");
    for (const comment of comments) assertNoCredentialMaterial(comment.body, [config.password], "E.agent-proof-comment");
    const agentComments = comments.filter((comment) =>
      comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id,
    );
    const proofs = agentComments.map((comment) => parseSanitizedAgentProof(comment.body, config.projectId)).filter(Boolean);
    if (agentComments.length !== 1 || proofs.length !== 1) {
      fail("E.agent-proof-comment", "single_sanitized_proof_missing");
    }
    const [proof] = proofs;

    let finalConnectionActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [config.password], "E.agent-audit");
      finalConnectionActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === child.id
        && event.agentId === agent.id
        && event.toolName === PROJECT_GET
        && event.invocationId === proof.invocationId
        && event.outcome === "success",
      ) ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "project_get_input_not_empty");
    const childToolEvents = asArray(finalConnectionActivity, "events").filter((event) => event.issueId === child.id && event.invocationId);
    if (childToolEvents.length === 0 || childToolEvents.some((event) => event.toolName !== PROJECT_GET)) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    if (new Set(childToolEvents.map((event) => event.invocationId)).size !== 1) {
      fail("E.agent-audit", "project_get_invoked_more_than_once");
    }
    if (proof.projectName !== boardProject.name) fail("E.agent-proof-comment", "project_name_mismatch");

    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(
        context.request,
        config.baseUrl,
        "GET",
        `/api/heartbeat-runs/${agentEvent.runId}`,
        undefined,
        "E.agent-run-status",
      );
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });

    summary.freshRun = {
      issueId: child.id,
      issueIdentifier: child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: observedStatuses.has("in_progress") || Boolean(finishedChild.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      project: { id: proof.projectId, name: proof.projectName },
      auditOutcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/issues/${child.identifier}`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(child.title, { exact: true }).first(), "F.child-screenshot", "child_issue_missing");
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(PROJECT_GET, { exact: false }).first(), "F.activity-screenshot", "project_get_activity_missing");
    const activityShot = "05-redacted-activity.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
    cleanupComplete = true;
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
  } finally {
    if (connectionId && companyId && context && !cleanupComplete) {
      try {
        summary.cleanup = await cleanupConnection(context.request, config, companyId, connectionId, connectionName);
        cleanupComplete = true;
      } catch {
        summary.cleanup = { completed: false, code: "cleanup_failed" };
        if (!caughtFailure) caughtFailure = new SmokeFailure("F.cleanup", "cleanup_failed");
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  summary.completedAt = new Date().toISOString();
  if (caughtFailure) {
    summary.failure = { checkpoint: caughtFailure.checkpoint, code: caughtFailure.code };
  }
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });

  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  let prepared;
  try {
    const options = parsePosthogLiveArguments(process.argv.slice(2));
    prepared = await preparePosthogLiveSmoke({
      baseUrl: options.baseUrl,
      loadBrowser: () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof PosthogLivePreflightError ? 2 : 1;
    return;
  }

  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`PostHog live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`PostHog live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();
