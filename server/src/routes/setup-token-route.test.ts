// The wired setup-token login route. This test drives the full login path —
// start, read-prompt, submit-code, and completion — through the HTTP route with
// a fake transport. It proves the guarded session contract is the live login
// path and that the security controls hold end to end at the route level.
//
// The test covers these criteria (the full set is on the parent plan document):
//   * The full path returns the sign-in URL to the owner, accepts one code, and
//     returns the non-secret storedSessionId claim after the secret write, with
//     no token.
//   * SR-1 and SR-5: the browser code, the authorization-URL query values, and
//     the token never reach the request log, an activity detail, the exception
//     metadata, or a non-owner response. The owner read-prompt response carries
//     the full URL with `Cache-Control: no-store`; every other response carries
//     the sanitized URL form only.
//   * SR-6 and SR-7: the fail-closed confidential transport guard rejects a
//     non-TLS request and a spoofed forwarded protocol through the wired route.

import express from "express";
import { Writable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETUP_TOKEN_SESSION_NOT_FOUND,
  SETUP_TOKEN_SUBMIT_CONFLICT,
  SETUP_TOKEN_TRANSPORT_INSECURE,
  type SetupTokenCleanupRecord,
  type SetupTokenCleanupStore,
  type SetupTokenLeaseManager,
  type SetupTokenLoginOutcome,
  type SetupTokenLoginProcessFactory,
  type SetupTokenSecretWriter,
} from "../services/setup-token-session.js";

// --- Test fixtures -----------------------------------------------------------

const COMPANY_ID = "company-1";
const OTHER_COMPANY_ID = "company-2";
const OWNER_USER_ID = "owner-user-1";
const OTHER_USER_ID = "other-user-2";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";

// The distinctive secret values. Each holds a unique marker, so a substring
// check proves the value never reached a sink.
const BROWSER_CODE = "CODESECRETqrs321";
const URL_CODE_QUERY = "QUERYSECRETabc123";
const URL_STATE_QUERY = "STATESECRETdef456";
const MINTED_TOKEN = "sk-ant-oat01-TOKENSECRETxyz789aaaaaaaaaaaa";

// The full authorization URL the transport surfaces. Its query holds the two
// distinctive markers. The sanitized form keeps only the origin and the path.
const FULL_LOGIN_URL =
  "https://claude.com/cai/oauth/authorize" +
  "?client_id=abc" +
  `&code=${URL_CODE_QUERY}` +
  "&code_challenge=xyz" +
  "&code_challenge_method=S256" +
  "&redirect_uri=https%3A%2F%2Fexample.test%2Fcb" +
  "&response_type=code" +
  "&scope=user" +
  `&state=${URL_STATE_QUERY}`;
const SANITIZED_LOGIN_URL = "https://claude.com/cai/oauth/authorize";

const SECRET_MARKERS = [BROWSER_CODE, URL_CODE_QUERY, URL_STATE_QUERY, MINTED_TOKEN, "TOKENSECRETxyz789"];

