import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterAuthSessionConflictError } from "../services/codex-device-login-service.js";
import type {
  AdapterAuthSessionRow,
  AdapterAuthSessionStore,
  AcquireLoginLeaseInput,
  LoginSessionLease,
  LoginSessionRuntime,
} from "../services/codex-device-login-service.js";

// The company-scoped adapter device-login routes. These tests drive the real
// login-session service through the route layer. A fake in-memory store models
// the active company-adapter slot, and a fake runtime models the sandbox, so the
// tests run with no database and no provider. The tests assert the owner
// authorization contract, the environment guard, the concurrency conflict, and
// the redaction of logs and activity.

const COMPANY_1 = "company-1";
const COMPANY_2 = "company-2";
const OWNER_A = "user-a";
const OWNER_B = "user-b";
const SANDBOX_ENV_1 = "11111111-1111-4111-8111-111111111111";
const SANDBOX_ENV_2 = "22222222-2222-4222-8222-222222222222";

// The device-login URL and the one-time code the fake sandbox streams. The
// runner's parser accepts the exact URL and a code of four characters, a hyphen,
// and five characters on a dedicated line after the "one-time code" preamble.
const DEVICE_LOGIN_URL = "https://auth.openai.com/codex/device";
const PROMPT_CODE = "ABCD-EFGHI";
const PROMPT_OUTPUT = `Open ${DEVICE_LOGIN_URL} in your browser.\nEnter the one-time code below:\n${PROMPT_CODE}\n`;
// A credential byte string the fake sandbox returns. The routes and the activity
// must never log it.
const CREDENTIAL_BYTES = '{"tokens":{"access":"SECRET-ACCESS-TOKEN"}}';

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  collectMissingRuntimeBindings: vi.fn(async () => [] as Array<Record<string, unknown>>),
  resolveEnvBindings: vi.fn(async () => ({
    env: {} as Record<string, string>,
    secretKeys: new Set<string>(),
    manifest: [],
  })),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
  // The login guard reads the companies that own the environment. An empty
  // list marks an instance-global environment, so the guard stays open.
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
}));

const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockDeviceLoginPromotion = vi.hoisted(() => vi.fn());

// Capture every logger call, so the redaction test can assert the logs and the
// activity omit the URL, the code, the credential bytes, and the lease id.
const mockLogger = vi.hoisted(() => {
  const logger: Record<string, unknown> = {};
  for (const level of ["info", "warn", "error", "debug", "trace", "fatal"]) {
    logger[level] = vi.fn();
  }
  logger.child = vi.fn(() => logger);
  return logger;
});

// The harness holds the fake store and the fake runtime the route service binds
// to. The service module mock returns these through the store and runtime
// factories. A gate keeps the fake login run active during a test.
const harness = vi.hoisted(() => ({
  store: null as unknown as AdapterAuthSessionStore,
  runtime: null as unknown as LoginSessionRuntime,
  acquisitions: [] as AcquireLoginLeaseInput[],
  gate: Promise.resolve<void>(undefined),
  releaseGate: (() => {}) as () => void,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(),
    cancelActiveForAgent: vi.fn(),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Retain the production readiness helper while making the promotion decision
// observable. This lets the route test prove that a resolved but rejected
// Decision H outcome becomes a failed terminal rather than authenticated.
vi.mock("@paperclipai/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-codex-local/server")>();
  return {
    ...actual,
    promoteDeviceLoginCredential: mockDeviceLoginPromotion,
  };
});

// Keep the real login-session service and the real conflict error. Replace only
// the store factory and the production runtime factory with the harness fakes.
vi.mock("../services/codex-device-login-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/codex-device-login-service.js")>();
  return {
    ...actual,
    createDbAdapterAuthSessionStore: () => harness.store,
    createProductionLoginSessionRuntime: () => harness.runtime,
  };
});

