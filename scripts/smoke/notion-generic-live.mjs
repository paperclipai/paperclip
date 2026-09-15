#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAutomaticRegistrationSource,
  assertSanitizedEvidence,
  connectionRemovalFacts,
  extractNotionIdentity,
  extractNotionVerificationCode,
  fetchNotionTestCredentials,
  inspectAuthorizationUrl,
  isFreshNotionVerificationMessage,
  NotionGenericLivePreflightError,
  notionVerificationAuthenticationPassed,
  parseRuntimeAbsenceProof,
  parseSanitizedAgentProof,
  persistedOAuthStartResult,
  preflightFailureMessage,
  prepareNotionGenericLiveSmoke,
  safeEndpointSummary,
} from "./notion-generic-live-lib.mjs";

const TARGET_COMPANY_PREFIX = "PAP";
const TARGET_AGENT_NAME = "CodexCoderPro";
const NOTION_RESOURCE = "https://mcp.notion.com/mcp";
const NOTION_GET_SELF = "notion-get-self";
const NOTION_CREATE_PAGES = "notion-create-pages";
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2 * 60_000;

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

function assertNoCredentialMaterial(value, credentials, checkpoint) {
  const serialized = JSON.stringify(value);
  for (const credential of credentials) {
    if (credential && serialized.includes(credential)) fail(checkpoint, "credential_material_visible");
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

function issueMutationHeaders(config, method, pathname) {
  if (method === "GET" || !pathname.startsWith("/api/issues/")) return {};
  return { "X-Paperclip-Run-Id": config.runId };
}

async function apiJson(request, config, method, pathname, data, checkpoint, expectedStatuses = [200]) {
  let response;
  try {
    response = await request.fetch(new URL(pathname, config.baseUrl).toString(), {
      method,
      ...(data === undefined ? {} : { data }),
      headers: {
        accept: "application/json",
        ...(method === "GET" ? {} : { origin: config.baseUrl }),
        ...issueMutationHeaders(config, method, pathname),
      },
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

async function gotoWithVisibleMarker(
  page,
  url,
  marker,
  checkpoint,
  code,
  { attempts = 2, timeout = 15_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      if (response?.ok()) {
        await marker().waitFor({ state: "visible", timeout });
        return;
      }
    } catch {
      // A credential-free Paperclip navigation is safe to repeat once. Do not
      // retry provider pages or any mutation from this helper.
    }
    if (attempt < attempts) await page.waitForTimeout(500);
  }
  fail(checkpoint, code);
}

async function loginPaperclipBoard(page, context, config) {
  const loginUrl = new URL("/auth?next=/", config.baseUrl).toString();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await gotoWithVisibleMarker(
      page,
      loginUrl,
      () => page.getByLabel(/^email$/i),
      "A.paperclip-login",
      "email_field_missing",
    );
    const paperclipEmailInput = page.getByLabel(/^email$/i);
    const paperclipPasswordInput = page.getByLabel(/^password$/i);
    await expectVisible(paperclipPasswordInput, "A.paperclip-login", "password_field_missing");
    await paperclipEmailInput.fill(config.paperclipEmail);
    await paperclipPasswordInput.fill(config.paperclipPassword);
    const loginResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/sign-in/email",
    );
    await page.getByRole("button", { name: /^sign in$/i }).click();
    const loginResponse = await loginResponsePromise;
    if (!loginResponse.ok()) fail("A.paperclip-login", `http_${loginResponse.status()}`);

    // A redirect is a UI implementation detail; the authenticated session is
    // the prerequisite the smoke actually needs. A successful sign-in response
    // without a usable cookie has occurred intermittently through public dev
    // proxies, so verify the cookie and repeat the idempotent sign-in once.
    const session = await context.request.get(new URL("/api/auth/get-session", config.baseUrl).toString(), {
      headers: { accept: "application/json" },
    });
    if (session.ok()) return;
    if (attempt < 2) await page.waitForTimeout(500);
  }
  fail("A.paperclip-login", "session_cookie_missing");
}

async function clickVisibleButton(page, names) {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: false }).filter({ visible: true }).first();
    if (!await button.count()) continue;
    try {
      await button.click({ timeout: 2_000 });
      return true;
    } catch {
      // Provider pages replace controls while advancing between login steps.
    }
  }
  return false;
}

function verificationTimeoutMs() {
  const configured = Number(process.env.NOTION_VERIFICATION_TIMEOUT_MS || DEFAULT_VERIFICATION_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, 30_000), 5 * 60_000)
    : DEFAULT_VERIFICATION_TIMEOUT_MS;
}

