import express from "express";
import request from "supertest";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { AdapterAuthSessionConflictError } from "../services/device-login-service.js";
import type {
  AdapterAuthSessionRow,
  AdapterAuthSessionStore,
  AcquireLoginLeaseInput,
  LoginSessionLease,
  LoginSessionRuntime,
} from "../services/device-login-service.js";

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

// The Grok device-login URL and the one-time code the fake sandbox streams for
// a `grok_local` session. The Grok parser requires the `user_code` query to
// equal the code that stands alone on its own line after the preamble.
const GROK_CODE = "WXYZ-ABCD";
const GROK_DEVICE_LOGIN_URL = `https://accounts.x.ai/oauth2/device?user_code=${GROK_CODE}`;
const GROK_PROMPT_OUTPUT = [
  "To sign in, open this URL in your browser:",
  `  ${GROK_DEVICE_LOGIN_URL}`,
  "Confirm this code in your browser:",
  `  ${GROK_CODE}`,
].join("\n");
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
  // The account-home secret lookup and creation. Absent by default, so a
  // successful promotion creates it; a test overrides either to drive the
  // idempotent-repeat-login and secret-creation-failure paths.
  getByName: vi.fn(async (_companyId: string, _name: string) => null as Record<string, unknown> | null),
  create: vi.fn(async (_companyId: string, _input: Record<string, unknown>) => ({ id: "secret-1" })),
  // The company-wide secret listing the cleanup-safety scan reads. Empty by
  // default, so a cleanup that finds no other claimant removes the
  // directory; a test overrides it with a differently named secret to prove
  // the scan finds a claimant a name-only check would miss.
  list: vi.fn(
    async (_companyId: string) => [] as Array<{ id: string; name: string; provider: string }>,
  ),
  // The pre-existing-secret value check. Defaults to a value that never
  // matches an account home, so a test that leaves this unset and still
  // reaches an existing-secret branch fails loud instead of passing by
  // accident; a test overrides it to the account home under test.
  resolveSecretValueForDeviceLoginCheck: vi.fn(
    async (_companyId: string, _secretId: string, _context: { configPath: string }) =>
      "/unset-mock-value" as string,
  ),
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
// The provider capability resolver the device-login gate reads. A supported
// provider advertises the login pseudo-terminal capability. A test overrides this
// to prove an unsupported provider fails closed before any session or lease.
const mockResolvePluginSandboxProviderDriverByKey = vi.hoisted(() => vi.fn());
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