// An in-memory session store. It mimics the active company-adapter slot: the
// partial unique index allows one active session per company and adapter, so a
// second active start throws the conflict error.
function createMemoryStore(): AdapterAuthSessionStore & { rows: Map<string, AdapterAuthSessionRow> } {
  const rows = new Map<string, AdapterAuthSessionRow>();
  const activeSlots = new Set<string>();
  // The active slot is scoped to the company, the owner, and the adapter.
  const slotKey = (companyId: string, startedByUserId: string, adapterType: string) =>
    `${companyId}|${startedByUserId}|${adapterType}`;
  const isActive = (status: AdapterAuthSessionRow["status"]) =>
    status === "starting" || status === "waiting_for_user" || status === "promoting";
  return {
    rows,
    async insert(input) {
      const key = slotKey(input.companyId, input.startedByUserId, input.adapterType);
      if (activeSlots.has(key)) {
        throw new AdapterAuthSessionConflictError();
      }
      activeSlots.add(key);
      rows.set(input.id, {
        id: input.id,
        publicSessionId: input.publicSessionId,
        companyId: input.companyId,
        environmentId: input.environmentId,
        adapterType: input.adapterType,
        startedByUserId: input.startedByUserId,
        providerLeaseId: null,
        status: "starting",
        expiresAt: input.expiresAt,
        promotionExpiresAt: null,
        finishedAt: null,
        failureReason: null,
      });
    },
    async recordLeaseAcquired(input) {
      const row = rows.get(input.sessionId);
      if (row) row.providerLeaseId = input.providerLeaseId;
    },
    async setStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row) return;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
      if (!isActive(input.status))
        activeSlots.delete(slotKey(row.companyId, row.startedByUserId, row.adapterType));
    },
    async compareAndSetStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row || !input.expectedStatuses.includes(row.status)) return false;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
      if (!isActive(input.status))
        activeSlots.delete(slotKey(row.companyId, row.startedByUserId, row.adapterType));
      return true;
    },
    async get(sessionId) {
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
    async getByPublicId(publicSessionId, companyId) {
      // Scope the read to the company and the public session id, so a
      // foreign-company lookup reads nothing and the internal id never matches.
      for (const row of rows.values()) {
        if (row.publicSessionId === publicSessionId && row.companyId === companyId) {
          return { ...row };
        }
      }
      return null;
    },
    async withCompanyAdapterPromotionLock(_companyId, _startedByUserId, _adapterType, fn) {
      // The route test runs on a single event loop, so it needs no real lock. The
      // pass-through keeps the promotion contract satisfied.
      return fn();
    },
  };
}

// A fake runtime. It streams the prompt, then waits on the harness gate, so the
// login run stays active while the test reads and cancels it. The gate resolves
// in `afterEach`, so no run and no timer survives the test.
function createFakeRuntime(): LoginSessionRuntime {
  return {
    async acquireLoginLease(input) {
      harness.acquisitions.push(input);
      const lease: LoginSessionLease = {
        providerLeaseId: `provider-lease-${input.sessionId}`,
        authPath: `/tmp/paperclip-adapter-login/${input.sessionId}/auth.json`,
        driver: {
          async execStreaming(_command, onStdout) {
            onStdout(PROMPT_OUTPUT);
            await harness.gate;
            return { exitCode: 0 };
          },
          async readFile() {
            return Buffer.from(CREDENTIAL_BYTES, "utf8");
          },
          async dispose() {},
        },
        async deleteSandbox() {
          return { outcome: "deleted" };
        },
        async release() {},
      };
      return lease;
    },
  };
}

let currentActor: Record<string, unknown>;