async function fetchNotionVerificationCodeFromAgentMail({ notBefore }) {
  const apiKey = process.env.AGENTMAIL_API_KEY?.trim();
  const inboxId = process.env.NOTION_AGENTMAIL_INBOX_ID?.trim();
  if (!apiKey || !inboxId) fail("C.notion-login", "verification_inbox_unavailable");

  let AgentMailClient;
  try {
    ({ AgentMailClient } = await import("agentmail"));
  } catch {
    fail("C.notion-login", "agentmail_sdk_unavailable");
  }
  const client = new AgentMailClient({ apiKey });
  try {
    const inbox = await client.inboxes.get(inboxId);
    if (inbox.inboxId !== inboxId && inbox.email !== inboxId) {
      fail("C.notion-login", "verification_inbox_mismatch");
    }
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail("C.notion-login", "verification_inbox_request_failed");
  }

  const deadline = Date.now() + verificationTimeoutMs();
  const after = new Date(new Date(notBefore).getTime() - 5_000);
  while (Date.now() < deadline) {
    try {
      let pageToken;
      let inspected = 0;
      do {
        const response = await client.inboxes.messages.list(inboxId, {
          limit: 50,
          after,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const item of response.messages) {
          inspected += 1;
          if (!isFreshNotionVerificationMessage(item, { notBefore: after })) continue;
          const message = await client.inboxes.messages.get(inboxId, item.messageId);
          if (!notionVerificationAuthenticationPassed(message)) continue;
          const code = extractNotionVerificationCode(message);
          if (code) return code;
        }
        pageToken = response.nextPageToken;
      } while (pageToken && inspected < 100);
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      fail("C.notion-login", "verification_inbox_request_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail("C.notion-login", "verification_code_timed_out");
}

async function completeNotionAuthorization(page, config, credential, connectionId) {
  const paperclipOrigin = new URL(config.baseUrl).origin;
  const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
  const deadline = Date.now() + 6 * 60_000;
  const verificationNotBefore = new Date();
  let providerSeen = false;
  let verificationCodeSubmitted = false;
  while (Date.now() < deadline) {
    let current;
    try {
      current = new URL(page.url());
    } catch {
      fail("C.oauth-callback", "invalid_navigation_url");
    }
    if (current.origin === paperclipOrigin) {
      if (providerSeen && current.pathname === permissionsPath) return;
      await page.waitForTimeout(300);
      continue;
    }
    providerSeen = true;

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/check your (?:email|inbox)|verification code|one-time code/i.test(bodyText)) {
      if (verificationCodeSubmitted) fail("C.notion-login", "verification_code_rejected");
      const codeInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[name*="code" i]',
        'input[inputmode="numeric"]',
      ].join(",")).filter({ visible: true }).first();
      if (!await codeInput.count()) {
        await page.waitForTimeout(300);
        continue;
      }
      let code = await fetchNotionVerificationCodeFromAgentMail({ notBefore: verificationNotBefore });
      await codeInput.fill(code);
      code = "";
      if (!await clickVisibleButton(page, [/^verify$/i, /^continue$/i, /^submit$/i, /^sign in$/i])) {
        await codeInput.press("Enter");
      }
      verificationCodeSubmitted = true;
      await page.waitForTimeout(600);
      continue;
    }

    const usernameInput = page.locator([
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[autocomplete="username"]',
    ].join(",")).filter({ visible: true }).first();
    if (await usernameInput.count()) {
      const currentValue = await usernameInput.inputValue().catch(() => "");
      if (!currentValue) await usernameInput.fill(credential.username);
    }

    const passwordInput = page.locator([
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ].join(",")).filter({ visible: true }).first();
    if (await passwordInput.count()) {
      const currentValue = await passwordInput.inputValue().catch(() => "");
      if (!currentValue) await passwordInput.fill(credential.password);
      await clickVisibleButton(page, [/^sign in$/i, /^log in$/i, /^continue$/i]);
    } else if (await usernameInput.count()) {
      await clickVisibleButton(page, [/continue with email/i, /^continue$/i, /^next$/i, /^sign in$/i]);
    } else {
      await clickVisibleButton(page, [
        /^authorize$/i,
        /^allow$/i,
        /allow access/i,
        /^approve$/i,
        /^grant access$/i,
        /^accept$/i,
        /^continue$/i,
        /^select$/i,
      ]);
    }
    await page.waitForTimeout(600);
  }
  fail("C.oauth-callback", "provider_authorization_timed_out");
}

async function safeScreenshot(page, outputPath, config, credential, checkpoint) {
  const current = new URL(page.url());
  if (current.origin !== new URL(config.baseUrl).origin) fail(checkpoint, "screenshot_not_on_paperclip");
  for (const queryKey of ["code", "state", "token", "access_token", "refresh_token"]) {
    if (current.searchParams.has(queryKey)) fail(checkpoint, "credential_query_in_screenshot_url");
  }
  const bodyText = await page.locator("body").innerText();
  if (bodyText.includes(config.paperclipPassword)
    || bodyText.includes(credential.password)
    || /[?&](?:code|state|access_token|refresh_token)=/i.test(bodyText)) {
    fail(checkpoint, "credential_material_in_screenshot");
  }
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: "disabled",
    mask: [
      page.getByText(config.paperclipEmail, { exact: false }),
      page.getByText(credential.username, { exact: false }),
    ],
  });
}

function assertGenericProvenance(connectResult, connectionName) {
  if (connectResult?.application?.name !== connectionName) fail("B.generic-provenance", "application_name_mismatch");
  if (!String(connectResult?.application?.applicationKey ?? "").startsWith("app-gallery:link:")) {
    fail("B.generic-provenance", "application_key_not_generic");
  }
  if (connectResult?.application?.metadata?.source !== "link") fail("B.generic-provenance", "metadata_source_not_link");
  const config = connectResult?.connection?.config;
  if (connectResult?.connection?.transport !== "mcp_remote"
    || config?.url !== NOTION_RESOURCE
    || config?.unverifiedServer !== true
    || config?.galleryKey === "notion"
    || config?.sourceTemplateKey === "notion") {
    fail("B.generic-provenance", "connection_not_unverified_generic");
  }
}