vi.mock("../services/plugin-environment-driver.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-environment-driver.js")>(
    "../services/plugin-environment-driver.js",
  );
  return {
    ...actual,
    resolvePluginSandboxProviderDriverByKey: mockResolvePluginSandboxProviderDriverByKey,
  };
});

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
vi.mock("../services/device-login-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/device-login-service.js")>();
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
function createFakeRuntime(promptOutput: string = PROMPT_OUTPUT): LoginSessionRuntime {
  return {
    async acquireLoginLease(input) {
      harness.acquisitions.push(input);
      const lease: LoginSessionLease = {
        providerLeaseId: `provider-lease-${input.sessionId}`,
        authPath: `/tmp/paperclip-adapter-login/${input.sessionId}/auth.json`,
        driver: {
          async start(_command, onData) {
            onData(promptOutput);
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
  // Real temp directories a test plants as an account home, cleaned up in
  // `afterEach` whether or not the route removed them itself.
  const accountHomeTestDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDeviceLoginPromotion.mockResolvedValue({
      outcome: "promoted",
      accountId: "acct-default",
      accountHomeDir: "/tmp/paperclip-codex-account-home/acct-default",
    });
    mockSecretService.getByName.mockResolvedValue(null);
    mockSecretService.create.mockResolvedValue({ id: "secret-1" });
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
    // The default provider advertises the login pseudo-terminal capability. A
    // test overrides this to prove an unsupported provider fails closed.
    mockResolvePluginSandboxProviderDriverByKey.mockImplementation(
      async ({ driverKey }: { driverKey: string }) =>
        driverKey === "daytona"
          ? { plugin: { id: "plugin-daytona" }, driver: { supportsLoginPty: true } }
          : null,
    );
  });

  afterEach(async () => {
    // Release the gate, so every in-flight login run ends and clears its timer.
    harness.releaseGate();
    while (accountHomeTestDirs.length > 0) {
      const dir = accountHomeTestDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
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

  it("rejects an adapter whose login capability drives a different panel mode", async () => {
    // The Claude adapter declares a submitted-browser-code login, not a
    // displayed-code device login. The guard reads the capability panel mode, so
    // it rejects the adapter with a fixed 400 before any lease.
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1, "claude_local"))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(harness.acquisitions).toHaveLength(0);
  });

  it("rejects a displayed-code adapter that has no mapped login command key", async () => {
    // A third adapter declares a displayed-code login capability, but its adapter
    // type maps to no login command key. The login opener resolves the command
    // key from the closed command map, so this adapter would fail at command
    // resolution after the route creates session state. The guard keeps admission
    // consistent with the command map, so it rejects the adapter with a fixed 400
    // before any lease. The test overrides an existing adapter type so the strict
    // request schema accepts it.
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
        timeoutPolicy: "caller_bounded",
        getCommand: () => "vendor login",
        parsePrompt: () => null,
      },
    });
    try {
      const res = await request(app)
        .post(loginPath(COMPANY_1, "gemini_local"))
        .send({ environmentId: SANDBOX_ENV_1 });

      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(harness.acquisitions).toHaveLength(0);
    } finally {
      unregisterServerAdapter("gemini_local");
    }
  });

  it("starts a device login for a non-Codex adapter that maps to a login command key", async () => {
    // A non-Codex adapter type that maps to a login command key declares a
    // displayed-code login capability. The guard reads the registry capability
    // and the command map, not the adapter name, so the adapter passes the guard
    // and starts a session. This proves no adapter-name branch remains in the
    // guard path. The test overrides the mapped `claude_local` type with a
    // displayed-code capability so the guard admits it.
    const app = await createApp();
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "claude_local",
      execute: async () => {
        throw new Error("not used");
      },
      testEnvironment: async () => {
        throw new Error("not used");
      },
      loginCapability: {
        panelMode: "displayed_code",
        timeoutPolicy: "caller_bounded",
        getCommand: () => "vendor login",
        parsePrompt: () => null,
      },
    });
    try {
      const res = await request(app)
        .post(loginPath(COMPANY_1, "claude_local"))
        .send({ environmentId: SANDBOX_ENV_1 });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ environmentId: SANDBOX_ENV_1, status: "starting" });
      expect(harness.acquisitions).toHaveLength(1);
      expect(harness.acquisitions[0]).toMatchObject({ adapterType: "claude_local" });
    } finally {
      unregisterServerAdapter("claude_local");
    }
  });

  it("rejects a provider that does not advertise the login pseudo-terminal capability", async () => {
    // The device login runs on a real pseudo-terminal, so it needs a provider
    // that advertises the login pseudo-terminal capability. The provider resolves
    // to a driver with no capability, so the route gate fails closed before any
    // session row or lease.
    mockResolvePluginSandboxProviderDriverByKey.mockImplementation(
      async ({ driverKey }: { driverKey: string }) =>
        driverKey === "daytona"
          ? { plugin: { id: "plugin-daytona" }, driver: { supportsLoginPty: false } }
          : null,
    );
    const app = await createApp();

    const res = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ code: "codex_device_login_provider_unsupported" });
    // The gate ran before any session row or lease, so the runtime acquired none.
    expect(harness.acquisitions).toHaveLength(0);
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

  it("starts a Grok session, delivers the Grok prompt once, and a codex_local read finds no row", async () => {
    // The Grok parser reaches this session because the profile map resolves it
    // by adapter type. The fake sandbox streams a Grok-shaped prompt, not a
    // Codex-shaped one, so a surfaced prompt proves the Grok parser ran.
    harness.runtime = createFakeRuntime(GROK_PROMPT_OUTPUT);
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1, "grok_local"))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    const first = await request(app).get(`${loginPath(COMPANY_1, "grok_local")}/${sessionId}`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.prompt).toEqual({ url: GROK_DEVICE_LOGIN_URL, code: GROK_CODE });

    // The row belongs to `grok_local`, not `codex_local`. Reading it through the
    // `codex_local` path finds no row for the owner.
    const wrongAdapterRead = await request(app).get(`${loginPath(COMPANY_1, "codex_local")}/${sessionId}`);
    expect(wrongAdapterRead.status, JSON.stringify(wrongAdapterRead.body)).toBe(404);

    const cancel = await request(app).post(`${loginPath(COMPANY_1, "grok_local")}/${sessionId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    // The cancel resolves the public terminal status at once. Internally the row
    // holds `cleanup_pending`, which encodes the cancelled terminal until the
    // reaper finalizes it — the same durable-cancel contract every adapter uses.
    expect(cancel.body.status).toBe("cancelled");

    const store = harness.store as ReturnType<typeof createMemoryStore>;
    const row = await store.getByPublicId(sessionId, COMPANY_1);
    expect(row?.status).toBe("cleanup_pending");
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
    // Both logins bind the default account home, and the login service
    // reconfirms the bound secret's value a second time right before it
    // commits the terminal `authenticated` state.
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(
      "/tmp/paperclip-codex-account-home/acct-default",
    );
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
    // Drain both sessions to a terminal status before the test ends. Neither
    // session's promotion has run yet (both still wait on the gate), so an
    // undrained session keeps running after this test returns and can consume
    // a later test's own mocked promotion result. A status read is owner
    // scoped, so read each session back as the owner that started it.
    harness.releaseGate();
    await vi.waitFor(async () => {
      currentActor = boardActor(OWNER_A);
      const firstStatus = await request(app).get(`${loginPath(COMPANY_1)}/${first.body.sessionId}`);
      expect(firstStatus.body.status).toBe("authenticated");
    });
    await vi.waitFor(async () => {
      currentActor = boardActor(OWNER_B);
      const secondStatus = await request(app).get(`${loginPath(COMPANY_1)}/${second.body.sessionId}`);
      expect(secondStatus.body.status).toBe("authenticated");
    });
  });

  it("returns 409 for a second active start in a different environment", async () => {
    // The login binds the default account home, and the login service
    // reconfirms the bound secret's value a second time right before it
    // commits the terminal `authenticated` state.
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(
      "/tmp/paperclip-codex-account-home/acct-default",
    );
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
    // Drain the first session to a terminal status before the test ends. An
    // undrained session keeps running after this test returns and can consume
    // a later test's own mocked promotion result.
    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${first.body.sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });
  });

  it("fails closed when promotion loses the sole-owner claim", async () => {
    // This is the expiry/reaper-race result from Decision H. It is a normal
    // resolved adapter outcome, but it must never be accepted as authentication.
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "not_sole_owner",
      accountId: null,
      accountHomeDir: null,
    });
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

  it("a successful Codex login creates the company secret naming the account home", async () => {
    // A second, different account no longer fails behind an occupied company
    // home: each account gets its own home, named by a company secret.
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(
      "/tmp/paperclip-codex-account-home/acct-second",
    );
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-second",
      accountHomeDir: "/tmp/paperclip-codex-account-home/acct-second",
    });
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });

    expect(mockSecretService.getByName).toHaveBeenCalledWith(COMPANY_1, "CODEX_HOME_acct-second");
    expect(mockSecretService.create).toHaveBeenCalledWith(
      COMPANY_1,
      expect.objectContaining({
        name: "CODEX_HOME_acct-second",
        value: "/tmp/paperclip-codex-account-home/acct-second",
      }),
      expect.anything(),
    );
  });

  it("a repeat login for the same account creates no second secret", async () => {
    // The secret already names this account's home, so the route reads it,
    // confirms the value still matches, and creates nothing new: a repeat
    // login is idempotent.
    const accountHomeDir = "/tmp/paperclip-codex-account-home/acct-default";
    mockSecretService.getByName.mockResolvedValue({ id: "existing-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "kept",
      accountId: "acct-default",
      accountHomeDir,
    });
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });

    expect(mockSecretService.create).not.toHaveBeenCalled();
    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).toHaveBeenCalledWith(
      COMPANY_1,
      "existing-secret",
      expect.objectContaining({ configPath: "secrets.CODEX_HOME_acct-default" }),
    );
  });

  it("holds the account-home secret mutation lock while checking a pre-existing secret's value", async () => {
    // A `local_encrypted` secret rotate takes `withAccountHomeSecretMutationLock`
    // for the whole of its write. The pre-existing-secret check must run
    // inside the same lock and return right after: otherwise a rotate could
    // commit a new value in the gap between the check and the login
    // reporting success, and the login would report success for a value
    // that no longer names the account's own home. This proves the check
    // waits for a lock held elsewhere, and only reads the secret's value
    // once that lock frees.
    const accountHomeDir = "/tmp/paperclip-codex-account-home/acct-default";
    mockSecretService.getByName.mockResolvedValue({ id: "existing-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "kept",
      accountId: "acct-default",
      accountHomeDir,
    });

    let releaseHeldLock!: () => void;
    const heldLockGate = new Promise<void>((resolve) => {
      releaseHeldLock = resolve;
    });
    const lockHolder = withAccountHomeSecretMutationLock(undefined, COMPANY_1, () => heldLockGate);
    // Give the held lock a chance to actually acquire before the login
    // starts racing for the same lock.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const app = await createApp();
    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;
    harness.releaseGate();

    // The login's check must stay blocked behind the held lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).not.toHaveBeenCalled();

    releaseHeldLock();
    await lockHolder;
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });
    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).toHaveBeenCalled();
  });

  it("reconfirms the account-home secret a second time immediately before the terminal authenticated commit", async () => {
    // The early check inside `promote` releases its lock well before the
    // login service records the terminal `authenticated` state, so it alone
    // cannot prove the value still matches at that later point. The service
    // must run the same check again, right before that commit, under a
    // fresh lock acquisition: this test proves the second check runs, not
    // only the first.
    const accountHomeDir = "/tmp/paperclip-codex-account-home/acct-default";
    mockSecretService.getByName.mockResolvedValue({ id: "existing-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "kept",
      accountId: "acct-default",
      accountHomeDir,
    });
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });

    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the account-home secret is rotated after validation but before the login service commits its terminal state", async () => {
    // A board user can rotate the matching `CODEX_HOME` secret after
    // `promote`'s own check passes and before the login service commits its
    // terminal state, because `promote`'s lock is fully released by then.
    // The service must catch this with a second check it runs right before
    // that commit, or it would report `authenticated` for a value that no
    // longer names the account's own home.
    const accountHomeDir = "/tmp/paperclip-codex-account-home/acct-default";
    mockSecretService.getByName.mockResolvedValue({ id: "existing-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck
      // `promote`'s own early check: still matches.
      .mockResolvedValueOnce(accountHomeDir)
      // The rotation lands in the gap. The final check, immediately before
      // the terminal commit, now reads the rotated value.
      .mockResolvedValueOnce("/rotated/away/from/the/account/home");
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "kept",
      accountId: "acct-default",
      accountHomeDir,
    });
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

    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a pre-existing secret names a different account home", async () => {
    // A stale or hand-entered secret at this name must not let the login
    // report success while a bound agent reads the wrong credential home.
    mockSecretService.getByName.mockResolvedValue({ id: "stale-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(
      "/some/other/path/left-over-from-before",
    );
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "kept",
      accountId: "acct-stale",
      accountHomeDir: "/tmp/paperclip-codex-account-home/acct-stale",
    });
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

    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("fails closed and removes the account home when secret creation fails", async () => {
    // This login created the account home, so a secret-creation failure must
    // fail the login and remove the directory it just created, so the
    // operation stays atomic.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-broken-secret",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
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

    await expect(lstat(accountHomeDir)).rejects.toThrow();
  });

  it("a secret creation failure keeps an account home that already existed", async () => {
    // The account home directory pre-dates this login (a user deleted the
    // secret but kept the directory, or an earlier login already wrote it).
    // A secret-creation failure must still fail the login, but it must never
    // remove a directory this login did not create.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-existing-home",
      accountHomeDir,
      accountHomeCreated: false,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
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

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("a secret name conflict succeeds and keeps the account home", async () => {
    // Two logins for one account can both read no secret and then race the
    // create call. The loser gets a 409 conflict, which proves the secret
    // already exists. A repeat login for the same account must be idempotent,
    // so the loser must confirm the winning secret's value, report a
    // successful login, and must never remove the account home the winner
    // just wrote.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-conflict",
      accountHomeDir,
      accountHomeCreated: true,
    });
    // `vi.resetModules()` in `beforeEach` gives the route module a fresh copy
    // of `../errors.js`. Import the conflict helper from that same fresh copy,
    // so the route's `err instanceof HttpError` check sees a matching class.
    const { conflict: freshConflict } =
      await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockSecretService.create.mockRejectedValueOnce(
      freshConflict("a secret with this name already exists"),
    );
    // The first read (before `create`) finds no secret; the second read
    // (after the conflict) finds the winner's secret.
    mockSecretService.getByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "winning-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(accountHomeDir);
    const app = await createApp();

    const start = await request(app)
      .post(loginPath(COMPANY_1))
      .send({ environmentId: SANDBOX_ENV_1 });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const sessionId = start.body.sessionId as string;

    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath(COMPANY_1)}/${sessionId}`);
      expect(status.body.status).toBe("authenticated");
    });

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("fails closed when the secret that won the create race names a different account home", async () => {
    // The 409 conflict proves some secret now holds this name, but that
    // secret could belong to unrelated stale state, not the winner of a
    // genuine same-account race. The login must not report success without
    // checking the winning secret's value.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-conflict-mismatch",
      accountHomeDir,
      accountHomeCreated: true,
    });
    const { conflict: freshConflict } =
      await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockSecretService.create.mockRejectedValueOnce(
      freshConflict("a secret with this name already exists"),
    );
    mockSecretService.getByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "winning-secret" });
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValue(
      "/some/other/path/left-over-from-before",
    );
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

    // The mismatch is a validation failure on the winner's secret, not this
    // call's own directory, so this call must still never delete it.
    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("does not remove an account home a concurrent login already claimed", async () => {
    // This call created the account home directory (`accountHomeCreated:
    // true`), but a concurrent login for the same account can still create
    // the company secret before this call's own, unrelated secret-creation
    // attempt fails. The directory now belongs to that other login's secret,
    // so the cleanup scan must find it by value and keep the directory.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-concurrent-claim",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    // The first read (before `create`) finds no secret.
    mockSecretService.getByName.mockResolvedValueOnce(null);
    // The cleanup scan lists every company secret and resolves each one's
    // value. The concurrent login's secret carries this call's own generated
    // name, so this proves the scan still catches a same-name claimant.
    mockSecretService.list.mockResolvedValueOnce([
      { id: "concurrent-secret", name: "CODEX_HOME_acct-concurrent-claim", provider: "local_encrypted" },
    ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValueOnce(accountHomeDir);
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

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("does not remove an account home a differently named secret still references", async () => {
    // A user can bind a hand-named secret to an account home directly, with
    // no relation to the generated `CODEX_HOME_<handle>` name. A cleanup that
    // checks only the generated name would miss this secret and delete a
    // directory it still needs; the scan must catch it by value instead.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-aliased",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    mockSecretService.getByName.mockResolvedValueOnce(null);
    mockSecretService.list.mockResolvedValueOnce([
      // An unrelated secret that resolves to a different value. The scan
      // must not stop at the first entry and must not treat every secret as
      // a match.
      { id: "unrelated-secret", name: "SOME_OTHER_SECRET", provider: "local_encrypted" },
      { id: "hand-named-secret", name: "MY_CODEX_HOME", provider: "local_encrypted" },
    ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockImplementation(
      async (_companyId: string, secretId: string, _context: { configPath: string }) =>
        secretId === "hand-named-secret" ? accountHomeDir : "/some/unrelated/path",
    );
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

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("does not remove an account home an AWS Secrets Manager-backed secret still references", async () => {
    // A secret's value is a plain string regardless of its provider, so a
    // hand-named secret bound to this account home through AWS Secrets
    // Manager is just as real a claimant as a `local_encrypted` one. The
    // scan must resolve it too, not skip it for its provider.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-aws-claim",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    mockSecretService.getByName.mockResolvedValueOnce(null);
    mockSecretService.list.mockResolvedValueOnce([
      { id: "aws-secret", name: "MY_CODEX_HOME", provider: "aws_secrets_manager" },
    ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValueOnce(accountHomeDir);
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

    expect(mockSecretService.resolveSecretValueForDeviceLoginCheck).toHaveBeenCalledWith(
      COMPANY_1,
      "aws-secret",
      expect.objectContaining({ configPath: "secrets.MY_CODEX_HOME" }),
    );
    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("removes the account home when the cleanup scan finds no claimant", async () => {
    // No secret, under any name, resolves to this directory, so the cleanup
    // must still remove it — the broader scan must not make cleanup any less
    // eager than the old name-only check when nothing claims the directory.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-unclaimed",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    mockSecretService.getByName.mockResolvedValueOnce(null);
    mockSecretService.list.mockResolvedValueOnce([
      { id: "unrelated-secret", name: "SOME_OTHER_SECRET", provider: "local_encrypted" },
    ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockResolvedValueOnce("/some/unrelated/path");
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

    await expect(lstat(accountHomeDir)).rejects.toThrow();
  });

  it("preserves the account home when the cleanup scan cannot resolve a secret's value", async () => {
    // A resolve failure on one secret is not proof that secret names a
    // different directory: the failure can hit the exact secret that would
    // have matched. The cleanup must keep the directory rather than treat an
    // unresolved secret as a non-match, even when every secret that DID
    // resolve named a different directory.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-unresolvable",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    mockSecretService.getByName.mockResolvedValueOnce(null);
    mockSecretService.list.mockResolvedValueOnce([
      { id: "unrelated-secret", name: "SOME_OTHER_SECRET", provider: "local_encrypted" },
      { id: "unresolvable-secret", name: "MAYBE_CODEX_HOME", provider: "local_encrypted" },
    ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockImplementation(
      async (_companyId: string, secretId: string, _context: { configPath: string }) => {
        if (secretId === "unresolvable-secret") throw new Error("decryption key unavailable");
        return "/some/unrelated/path";
      },
    );
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

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("preserves the account home when a secret appears after the scan starts", async () => {
    // The scan lists secrets once, then resolves each one in turn. A new
    // secret can appear after that first list call, while the scan is still
    // resolving an earlier secret. The scan must re-list and check that new
    // secret too, instead of trusting its first, now-stale list.
    const accountHomeDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-account-home-test-"));
    accountHomeTestDirs.push(accountHomeDir);
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct-late-claim",
      accountHomeDir,
      accountHomeCreated: true,
    });
    mockSecretService.create.mockRejectedValueOnce(new Error("db unavailable"));
    mockSecretService.getByName.mockResolvedValueOnce(null);
    // The first pass sees only the unrelated secret. By the time the scan
    // re-lists, a second, differently named secret now names this account
    // home; the scan must catch it on that later pass.
    mockSecretService.list
      .mockResolvedValueOnce([{ id: "unrelated-secret", name: "SOME_OTHER_SECRET", provider: "local_encrypted" }])
      .mockResolvedValueOnce([
        { id: "unrelated-secret", name: "SOME_OTHER_SECRET", provider: "local_encrypted" },
        { id: "late-secret", name: "LATE_CODEX_HOME", provider: "local_encrypted" },
      ]);
    mockSecretService.resolveSecretValueForDeviceLoginCheck.mockImplementation(
      async (_companyId: string, secretId: string, _context: { configPath: string }) =>
        secretId === "late-secret" ? accountHomeDir : "/some/unrelated/path",
    );
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

    await expect(lstat(accountHomeDir)).resolves.toBeDefined();
  });

  it("fails closed when the account identifier cannot form a valid account home name", async () => {
    // The promotion helper itself already rejects an identifier that cannot
    // become an account handle; a defensive re-check in the route covers a
    // promotion result the route did not fully trust.
    mockDeviceLoginPromotion.mockResolvedValueOnce({
      outcome: "promoted",
      accountId: "acct with space",
      accountHomeDir: "/tmp/paperclip-codex-account-home/unused",
    });
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

    expect(mockSecretService.create).not.toHaveBeenCalled();
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
