// The wired setup-token login route. This test drives the full login path —
// start, read-prompt, submit-code, and receive-token — through the HTTP route
// with a fake transport. It proves the guarded session contract is the live
// login path and that the security controls hold end to end at the route level.
//
// The test covers these criteria (the full set is on the parent plan document):
//   * The full path returns the sign-in URL to the owner, accepts one code, and
//     returns the minted token one time.
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
} from "../services/setup-token-session.js";

// --- Test fixtures -----------------------------------------------------------

const COMPANY_ID = "company-1";
const OWNER_USER_ID = "owner-user-1";
const OTHER_USER_ID = "other-user-2";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

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
  submittedCodes: string[];
}

/**
 * Builds a fake login transport. The factory surfaces the sign-in URL at once.
 * On submit it either completes the login and delivers the token, throws an
 * internal error, or leaves the process pending. The lease manager and the store
 * are in-memory and hold no secret.
 */
function buildTransport(opts: { onSubmit?: "complete" | "throw" | "pending" } = {}): TransportHandle {
  const mode = opts.onSubmit ?? "complete";
  const submittedCodes: string[] = [];
  const rows = new Map<string, SetupTokenCleanupRecord>();
  const store: SetupTokenCleanupStore = {
    async record(record) {
      rows.set(record.sessionId, { ...record });
    },
    async markState(sessionId, state) {
      const row = rows.get(sessionId);
      if (row) row.state = state;
    },
    async remove(sessionId) {
      rows.delete(sessionId);
    },
    async listReapable() {
      return [];
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
          onCredential(MINTED_TOKEN);
          resolveDone("success");
        }
        // pending: the process stays open; the test drives no completion.
      },
      stop() {},
    };
  };
  return { factory, leases, store, submittedCodes };
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
        ? { factory: opts.transport.factory, leases: opts.transport.leases, store: opts.transport.store }
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
  });
});

describe("setup-token login route — full path", () => {
  it("drives start, read-prompt, submit-code, and receive-token with a fake transport", async () => {
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

    // Receive the token one time. The owner response carries the token, with
    // no-store.
    const tokenRes = await request(app).post(`${BASE}/${sessionId}/token`).send({});
    expect(tokenRes.status, JSON.stringify(tokenRes.body)).toBe(200);
    expect(tokenRes.body.token).toBe(MINTED_TOKEN);
    expect(tokenRes.headers["cache-control"]).toBe("no-store");

    // The second receive returns the same not-found error as a missing session.
    const secondTokenRes = await request(app).post(`${BASE}/${sessionId}/token`).send({});
    expect(secondTokenRes.status).toBe(404);
    expect(secondTokenRes.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
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

    // receive-token over plain HTTP also fails closed and leaks no token.
    const tokenRes = await request(app)
      .post(`${BASE}/${sessionId}/token`)
      .set("X-Forwarded-Proto", "https")
      .send({});
    expect(tokenRes.status).toBe(403);
    expect(tokenRes.body.error).toBe(SETUP_TOKEN_TRANSPORT_INSECURE);
    expect(tokenRes.body.token).toBeUndefined();
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
