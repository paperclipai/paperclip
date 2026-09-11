import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutomaticRegistrationSource,
  assertSanitizedEvidence,
  connectionRemovalFacts,
  extractNotionIdentity,
  extractNotionVerificationCode,
  inspectAuthorizationUrl,
  isFreshNotionVerificationMessage,
  NotionGenericLivePreflightError,
  notionVerificationAuthenticationPassed,
  parseRuntimeAbsenceProof,
  parseSanitizedAgentProof,
  persistedOAuthStartResult,
  preflightNotionGenericLive,
  prepareNotionGenericLiveSmoke,
  safeEndpointSummary,
} from "./notion-generic-live-lib.mjs";

const COMPLETE_ENV = {
  PAPERCLIP_E2E_BASE_URL: "https://paperclip.example.test",
  PAPERCLIP_E2E_EMAIL: "operator@example.test",
  PAPERCLIP_DEV_LOGIN_PASSWORD: "not-a-real-password",
  PAPERCLIP_API_URL: "https://paperclip.example.test/api",
  PAPERCLIP_API_KEY: "not-a-real-agent-key",
  PAPERCLIP_RUN_ID: "run-123",
  PAPERCLIP_TASK_ID: "issue-123",
};

test("preflight reports binding names without exposing supplied values", () => {
  assert.throws(
    () => preflightNotionGenericLive({ PAPERCLIP_DEV_LOGIN_PASSWORD: "present" }),
    (error) => {
      assert.ok(error instanceof NotionGenericLivePreflightError);
      assert.equal(error.code, "missing_environment");
      assert.deepEqual(error.details.missing, [
        "PAPERCLIP_E2E_BASE_URL",
        "PAPERCLIP_E2E_EMAIL",
        "PAPERCLIP_API_URL",
        "PAPERCLIP_API_KEY",
        "PAPERCLIP_RUN_ID",
        "PAPERCLIP_TASK_ID",
      ]);
      assert.doesNotMatch(error.message, /present/);
      return true;
    },
  );
});

test("preflight requires explicit credential-free HTTPS target and control-plane URLs", () => {
  for (const baseUrl of [
    "http://127.0.0.1:3100",
    "http://paperclip.example.test",
    "https://user:secret@paperclip.example.test",
    "https://paperclip.example.test/?code=secret",
  ]) {
    assert.throws(
      () => preflightNotionGenericLive({ ...COMPLETE_ENV, PAPERCLIP_E2E_BASE_URL: baseUrl }),
      (error) => error instanceof NotionGenericLivePreflightError && error.code === "unsafe_base_url",
    );
  }
  const split = preflightNotionGenericLive({
    ...COMPLETE_ENV,
    PAPERCLIP_API_URL: "https://control-plane.example.test/api",
  });
  assert.equal(split.baseUrl, "https://paperclip.example.test");
  assert.equal(split.apiBaseUrl, "https://control-plane.example.test/api");
});

test("health and binding metadata pass before browser loading, without fetching the value", async () => {
  const requests = [];
  let browserLoaded = false;
  const prepared = await prepareNotionGenericLiveSmoke({
    environment: COMPLETE_ENV,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), method: init.method ?? "GET" });
      if (String(url).endsWith("/api/health")) {
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      return {
        ok: true,
        json: async () => ({ secrets: [{ key: "generic-flow-test-account", delivery: "api" }] }),
      };
    },
    loadBrowser: async () => {
      browserLoaded = true;
      return { chromium: {} };
    },
  });
  assert.equal(prepared.config.callbackUrl, "https://paperclip.example.test/api/tools/oauth/callback");
  assert.equal(browserLoaded, true);
  assert.deepEqual(requests.map((entry) => entry.method), ["GET", "GET"]);
  assert.equal(requests.some((entry) => entry.url.includes("/value")), false);
});

test("an unavailable secret binding fails before browser or credential entry", async () => {
  let browserLoaded = false;
  await assert.rejects(
    prepareNotionGenericLiveSmoke({
      environment: COMPLETE_ENV,
      fetchImpl: async (url) => String(url).endsWith("/api/health")
        ? { ok: true, json: async () => ({ status: "ok" }) }
        : { ok: true, json: async () => ({ secrets: [] }) },
      loadBrowser: async () => {
        browserLoaded = true;
      },
    }),
    (error) => error instanceof NotionGenericLivePreflightError && error.code === "secret_binding_unavailable",
  );
  assert.equal(browserLoaded, false);
});

test("selects only fresh authenticated Notion verification mail and extracts one code", () => {
  const notBefore = new Date("2026-08-18T12:00:00.000Z");
  const message = {
    timestamp: new Date("2026-08-18T12:00:05.000Z"),
    from: "Notion <login@mail.notion.so>",
    subject: "Your Notion login code",
    extractedText: "Your temporary login code is 123 456.",
    headers: {
      "authentication-results": "dkim=pass; spf=pass; dmarc=pass",
    },
  };
  assert.equal(isFreshNotionVerificationMessage(message, { notBefore }), true);
  assert.equal(notionVerificationAuthenticationPassed(message), true);
  assert.equal(extractNotionVerificationCode(message), "123456");
  assert.equal(isFreshNotionVerificationMessage({
    ...message,
    timestamp: new Date("2026-08-18T11:59:59.000Z"),
  }, { notBefore }), false);
  assert.equal(isFreshNotionVerificationMessage({
    ...message,
    from: "Notion <login@example.test>",
  }, { notBefore }), false);
  assert.equal(notionVerificationAuthenticationPassed({
    ...message,
    headers: { "authentication-results": "dkim=fail; spf=pass" },
  }), false);
  assert.equal(extractNotionVerificationCode({ ...message, extractedText: "Codes 123456 and 654321" }), null);
});

