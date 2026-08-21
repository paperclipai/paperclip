import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "allowed" })),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
}));

const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn(async () => null));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockRunClaudeLogin = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

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
  heartbeatService: () => ({ wakeup: vi.fn(), cancelActiveForAgent: vi.fn() }),
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

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return {
    ...actual,
    runClaudeLogin: mockRunClaudeLogin,
  };
});

// NOTE: ../services/secrets.js is intentionally NOT mocked — the routes resolve
// against the real embedded-postgres-backed secret service.
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping adapter-config user-secret route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

type TestActor = Express.Request["actor"];
let currentActor: TestActor | undefined;

const testEnvironmentSpy = vi.fn();

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: testEnvironmentSpy,
};

describeEmbeddedPostgres("agents adapter-config user-secret resolution routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-adapter-user-secret-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("adapter-user-secret-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Acme",
      issuePrefix: "ACME",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: COMPANY_ID,
      principalType: "user",
      principalId: "user-1",
      status: "active",
      membershipRole: "owner",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
  });

  beforeEach(() => {
    // Reset the request actor so each test starts from an explicit, empty
    // fixture state — a test that forgets to set an actor fails loudly rather
    // than inheriting one leaked from a prior test.
    currentActor = undefined;
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "allowed",
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
    testEnvironmentSpy.mockResolvedValue({
      adapterType: "external_test",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
  });

  afterAll(async () => {
    const { unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("external_test");
    if (stopDb) await stopDb();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function createApp() {
    const { agentRoutes } = await vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js");
    const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = currentActor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardUserActor: TestActor = {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
  };

  const boardNoUserActor: TestActor = {
    type: "board",
    companyIds: [COMPANY_ID],
    source: "local_implicit",
    isInstanceAdmin: false,
  };

  async function seedUserSecretDefinitionWithValue(key: string, value: string) {
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(COMPANY_ID, {
      key,
      name: key,
      provider: "local_encrypted",
    });
    await svc.createCurrentUserSecretValue(COMPANY_ID, "user-1", {
      definitionId: definition.id,
      value,
    });
    return definition;
  }

  // ── test-environment ──────────────────────────────────────────────

  it("test-environment resolves a required user_secret_ref for the acting user (owner-scoped, no declaration)", async () => {
    beforeEachActor(boardUserActor);
    await seedUserSecretDefinitionWithValue("github_token", "ghp_owner");
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/external_test/test-environment`)
      .send({
        adapterConfig: {
          env: {
            GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ adapterType: "external_test", status: "pass" });
    // The resolved (secret) value reached the adapter probe.
    expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
    expect(testEnvironmentSpy.mock.calls[0][0].config.env.GH_TOKEN).toBe("ghp_owner");
  });

  it("test-environment throws responsible_user_missing when no responsible user", async () => {
    beforeEachActor(boardNoUserActor);
    await seedUserSecretDefinitionWithValue("github_token", "ghp_owner");
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/external_test/test-environment`)
      .send({
        adapterConfig: {
          env: {
            GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ code: "responsible_user_missing" });
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it("test-environment company secret_ref still resolves (no binding_missing regression)", async () => {
    beforeEachActor(boardUserActor);
    const svc = secretService(db);
    const companySecret = await svc.create(COMPANY_ID, {
      name: `company-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "company-value",
    });
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/external_test/test-environment`)
      .send({
        adapterConfig: {
          env: {
            COMPANY_TOKEN: { type: "secret_ref", secretId: companySecret.id, version: "latest" },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy.mock.calls[0][0].config.env.COMPANY_TOKEN).toBe("company-value");
  });

  it("test-environment records an honest audit consumer (environment:<id> when selected, else system:adapter_test — never agent) with the real actor/responsible-user", async () => {
    // (a) No environment selected → system:adapter_test.
    beforeEachActor(boardUserActor);
    await seedUserSecretDefinitionWithValue("github_token", "ghp_owner");
    let app = await createApp();
    await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/external_test/test-environment`)
      .send({
        adapterConfig: {
          env: { GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true } },
        },
      })
      .expect(200);

    let events = await db.select().from(secretAccessEvents);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.consumerType).toBe("system");
      expect(ev.consumerId).toBe("adapter_test");
      expect(ev.consumerType).not.toBe("agent");
      expect(ev.actorType).toBe("user");
      expect(ev.actorId).toBe("user-1");
      expect(ev.responsibleUserId).toBe("user-1");
    }

    // (b) Environment selected → environment:<id>.
    await db.delete(secretAccessEvents);
    mockEnvironmentService.getById.mockResolvedValue({
      id: ENVIRONMENT_ID,
      companyId: COMPANY_ID,
      name: "Sandbox",
      driver: "local",
      config: {},
    });
    app = await createApp();
    await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/external_test/test-environment`)
      .send({
        environmentId: ENVIRONMENT_ID,
        adapterConfig: {
          env: { GH_TOKEN: { type: "user_secret_ref", key: "github_token", version: "latest", required: true } },
        },
      })
      .expect(200);

    events = await db.select().from(secretAccessEvents);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.consumerType).toBe("environment");
      expect(ev.consumerId).toBe(ENVIRONMENT_ID);
      expect(ev.actorType).toBe("user");
      expect(ev.responsibleUserId).toBe("user-1");
    }
  });

  // ── claude-login ──────────────────────────────────────────────────

  it("claude-login resolves a declared required user_secret_ref; undeclared → binding_missing", async () => {
    const definition = await seedUserSecretDefinitionWithValue("anthropic_key", "sk-owner");
    const agentId = randomUUID();
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId: COMPANY_ID,
      name: "Claude agent",
      adapterType: "claude_local",
      adapterConfig: {
        env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: "anthropic_key", version: "latest", required: true } },
      },
    });
    beforeEachActor(boardUserActor);

    // Undeclared → binding_missing (declared mode declaration guard active).
    let app = await createApp();
    let res = await request(app).post(`/api/agents/${agentId}/claude-login`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ code: "binding_missing" });
    expect(mockRunClaudeLogin).not.toHaveBeenCalled();

    // Declare it at the resolver-injected configPath (env.<KEY>) for consumer agent:<agentId>.
    await db.insert(userSecretDeclarations).values({
      companyId: COMPANY_ID,
      userSecretDefinitionId: definition.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.ANTHROPIC_API_KEY",
      envKey: "ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
      allowMissingOverride: false,
    });

    app = await createApp();
    res = await request(app).post(`/api/agents/${agentId}/claude-login`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRunClaudeLogin).toHaveBeenCalledTimes(1);
    expect(mockRunClaudeLogin.mock.calls[0][0].config.env.ANTHROPIC_API_KEY).toBe("sk-owner");
  });
});

function beforeEachActor(actor: TestActor) {
  currentActor = actor;
}