function oauthEndpointProof(connection, startResult, config) {
  const source = assertAutomaticRegistrationSource(startResult.registrationSource);
  const oauth = connection?.config?.oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) fail("C.oauth-proof", "oauth_config_missing");
  if (connection.authKind !== "oauth" || oauth.clientRegistrationSource !== source) {
    fail("C.oauth-proof", "registration_source_not_persisted");
  }
  if (oauth.resource !== NOTION_RESOURCE || startResult.resource !== NOTION_RESOURCE) {
    fail("C.oauth-proof", "resource_mismatch");
  }
  if (oauth.clientRedirectUri !== config.callbackUrl) fail("C.oauth-proof", "client_callback_mismatch");
  if (source === "cimd" && oauth.clientIdMetadataDocumentSupported !== true) {
    fail("C.oauth-proof", "cimd_support_not_persisted");
  }
  const endpoints = {
    issuer: safeEndpointSummary(oauth.issuer, "issuer"),
    metadata: safeEndpointSummary(oauth.metadataUrl, "metadata"),
    authorize: safeEndpointSummary(oauth.authorizationUrl, "authorize"),
    exchange: safeEndpointSummary(oauth.tokenUrl, "exchange"),
    ...(oauth.registrationUrl ? { registration: safeEndpointSummary(oauth.registrationUrl, "registration") } : {}),
  };
  return { source, endpoints };
}

function catalogFacts(catalog, checkpoint) {
  const active = catalog.filter((entry) => entry.status !== "removed");
  const getSelf = active.find((entry) => entry.toolName === NOTION_GET_SELF);
  const createPages = active.find((entry) => entry.toolName === NOTION_CREATE_PAGES);
  if (!getSelf || !getSelf.isReadOnly) fail(checkpoint, "notion_get_self_missing_or_not_read_only");
  if (!createPages || createPages.isReadOnly) fail(checkpoint, "notion_create_pages_missing_or_not_write");
  return { active, getSelf, createPages };
}

async function finishAgentOnlySetup(request, config, companyId, connectionId, catalog, agentId) {
  const facts = catalogFacts(catalog, "D.catalog-policy");
  await apiJson(
    request,
    config,
    "POST",
    `/api/companies/${companyId}/tools/apps/${connectionId}/finish`,
    {
      enabledCatalogEntryIds: [facts.getSelf.id],
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: facts.active
        .filter((entry) => entry.status === "quarantined")
        .map((entry) => entry.id),
      access: { agentIds: [agentId] },
    },
    "D.catalog-policy",
  );
  await apiJson(
    request,
    config,
    "PUT",
    `/api/tool-connections/${connectionId}/installs`,
    { installs: [{ targetType: "agent", targetId: agentId }] },
    "D.agent-install",
  );
  return facts;
}

async function createAndWaitForProofIssue(request, config, input, checkpoint) {
  const child = await apiJson(
    request,
    config,
    "POST",
    `/api/issues/${config.taskId}/children`,
    input,
    `${checkpoint}.create`,
    [201],
  );
  if (child.status !== "todo") fail(`${checkpoint}.create`, "child_not_created_todo");
  const observedStatuses = new Set(["todo"]);
  const finished = await waitFor(`${checkpoint}.run`, async () => {
    const issue = await apiJson(request, config, "GET", `/api/issues/${child.id}`, undefined, `${checkpoint}.run`);
    observedStatuses.add(issue.status);
    if (["blocked", "cancelled"].includes(issue.status)) fail(`${checkpoint}.run`, `child_${issue.status}`);
    return issue.status === "done" ? issue : null;
  }, {
    timeoutMs: Number(process.env.NOTION_AGENT_TIMEOUT_MS || DEFAULT_AGENT_TIMEOUT_MS),
    intervalMs: 3_000,
  });
  if (!finished.startedAt || !finished.completedAt) fail(`${checkpoint}.run`, "transition_timestamps_missing");
  const commentsResponse = await apiJson(
    request,
    config,
    "GET",
    `/api/issues/${child.id}/comments`,
    undefined,
    `${checkpoint}.comment`,
  );
  return { child, finished, observedStatuses, comments: asArray(commentsResponse, "comments") };
}