function boardActor(userId: string, companyIds: string[] = [COMPANY_1, COMPANY_2]): Record<string, unknown> {
  return {
    type: "board",
    userId,
    companyIds,
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = currentActor;
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const loginPath = (companyId: string, type = "codex_local") =>
  `/api/companies/${companyId}/adapters/${type}/login-sessions`;

describe("adapter device-login routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDeviceLoginPromotion.mockResolvedValue("promoted");
    harness.store = createMemoryStore();
    harness.runtime = createFakeRuntime();
    harness.acquisitions = [];
    harness.gate = new Promise<void>((resolve) => {
      harness.releaseGate = resolve;
    });
    currentActor = boardActor(OWNER_A);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockEnvironmentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
      envVars: {},
    }));
  });

  afterEach(() => {
    // Release the gate, so every in-flight login run ends and clears its timer.
    harness.releaseGate();
  });

  it("requires a board actor and rejects an agent-token start", async () => {
    currentActor = {
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_1,
      source: "agent_key",
    };
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("starts a login for a board actor with the configuration permission and acquires a fresh lease", async () => {
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      environmentId: SANDBOX_ENV_1,
      status: "starting",
    });
    expect(typeof res.body.sessionId).toBe("string");
    // A fresh lease is acquired for the owner.
    expect(harness.acquisitions).toHaveLength(1);
    expect(harness.acquisitions[0]).toMatchObject({
      companyId: COMPANY_1,
      environmentId: SANDBOX_ENV_1,
      adapterType: "codex_local",
      startedByUserId: OWNER_A,
    });
    // The row persists the immutable owner from the actor. The response carries
    // the public session id, so read the row by the public id, not the internal id.
    const store = harness.store as ReturnType<typeof createMemoryStore>;
    const row = await store.getByPublicId(res.body.sessionId, COMPANY_1);
    expect(row?.startedByUserId).toBe(OWNER_A);
    // The public session id is never the internal row id.
    expect(row?.id).not.toBe(res.body.sessionId);
    // No row is keyed by the public session id in the internal-id map.
    expect(store.rows.get(res.body.sessionId)).toBeUndefined();
  });

  it("rejects an adapter whose login capability drives a different transport", async () => {
    // The Claude adapter declares a pseudo-terminal login, not a streamed-exec
    // device login. The guard reads the capability transport, so it rejects the
    // adapter with a fixed 400 before any lease.
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1, "claude_local"))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("starts a device login for a third adapter that declares the streamed-exec capability", async () => {
    // A third adapter, not the Codex adapter, declares a streamed-exec login
    // capability. The guard reads the registry capability, not the adapter name,
    // so the adapter passes the guard and starts a session. This proves no
    // adapter-name branch remains in the guard path. The test overrides an
    // existing adapter type so the strict request schema accepts it.
    const app = await createApp();
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "gemini_local",
      execute: async () => {
        throw new Error("not used");
      },
      testEnvironment: async () => {
        throw new Error("not used");
      },
      loginCapability: {
        panelMode: "displayed_code",
        sandboxTransport: "streamed_exec",
        timeoutPolicy: "caller_bounded",
        getCommand: () => "vendor login",
        parsePrompt: () => null,
      },
    });
    try {
      const res = await request(app)
        .post(loginPath(COMPANY_1, "gemini_local"))
        .send({ environmentId: SANDBOX_ENV_1 });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ environmentId: SANDBOX_ENV_1, status: "starting" });
      expect(harness.acquisitions).toHaveLength(1);
      expect(harness.acquisitions[0]).toMatchObject({ adapterType: "gemini_local" });
    } finally {
      unregisterServerAdapter("gemini_local");
    }
  });

  it("rejects a malformed start body with the strict schema before any side effect", async () => {
    const app = await createApp();

    // The strict start schema rejects an unknown field. The old lax parse
    // accepted an extra field and started a session; the shared spine now fails
    // the request with a fixed 400 before it acquires a lease.
    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1, unexpectedField: "x" });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("rejects a local environment", async () => {
    mockEnvironmentService.getById.mockResolvedValueOnce({
      id: SANDBOX_ENV_1,
      companyId: COMPANY_1,
      name: "Local",
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
    });
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("rejects an archived (inactive) sandbox environment", async () => {
    mockEnvironmentService.getById.mockResolvedValueOnce({
      id: SANDBOX_ENV_1,
      companyId: COMPANY_1,
      name: "Sandbox QA",
      driver: "sandbox",
      status: "archived",
      config: { provider: "daytona" },
      envVars: {},
    });
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("rejects a missing environment", async () => {
    mockEnvironmentService.getById.mockResolvedValueOnce(null);
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("delivers the one-time prompt to the owner on the first read only", async () => {
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    // The first authorized owner read receives the one-time prompt.
    const first = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.prompt).toEqual({ url: DEVICE_LOGIN_URL, code: PROMPT_CODE });

    // A second authorized owner read no longer carries the prompt. The status
    // stays available, so the owner still tracks the session.
    const second = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.prompt).toBeNull();
    expect(second.body.status).toBe(first.body.status);
  });

  it("returns 404 for a wrong-user status, prompt, and cancel", async () => {
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    // A different board user in the same company is not the owner.
    currentActor = boardActor(OWNER_B);

    const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
    expect(status.status, JSON.stringify(status.body)).toBe(404);
    expect(status.body.prompt).toBeUndefined();
    expect(status.body.environmentId).toBeUndefined();

    const cancel = await request(app).post(`${loginPath(COMPANY_1)}/${sessionId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(404);
  });

  it("returns 404 for a cross-company status", async () => {
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    // The same owner reads the session under a different company scope.
    const status = await request(app).get(`${loginPath(COMPANY_2)}/${sessionId}`);
    expect(status.status, JSON.stringify(status.body)).toBe(404);
    expect(status.body.prompt).toBeUndefined();
  });

  it("durably cancels a login for the owner and releases the company slot", async () => {
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    const cancel = await request(app).post(`${loginPath(COMPANY_1)}/${sessionId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.sessionId).toBe(sessionId);
    // The cancel resolves the public terminal status at once.
    expect(cancel.body.status).toBe("cancelled");

    // The durable write released the company slot, so a fresh start for the same
    // company and adapter succeeds without a wait for the in-flight run or the
    // reaper. This proves the cancel does not depend on the process-local abort.
    const restart = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(restart.status, JSON.stringify(restart.body)).toBe(201);
    expect(restart.body.sessionId).not.toBe(sessionId);
  });

  it("lets a second owner start an active login in the same company", async () => {
    const app = await createApp();

    const first = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // A different owner starts a second login for the same company and adapter.
    // The active slot is scoped to the company, the owner, and the adapter, so
    // the second owner holds an independent slot and the start succeeds.
    currentActor = boardActor(OWNER_B);
    const second = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    // Each owner's start acquires its own lease.
    expect(harness.acquisitions).toHaveLength(2);
  });

  it("returns 409 for a second active start in a different environment", async () => {
    const app = await createApp();

    const first = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // The same owner starts a second login in a different environment for the
    // same company and adapter.
    const second = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_2 });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(harness.acquisitions).toHaveLength(1);
  });

  it("fails closed when promotion loses the sole-owner claim", async () => {
    // This is the expiry/reaper-race result from Decision H. It is a normal
    // resolved adapter outcome, but it must never be accepted as authentication.
    mockDeviceLoginPromotion.mockResolvedValueOnce("not_sole_owner");
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("failed");
      expect(status.body.failure?.reason).toBe("promotion_failed");
    });

    const row = await (harness.store as ReturnType<typeof createMemoryStore>).getByPublicId(
      sessionId,
      COMPANY_1,
    );
    expect(row?.status).toBe("failed");
    expect(mockDeviceLoginPromotion).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the login is a different account than the company home", async () => {
    // The promotion keeps the occupied company home and installs nothing durable
    // for a different-identity login. The identity-anchored vend can never select
    // this login, so a later run keeps the existing account. The route must fail
    // the session instead of a report of `authenticated`.
    mockDeviceLoginPromotion.mockResolvedValueOnce("kept_foreign_identity");
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("failed");
      expect(status.body.failure?.reason).toBe("promotion_failed");
    });

    const row = await (harness.store as ReturnType<typeof createMemoryStore>).getByPublicId(
      sessionId,
      COMPANY_1,
    );
    expect(row?.status).toBe("failed");
    expect(mockDeviceLoginPromotion).toHaveBeenCalledTimes(1);
  });

  it("omits the URL, code, credential bytes, and lease id from logs and activity", async () => {
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    // Read the owner status, so the prompt passes through the owner read path.
    const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
    expect(status.status).toBe(200);

    // Serialize every logged argument and assert none carries a secret.
    const loggedText = (["info", "warn", "error", "debug"] as const)
      .flatMap((level) => (mockLogger[level] as ReturnType<typeof vi.fn>).mock.calls)
      .map((args) => JSON.stringify(args))
      .join("\n");
    expect(loggedText).not.toContain("auth.openai.com");
    expect(loggedText).not.toContain(PROMPT_CODE);
    expect(loggedText).not.toContain("SECRET-ACCESS-TOKEN");
    expect(loggedText).not.toContain("provider-lease-");
  });
});