test("authorization proof requires automatic registration, PKCE, callback, resource, and safe endpoints", () => {
  assert.equal(assertAutomaticRegistrationSource("cimd"), "cimd");
  assert.equal(assertAutomaticRegistrationSource("dcr"), "dcr");
  for (const source of ["manual", "preconfigured", null]) {
    assert.throws(
      () => assertAutomaticRegistrationSource(source),
      (error) => error instanceof NotionGenericLivePreflightError && error.code === "unexpected_registration_source",
    );
  }

  const baseUrl = "https://paperclip.example.test";
  const callbackUrl = `${baseUrl}/api/tools/oauth/callback`;
  const resource = "https://mcp.notion.com/mcp";
  const url = new URL("https://mcp.notion.com/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", `${baseUrl}/api/tools/oauth/client-metadata`);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", "not-recorded");
  url.searchParams.set("code_challenge", "not-recorded");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);

  assert.deepEqual(inspectAuthorizationUrl(url.toString(), {
    callbackUrl,
    resource,
    registrationSource: "cimd",
    baseUrl,
  }), {
    endpoint: { origin: "https://mcp.notion.com", path: "/authorize" },
    parameters: { clientId: true, state: true, pkceS256: true, callbackUri: true, resource: true },
  });
  assert.deepEqual(safeEndpointSummary("https://mcp.notion.com/token", "token"), {
    origin: "https://mcp.notion.com",
    path: "/token",
  });
  assert.throws(
    () => safeEndpointSummary("http://mcp.notion.com/token", "token"),
    (error) => error instanceof NotionGenericLivePreflightError && error.code === "unsafe_token_endpoint",
  );
});

test("authorization proof rejects a provider login page after OAuth parameters were consumed", () => {
  assert.throws(
    () => inspectAuthorizationUrl("https://id.notion.test/login", {
      callbackUrl: "https://paperclip.example/api/tools/oauth/callback",
      resource: "https://mcp.notion.com/mcp",
      registrationSource: "dcr",
      baseUrl: "https://paperclip.example",
    }),
    (error) => error instanceof NotionGenericLivePreflightError
      && error.code === "authorization_parameter_missing",
  );
});

test("reconstructs the inline OAuth start from durable connection state and provider navigation", () => {
  assert.deepEqual(persistedOAuthStartResult({
    id: "connection-123",
    config: {
      oauth: {
        clientRegistrationSource: "cimd",
        issuer: "https://mcp.notion.com",
        resource: "https://mcp.notion.com/mcp",
      },
    },
  }, " https://mcp.notion.com/authorize?state=not-recorded "), {
    connectionId: "connection-123",
    authorizationUrl: "https://mcp.notion.com/authorize?state=not-recorded",
    registrationSource: "cimd",
    issuer: "https://mcp.notion.com",
    resource: "https://mcp.notion.com/mcp",
  });
  assert.equal(persistedOAuthStartResult({ id: "connection-123", config: {} }, "https://example.test"), null);
});

test("accepts zero-count cleanup before setup but requires full revocation after install", () => {
  const partial = {
    installsRemoved: 0,
    appProfileBindingsRemoved: 0,
    credentialRefsCleared: 0,
    secretsRevoked: 0,
    secretBindingsRemoved: 0,
    grantsRevoked: 0,
    oauthStatesDiscarded: 1,
    runtimeSlotsStopped: 0,
    appProfile: "absent",
  };
  assert.deepEqual(connectionRemovalFacts(partial), {
    credentialsRemoved: 0,
    secretBindingsRemoved: 0,
    grantsRevoked: 0,
    accessBindingsRemoved: 0,
    installsRemoved: 0,
    oauthStatesDiscarded: 1,
    runtimeSlotsStopped: 0,
    appProfile: "absent",
  });
  assert.equal(connectionRemovalFacts(partial, { requireInstalled: true }), null);
  assert.ok(connectionRemovalFacts({
    ...partial,
    installsRemoved: 1,
    appProfileBindingsRemoved: 1,
    secretsRevoked: 1,
    appProfile: "deleted",
  }, { requireInstalled: true }));
});

test("workspace proof extraction and fresh-run comments retain only sanitized identity", () => {
  const identity = extractNotionIdentity({
    result: {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: "bot-123",
          type: "bot",
          bot: { workspace_id: "workspace-123", workspace_name: "Paperclip" },
          token: "discard-me",
        }),
      }],
    },
  });
  assert.deepEqual(identity, {
    workspaceId: "workspace-123",
    workspaceName: "Paperclip",
    botId: "bot-123",
  });
  assert.deepEqual(
    parseSanitizedAgentProof(
      '{"workspaceId":"workspace-123","workspaceName":"Paperclip","invocationId":"inv-123"}',
      identity,
    ),
    { workspaceId: "workspace-123", workspaceName: "Paperclip", invocationId: "inv-123" },
  );
  assert.deepEqual(
    parseRuntimeAbsenceProof('{"connectionId":"conn-123","toolPresent":false}', "conn-123"),
    { connectionId: "conn-123", toolPresent: false },
  );
});

test("sanitized evidence rejects credential fields, sessions, and OAuth query values", () => {
  assert.doesNotThrow(() => assertSanitizedEvidence({ workspaceId: "workspace-123", invocationId: "inv-123" }));
  assert.throws(() => assertSanitizedEvidence({ accessToken: "secret" }), /unsafe_evidence_key/);
  assert.throws(() => assertSanitizedEvidence({ sessionId: "secret" }), /unsafe_evidence_key/);
  assert.throws(() => assertSanitizedEvidence({ note: "callback?code=secret" }), /unsafe_evidence_text/);
});