function expectNoSecret(text: string): void {
  for (const marker of SECRET_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

// --- Service mocks -----------------------------------------------------------

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
// The environment service the company-and-environment routes call to resolve the
// sandbox environment server-side. A test sets the resolved environment shape to
// prove the fail-closed environment guard.
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn(), getByIdentifier: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockRunSecretRedactionRegistry = vi.hoisted(() => ({
  redactForRun: vi.fn(async (_companyId: string, _runId: string, value: unknown) => value),
}));

function registerModuleMocks(): void {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
  vi.doMock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
  vi.doMock("../services/run-secret-redaction.js", () => ({
    createRunSecretRedactionRegistry: () => mockRunSecretRedactionRegistry,
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

// The actor the request middleware installs. A test switches the owner id to
// prove the owner-binding check (SR-3).
let currentActor: Record<string, unknown>;
function useOwner(userId: string = OWNER_USER_ID): void {
  currentActor = {
    type: "board",
    userId,
    companyIds: [COMPANY_ID],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

// --- Fake transport ----------------------------------------------------------

interface TransportHandle {
  factory: SetupTokenLoginProcessFactory;
  leases: SetupTokenLeaseManager;
  store: SetupTokenCleanupStore;
  completeCredential: SetupTokenSecretWriter;
  submittedCodes: string[];
  secretWrites: string[];
  // Every cleanup record the store persisted. A test asserts the route writes no
  // empty environment scope, so a rejected environment never reaches the store.
  records: SetupTokenCleanupRecord[];
}

/**
 * Builds a fake login transport. The factory surfaces the sign-in URL at once.
 * On submit it either completes the login and writes the credential, throws an
 * internal error, or leaves the process pending. The lease manager, the store,
 * and the secret writer are in-memory and hold no secret in a durable sink.
 */
function buildTransport(opts: { onSubmit?: "complete" | "throw" | "pending" } = {}): TransportHandle {
  const mode = opts.onSubmit ?? "complete";
  const submittedCodes: string[] = [];
  // The owner-bound secret writer records only the token it received in memory,
  // so a test can prove the write ran without a durable secret sink.
  const secretWrites: string[] = [];
  const completeCredential: SetupTokenSecretWriter = async (input) => {
    secretWrites.push(input.token);
  };
  const rows = new Map<string, SetupTokenCleanupRecord>();
  const records: SetupTokenCleanupRecord[] = [];
  const store: SetupTokenCleanupStore = {
    async record(record) {
      rows.set(record.sessionId, { ...record });
      records.push({ ...record });
    },
    async markState(identity, state) {
      const row = rows.get(identity.sessionId);
      if (row) row.state = state;
    },
    async remove(sessionId) {
      rows.delete(sessionId);
    },
    async listReapable() {
      return [];
    },
    async consumeStoredClaim(identity) {
      const row = rows.get(identity.sessionId);
      if (!row || row.state !== "stored" || row.boundAt !== null || row.deadline <= Date.now()) {
        return null;
      }
      row.boundAt = Date.now();
      return { ...row };
    },
  };
  const leases: SetupTokenLeaseManager = {
    async acquire() {
      return { id: "lease-1" };
    },
    async release() {},
    async releaseById() {},
  };
  const factory: SetupTokenLoginProcessFactory = ({ onPrompt, onCredential }) => {
    onPrompt({ url: FULL_LOGIN_URL });
    let resolveDone!: (outcome: SetupTokenLoginOutcome) => void;
    const done = new Promise<SetupTokenLoginOutcome>((resolve) => {
      resolveDone = resolve;
    });
    return {
      done,
      submitCode(code: string) {
        submittedCodes.push(code);
        if (mode === "throw") {
          throw new Error("the sandbox pseudo-terminal write failed.");
        }
        if (mode === "complete") {
          // Await the credential sink (the owner-bound secret write) before the
          // process reports success, the way the real runner awaits its sink.
          void onCredential(MINTED_TOKEN).then(
            () => resolveDone("success"),
            () => resolveDone("failure"),
          );
        }
        // pending: the process stays open; the test drives no completion.
      },
      stop() {},
    };
  };
  return { factory, leases, store, completeCredential, submittedCodes, secretWrites, records };
}

// --- App builder with a capturing request logger -----------------------------

interface AppHandle {
  app: express.Express;
  logLines: string[];
}

async function createApp(opts: {
  deploymentMode?: "local_trusted" | "authenticated";
  confidentialProxyAllowlist?: string[];
  transport?: TransportHandle;
} = {}): Promise<AppHandle> {
  const [{ agentRoutes }, { errorHandler }, pinoModule, pinoHttpModule, redactModule] =
    await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("pino")>("pino"),
      vi.importActual<typeof import("pino-http")>("pino-http"),
      vi.importActual<typeof import("../middleware/redact-sensitive.js")>(
        "../middleware/redact-sensitive.js",
      ),
    ]);
  const { pino } = pinoModule;
  const { pinoHttp } = pinoHttpModule;
  const { redactSensitive } = redactModule;

  // Capture every request-log line into an array. The custom properties mirror
  // the production request logger: on a 4xx or 5xx response it logs the request
  // body, params, and query through `redactSensitive`, so a secret in a request
  // body cannot reach the log line.
  const logLines: string[] = [];
  const captureStream = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const captureLogger = pino({ level: "debug" }, captureStream);
  const httpCapture = pinoHttp({
    logger: captureLogger,
    customProps(req, res) {
      if (res.statusCode < 400) return {};
      const ctx = (res as unknown as { __errorContext?: Record<string, unknown> }).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          reqQuery: redactSensitive(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as unknown as {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactSensitive(query);
      }
      return props;
    },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = currentActor;
    next();
  });
  app.use(httpCapture);
  app.use(
    "/api",
    agentRoutes({} as never, {
      deploymentMode: opts.deploymentMode,
      confidentialProxyAllowlist: opts.confidentialProxyAllowlist,
      setupTokenLogin: opts.transport
        ? {
            factory: opts.transport.factory,
            leases: opts.transport.leases,
            store: opts.transport.store,
            completeCredential: opts.transport.completeCredential,
          }
        : undefined,
    }),
  );
  app.use(errorHandler);
  return { app, logLines };
}

// Lets the pending microtasks settle, so the login-process `done` handler runs
// its terminal-state transition and the cleanup before the next request.
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const BASE = `/api/agents/${AGENT_ID}/setup-token-login-sessions`;

beforeEach(() => {
  vi.resetModules();
  registerModuleMocks();
  vi.clearAllMocks();
  useOwner();
  mockAgentService.getById.mockResolvedValue({
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Claude agent",
    adapterType: "claude_local",
    defaultEnvironmentId: ENVIRONMENT_ID,
  });
  // The default resolved environment is an active sandbox with a real provider,
  // so the company-and-environment start route passes the fail-closed guard. A
  // test overrides this to prove the guard rejects an invalid environment.
  mockEnvironmentService.getById.mockResolvedValue({
    id: ENVIRONMENT_ID,
    driver: "sandbox",
    status: "active",
    config: { provider: "kubernetes" },
  });
});

describe("setup-token login route — full path", () => {
  it("drives start, read-prompt, submit-code, and completion with a fake transport", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    // Start the session. The route returns the opaque id and no secret.
    const startRes = await request(app).post(BASE).send({});
    expect(startRes.status, JSON.stringify(startRes.body)).toBe(201);
    const sessionId = startRes.body.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(startRes.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(startRes.body));

    // Read the prompt. The owner response carries the full URL, with no-store.
    const promptRes = await request(app).get(`${BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status, JSON.stringify(promptRes.body)).toBe(200);
    expect(promptRes.body.loginUrl).toBe(FULL_LOGIN_URL);
    expect(promptRes.body.state).toBe("awaiting_code");
    expect(promptRes.headers["cache-control"]).toBe("no-store");

    // Submit the one browser code. The response carries no secret.
    const codeRes = await request(app).post(`${BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE });
    expect(codeRes.status, JSON.stringify(codeRes.body)).toBe(200);
    expect(transport.submittedCodes).toEqual([BROWSER_CODE]);
    expectNoSecret(JSON.stringify(codeRes.body));

    await settle();

    // The owner-bound secret write ran with the minted token.
    expect(transport.secretWrites).toEqual([MINTED_TOKEN]);

    // Read the completion. The owner response carries the non-secret
    // storedSessionId and no token, with no-store.
    const tokenRes = await request(app).post(`${BASE}/${sessionId}/token`).send({});
    expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
    expect(tokenRes.body.storedSessionId).toBe(sessionId);
    expect(tokenRes.body.token).toBeUndefined();
    expect(tokenRes.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(tokenRes.body));

    // The completion is non-secret and idempotent within the retention window.
    const secondTokenRes = await request(app).post(`${BASE}/${sessionId}/token`).send({});
    expect(secondTokenRes.status).toBe(200);
    expect(secondTokenRes.body.storedSessionId).toBe(sessionId);
  });

  it("returns the fixed no-secret error when no transport is bound", async () => {
    const { app } = await createApp({});
    const startRes = await request(app).post(BASE).send({});
    expect(startRes.status).toBe(503);
    expect(startRes.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(startRes.body));
  });

  it("binds the session to the owner: a different owner gets the same not-found error", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const startRes = await request(app).post(BASE).send({});
    const sessionId = startRes.body.sessionId as string;

    // A different owner reads the same id. The route returns the not-found error,
    // so a caller cannot tell a cross-owner session from a missing one.
    useOwner(OTHER_USER_ID);
    const promptRes = await request(app).get(`${BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status).toBe(404);
    expect(promptRes.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
    expect(JSON.stringify(promptRes.body)).not.toContain(URL_CODE_QUERY);
  });
});

describe("setup-token login route — SR-1 and SR-5 (no secret in a sink)", () => {
  it("keeps the code, the URL query, and the token out of every log, activity, and non-owner sink", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app, logLines } = await createApp({ transport });

    const startRes = await request(app).post(BASE).send({});
    const sessionId = startRes.body.sessionId as string;

    // The invalid-session path: a bogus id with the code in the body.
    const invalidRes = await request(app)
      .post(`${BASE}/bogus-session-id/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(invalidRes.status).toBe(404);
    expect(invalidRes.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
    expectNoSecret(JSON.stringify(invalidRes.body));

    // The first submit completes the login.
    const firstCode = await request(app).post(`${BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE });
    expect(firstCode.status).toBe(200);
    await settle();

    // The duplicate-submit path: the same code again, after completion.
    const duplicateRes = await request(app)
      .post(`${BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(duplicateRes.status).toBe(409);
    expect(duplicateRes.body.error).toBe(SETUP_TOKEN_SUBMIT_CONFLICT);
    expectNoSecret(JSON.stringify(duplicateRes.body));

    await settle();

    // The request log holds no secret, and it did log the redacted request body,
    // so the check is not vacuous.
    const logText = logLines.join("\n");
    expectNoSecret(logText);
    expect(logText).toContain("[REDACTED]");

    // No activity detail holds a secret.
    const activityText = JSON.stringify(mockLogActivity.mock.calls);
    expectNoSecret(activityText);
  });

  it("keeps the code out of the exception metadata on the internal-error path", async () => {
    const transport = buildTransport({ onSubmit: "throw" });
    const { app, logLines } = await createApp({ transport });

    const startRes = await request(app).post(BASE).send({});
    const sessionId = startRes.body.sessionId as string;

    const errorRes = await request(app).post(`${BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE });
    expect(errorRes.status).toBe(500);
    expect(errorRes.body.error).toBe("Internal server error");
    expectNoSecret(JSON.stringify(errorRes.body));

    await settle();
    const logText = logLines.join("\n");
    expectNoSecret(logText);
  });
});

describe("setup-token login route — SR-6 and SR-7 (fail-closed transport guard)", () => {
  it("rejects a non-TLS confidential request and a spoofed forwarded protocol", async () => {
    // Authenticated mode with no proxy allowlist: a loopback HTTP peer does not
    // pass the confidential guard, so read-prompt and receive-token fail closed.
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport, deploymentMode: "authenticated", confidentialProxyAllowlist: [] });

    const startRes = await request(app).post(BASE).send({});
    const sessionId = startRes.body.sessionId as string;

    // read-prompt over plain HTTP → fixed no-secret error, no URL.
    const promptRes = await request(app).get(`${BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status).toBe(403);
    expect(promptRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expect(promptRes.headers["cache-control"]).toBe("no-store");
    expect(promptRes.body.loginUrl).toBeUndefined();
    expectNoSecret(JSON.stringify(promptRes.body));

    // A spoofed forwarded protocol does not unlock the response. The guard reads
    // the raw socket, not the header, unless the peer is on the allowlist.
    const spoofRes = await request(app)
      .get(`${BASE}/${sessionId}/prompt`)
      .set("X-Forwarded-Proto", "https")
      .send();
    expect(spoofRes.status).toBe(403);
    expect(spoofRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expectNoSecret(JSON.stringify(spoofRes.body));

    // submit-code over plain HTTP → the guard fails closed. The browser code is
    // the confidential OAuth secret, so it must never ride an untrusted transport.
    // A spoofed forwarded protocol does not unlock it either. The code never
    // reaches the transport.
    const codeRes = await request(app).post(`${BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE });
    expect(codeRes.status).toBe(403);
    expect(codeRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expectNoSecret(JSON.stringify(codeRes.body));

    const spoofCodeRes = await request(app)
      .post(`${BASE}/${sessionId}/code`)
      .set("X-Forwarded-Proto", "https")
      .send({ browserCode: BROWSER_CODE });
    expect(spoofCodeRes.status).toBe(403);
    expect(spoofCodeRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expectNoSecret(JSON.stringify(spoofCodeRes.body));

    expect(transport.submittedCodes).toEqual([]);

    // The completion over plain HTTP also fails closed and returns no claim.
    const tokenRes = await request(app)
      .post(`${BASE}/${sessionId}/token`)
      .set("X-Forwarded-Proto", "https")
      .send({});
    expect(tokenRes.status).toBe(403);
    expect(tokenRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expect(tokenRes.body.token).toBeUndefined();
    expect(tokenRes.body.storedSessionId).toBeUndefined();
    expectNoSecret(JSON.stringify(tokenRes.body));
  });

  it("ignores a forwarded protocol from a non-allowlisted peer", async () => {
    // A non-empty allowlist that does not match the loopback peer still fails
    // closed for a forwarded HTTPS protocol.
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({
      transport,
      deploymentMode: "authenticated",
      confidentialProxyAllowlist: ["10.0.0.1"],
    });

    const startRes = await request(app).post(BASE).send({});
    const sessionId = startRes.body.sessionId as string;

    const promptRes = await request(app)
      .get(`${BASE}/${sessionId}/prompt`)
      .set("X-Forwarded-Proto", "https")
      .send();
    expect(promptRes.status).toBe(403);
    expect(promptRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expectNoSecret(JSON.stringify(promptRes.body));
  });
});

// --- Company-and-environment routes ------------------------------------------
//
// These tests drive the agentless Claude login. The scope binds one login to one
// company, one owner, one adapter, and one environment. The route carries no
// agent id, resolves the environment server-side, and returns the same not-found
// error for a foreign session as for a missing session (Control 2).

const COMPANY_BASE = `/api/companies/${COMPANY_ID}/setup-token-login-sessions`;

// Starts a company-and-environment login and returns the session id. The default
// body names the Claude adapter and the resolved sandbox environment.
async function startCompanySession(
  app: express.Express,
  body: Record<string, unknown> = { environmentId: ENVIRONMENT_ID, adapterType: "claude_local" },
): Promise<request.Response> {
  return request(app).post(COMPANY_BASE).send(body);
}

describe("company-and-environment setup-token route — full path", () => {
  it("drives start, status, prompt, code, and completion with no agent id", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    // Start. The response carries the environment, the panel mode, and no prompt
    // and no secret. The full login URL rides only in the guarded prompt read.
    const startRes = await startCompanySession(app);
    expect(startRes.status, JSON.stringify(startRes.body)).toBe(201);
    const sessionId = startRes.body.sessionId as string;
    expect(sessionId).toBeTruthy();
    expect(startRes.body.environmentId).toBe(ENVIRONMENT_ID);
    expect(startRes.body.status).toBe("waiting_for_user");
    expect(startRes.body.panelMode).toBe("submitted_browser_code");
    expect(startRes.body.prompt).toBeNull();
    expect(startRes.body.failure).toBeNull();
    expect(startRes.headers["cache-control"]).toBe("no-store");
    // The scope carries no agent id, so the response holds none.
    expect(JSON.stringify(startRes.body)).not.toContain(AGENT_ID);
    expectNoSecret(JSON.stringify(startRes.body));

    // The store persisted the resolved environment, never an empty value.
    expect(transport.records.map((r) => r.environmentId)).toEqual([ENVIRONMENT_ID]);

    // Read the public status. It carries no prompt and no secret.
    const statusRes = await request(app).get(`${COMPANY_BASE}/${sessionId}`).send();
    expect(statusRes.status, JSON.stringify(statusRes.body)).toBe(200);
    expect(statusRes.body.status).toBe("waiting_for_user");
    expect(statusRes.body.environmentId).toBe(ENVIRONMENT_ID);
    expect(statusRes.body.prompt).toBeUndefined();
    expectNoSecret(JSON.stringify(statusRes.body));

    // Read the prompt. The owner response carries the full URL, with no-store.
    const promptRes = await request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status, JSON.stringify(promptRes.body)).toBe(200);
    expect(promptRes.body.authorizationUrl).toBe(FULL_LOGIN_URL);
    expect(promptRes.headers["cache-control"]).toBe("no-store");

    // Submit the one browser code. The response carries no secret.
    const codeRes = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(codeRes.status, JSON.stringify(codeRes.body)).toBe(200);
    expect(transport.submittedCodes).toEqual([BROWSER_CODE]);
    expectNoSecret(JSON.stringify(codeRes.body));

    await settle();
    expect(transport.secretWrites).toEqual([MINTED_TOKEN]);

    // Read the completion. The owner response carries the non-secret
    // storedSessionId and no token, with no-store.
    const completionRes = await request(app).post(`${COMPANY_BASE}/${sessionId}/completion`).send();
    expect(completionRes.status, JSON.stringify(completionRes.body)).toBe(200);
    expect(completionRes.body.storedSessionId).toBe(sessionId);
    expect(completionRes.body.token).toBeUndefined();
    expect(completionRes.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(completionRes.body));
  });

  it("addresses no agent-scoped session: an agent read cannot reach a company session", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // The agent-scoped read builds a scope with the agent id, so it cannot
    // resolve the agentless company session. It returns the same not-found error.
    const agentRead = await request(app).get(`${BASE}/${sessionId}/prompt`).send();
    expect(agentRead.status).toBe(404);
    expect(agentRead.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
  });

  it("returns the fixed no-secret error when no transport is bound", async () => {
    const { app } = await createApp({});
    const startRes = await startCompanySession(app);
    expect(startRes.status).toBe(503);
    expect(startRes.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(startRes.body));
  });
});

describe("company-and-environment setup-token route — object-level authorization", () => {
  it("returns the same not-found for a cross-owner caller on every action", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // A different owner reads the same id. Every action returns the not-found
    // error, so a caller cannot tell a cross-owner session from a missing one.
    useOwner(OTHER_USER_ID);
    const paths: Array<() => request.Test> = [
      () => request(app).get(`${COMPANY_BASE}/${sessionId}`).send(),
      () => request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send(),
      () => request(app).post(`${COMPANY_BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE }),
      () => request(app).post(`${COMPANY_BASE}/${sessionId}/completion`).send(),
      () => request(app).post(`${COMPANY_BASE}/${sessionId}/cancel`).send(),
    ];
    for (const call of paths) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
      expectNoSecret(JSON.stringify(res.body));
    }
    expect(transport.submittedCodes).toEqual([]);
  });

  it("returns the same not-found for a cross-company caller", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // The same owner reads the session under a different company path. The
    // session belongs to the first company, so the read returns the not-found
    // error and never confirms the session across a company boundary.
    const crossCompanyBase = `/api/companies/${OTHER_COMPANY_ID}/setup-token-login-sessions`;
    const res = await request(app).get(`${crossCompanyBase}/${sessionId}`).send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
  });

  it("rejects an adapter other than claude_local at start", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const res = await startCompanySession(app, {
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
    });
    expect(res.status).toBe(400);
    // The route rejected the adapter before it started a session, so the store
    // holds no record.
    expect(transport.records).toEqual([]);
  });
});

describe("company-and-environment setup-token route — fail-closed environment", () => {
  it("rejects a missing environment and writes no scope", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });
    mockEnvironmentService.getById.mockResolvedValue(null);

    const res = await startCompanySession(app);
    expect(res.status).toBe(422);
    // The route rejected the environment before it started a session, so no
    // store holds an empty environment scope.
    expect(transport.records).toEqual([]);
  });

  it("rejects an absent environment id in the request body", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const res = await startCompanySession(app, { adapterType: "claude_local" });
    expect(res.status).toBe(400);
    expect(transport.records).toEqual([]);
  });

  it("rejects an archived, a local, an ssh, and a fake-provider environment", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const cases = [
      { id: ENVIRONMENT_ID, driver: "sandbox", status: "archived", config: { provider: "kubernetes" } },
      { id: ENVIRONMENT_ID, driver: "local", status: "active", config: {} },
      { id: ENVIRONMENT_ID, driver: "ssh", status: "active", config: {} },
      { id: ENVIRONMENT_ID, driver: "sandbox", status: "active", config: { provider: "fake" } },
    ];
    for (const environment of cases) {
      mockEnvironmentService.getById.mockResolvedValueOnce(environment);
      const res = await startCompanySession(app);
      expect(res.status, JSON.stringify(environment)).toBe(422);
    }
    // No rejected environment reached the store.
    expect(transport.records).toEqual([]);
  });
});

describe("company-and-environment setup-token route — browser-code grammar", () => {
  it("rejects a missing, an oversized, and a control-byte code before it forwards", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // A missing code.
    const missing = await request(app).post(`${COMPANY_BASE}/${sessionId}/code`).send({});
    expect(missing.status).toBe(400);

    // An oversized code (one character over the bounded maximum).
    const oversized = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: "a".repeat(513) });
    expect(oversized.status).toBe(400);

    // A control byte and a space are both rejected.
    for (const badCode of ["abc\ndef", "abc def"]) {
      const res = await request(app)
        .post(`${COMPANY_BASE}/${sessionId}/code`)
        .send({ browserCode: badCode });
      expect(res.status).toBe(400);
    }

    // No malformed code reached the live login process.
    expect(transport.submittedCodes).toEqual([]);
  });
});

describe("company-and-environment setup-token route — fail-closed transport guard", () => {
  it("rejects a non-TLS prompt and code request", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({
      transport,
      deploymentMode: "authenticated",
      confidentialProxyAllowlist: [],
    });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // The prompt over plain HTTP fails closed and returns no URL.
    const promptRes = await request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status).toBe(403);
    expect(promptRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expect(promptRes.body.authorizationUrl).toBeUndefined();
    expectNoSecret(JSON.stringify(promptRes.body));

    // The code over plain HTTP fails closed. The code never reaches the process.
    const codeRes = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(codeRes.status).toBe(403);
    expect(codeRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expect(transport.submittedCodes).toEqual([]);
    expectNoSecret(JSON.stringify(codeRes.body));
  });
});
