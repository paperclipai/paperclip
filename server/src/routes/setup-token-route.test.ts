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
//   * The route does not force TLS. On a non-confidential
//     transport it proceeds and attaches a non-blocking advisory to the
//     response, so the login completes and the client shows a disclaimer.

import express from "express";
import { Writable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SETUP_TOKEN_SESSION_NOT_FOUND,
  SETUP_TOKEN_PROVIDER_UNSUPPORTED,
  type SetupTokenCleanupRecord,
  type SetupTokenCleanupStore,
  type SetupTokenLeaseManager,
  type SetupTokenLoginOutcome,
  type SetupTokenLoginProcessFactory,
  type SetupTokenSecretWriter,
} from "../services/setup-token-session.js";
import { SETUP_TOKEN_TRANSPORT_ADVISORY_CODE } from "@paperclipai/shared";

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
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  listBoundCompanyIds: vi.fn(),
}));
// The provider-capability resolver the setup-token routes call to gate the login
// on the provider setup-token capability. The default resolves "daytona" as a
// capable provider. A test overrides it to prove an unsupported provider fails
// closed before a session row, a lease, or a pseudo-terminal.
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());
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
// The narrow secrets service the status route calls. The route reads only
// `readClaudeOAuthUserSecretStatus`; a test drives its result to prove the route
// derives the owner from the actor and discloses no existence distinction.
const mockSecretService = vi.hoisted(() => ({
  readClaudeOAuthUserSecretStatus: vi.fn(),
}));

function registerModuleMocks(): void {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/secrets.js", async () => {
    const actual = await vi.importActual<typeof import("../services/secrets.js")>(
      "../services/secrets.js",
    );
    return { ...actual, secretService: () => mockSecretService };
  });
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
  vi.doMock("../services/plugin-environment-driver.js", async () => {
    const actual = await vi.importActual<typeof import("../services/plugin-environment-driver.js")>(
      "../services/plugin-environment-driver.js",
    );
    return {
      ...actual,
      resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
    };
  });
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

