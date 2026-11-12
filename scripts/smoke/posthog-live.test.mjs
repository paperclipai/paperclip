import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSanitizedEvidence,
  extractProjectSummary,
  parsePosthogLiveArguments,
  parseSanitizedAgentProof,
  PosthogLivePreflightError,
  preflightPosthogLive,
  preparePosthogLiveSmoke,
} from "./posthog-live-lib.mjs";

const COMPLETE_ENV = {
  PAPERCLIP_API_URL: "https://paperclip.example.test/api",
  INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL: "operator@example.test",
  INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD: "not-a-real-password",
  INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID: "483530",
};

test("preflight reports only missing binding names", () => {
  assert.throws(
    () => preflightPosthogLive({
      PAPERCLIP_API_URL: "https://paperclip.example.test/api",
      INTEGRATIONS_POSTHOG_PAPERCLIP_DEV_LOGIN_PASSWORD: "present",
    }),
    (error) => {
      assert.ok(error instanceof PosthogLivePreflightError);
      assert.equal(error.code, "missing_environment");
      assert.deepEqual(error.details.missing, [
        "INTEGRATIONS_POSTHOG_PAPERCLIP_E2E_EMAIL",
        "INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID",
      ]);
      assert.doesNotMatch(error.message, /present/);
      return true;
    },
  );
});

test("preflight rejects credential-bearing and non-HTTPS remote URLs", () => {
  for (const baseUrl of [
    "https://user:secret@example.test",
    "https://example.test/?code=secret",
    "http://example.test",
  ]) {
    assert.throws(
      () => preflightPosthogLive({ ...COMPLETE_ENV, PAPERCLIP_API_URL: baseUrl }),
      (error) => error instanceof PosthogLivePreflightError && error.code === "unsafe_base_url",
    );
  }
  assert.equal(
    preflightPosthogLive(COMPLETE_ENV, { baseUrl: "http://127.0.0.1:3100" }).baseUrl,
    "http://127.0.0.1:3100",
  );
});

test("preflight derives the current Paperclip origin and accepts an explicit target", () => {
  assert.equal(preflightPosthogLive(COMPLETE_ENV).baseUrl, "https://paperclip.example.test");
  assert.equal(
    preflightPosthogLive(COMPLETE_ENV, { baseUrl: "https://other-paperclip.example.test" }).baseUrl,
    "https://other-paperclip.example.test",
  );
  assert.throws(
    () => preflightPosthogLive({ ...COMPLETE_ENV, PAPERCLIP_API_URL: "" }),
    (error) => error instanceof PosthogLivePreflightError && error.code === "missing_base_url",
  );
});

test("preflight fails closed unless the PostHog project is exactly 483530", () => {
  assert.throws(
    () => preflightPosthogLive({
      ...COMPLETE_ENV,
      INTEGRATIONS_POSTHOG_POSTHOG_PROJECT_ID: "42",
    }),
    (error) => error instanceof PosthogLivePreflightError && error.code === "unexpected_project_id",
  );
});

test("live smoke arguments accept a target URL without another environment binding", () => {
  assert.deepEqual(parsePosthogLiveArguments([]), {});
  assert.deepEqual(
    parsePosthogLiveArguments(["https://paperclip.example.test"]),
    { baseUrl: "https://paperclip.example.test" },
  );
  assert.deepEqual(
    parsePosthogLiveArguments(["--base-url", "https://paperclip.example.test"]),
    { baseUrl: "https://paperclip.example.test" },
  );
  assert.throws(
    () => parsePosthogLiveArguments(["--unknown"]),
    (error) => error instanceof PosthogLivePreflightError && error.code === "invalid_arguments",
  );
});

test("browser loading happens only after binding and health preflight", async () => {
  let fetchCalled = false;
  let browserLoaded = false;
  await assert.rejects(
    preparePosthogLiveSmoke({
      environment: {},
      fetchImpl: async () => {
        fetchCalled = true;
      },
      loadBrowser: async () => {
        browserLoaded = true;
      },
    }),
    (error) => error instanceof PosthogLivePreflightError && error.code === "missing_environment",
  );
  assert.equal(fetchCalled, false);
  assert.equal(browserLoaded, false);

  await assert.rejects(
    preparePosthogLiveSmoke({
      environment: COMPLETE_ENV,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      loadBrowser: async () => {
        browserLoaded = true;
      },
    }),
    (error) => error instanceof PosthogLivePreflightError && error.code === "health_http_error",
  );
  assert.equal(browserLoaded, false);
});

test("project proof extraction retains only the expected id and name", () => {
  const result = {
    data: {
      content: [{ type: "text", text: JSON.stringify({ id: 483530, name: "Paperclip", token: "discard-me" }) }],
    },
  };
  assert.deepEqual(extractProjectSummary(result, "483530"), { id: "483530", name: "Paperclip" });
  assert.equal(extractProjectSummary(result, "42"), null);

  assert.deepEqual(
    parseSanitizedAgentProof(
      '{"projectId":"483530","projectName":"Paperclip","invocationId":"inv-123"}',
      "483530",
    ),
    { projectId: "483530", projectName: "Paperclip", invocationId: "inv-123" },
  );
  assert.equal(
    parseSanitizedAgentProof(
      'Done: {"projectId":"483530","projectName":"Paperclip","invocationId":"inv-123"}',
      "483530",
    ),
    null,
  );
  assert.equal(
    parseSanitizedAgentProof(
      '{"projectId":"483530","projectName":"Paperclip","invocationId":"inv-123","token":"unsafe"}',
      "483530",
    ),
    null,
  );
});

test("sanitized evidence rejects credential fields and OAuth query values", () => {
  assert.doesNotThrow(() => assertSanitizedEvidence({ projectId: "483530", invocationId: "inv-123" }));
  assert.throws(() => assertSanitizedEvidence({ accessToken: "secret" }), /unsafe_evidence_key/);
  assert.throws(() => assertSanitizedEvidence({ note: "callback?code=secret" }), /unsafe_evidence_text/);
});