async function cleanupConnection(
  request,
  config,
  companyId,
  connectionId,
  connectionName,
  { requireInstalled = false } = {},
) {
  const removed = await apiJson(
    request,
    config,
    "DELETE",
    `/api/tool-connections/${connectionId}`,
    undefined,
    "F.cleanup",
  );
  const receipt = removed.removal;
  const removalFacts = connectionRemovalFacts(receipt, { requireInstalled });
  if (!removalFacts) fail("F.cleanup", "incomplete_removal_receipt");

  const connections = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/connections`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(connections, "connections").some((candidate) =>
    candidate.id === connectionId
    && candidate.name === connectionName
    && candidate.status !== "archived")) {
    fail("F.cleanup-verification", "test_connection_remains");
  }
  const profiles = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/profiles`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(profiles, "profiles").some((profile) => profile.profileKey === `app:${connectionId}` && profile.status === "active")) {
    fail("F.cleanup-verification", "active_profile_remains");
  }
  const pending = await apiJson(
    request,
    config,
    "GET",
    `/api/companies/${companyId}/tools/action-requests?status=pending`,
    undefined,
    "F.cleanup-verification",
  );
  if (asArray(pending, "actionRequests").some((item) => (item.connectionId ?? item.request?.connectionId) === connectionId)) {
    fail("F.cleanup-verification", "pending_action_remains");
  }
  return {
    completed: true,
    ...removalFacts,
    pendingActions: 0,
    remainingConnections: 0,
  };
}