// Installs a non-`local_implicit` company member. The actor is a signed-in
// board user with an explicit company allow-list, so `hasCompanyAccess` denies a
// company that is not on the list. A test uses this actor to prove the
// cross-company read returns the fixed not-found error, not a membership oracle.
function useCompanyMember(userId: string = OWNER_USER_ID, companyIds: string[] = [COMPANY_ID]): void {
  currentActor = {
    type: "board",
    userId,
    companyIds,
    source: "session",
    isInstanceAdmin: false,
    memberships: companyIds.map((companyId) => ({
      companyId,
      status: "active",
      membershipRole: "admin",
    })),
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
  // The overwrite capture the session scope carried on each secret write. A
  // first-write login records null; a confirmed-overwrite login records the
  // captured expected secret id and version.
  overwriteCaptures: Array<
    { expectedSecretId: string; expectedLatestVersion: number } | null
  >;
  // Every cleanup record the store persisted. A test asserts the route writes no
  // empty environment scope, so a rejected environment never reaches the store.
  records: SetupTokenCleanupRecord[];
  // The count of login-process (pseudo-terminal) starts. A test asserts an
  // unsupported provider starts no pseudo-terminal.
  factoryInvocations: { count: number };
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
  // so a test can prove the write ran without a durable secret sink. It also
  // records the overwrite capture from the session scope, so a test proves the
  // start route threads the capture into the immutable scope.
  const secretWrites: string[] = [];
  const overwriteCaptures: Array<
    { expectedSecretId: string; expectedLatestVersion: number } | null
  > = [];
  const completeCredential: SetupTokenSecretWriter = async (input) => {
    secretWrites.push(input.token);
    overwriteCaptures.push(input.scope.confirmedOverwrite ?? null);
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
    async remove(identity) {
      rows.delete(identity.sessionId);
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
  const factoryInvocations = { count: 0 };
  const factory: SetupTokenLoginProcessFactory = ({ onPrompt, onCredential }) => {
    factoryInvocations.count += 1;
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
  return {
    factory,
    leases,
    store,
    completeCredential,
    submittedCodes,
    secretWrites,
    overwriteCaptures,
    records,
    factoryInvocations,
  };
}

// --- App builder with a capturing request logger -----------------------------

interface AppHandle {
  app: express.Express;
  logLines: string[];
}

async function createApp(opts: {
  deploymentMode?: "local_trusted" | "authenticated";
  confidentialProxyAllowlist?: string[];
  confidentialEdgeTlsTerminated?: boolean;
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
      confidentialEdgeTlsTerminated: opts.confidentialEdgeTlsTerminated,
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

beforeEach(() => {
  vi.resetModules();
  registerModuleMocks();
  vi.clearAllMocks();
  useOwner();
  // The default owner has no stored Claude value. A test overrides this to prove
  // the status route returns the metadata for a present owner value.
  mockSecretService.readClaudeOAuthUserSecretStatus.mockResolvedValue(null);
  mockAgentService.getById.mockResolvedValue({
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Claude agent",
    adapterType: "claude_local",
    defaultEnvironmentId: ENVIRONMENT_ID,
  });
  // The default resolved environment is an active sandbox on a provider that
  // supports the setup-token login, so the start routes pass the fail-closed
  // guard. A test overrides this to prove the guard rejects an invalid
  // environment or an unsupported provider.
  mockEnvironmentService.getById.mockResolvedValue({
    id: ENVIRONMENT_ID,
    driver: "sandbox",
    status: "active",
    config: { provider: "daytona" },
  });
  // The default environment has no company binding, so it is instance-global
  // and open to every member. A test overrides this to prove the guard rejects
  // an environment that another company owns.
  mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
  // The default provider advertises the setup-token login capability. A test
  // overrides this to prove an unsupported provider fails closed.
  mockResolvePluginSandboxProviderDriverByKey.mockImplementation(
    async ({ driverKey }: { driverKey: string }) =>
      driverKey === "daytona"
        ? { plugin: { id: "plugin-daytona" }, driver: { supportsSetupTokenLogin: true } }
        : null,
  );
});

// --- Company-and-environment routes ------------------------------------------
//
// These tests drive the agentless Claude login. The scope binds one login to one
// company, one owner, one adapter, and one environment. The route carries no
// agent id, resolves the environment server-side, and returns the same not-found
// error for a foreign session as for a missing session.

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
    // The default deployment is a local-trusted loopback: a confidential
    // transport. So the prompt carries no advisory.
    expect(promptRes.body.transportAdvisory).toBeNull();

    // Submit the one browser code. The response carries no secret.
    const codeRes = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(codeRes.status, JSON.stringify(codeRes.body)).toBe(200);
    expect(codeRes.body.transportAdvisory).toBeNull();
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

    // A different owner reads the same id. Every read action returns the
    // not-found error, so a caller cannot tell a cross-owner session from a
    // missing one.
    useOwner(OTHER_USER_ID);
    const paths: Array<() => request.Test> = [
      () => request(app).get(`${COMPANY_BASE}/${sessionId}`).send(),
      () => request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send(),
      () => request(app).post(`${COMPANY_BASE}/${sessionId}/code`).send({ browserCode: BROWSER_CODE }),
      () => request(app).post(`${COMPANY_BASE}/${sessionId}/completion`).send(),
    ];
    for (const call of paths) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
      expectNoSecret(JSON.stringify(res.body));
    }

    // Cancel is idempotent, so a cross-owner cancel returns the same 200 success
    // as a repeat cancel and a cancel of a missing session. The response is
    // identical for a foreign, an already-terminal, and a missing session, so it
    // is not an existence oracle. The route cancels nothing for a foreign id: the
    // scope check throws before the cancel runs, so the session stays active.
    const cancelRes = await request(app).post(`${COMPANY_BASE}/${sessionId}/cancel`).send();
    expect(cancelRes.status).toBe(200);
    expectNoSecret(JSON.stringify(cancelRes.body));

    // The owner reads the session again. It is still active, so the cross-owner
    // cancel did not terminate it.
    useOwner(OWNER_USER_ID);
    const ownerStatus = await request(app).get(`${COMPANY_BASE}/${sessionId}`).send();
    expect(ownerStatus.status).toBe(200);
    expect(ownerStatus.body.status).toBe("waiting_for_user");

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

  it("returns the fixed not-found for a non-member on every action across a company boundary", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    // A member of one company starts the session in that company.
    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // A signed-in board member of the first company reads the session under a
    // second company it is not a member of. The company reference is a
    // cross-company reference. The route must return the same fixed not-found
    // error as a missing session, so it is not a company-membership oracle. It
    // must not return a 403, a login URL, a token, or the browser code forward.
    useCompanyMember(OWNER_USER_ID, [COMPANY_ID]);
    const crossCompanyBase = `/api/companies/${OTHER_COMPANY_ID}/setup-token-login-sessions`;
    const paths: Array<() => request.Test> = [
      () => request(app).get(`${crossCompanyBase}/${sessionId}`).send(),
      () => request(app).get(`${crossCompanyBase}/${sessionId}/prompt`).send(),
      () => request(app).post(`${crossCompanyBase}/${sessionId}/code`).send({ browserCode: BROWSER_CODE }),
      () => request(app).post(`${crossCompanyBase}/${sessionId}/completion`).send(),
      () => request(app).post(`${crossCompanyBase}/${sessionId}/cancel`).send(),
    ];
    for (const call of paths) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
      expect(res.body.authorizationUrl).toBeUndefined();
      expect(res.body.loginUrl).toBeUndefined();
      expect(res.body.token).toBeUndefined();
      expect(res.body.storedSessionId).toBeUndefined();
      expectNoSecret(JSON.stringify(res.body));
    }
    // The code route returned the not-found error before it forwarded the code,
    // so the login process received no submit.
    expect(transport.submittedCodes).toEqual([]);
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

describe("company-and-environment setup-token route — idempotent cancel", () => {
  it("cancels an active session, then returns 200 on a repeat cancel", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // The first cancel terminates the active session and returns success.
    const firstCancel = await request(app).post(`${COMPANY_BASE}/${sessionId}/cancel`).send();
    expect(firstCancel.status).toBe(200);
    expect(firstCancel.headers["cache-control"]).toBe("no-store");
    await settle();

    // The server removed the terminal session, so the status read now returns the
    // not-found error. This is the state the panel used to poll forever.
    const statusRes = await request(app).get(`${COMPANY_BASE}/${sessionId}`).send();
    expect(statusRes.status).toBe(404);

    // The repeat cancel finds no record. It returns the same 200 success instead
    // of a hard 404, so the client can stop the poll.
    const repeatCancel = await request(app).post(`${COMPANY_BASE}/${sessionId}/cancel`).send();
    expect(repeatCancel.status).toBe(200);
    expect(repeatCancel.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(repeatCancel.body));
  });

  it("returns 200 for a cancel of an unknown session id", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    // The owner is a member of the company, but the session id never existed. The
    // cancel is idempotent, so it returns success, not a 404.
    const res = await request(app)
      .post(`${COMPANY_BASE}/00000000-0000-4000-8000-000000000000/cancel`)
      .send();
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectNoSecret(JSON.stringify(res.body));
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

  it("rejects an environment that another company owns", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });
    // The environment binds to another company only, so the request company does
    // not own it. The guard fails closed before the session starts.
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([OTHER_COMPANY_ID]);

    const res = await startCompanySession(app);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("The selected environment belongs to another company.");
    // No rejected environment reached the store.
    expect(transport.records).toEqual([]);
  });

  it("accepts an environment the request company also owns", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });
    // The environment binds to the request company and another company. A shared
    // managed sandbox binds to many companies at once, so a co-owned binding
    // stays open to the request company.
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([OTHER_COMPANY_ID, COMPANY_ID]);

    const res = await startCompanySession(app);
    expect(res.status).toBe(201);
  });

  it("rejects a provider without the setup-token login capability and starts no session", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });
    // The resolved environment runs on a provider that does not advertise the
    // setup-token login capability. The guard fails closed before a session row,
    // a lease, or a pseudo-terminal.
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_ID,
      driver: "sandbox",
      status: "active",
      config: { provider: "e2b" },
    });

    const res = await startCompanySession(app);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe(SETUP_TOKEN_PROVIDER_UNSUPPORTED);
    // No session row, no lease, and no pseudo-terminal started.
    expect(transport.records).toEqual([]);
    expect(transport.factoryInvocations.count).toBe(0);
    expect(transport.submittedCodes).toEqual([]);
    expect(transport.secretWrites).toEqual([]);
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

