import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

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
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
  findManagedSandboxEnvironment: vi.fn(async () => null as Record<string, unknown> | null),
}));

const mockReleaseRunLease = vi.hoisted(() => vi.fn(async () => undefined));
const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({
    releaseRunLease: mockReleaseRunLease,
  })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null as string | null })),
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async () => ({ enableManagedSandboxOnly: false })),
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

const testEnvironmentSpy = vi.fn();

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: testEnvironmentSpy,
};

// Only the runtime preparation is replaced: it needs a database and a stored
// grant, and these tests exercise the route's verdict, not credential
// resolution. Everything else in the module stays real. The same goes for
// validateAiApiKey — it calls the provider's real endpoint, and these tests
// direct its verdict instead of the network.
const mockPrepareManagedAiRuntime = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-connection-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ai-connection-runtime.js")>()),
  prepareManagedAiRuntime: mockPrepareManagedAiRuntime,
}));
const mockValidateAiApiKey = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../routes/ai-connections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/ai-connections.js")>()),
  validateAiApiKey: mockValidateAiApiKey,
}));

function mockManagedRuntime(method: "api_key" | "subscription") {
  mockPrepareManagedAiRuntime.mockImplementation(
    async (_db: unknown, input: { config: Record<string, unknown> }) => ({
      config: {
        ...input.config,
        // The real preparation injects the credential under the provider's
        // env key; the adoption re-verification reads it from there.
        env: { ...(method === "api_key" ? { ANTHROPIC_API_KEY: "sk-ant-test-key" } : {}) },
        managedAiConnection: {
          connectionId: "conn-1",
          grantId: "grant-1",
          provider: "anthropic",
          method,
          mode: "responsible_user",
          responsibleUserId: "local-board",
          identity: "grant-1:local-board:0000000000000000",
        },
      },
      attribution: {
        connectionId: "conn-1",
        grantId: "grant-1",
        provider: "anthropic",
        method,
        mode: "responsible_user",
        responsibleUserId: "local-board",
      },
      accountName: "My Claude Account",
      accountOwnerUserId: "local-board",
      identity: "grant-1:local-board:0000000000000000",
      cleanup: vi.fn(async () => {}),
    }),
  );
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("agent test-environment route", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: false });
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue(null);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: "Sandbox QA",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    // Default to an instance-global environment with no company binding, so the
    // tenant-binding guard passes unless a test overrides it.
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
    mockEnvironmentRuntime.acquireRunLease.mockResolvedValue({
      lease: {
        id: "lease-1",
        provider: "daytona",
        providerLeaseId: "provider-lease-1",
        metadata: {
          remoteCwd: "/home/user/paperclip-workspace",
          sandboxId: "sandbox-1",
          sandboxName: "paperclip-probe",
          templateKind: "snapshot",
          templateRef: "snapshot-1",
        },
      },
      leaseContext: {
        executionWorkspaceId: null,
        executionWorkspaceMode: null,
      },
    });
    mockEnvironmentRuntime.realizeWorkspace.mockResolvedValue({
      cwd: "/home/user/paperclip-workspace",
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
    testEnvironmentSpy.mockResolvedValue({
      adapterType: "external_test",
      status: "pass",
      checks: [
        {
          code: "host_probe_ran",
          level: "info",
          message: "host probe should not run",
        },
      ],
      testedAt: new Date(0).toISOString(),
    });
    await unregisterTestAdapter("external_test");
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
  });

  it("tests the instance default sandbox when the agent inherits its environment", async () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: environmentId });
    const target = {
      kind: "remote", transport: "sandbox", remoteCwd: "/workspace",
      providerKey: "daytona", runner: { execute: vi.fn() },
    };
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(target);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ adapterConfig: {}, environmentId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnvironmentRuntime.acquireRunLease).toHaveBeenCalled();
    expect(testEnvironmentSpy).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: target }));
    expect(mockReleaseRunLease).toHaveBeenCalled();
  });

  it.each([
    { selection: "omitted", environmentId: undefined, expectedId: "22222222-2222-4222-8222-222222222222" },
    { selection: "cleared", environmentId: null, expectedId: "11111111-1111-4111-8111-111111111111" },
    { selection: "replaced", environmentId: "33333333-3333-4333-8333-333333333333", expectedId: "33333333-3333-4333-8333-333333333333" },
  ])("resolves the saved agent environment when the request selection is $selection", async ({ environmentId, expectedId }) => {
    const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockAgentService.getById.mockResolvedValue({
      id: agentId, companyId: "company-1", adapterType: "external_test",
      adapterConfig: {}, runtimeConfig: {}, defaultEnvironmentId: "22222222-2222-4222-8222-222222222222",
    });
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });
    mockEnvironmentService.getById.mockImplementation(async (id) => ({
      id, name: "Selected sandbox", driver: "sandbox", status: "active", config: { provider: "fake-plugin" },
    }));
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "daytona", runner: { execute: vi.fn() } };
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(target);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ agentId, adapterConfig: {}, ...(environmentId === undefined ? {} : { environmentId }) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnvironmentRuntime.acquireRunLease).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ id: expectedId }),
    }));
    expect(mockSecretService.resolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      "company-1", {}, expect.objectContaining({ consumerType: "environment", consumerId: expectedId }),
      expect.any(Object),
    );
    expect(testEnvironmentSpy).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: target }));
  });

  it("keeps an explicit local override ahead of the instance sandbox default", async () => {
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });
    mockEnvironmentService.getById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", name: "Local", driver: "local", status: "active", config: {} });
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ environmentId: "33333333-3333-4333-8333-333333333333" });
    expect(res.status).toBe(200);
    expect(mockInstanceSettingsService.get).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
    expect(testEnvironmentSpy).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: null }));
  });

  it("uses the managed sandbox when managed-only execution has no configured default", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "daytona", runner: { execute: vi.fn() } };
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(target);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ environmentId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: target }));
  });

  it("checks the inherited environment's company before resolving credentials", async () => {
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });
    mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-2"]);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ adapterConfig: {} });
    expect(res.status).toBe(403);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it("never probes the host when an inherited environment is missing", async () => {
    mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: "11111111-1111-4111-8111-111111111111" });
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ adapterConfig: {} });
    expect(res.body.checks).toEqual([expect.objectContaining({ code: "environment_not_found" })]);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it("does not probe locally when managed-only execution has no default or sandbox", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableManagedSandboxOnly: true });
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ adapterConfig: {} });
    expect(res.status).toBe(422);
    expect(res.body.details.code).toBe("managed_sandbox_unavailable");
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it("tests a prospective adapter switch before saving the agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
    });
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", adapterConfig: { model: "prospective-model" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).toHaveBeenCalledWith(expect.objectContaining({ config: { model: "prospective-model" } }));
  });

  it("requires agent update permission to test a prospective adapter switch", async () => {
    mockAgentService.getById.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1", adapterType: "codex_local", adapterConfig: {} });
    mockAccessService.decide.mockImplementation(async ({ action }) => ({ allowed: action !== "agent_config:update", reason: "test", explanation: "Update denied" }));
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", adapterConfig: {} });
    expect(res.status).toBe(403);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it.each(["CURSOR_API_KEY", "KIMI_MODEL_API_KEY", "ZAI_API_KEY", "KIMI_API_KEY", "MINIMAX_API_KEY"])("accepts %s as a probe-only credential", async (key) => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ testCredentials: { [key]: "probe-only-key" } });
    expect(res.status).toBe(200);
    expect(mockSecretService.normalizeAdapterConfigForPersistence.mock.calls[0]?.[1]).toEqual({});
    expect(testEnvironmentSpy.mock.calls[0]?.[0].config.env).toEqual({ [key]: "probe-only-key" });
  });

  it("maps the Hermes gateway probe key without passing it to persistence", async () => {
    const { registerServerAdapter, getServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    const previous = getServerAdapter("hermes_gateway");
    unregisterServerAdapter("hermes_gateway");
    registerServerAdapter({ ...externalAdapter, type: "hermes_gateway" });
    try {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/adapters/hermes_gateway/test-environment")
        .send({ adapterConfig: { apiBaseUrl: "https://hermes.example.com" }, testCredentials: { API_SERVER_KEY: "gateway-probe-key" } });
      expect(res.status).toBe(200);
      expect(mockSecretService.normalizeAdapterConfigForPersistence.mock.calls[0]?.[1]).toEqual({ apiBaseUrl: "https://hermes.example.com" });
      expect(testEnvironmentSpy.mock.calls[0]?.[0].config.apiKey).toBe("gateway-probe-key");
      expect(JSON.stringify(res.body)).not.toContain("gateway-probe-key");
    } finally {
      unregisterServerAdapter("hermes_gateway");
      if (previous) registerServerAdapter(previous);
    }
  });

  // The managed-adoption verdict, all three ways. An api_key account is
  // re-verified against the provider's endpoint at adoption — the same check
  // its save performed, catching a key revoked since — but never through the
  // CLI-lane hello probe, which a clean machine without a provider CLI can
  // never pass (the regression that walled off onboarding's API-key path in
  // the nightly release smoke). A stored subscription login still needs the
  // hello probe: only a real turn proves the runtime lane can consume it.
  it("adopts an api_key connection on the engine's verdict plus a live key check, without a CLI hello probe", async () => {
    mockManagedRuntime("api_key");
    // A sentinel in claude_local's slot: the forced CLI-lane fallback would
    // land here, so the fix is proven by this never being consulted — not by
    // whatever verdict the host machine's real adapter would return.
    const { registerServerAdapter, getServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    const previous = getServerAdapter("claude_local");
    unregisterServerAdapter("claude_local");
    const cliProbeSpy = vi.fn(async () => ({
      adapterType: "claude_local",
      status: "fail" as const,
      checks: [{ code: "adapter_command_missing", level: "error" as const, message: 'Command not found in PATH: "claude"' }],
      testedAt: new Date(0).toISOString(),
    }));
    registerServerAdapter({ ...externalAdapter, type: "claude_local", testEnvironment: cliProbeSpy });
    try {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          adapterConfig: { cwd: "/" },
          aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pass");
      expect(JSON.stringify(res.body)).not.toContain("ai_connection_validation_incomplete");
      expect(res.body.checks.map((check: { code: string }) => check.code)).toContain("ai_connection_api_key_reverified");
      expect(mockValidateAiApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-test-key");
      expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
      expect(cliProbeSpy).not.toHaveBeenCalled();
    } finally {
      unregisterServerAdapter("claude_local");
      if (previous) registerServerAdapter(previous);
    }
  });

  it("fails adoption of an api_key connection the provider no longer accepts", async () => {
    mockManagedRuntime("api_key");
    mockValidateAiApiKey.mockRejectedValueOnce(Object.assign(new Error("The provider rejected this API key."), { status: 422 }));
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({
        adapterConfig: { cwd: "/" },
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("fail");
    expect(res.body.checks.map((check: { code: string }) => check.code)).toContain("ai_connection_api_key_rejected");
  });

  it("still fails subscription adoption when no hello probe can run", async () => {
    mockManagedRuntime("subscription");
    const { registerServerAdapter, getServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    const previous = getServerAdapter("claude_local");
    unregisterServerAdapter("claude_local");
    const cliProbeSpy = vi.fn(async () => ({
      adapterType: "claude_local",
      status: "fail" as const,
      checks: [{ code: "adapter_command_missing", level: "error" as const, message: 'Command not found in PATH: "claude"' }],
      testedAt: new Date(0).toISOString(),
    }));
    registerServerAdapter({ ...externalAdapter, type: "claude_local", testEnvironment: cliProbeSpy });
    try {
      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          adapterConfig: { cwd: "/" },
          aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("fail");
      expect(res.body.checks.map((check: { code: string }) => check.code)).toContain("ai_connection_validation_incomplete");
      expect(cliProbeSpy).toHaveBeenCalledTimes(1);
      expect(cliProbeSpy.mock.calls[0]?.[0]?.config.engine).toBe("cli");
    } finally {
      unregisterServerAdapter("claude_local");
      if (previous) registerServerAdapter(previous);
    }
  });

  it("passes one-shot provider credentials only to the probe, never persistence normalization", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ adapterConfig: { env: { KEEP: "value" } }, testCredentials: { OPENROUTER_API_KEY: "probe-only-key" } });
    expect(res.status).toBe(200);
    expect(mockSecretService.normalizeAdapterConfigForPersistence.mock.calls[0]?.[1]).toEqual({ env: { KEEP: "value" } });
    expect(testEnvironmentSpy.mock.calls[0]?.[0].config.env).toEqual({ KEEP: "value", OPENROUTER_API_KEY: "probe-only-key" });
    expect(JSON.stringify(res.body)).not.toContain("probe-only-key");
  });

  it("rejects non-provider variables in one-shot credentials", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({ testCredentials: { NODE_OPTIONS: "--require unsafe" } });
    expect(res.status).toBe(400);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
  });

  it("does not fall back to a host probe when a requested environment cannot produce an execution target", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({
        adapterConfig: {},
        environmentId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      adapterType: "external_test",
      status: "warn",
      checks: [
        {
          code: "environment_target_unsupported",
          level: "warn",
          message: 'Adapter "external_test" is not allowed in "Sandbox QA" environments.',
        },
      ],
    });
    expect(mockReleaseRunLease).toHaveBeenCalledWith({
      environment: expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Sandbox QA",
        driver: "sandbox",
      }),
      lease: expect.objectContaining({
        id: "lease-1",
      }),
      status: "failed",
    });
  });

  it("returns a diagnostic result instead of probing the host when the requested environment is missing", async () => {
    // The route reads the environment more than once: the tenant-binding guard
    // loads it, then the execution-context resolver loads it. Return null for
    // every read so the missing-environment path is stable.
    mockEnvironmentService.getById.mockResolvedValue(null);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({
        adapterConfig: {},
        environmentId: "22222222-2222-4222-8222-222222222222",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
    expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      adapterType: "external_test",
      status: "warn",
      checks: [
        {
          code: "environment_not_found",
          level: "warn",
          message: "Selected environment was not found. The test did not run.",
        },
      ],
    });
  });

  it("runs the adapter probe against the resolved sandbox target on the happy path and releases the lease on success", async () => {
    mockResolveEnvironmentExecutionTarget.mockResolvedValueOnce({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/home/user/paperclip-workspace",
      providerKey: "fake-plugin",
      runner: { execute: vi.fn() },
    });
    testEnvironmentSpy.mockResolvedValueOnce({
      adapterType: "external_test",
      status: "pass",
      checks: [
        {
          code: "external_test_hello_probe_passed",
          level: "info",
          message: "OK",
        },
      ],
      testedAt: new Date(0).toISOString(),
    });
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({
        adapterConfig: {},
        environmentId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
    // Test leases boot fresh and stay debuggable: never resume a retained
    // agent lease, archive (not delete) the sandbox on release.
    expect(mockEnvironmentRuntime.acquireRunLease).toHaveBeenCalledWith(
      expect.objectContaining({
        applyCustomImageTemplate: true,
        // The Test lease re-checks the company binding, so a binding change
        // between the route guard and the lease cannot open a foreign sandbox.
        assertCompanyBinding: true,
        environment: expect.objectContaining({
          config: expect.objectContaining({
            reuseLease: false,
            archiveOnRelease: true,
          }),
        }),
      }),
    );
    expect(testEnvironmentSpy.mock.calls[0]?.[0]).toMatchObject({
      executionTarget: expect.objectContaining({
        kind: "remote",
        transport: "sandbox",
      }),
      environmentName: "Sandbox QA",
    });
    expect(res.body).toMatchObject({ adapterType: "external_test", status: "pass" });
    expect(res.body.checks).toEqual([
      expect.objectContaining({
        code: "sandbox_test_identity",
        level: "info",
        message: 'Environment test identity for "Sandbox QA".',
        detail: expect.stringContaining("paperclipLeaseId=lease-1"),
      }),
      expect.objectContaining({
        code: "external_test_hello_probe_passed",
        level: "info",
        message: "OK",
      }),
    ]);
    expect(res.body.checks[0].detail).toContain("providerLeaseId=provider-lease-1");
    expect(res.body.checks[0].detail).toContain("provider=daytona");
    expect(res.body.checks[0].detail).toContain("sandboxId=sandbox-1");
    expect(res.body.checks[0].detail).toContain("sandboxName=paperclip-probe");
    expect(res.body.checks[0].detail).toContain("snapshotRef=snapshot-1");
    expect(mockReleaseRunLease).toHaveBeenCalledWith({
      environment: expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      status: "released",
    });
  });

  it("releases the lease as failed and returns a diagnostic when realizeWorkspace throws", async () => {
    mockEnvironmentRuntime.realizeWorkspace.mockRejectedValueOnce(
      new Error("workspace realization failed"),
    );
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/adapters/external_test/test-environment")
      .send({
        adapterConfig: {},
        environmentId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(testEnvironmentSpy).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      adapterType: "external_test",
      status: "fail",
      checks: [
        expect.objectContaining({
          code: "environment_workspace_realize_failed",
          level: "error",
        }),
      ],
    });
    expect(mockReleaseRunLease).toHaveBeenCalledWith({
      environment: expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      lease: expect.objectContaining({ id: "lease-1" }),
      status: "failed",
    });
  });

  describe("environment envVars merge", () => {
    const environmentId = "11111111-1111-4111-8111-111111111111";
    const sandboxExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/home/user/paperclip-workspace",
      providerKey: "fake-plugin",
      runner: { execute: vi.fn() },
    };

    it("merges resolved environment envVars under the agent adapterConfig env", async () => {
      mockEnvironmentService.getById.mockResolvedValue({
        id: environmentId,
        companyId: "company-1",
        name: "Sandbox QA",
        driver: "sandbox",
        config: { provider: "fake-plugin" },
        envVars: {
          CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "secret-1" },
          FOO: { type: "plain", value: "env-foo" },
          PAPERCLIP_API_KEY: { type: "plain", value: "must-not-flow" },
        },
      });
      mockResolveEnvironmentExecutionTarget.mockResolvedValueOnce(sandboxExecutionTarget);
      mockSecretService.resolveEnvBindings.mockResolvedValueOnce({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "resolved-token", FOO: "env-foo" },
        secretKeys: new Set(["CLAUDE_CODE_OAUTH_TOKEN"]),
        manifest: [],
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          adapterConfig: { env: { FOO: "agent-foo" } },
          environmentId,
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSecretService.resolveEnvBindings).toHaveBeenCalledWith(
        "company-1",
        {
          CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "secret-1" },
          FOO: { type: "plain", value: "env-foo" },
        },
        expect.objectContaining({
          consumerType: "environment",
          consumerId: environmentId,
        }),
      );
      expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
      // Environment env is the base layer; the agent's own env wins on conflicts.
      expect(testEnvironmentSpy.mock.calls[0]?.[0]?.config?.env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: "resolved-token",
        FOO: "agent-foo",
      });
      expect(res.body.status).toBe("pass");
    });

    it("skips env vars with missing secret bindings and fails the test", async () => {
      mockEnvironmentService.getById.mockResolvedValue({
        id: environmentId,
        companyId: "company-1",
        name: "Sandbox QA",
        driver: "sandbox",
        config: { provider: "fake-plugin" },
        envVars: {
          MISSING_TOKEN: { type: "secret_ref", secretId: "secret-gone" },
          GOOD: { type: "plain", value: "ok" },
        },
      });
      mockResolveEnvironmentExecutionTarget.mockResolvedValueOnce(sandboxExecutionTarget);
      mockSecretService.collectMissingRuntimeBindings.mockResolvedValueOnce([
        {
          consumerType: "environment",
          consumerId: environmentId,
          configPath: "env.MISSING_TOKEN",
          envKey: "MISSING_TOKEN",
          secretId: "secret-gone",
          secretName: "Gone",
        },
      ]);
      mockSecretService.resolveEnvBindings.mockResolvedValueOnce({
        env: { GOOD: "ok" },
        secretKeys: new Set<string>(),
        manifest: [],
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ adapterConfig: {}, environmentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // The unresolved key is excluded from resolution; the rest still flows.
      expect(mockSecretService.resolveEnvBindings).toHaveBeenCalledWith(
        "company-1",
        { GOOD: { type: "plain", value: "ok" } },
        expect.objectContaining({ consumerType: "environment" }),
      );
      expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
      expect(testEnvironmentSpy.mock.calls[0]?.[0]?.config?.env).toEqual({ GOOD: "ok" });
      // A missing binding blocks real dispatch, so the test reports fail even
      // though the adapter probe itself passed.
      expect(res.body.status).toBe("fail");
      expect(res.body.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "environment_env_binding_missing",
            level: "error",
            message: expect.stringContaining("MISSING_TOKEN"),
          }),
        ]),
      );
    });

    it("includes environment env checks when the environment cannot produce an execution target", async () => {
      mockEnvironmentService.getById.mockResolvedValue({
        id: environmentId,
        companyId: "company-1",
        name: "Sandbox QA",
        driver: "sandbox",
        config: { provider: "fake-plugin" },
        envVars: {
          MISSING_TOKEN: { type: "secret_ref", secretId: "secret-gone" },
        },
      });
      mockSecretService.collectMissingRuntimeBindings.mockResolvedValueOnce([
        {
          consumerType: "environment",
          consumerId: environmentId,
          configPath: "env.MISSING_TOKEN",
          envKey: "MISSING_TOKEN",
          secretId: "secret-gone",
          secretName: "Gone",
        },
      ]);
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ adapterConfig: {}, environmentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(testEnvironmentSpy).not.toHaveBeenCalled();
      expect(res.body.status).toBe("fail");
      expect(res.body.checks).toEqual([
        expect.objectContaining({ code: "environment_target_unsupported", level: "warn" }),
        expect.objectContaining({ code: "environment_env_binding_missing", level: "error" }),
      ]);
    });
  });

  describe("tenant-binding guard", () => {
    async function postForeignEnvironmentTest() {
      const app = await createApp();
      return request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          adapterConfig: { env: { FOO: "bar" } },
          environmentId: "11111111-1111-4111-8111-111111111111",
        });
    }

    function expectCompanyMismatch(res: request.Response) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).toContain("environment_company_mismatch");
      // The guard rejects before any secret resolution, target resolution,
      // sandbox lease, or adapter test runs.
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
      expect(testEnvironmentSpy).not.toHaveBeenCalled();
    }

    it("rejects an active environment bound to another company", async () => {
      mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-2"]);
      expectCompanyMismatch(await postForeignEnvironmentTest());
    });

    it("rejects an archived environment bound to another company without revealing its status", async () => {
      mockEnvironmentService.getById.mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-2",
        name: "Sandbox QA",
        driver: "sandbox",
        status: "archived",
        config: { provider: "fake-plugin" },
      });
      mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-2"]);
      expectCompanyMismatch(await postForeignEnvironmentTest());
    });

    it("rejects a disallowed-driver environment bound to another company without revealing its driver", async () => {
      mockEnvironmentService.getById.mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-2",
        name: "Plugin Env",
        driver: "plugin",
        status: "active",
        config: {},
      });
      mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-2"]);
      expectCompanyMismatch(await postForeignEnvironmentTest());
    });

    it("allows an instance-global environment with no company binding", async () => {
      mockEnvironmentService.listBoundCompanyIds.mockResolvedValue([]);
      const res = await postForeignEnvironmentTest();
      // The guard passes and the route proceeds to secret resolution.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalled();
    });

    it("allows an environment bound to the caller company", async () => {
      mockEnvironmentService.listBoundCompanyIds.mockResolvedValue(["company-1"]);
      const res = await postForeignEnvironmentTest();
      // The guard passes and the route proceeds to secret resolution.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalled();
    });
  });

  describe("managed-sandbox-only redirect", () => {
    const localEnvironmentId = "33333333-3333-4333-8333-333333333333";
    const managedSandboxEnvironment = {
      id: "44444444-4444-4444-8444-444444444444",
      companyId: null,
      name: "Managed sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "fake-plugin" },
    };
    const localEnvironment = {
      id: localEnvironmentId,
      companyId: null,
      name: "Local host",
      driver: "local",
      status: "active",
      config: {},
    };

    it("redirects a local-environment Test onto the managed sandbox and never probes the host", async () => {
      mockEnvironmentService.getById.mockResolvedValue(localEnvironment);
      mockInstanceSettingsService.getExperimental.mockResolvedValue({
        enableManagedSandboxOnly: true,
      });
      mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue(
        managedSandboxEnvironment,
      );
      mockResolveEnvironmentExecutionTarget.mockResolvedValueOnce({
        kind: "remote",
        transport: "sandbox",
        remoteCwd: "/home/user/paperclip-workspace",
        providerKey: "fake-plugin",
        runner: { execute: vi.fn() },
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ adapterConfig: {}, environmentId: localEnvironmentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // The Test leases and probes the managed sandbox the real run uses, not
      // the local host that the agent default still names.
      expect(mockEnvironmentRuntime.acquireRunLease).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.objectContaining({ id: managedSandboxEnvironment.id }),
        }),
      );
      expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
      expect(testEnvironmentSpy.mock.calls[0]?.[0]).toMatchObject({
        executionTarget: expect.objectContaining({ kind: "remote", transport: "sandbox" }),
        environmentName: "Managed sandbox",
      });
    });

    it("fails closed when the policy is on and no managed sandbox environment exists", async () => {
      mockEnvironmentService.getById.mockResolvedValue(localEnvironment);
      mockInstanceSettingsService.getExperimental.mockResolvedValue({
        enableManagedSandboxOnly: true,
      });
      mockEnvironmentService.findManagedSandboxEnvironment.mockResolvedValue(null);
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ adapterConfig: {}, environmentId: localEnvironmentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // No fall back to a host probe: the Test reports fail-closed.
      expect(testEnvironmentSpy).not.toHaveBeenCalled();
      expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
      expect(res.body.status).toBe("fail");
      expect(res.body.checks).toEqual([
        expect.objectContaining({ code: "managed_sandbox_unavailable", level: "error" }),
      ]);
    });

    it("probes the local host when the managed-sandbox-only policy is off", async () => {
      mockEnvironmentService.getById.mockResolvedValue(localEnvironment);
      mockInstanceSettingsService.getExperimental.mockResolvedValue({
        enableManagedSandboxOnly: false,
      });
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({ adapterConfig: {}, environmentId: localEnvironmentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // Legacy behavior: a local environment probes the host with no redirect
      // and no sandbox lease.
      expect(mockEnvironmentService.findManagedSandboxEnvironment).not.toHaveBeenCalled();
      expect(mockEnvironmentRuntime.acquireRunLease).not.toHaveBeenCalled();
      expect(testEnvironmentSpy).toHaveBeenCalledTimes(1);
      expect(testEnvironmentSpy.mock.calls[0]?.[0]?.executionTarget ?? null).toBeNull();
    });
  });
});