async function runSmoke({ config, chromium }) {
  const startedAt = new Date();
  const runKey = startedAt.toISOString().replace(/[:.]/g, "-");
  const connectionName = `Notion generic self-test ${startedAt.toISOString()}`;
  const outputDirectory = process.env.NOTION_EVIDENCE_DIR
    ? path.resolve(process.env.NOTION_EVIDENCE_DIR)
    : path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.cwd(), `notion-generic-live-${runKey}`);
  await mkdir(outputDirectory, { recursive: true });

  const summary = {
    schemaVersion: 1,
    smoke: "notion_generic_mcp_live",
    passed: false,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    target: { companyPrefix: TARGET_COMPANY_PREFIX, resource: NOTION_RESOURCE },
    importPreview: null,
    connection: null,
    oauthProof: null,
    catalog: null,
    boardTest: null,
    freshRun: null,
    cleanup: null,
    postCleanupRun: null,
    screenshots: [],
    failure: null,
  };

  let browser;
  let context;
  let credential = null;
  let connectionId = null;
  let companyId = null;
  let cleanupComplete = false;
  let caughtFailure = null;
  let activeCheckpoint = "A.paperclip-login";

  try {
    browser = await chromium.launch({ headless: process.env.NOTION_SMOKE_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    const page = await context.newPage();

    await loginPaperclipBoard(page, context, config);

    activeCheckpoint = "A.company-selection";
    const companies = await apiJson(context.request, config, "GET", "/api/companies", undefined, "A.company-selection");
    const company = asArray(companies, "companies").find((candidate) => candidate.issuePrefix === TARGET_COMPANY_PREFIX);
    if (!company) fail("A.company-selection", "pap_company_missing");
    companyId = company.id;
    activeCheckpoint = "A.agent-selection";
    const agents = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/agents`,
      undefined,
      "A.agent-selection",
    );
    const agent = asArray(agents, "agents").find((candidate) => candidate.name === TARGET_AGENT_NAME);
    if (!agent) fail("A.agent-selection", "codex_coder_pro_missing");

    activeCheckpoint = "A.connection-isolation";
    const existingConnections = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "A.connection-isolation",
    );
    const existingIds = new Set(asArray(existingConnections, "connections").map((entry) => entry.id));
    if (asArray(existingConnections, "connections").some((entry) => entry.name === connectionName && entry.status !== "archived")) {
      fail("A.connection-isolation", "connection_name_collision");
    }

    // Fetch only after URL, health, Paperclip login, company, agent, and binding
    // metadata have all passed. The value remains in this process and is never
    // written to browser artifacts or command arguments.
    activeCheckpoint = "A.secret-binding";
    credential = await fetchNotionTestCredentials(config);

    activeCheckpoint = "B.paste-config";
    await gotoWithVisibleMarker(
      page,
      new URL(`/${TARGET_COMPANY_PREFIX}/apps/advanced/paste-config`, config.baseUrl).toString(),
      () => page.getByRole("heading", { name: "Advanced setup", exact: true }),
      "B.paste-config",
      "advanced_setup_missing",
    );
    const configTextarea = page.locator("textarea").first();
    await expectVisible(configTextarea, "B.paste-config", "config_textarea_missing");
    const exactConfig = JSON.stringify({ mcpServers: { notion: { url: NOTION_RESOURCE } } }, null, 2);
    await configTextarea.fill(exactConfig);
    const importResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/companies/${companyId}/tools/mcp/import-json`,
    );
    await page.getByRole("button", { name: /^check config$/i }).click();
    const importResponse = await importResponsePromise;
    if (!importResponse.ok()) fail("B.import-preview", `http_${importResponse.status()}`);
    const preview = await importResponse.json().catch(() => fail("B.import-preview", "invalid_json"));
    const drafts = asArray(preview, "drafts");
    if (drafts.length !== 1
      || drafts[0].name !== "notion"
      || drafts[0].transport !== "mcp_remote"
      || drafts[0].config?.url !== NOTION_RESOURCE
      || drafts[0].credentialFields?.length !== 0
      || drafts[0].credentialRefs?.length !== 0) {
      fail("B.import-preview", "unexpected_draft");
    }
    const afterPreview = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "B.import-preview",
    );
    if (asArray(afterPreview, "connections").some((entry) => !existingIds.has(entry.id))) {
      fail("B.import-preview", "preview_created_connection");
    }
    summary.importPreview = {
      draftCount: 1,
      name: "notion",
      transport: "mcp_remote",
      resource: NOTION_RESOURCE,
      credentialFieldCount: 0,
      credentialRefCount: 0,
    };

    activeCheckpoint = "B.generic-connect";
    const connectionNameInput = page.getByText("Connection name", { exact: true }).locator("input");
    await expectVisible(connectionNameInput, "B.generic-connect", "connection_name_input_missing");
    await connectionNameInput.fill(connectionName);
    const paperclipOrigin = new URL(config.baseUrl).origin;
    const authorizationRequestPromise = page.waitForRequest((request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return false;
      try {
        const target = new URL(request.url());
        return target.protocol === "https:" && target.origin !== paperclipOrigin;
      } catch {
        return false;
      }
    }, { timeout: 90_000 });
    await page.getByRole("button", { name: /^check actions$/i }).click({ noWaitAfter: true });

    // `connect` returns the authorization URL inline, so the UI immediately
    // replaces this page with the provider. That navigation can abort a
    // Playwright response waiter even though the server committed successfully.
    // Persisted connection state is the durable evidence and gives cleanup the
    // ID before any provider credential entry.
    const createdConnection = await waitFor("B.generic-connect", async () => {
      const response = await apiJson(
        context.request,
        config,
        "GET",
        `/api/companies/${companyId}/tools/connections`,
        undefined,
        "B.generic-connect",
      );
      const matches = asArray(response, "connections").filter((candidate) =>
        candidate.name === connectionName && !existingIds.has(candidate.id) && candidate.status !== "archived");
      if (matches.length > 1) fail("B.generic-connect", "duplicate_connection_detected");
      return matches[0] ?? null;
    }, { timeoutMs: 90_000, intervalMs: 500 });
    connectionId = createdConnection.id;
    // Inspect the initial authorization request, not the provider's eventual
    // login page after redirects (which legitimately omits OAuth parameters).
    const authorizationRequest = await authorizationRequestPromise.catch(() =>
      fail("C.oauth-navigation", "authorization_navigation_missing"));
    const authorizationUrl = authorizationRequest.url();
    let connection = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "B.generic-connect",
    );
    const applications = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/applications`,
      undefined,
      "B.generic-connect",
    );
    const applicationMatches = asArray(applications, "applications").filter((candidate) =>
      candidate.id === connection.applicationId && candidate.name === connectionName && candidate.status !== "archived");
    if (applicationMatches.length !== 1) fail("B.generic-connect", "application_not_unique");
    const application = applicationMatches[0];
    assertGenericProvenance({ application, connection }, connectionName);
    if (connection.authKind !== "oauth") fail("B.generic-connect", "oauth_challenge_missing");
    summary.connection = {
      id: connectionId,
      applicationId: application.id,
      name: connectionName,
      applicationKey: application.applicationKey,
      metadataSource: "link",
      transport: "mcp_remote",
      unverifiedServer: true,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };

    const startResult = persistedOAuthStartResult(connection, authorizationUrl);
    if (!startResult) fail("C.oauth-start", "persisted_start_missing");
    if (startResult.connectionId !== connectionId) fail("C.oauth-start", "connection_id_changed");
    activeCheckpoint = "C.oauth-proof";
    const registrationSource = assertAutomaticRegistrationSource(startResult.registrationSource);
    const navigationProof = inspectAuthorizationUrl(startResult.authorizationUrl, {
      callbackUrl: config.callbackUrl,
      resource: NOTION_RESOURCE,
      registrationSource,
      baseUrl: config.baseUrl,
    });
    summary.oauthProof = {
      registrationSource,
      resource: NOTION_RESOURCE,
      callbackUriExact: true,
      pkceS256: true,
      statePresent: true,
      endpoint: navigationProof.endpoint,
      parameters: navigationProof.parameters,
      discoveredEndpoints: null,
    };

    // Registration source and every URL/PKCE/state invariant are checked before
    // the credential is entered into the provider page.
    activeCheckpoint = "C.notion-login";
    await completeNotionAuthorization(page, config, credential, connectionId);
    activeCheckpoint = "C.oauth-callback";
    const permissionsPath = `/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`;
    await page.goto(new URL(permissionsPath, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("OAuth connected", { exact: true }), "C.oauth-callback", "connected_state_missing", 45_000);
    await expectVisible(page.getByText("Unverified server", { exact: true }), "C.oauth-callback", "unverified_badge_missing");

    connection = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}`,
      undefined,
      "C.connection-detail",
    );
    if (connection.name !== connectionName
      || connection.config?.unverifiedServer !== true
      || connection.config?.sourceTemplateKey === "notion"
      || connection.authKind !== "oauth") {
      fail("C.connection-detail", "generic_provenance_lost");
    }
    const endpointProof = oauthEndpointProof(connection, startResult, config);
    assertNoCredentialMaterial(connection, [config.paperclipPassword, credential.username, credential.password], "C.connection-detail");
    summary.connection = {
      id: connectionId,
      applicationId: connection.applicationId,
      name: connectionName,
      applicationKey: application.applicationKey,
      metadataSource: "link",
      transport: "mcp_remote",
      unverifiedServer: true,
      status: connection.status,
      healthStatus: connection.healthStatus,
    };
    summary.oauthProof = {
      registrationSource,
      resource: NOTION_RESOURCE,
      callbackUriExact: true,
      pkceS256: true,
      statePresent: true,
      endpoint: navigationProof.endpoint,
      parameters: navigationProof.parameters,
      discoveredEndpoints: endpointProof.endpoints,
    };
    const connectedShot = "01-generic-connected.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, connectedShot), config, credential, "F.connected-screenshot");
    summary.screenshots.push(connectedShot);

    activeCheckpoint = "D.health-check";
    const health = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/health-check`,
      {},
      "D.health-check",
    );
    if (health.connection?.healthStatus !== "healthy") fail("D.health-check", "connection_not_healthy");
    const refreshed = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/catalog/refresh`,
      {},
      "D.catalog-refresh",
    );
    const catalog = asArray(refreshed, "catalog");
    const facts = await finishAgentOnlySetup(context.request, config, companyId, connectionId, catalog, agent.id);

    activeCheckpoint = "D.connection-active";
    connection = await apiJson(context.request, config, "GET", `/api/tool-connections/${connectionId}`, undefined, "D.connection-active");
    if (connection.status !== "active" || connection.healthStatus !== "healthy" || connection.config?.unverifiedServer !== true) {
      fail("D.connection-active", "connection_not_active_healthy_generic");
    }
    const uniqueConnections = await apiJson(
      context.request,
      config,
      "GET",
      `/api/companies/${companyId}/tools/connections`,
      undefined,
      "D.connection-active",
    );
    if (asArray(uniqueConnections, "connections").filter((candidate) => candidate.name === connectionName).length !== 1) {
      fail("D.connection-active", "duplicate_connection_detected");
    }
    const installs = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/installs`,
      undefined,
      "D.agent-install",
    );
    const installRows = asArray(installs, "installs");
    if (installRows.length !== 1 || installRows[0].targetType !== "agent" || installRows[0].targetId !== agent.id) {
      fail("D.agent-install", "install_not_agent_only");
    }
    const testAgents = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/test-agents`,
      undefined,
      "D.effective-policy",
    );
    const testAgent = asArray(testAgents, "agents").find((candidate) => candidate.id === agent.id);
    const getSelfAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === NOTION_GET_SELF);
    const createPagesAccess = testAgent?.effectiveAccess?.tools?.find((tool) => tool.toolName === NOTION_CREATE_PAGES);
    if (getSelfAccess?.decision !== "allowed" || createPagesAccess?.decision !== "off") {
      fail("D.effective-policy", "unexpected_effective_decision");
    }
    const deniedWrite = await apiJson(
      context.request,
      config,
      "POST",
      `/api/tool-connections/${connectionId}/test-calls`,
      { agentId: agent.id, toolName: NOTION_CREATE_PAGES, parameters: {} },
      "D.write-denial",
    );
    if (deniedWrite.decision !== "off" || typeof deniedWrite.invocationId !== "string" || !deniedWrite.error) {
      fail("D.write-denial", "write_action_not_denied");
    }
    summary.catalog = {
      discoveredCount: refreshed.discoveredCount,
      advertisedReadTools: facts.active
        .filter((entry) => [NOTION_GET_SELF, "notion-get-users", "notion-fetch"].includes(entry.toolName))
        .map((entry) => entry.toolName),
      getSelf: { catalogEntryId: facts.getSelf.id, decision: "allowed" },
      createPages: {
        catalogEntryId: facts.createPages.id,
        decision: "off",
        localDenialInvocationId: deniedWrite.invocationId,
        upstreamSent: false,
      },
      accessAgentId: agent.id,
      installAgentId: agent.id,
      enabledCatalogEntryCount: 1,
      healthCheck: "healthy",
      catalogRefresh: "succeeded",
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/permissions`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText("Who can use it", { exact: true }), "D.permissions-ui", "permissions_panel_missing");
    const getSelfPermission = page.locator(`[data-action-id="${facts.getSelf.id}"] select`);
    const createPagesPermission = page.locator(`[data-action-id="${facts.createPages.id}"] select`);
    await expectVisible(getSelfPermission, "D.permissions-ui", "get_self_permission_missing");
    await expectVisible(createPagesPermission, "D.permissions-ui", "create_pages_permission_missing");
    if (await getSelfPermission.inputValue() !== "allowed" || await createPagesPermission.inputValue() !== "off") {
      fail("D.permissions-ui", "permissions_ui_mismatch");
    }
    const permissionsShot = "02-read-only-policy.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, permissionsShot), config, credential, "F.permissions-screenshot");
    summary.screenshots.push(permissionsShot);

    activeCheckpoint = "D.test-panel";
    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/test`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByLabel("Choose which agent to test as"), "D.test-panel", "agent_picker_missing");
    await page.getByLabel("Choose which agent to test as").click();
    await page.getByLabel("Search agents").fill(TARGET_AGENT_NAME);
    await page.getByRole("button", { name: new RegExp(`^${escapeRegex(TARGET_AGENT_NAME)}`) }).click();
    await page.getByLabel("Find an action").fill(NOTION_GET_SELF);
    const getSelfTitle = facts.getSelf.title ?? facts.getSelf.toolName;
    const actionRow = page.locator("button").filter({ hasText: getSelfTitle }).filter({ hasText: "Allowed" }).first();
    await expectVisible(actionRow, "D.test-panel", "get_self_allowed_row_missing");
    await actionRow.click();
    await expectVisible(page.getByText("This action takes no inputs."), "D.test-panel", "empty_input_form_missing");
    const boardStartedAt = Date.now();
    const testCallResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/tool-connections/${connectionId}/test-calls`,
    );
    await page.getByRole("button", { name: /^run$/i }).click();
    const testCallResponse = await testCallResponsePromise;
    if (!testCallResponse.ok()) fail("D.board-get-self", `http_${testCallResponse.status()}`);
    const testCall = await testCallResponse.json().catch(() => fail("D.board-get-self", "invalid_json"));
    const testCallInput = testCallResponse.request().postDataJSON();
    if (testCallInput?.agentId !== agent.id
      || testCallInput?.toolName !== NOTION_GET_SELF
      || !testCallInput.parameters
      || Object.keys(testCallInput.parameters).length !== 0) {
      fail("D.board-get-self", "nonempty_or_unexpected_input");
    }
    if (testCall.decision !== "allowed" || testCall.error || typeof testCall.invocationId !== "string") {
      fail("D.board-get-self", "gateway_call_not_allowed");
    }
    const boardIdentity = extractNotionIdentity(testCall.result);
    if (!boardIdentity) fail("D.board-get-self", "workspace_identity_missing");
    await expectVisible(page.getByText(/^Worked\./), "D.board-get-self", "success_result_missing");
    const boardShot = "03-board-notion-get-self.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, boardShot), config, credential, "F.board-test-screenshot");
    summary.screenshots.push(boardShot);
    summary.boardTest = {
      catalogEntryId: facts.getSelf.id,
      toolName: NOTION_GET_SELF,
      invocationId: testCall.invocationId,
      decision: "allowed",
      resultStatus: "succeeded",
      workspace: boardIdentity,
      durationMs: Date.now() - boardStartedAt,
    };

    activeCheckpoint = "E.fresh-agent";
    const proofIssue = await createAndWaitForProofIssue(context.request, config, {
      title: `Notion generic installed-tool proof ${startedAt.toISOString()}`,
      description: [
        "Invoke exactly one installed action: the read-only `notion-get-self` tool with an empty `{}` input.",
        "Make no Notion mutation and do not invoke any other Notion action.",
        `Require workspace ID ${boardIdentity.workspaceId} and workspace name ${boardIdentity.workspaceName}.`,
        "Post exactly one JSON object with keys `workspaceId`, `workspaceName`, and `invocationId` (the Paperclip invocation ID), then mark this issue done.",
        "Do not report tokens, cookies, headers, authorization data, raw payloads, or any other fields.",
      ].join("\n\n"),
      status: "todo",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agent.id,
      acceptanceCriteria: [
        "The installed notion-get-self action succeeds with empty input.",
        "Only sanitized workspace ID/name and Paperclip invocation ID are reported.",
        "No Notion mutation is attempted.",
      ],
    }, "E.fresh-agent");
    for (const comment of proofIssue.comments) {
      assertNoCredentialMaterial(comment.body, [credential.username, credential.password], "E.agent-proof-comment");
    }
    const proof = proofIssue.comments
      .filter((comment) => comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id)
      .map((comment) => parseSanitizedAgentProof(comment.body, boardIdentity))
      .find(Boolean);
    if (!proof) fail("E.agent-proof-comment", "sanitized_proof_missing");

    let finalActivity;
    const agentEvent = await waitFor("E.agent-audit", async () => {
      const activity = await apiJson(
        context.request,
        config,
        "GET",
        `/api/tool-connections/${connectionId}/activity?limit=100`,
        undefined,
        "E.agent-audit",
      );
      assertNoCredentialMaterial(activity, [credential.username, credential.password], "E.agent-audit");
      finalActivity = activity;
      return asArray(activity, "events").find((event) =>
        event.issueId === proofIssue.child.id
        && event.agentId === agent.id
        && event.toolName === NOTION_GET_SELF
        && event.invocationId === proof.invocationId
        && event.outcome === "success") ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!agentEvent.runId) fail("E.agent-audit", "run_id_missing");
    if (agentEvent.requestSummary?.summary !== "{}") fail("E.agent-audit", "get_self_input_not_empty");
    const childToolEvents = asArray(finalActivity, "events").filter((event) =>
      event.issueId === proofIssue.child.id && event.invocationId);
    if (childToolEvents.length !== 1 || childToolEvents[0].toolName !== NOTION_GET_SELF) {
      fail("E.agent-audit", "unexpected_upstream_action");
    }
    const agentRun = await waitFor("E.agent-run-status", async () => {
      const run = await apiJson(context.request, config, "GET", `/api/heartbeat-runs/${agentEvent.runId}`, undefined, "E.agent-run-status");
      if (["failed", "cancelled", "timed_out"].includes(run.status)) fail("E.agent-run-status", `run_${run.status}`);
      return run.status === "succeeded" ? run : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    summary.freshRun = {
      issueId: proofIssue.child.id,
      issueIdentifier: proofIssue.child.identifier,
      transition: {
        created: "todo",
        enteredInProgress: proofIssue.observedStatuses.has("in_progress") || Boolean(proofIssue.finished.startedAt),
        completed: "done",
      },
      runId: agentEvent.runId,
      runStatus: agentRun.status,
      invocationId: proof.invocationId,
      workspace: { id: proof.workspaceId, name: proof.workspaceName },
      connectionId,
      decision: agentEvent.decision ?? "allowed",
      outcome: agentEvent.outcome,
      durationMs: agentEvent.latencyMs,
    };

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/issues/${proofIssue.child.identifier}`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(proofIssue.child.title, { exact: true }).first(), "F.child-screenshot", "child_issue_missing");
    const childShot = "04-fresh-agent-proof.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, childShot), config, credential, "F.child-screenshot");
    summary.screenshots.push(childShot);

    await page.goto(new URL(`/${TARGET_COMPANY_PREFIX}/apps/${connectionId}/activity`, config.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await expectVisible(page.getByText(NOTION_GET_SELF, { exact: false }).first(), "F.activity-screenshot", "get_self_activity_missing");
    const activityShot = "05-redacted-audit.png";
    await safeScreenshot(page, screenshotFile(outputDirectory, activityShot), config, credential, "F.activity-screenshot");
    summary.screenshots.push(activityShot);

    activeCheckpoint = "F.cleanup";
    summary.cleanup = await cleanupConnection(
      context.request,
      config,
      companyId,
      connectionId,
      connectionName,
      { requireInstalled: true },
    );
    cleanupComplete = true;

    activeCheckpoint = "F.post-cleanup-runtime";
    const absenceIssue = await createAndWaitForProofIssue(context.request, config, {
      title: `Notion generic cleanup runtime proof ${startedAt.toISOString()}`,
      description: [
        `Inspect the tools available in this fresh runtime after generic connection ${connectionId} was removed.`,
        "Do not call any Notion tool. Confirm `notion-get-self` from that removed connection is absent.",
        `Post exactly {\"connectionId\":\"${connectionId}\",\"toolPresent\":false} and mark this issue done.`,
        "Do not report any other fields or credential material.",
      ].join("\n\n"),
      status: "todo",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: agent.id,
      acceptanceCriteria: [
        "A fresh runtime does not expose the removed generic connection's notion-get-self tool.",
        "No Notion action is invoked.",
      ],
    }, "F.post-cleanup-runtime");
    const absenceProof = absenceIssue.comments
      .filter((comment) => comment.authorAgentId === agent.id || comment.derivedAuthorAgentId === agent.id)
      .map((comment) => parseRuntimeAbsenceProof(comment.body, connectionId))
      .find(Boolean);
    if (!absenceProof) fail("F.post-cleanup-runtime", "absence_proof_missing");
    const afterCleanupActivity = await apiJson(
      context.request,
      config,
      "GET",
      `/api/tool-connections/${connectionId}/activity?limit=100`,
      undefined,
      "F.post-cleanup-runtime",
    );
    if (asArray(afterCleanupActivity, "events").some((event) => event.issueId === absenceIssue.child.id && event.invocationId)) {
      fail("F.post-cleanup-runtime", "post_cleanup_tool_invocation_detected");
    }
    summary.postCleanupRun = {
      issueId: absenceIssue.child.id,
      issueIdentifier: absenceIssue.child.identifier,
      connectionId,
      toolPresent: false,
      invocationCount: 0,
      completed: "done",
    };
    summary.passed = true;
  } catch (error) {
    caughtFailure = error instanceof SmokeFailure
      ? error
      : error instanceof NotionGenericLivePreflightError
        ? new SmokeFailure(activeCheckpoint, error.code)
        : new SmokeFailure(activeCheckpoint, "unexpected_error");
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
  if (caughtFailure) summary.failure = { checkpoint: caughtFailure.checkpoint, code: caughtFailure.code };
  assertSanitizedEvidence(summary);
  const summaryPath = path.join(outputDirectory, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (caughtFailure) throw caughtFailure;
  return { outputDirectory, summaryPath, screenshots: summary.screenshots };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let prepared;
  try {
    prepared = await prepareNotionGenericLiveSmoke({
      loadBrowser: dryRun ? async () => null : () => import("@playwright/test"),
    });
  } catch (error) {
    process.stderr.write(`${preflightFailureMessage(error)}\n`);
    process.exitCode = error instanceof NotionGenericLivePreflightError ? 2 : 1;
    return;
  }
  if (dryRun) {
    process.stdout.write("Notion generic live smoke dry-run passed; no credential value was fetched.\n");
    return;
  }
  try {
    const result = await runSmoke({ config: prepared.config, chromium: prepared.browserModule.chromium });
    process.stdout.write(`Notion generic live smoke passed. Sanitized evidence: ${result.outputDirectory}\n`);
  } catch (error) {
    const failure = error instanceof SmokeFailure ? error : new SmokeFailure("unexpected", "unexpected_error");
    process.stderr.write(`Notion generic live smoke failed at ${failure.checkpoint} (${failure.code}).\n`);
    process.exitCode = 1;
  }
}

await main();