describe("company-and-environment setup-token route — strict request contract", () => {
  it("rejects a legacy ttlSeconds at start before any session or lease side effect", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const res = await startCompanySession(app, {
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      ttlSeconds: 300,
    });
    // The strict validator rejects the unknown field with a fixed 400.
    expect(res.status).toBe(400);
    // No session row, no lease, and no pseudo-terminal started.
    expect(transport.records).toEqual([]);
    expect(transport.factoryInvocations.count).toBe(0);
  });

  it("rejects an unknown field at start before any session or lease side effect", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const res = await startCompanySession(app, {
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      agentId: "44444444-4444-4444-8444-444444444444",
    });
    expect(res.status).toBe(400);
    expect(transport.records).toEqual([]);
    expect(transport.factoryInvocations.count).toBe(0);
  });

  it("rejects an unknown field on the browser-code route before it forwards", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    const res = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE, ttlSeconds: 300 });
    expect(res.status).toBe(400);
    // The unknown field failed the strict parse before the code reached the
    // live login process.
    expect(transport.submittedCodes).toEqual([]);
  });
});

describe("company-and-environment setup-token route — advisory transport", () => {
  it("proceeds on a non-TLS prompt and code request and attaches the advisory", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({
      transport,
      deploymentMode: "authenticated",
      confidentialProxyAllowlist: [],
    });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    // The prompt over plain HTTP surfaces the URL with the advisory. The URL
    // query is the owner-only confidential value, so the body holds it by design.
    const promptRes = await request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status).toBe(200);
    expect(promptRes.body.authorizationUrl).toBe(FULL_LOGIN_URL);
    expect(promptRes.body.transportAdvisory).toEqual({ code: SETUP_TOKEN_TRANSPORT_ADVISORY_CODE });

    // The code over plain HTTP proceeds. The code reaches the process and the
    // response carries the advisory.
    const codeRes = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(codeRes.status).toBe(200);
    expect(codeRes.body.transportAdvisory).toEqual({ code: SETUP_TOKEN_TRANSPORT_ADVISORY_CODE });
    expect(transport.submittedCodes).toEqual([BROWSER_CODE]);
    expectNoSecret(JSON.stringify(codeRes.body));
  });

  it("attaches no advisory when the operator declares platform edge TLS termination", async () => {
    // A managed-platform deployment: TLS terminates at the platform edge, the
    // app socket is plain HTTP, and the operator set
    // CLAUDE_LOGIN_EDGE_TLS_TERMINATED. The prompt and code responses carry no
    // advisory, so the client shows no clear-text warning for a connection that
    // is HTTPS to the user.
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({
      transport,
      deploymentMode: "authenticated",
      confidentialProxyAllowlist: [],
      confidentialEdgeTlsTerminated: true,
    });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;

    const promptRes = await request(app).get(`${COMPANY_BASE}/${sessionId}/prompt`).send();
    expect(promptRes.status).toBe(200);
    expect(promptRes.body.authorizationUrl).toBe(FULL_LOGIN_URL);
    expect(promptRes.body.transportAdvisory).toBeNull();

    const codeRes = await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    expect(codeRes.status).toBe(200);
    expect(codeRes.body.transportAdvisory).toBeNull();
    expect(transport.submittedCodes).toEqual([BROWSER_CODE]);
    expectNoSecret(JSON.stringify(codeRes.body));
  });
});

// The stored-token status route and the overwrite capture are the two deltas of
// the apply-stored-token-first flow. The status route derives the owner from the
// actor and discloses no existence distinction. The start route threads the
// confirmed-overwrite capture into the immutable session scope, so the final
// secret write rotates the stored value instead of a first write.

const STATUS_BASE = `/api/companies/${COMPANY_ID}/claude-oauth-token-status`;
const STORED_SECRET_ID = "44444444-4444-4444-8444-444444444444";

describe("company-and-environment stored-token status route", () => {
  it("returns the owner metadata with no token and no-store, and never a token", async () => {
    mockSecretService.readClaudeOAuthUserSecretStatus.mockResolvedValue({
      secretId: STORED_SECRET_ID,
      latestVersion: 3,
    });
    const { app } = await createApp({});

    const res = await request(app).get(STATUS_BASE).send();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ secretId: STORED_SECRET_ID, latestVersion: 3 });
    expect(res.headers["cache-control"]).toBe("no-store");
    // The owner comes from the actor, never from the request.
    expect(mockSecretService.readClaudeOAuthUserSecretStatus).toHaveBeenCalledWith(
      COMPANY_ID,
      OWNER_USER_ID,
    );
    // The response carries no token.
    expectNoSecret(JSON.stringify(res.body));
  });

  it("returns the fixed not-found for an owner with no value", async () => {
    mockSecretService.readClaudeOAuthUserSecretStatus.mockResolvedValue(null);
    const { app } = await createApp({});

    const res = await request(app).get(STATUS_BASE).send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("gives a same-company other user no existence distinction", async () => {
    // The route derives the owner from the actor. The service returns the value
    // only for the real owner, so a same-company other user gets the same fixed
    // not-found as an owner with no value.
    mockSecretService.readClaudeOAuthUserSecretStatus.mockImplementation(
      async (_companyId: string, ownerUserId: string) =>
        ownerUserId === OWNER_USER_ID ? { secretId: STORED_SECRET_ID, latestVersion: 1 } : null,
    );
    const { app } = await createApp({});

    const ownerRes = await request(app).get(STATUS_BASE).send();
    expect(ownerRes.status).toBe(200);

    // A different same-company user reads the same path. The route derives the
    // owner as that user and gets the fixed not-found.
    useOwner(OTHER_USER_ID);
    const otherRes = await request(app).get(STATUS_BASE).send();
    expect(otherRes.status).toBe(404);
    expect(otherRes.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
    expect(otherRes.headers["cache-control"]).toBe("no-store");
  });

  it("gives a cross-company caller the fixed not-found and never reads the value", async () => {
    // A signed-in board user who is not a member of the company. The company
    // gate returns the fixed not-found before any owner-value read runs.
    useCompanyMember(OWNER_USER_ID, [OTHER_COMPANY_ID]);
    const { app } = await createApp({});

    const res = await request(app).get(STATUS_BASE).send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(SETUP_TOKEN_SESSION_NOT_FOUND);
    expect(res.headers["cache-control"]).toBe("no-store");
    // The route never reads the owner value for a non-member.
    expect(mockSecretService.readClaudeOAuthUserSecretStatus).not.toHaveBeenCalled();
  });
});

describe("company-and-environment login overwrite capture", () => {
  it("threads the confirmed-overwrite capture into the session scope", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app, {
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      overwrite: { expectedSecretId: STORED_SECRET_ID, expectedLatestVersion: 2 },
    });
    expect(startRes.status, JSON.stringify(startRes.body)).toBe(201);
    const sessionId = startRes.body.sessionId as string;

    await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    await settle();

    // The secret write ran with the overwrite capture from the session scope, so
    // the writer selects a confirmed rotation instead of a first write.
    expect(transport.secretWrites).toEqual([MINTED_TOKEN]);
    expect(transport.overwriteCaptures).toEqual([
      { expectedSecretId: STORED_SECRET_ID, expectedLatestVersion: 2 },
    ]);
  });

  it("carries no overwrite capture for a plain first-write login", async () => {
    const transport = buildTransport({ onSubmit: "complete" });
    const { app } = await createApp({ transport });

    const startRes = await startCompanySession(app);
    const sessionId = startRes.body.sessionId as string;
    await request(app)
      .post(`${COMPANY_BASE}/${sessionId}/code`)
      .send({ browserCode: BROWSER_CODE });
    await settle();

    expect(transport.overwriteCaptures).toEqual([null]);
  });

  it("rejects a malformed overwrite capture with a fixed 400", async () => {
    const transport = buildTransport({ onSubmit: "pending" });
    const { app } = await createApp({ transport });

    const res = await startCompanySession(app, {
      environmentId: ENVIRONMENT_ID,
      adapterType: "claude_local",
      overwrite: { expectedSecretId: "not-a-uuid", expectedLatestVersion: 0 },
    });
    expect(res.status).toBe(400);
    // The malformed-capture 400 is a request-validation error like the adapter
    // and the environment checks; it carries no secret in the response body.
    expectNoSecret(JSON.stringify(res.body));
  });
});
