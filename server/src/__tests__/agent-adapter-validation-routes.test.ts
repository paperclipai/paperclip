import express from "express";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
}));

const mockAdapterPluginStore = vi.hoisted(() => ({
  getDisabledAdapterTypes: vi.fn<() => string[]>(() => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  syncEnvBindingsForTarget: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockCheckProtectedKeys = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({ defaultEnvironmentId: null })),
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  getExperimental: vi.fn(async (): Promise<{ enableNativeRunner: boolean; enableOpenAiDot?: boolean; enableManagedSandboxOnly?: boolean }> => ({ enableNativeRunner: false })),
}));

const mockManagedAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockRemoteAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAntigravityModels = vi.hoisted(() => vi.fn());
vi.mock("../services/antigravity-connection-models.js", () => ({ antigravityConnectionModels: mockAntigravityModels }));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/managed-agent-profiles.js", () => ({
  managedAgentProfileService: () => mockManagedAgentProfileService,
}));

vi.mock("../services/remote-agent-profiles.js", () => ({
  remoteAgentProfileService: () => mockRemoteAgentProfileService,
}));

function registerModuleMocks() {
  vi.doMock("../services/protected-environment-keys.js", async () => ({
    ...await vi.importActual<typeof import("../services/protected-environment-keys.js")>("../services/protected-environment-keys.js"),
    checkAgentProtectedEnvironmentKeys: mockCheckProtectedKeys,
  }));
  vi.doMock("../services/antigravity-connection-models.js", () => ({ antigravityConnectionModels: mockAntigravityModels }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/managed-agent-profiles.js", () => ({
    managedAgentProfileService: () => mockManagedAgentProfileService,
  }));

  vi.doMock("../services/remote-agent-profiles.js", () => ({
    remoteAgentProfileService: () => mockRemoteAgentProfileService,
  }));

  // The adapter registry reads the disabled set from this store. Mock it so a
  // test can declare an adapter disabled without writing to the real
  // ~/.paperclip/adapter-settings.json.
  vi.doMock("../services/adapter-plugin-store.js", () => ({
    getDisabledAdapterTypes: mockAdapterPluginStore.getDisabledAdapterTypes,
    isAdapterDisabled: (type: string) =>
      mockAdapterPluginStore.getDisabledAdapterTypes().includes(type),
    listAdapterPlugins: () => [],
    getAdapterPluginByType: () => undefined,
    setAdapterDisabled: vi.fn(),
  }));
}
import {
  createAgentValidationApp as createApp,
  externalAdapter,
  missingAdapterType,
  requestAgentValidationApp as requestApp,
  resetAgentValidationMocks,
  unregisterTestAdapter,
} from "./helpers/agent-adapter-validation-harness.js";

describe("agent routes adapter validation", () => {
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    await resetAgentValidationMocks({
      mockAgentService,
      mockAdapterPluginStore,
      mockAccessService,
      mockCompanySkillService,
      mockSecretService,
      mockAgentInstructionsService,
      mockCheckProtectedKeys,
      mockInstanceSettingsService,
      mockManagedAgentProfileService,
      mockRemoteAgentProfileService,
      mockLogActivity,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
  });

  it("round-trips the protected YAML projection and forwards its revision to the write lock", async () => {
    const existing = {
      ...(await mockAgentService.getById()),
      adapterConfig: { model: "old", removeMe: true, env: { DEMO_VALUE: "private-fixture" } },
      metadata: { token: "private-metadata-fixture" },
    };
    mockAgentService.getById.mockResolvedValue(existing);
    const app = await createApp();
    const loaded = await requestApp(app, base => request(base).get(`/api/agents/${existing.id}/configuration`));
    expect(loaded.status).toBe(200);
    expect(loaded.body.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(loaded.body)).not.toContain("private-fixture");
    expect(JSON.stringify(loaded.body)).not.toContain("private-metadata-fixture");
    const adapterConfig = { ...loaded.body.adapterConfig, model: "new" };
    delete adapterConfig.removeMe;
    const saved = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      adapterConfig, replaceAdapterConfig: true, metadata: { ...loaded.body.metadata, label: "new" },
      expectedConfigurationRevision: loaded.body.configurationRevision,
    }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      adapterConfig: expect.objectContaining({ model: "new", env: existing.adapterConfig.env }),
      metadata: { ...existing.metadata, label: "new" },
    }), expect.objectContaining({ expectedConfigurationRevision: loaded.body.configurationRevision }));
    expect(mockAgentService.update.mock.calls[0][1].adapterConfig).not.toHaveProperty("removeMe");
    expect(saved.body.configurationRevision).not.toBe(loaded.body.configurationRevision);
    expect(JSON.stringify(saved.body)).not.toContain("private-fixture");
    expect(JSON.stringify(saved.body)).not.toContain("private-metadata-fixture");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.updated" }));
  });

  it("rejects stale and unauthorized YAML saves before calling the update service", async () => {
    const existing = await mockAgentService.getById();
    const app = await createApp();
    const loaded = await requestApp(app, base => request(base).get(`/api/agents/${existing.id}/configuration`));
    const stale = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      title: "Stale", expectedConfigurationRevision: "0".repeat(64),
    }));
    expect(stale.status).toBe(409);
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_missing_grant", explanation: "No configuration permission" });
    const denied = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      title: "Denied", expectedConfigurationRevision: loaded.body.configurationRevision,
    }));
    expect(denied.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("routes narrow roster edits through authorization, config merging and audit history", async () => {
    const existing = { ...(await mockAgentService.getById()), adapterConfig: { model: "old", cwd: "/workspace" }, runtimeConfig: { heartbeat: { intervalSec: 900 } } };
    mockAgentService.getById.mockResolvedValue(existing);
    const app = await createApp();
    const response = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({ runtimeSettings: {
      harness: "codex_local", model: "new", expected: { model: "old", aiConnection: null },
    } }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.adapterConfig).toMatchObject({ model: "new", cwd: "/workspace" });
    expect(response.body.runtimeConfig).toEqual(existing.runtimeConfig);
    expect(mockAgentService.update).toHaveBeenCalledWith(existing.id, expect.not.objectContaining({ runtimeSettings: expect.anything() }), expect.objectContaining({ expectedConfiguration: expect.objectContaining({ adapterConfig: existing.adapterConfig }), recordRevision: expect.anything() }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.updated", entityId: existing.id }));
  });

  it("refuses a roster edit without configuration permission", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "deny_missing_grant", explanation: "No configuration permission" });
    const app = await createApp();
    const response = await requestApp(app, base => request(base).patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ runtimeSettings: {
      harness: "codex_local", model: "new", expected: { model: null, aiConnection: null },
    } }));
    expect(response.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("omits the default marker from the native Grok catalog while retaining Legacy defaults", async () => {
    const adapters = await import("../adapters/index.js");
    const models = [{ id: "grok-build", label: "Default" }, { id: "grok-4.7", label: "Grok 4.7" }];
    const list = vi.spyOn(adapters, "listAdapterModels").mockResolvedValue(models);
    const refresh = vi.spyOn(adapters, "refreshAdapterModels").mockResolvedValue(models);
    try {
      const app = await createApp();
      for (const suffix of ["", "&refresh=true"]) {
        const native = await requestApp(app, baseUrl => request(baseUrl).get(`/api/companies/company-1/adapters/paperclip_runner/models?provider=acpx&acpxAgent=grok${suffix}`));
        expect(native.status).toBe(200);
        expect(native.body).toEqual([models[1]]);
        const legacy = await requestApp(app, baseUrl => request(baseUrl).get(`/api/companies/company-1/adapters/grok_local/models?refresh=${Boolean(suffix)}`));
        expect(legacy.status).toBe(200);
        expect(legacy.body).toEqual(models);
      }
    } finally { list.mockRestore(); refresh.mockRestore(); }
  });

  it("selects and refreshes the runner provider catalog independently", async () => {
    const adapters = await import("../adapters/index.js");
    const list = vi.spyOn(adapters, "listAdapterModels").mockImplementation(async (type) => [{ id: type, label: type }]);
    const refresh = vi.spyOn(adapters, "refreshAdapterModels").mockImplementation(async (type) => [{ id: `${type}-fresh`, label: type }]);
    try {
      const app = await createApp();
      for (const [provider, adapter] of [["acpx", "claude_local"], ["acpx&acpxAgent=grok", "grok_local"], ["codex", "codex_local"], ["opencode", "opencode_local"]]) {
        const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/company-1/adapters/paperclip_runner/models?provider=${provider}`));
        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ id: adapter, label: adapter }]);
        const refreshed = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/company-1/adapters/paperclip_runner/models?provider=${provider}&refresh=true`));
        expect(refreshed.status).toBe(200);
        expect(refreshed.body).toEqual([{ id: `${adapter}-fresh`, label: adapter }]);
      }
      const invalid = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/adapters/paperclip_runner/models?provider=acpx_codex"));
      expect(invalid.status).toBe(422);
    } finally { list.mockRestore(); refresh.mockRestore(); }
  });

  it("loads setup-only Antigravity account metadata without consulting another harness", async () => {
    const adapters = await import("../adapters/index.js");
    const list = vi.spyOn(adapters, "listAdapterModels");
    const refresh = vi.spyOn(adapters, "refreshAdapterModels");
    const catalog = [{ id: "caller-exact-google-model", label: "Google account model" }];
    mockAntigravityModels.mockResolvedValue(catalog);
    try {
      const app = await createApp();
      for (const suffix of ["", "&refresh=true"]) {
        const response = await requestApp(app, base => request(base).get(`/api/companies/company-1/adapters/paperclip_runner/models?provider=acpx&acpxAgent=antigravity${suffix}`));
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body).toEqual(catalog);
        expect(mockAntigravityModels).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
          companyId: "company-1", binding: { provider: "google", method: "subscription", mode: "responsible_user" },
        }));
      }
      expect(list).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    } finally { list.mockRestore(); refresh.mockRestore(); }
  });

  it("refuses another provider binding before Antigravity model discovery", async () => {
    const app = await createApp();
    const binding = encodeURIComponent(JSON.stringify({ provider: "openai", method: "subscription", mode: "responsible_user" }));
    const response = await requestApp(app, base => request(base).get(`/api/companies/company-1/adapters/paperclip_runner/models?provider=acpx&acpxAgent=antigravity&aiConnection=${binding}`));
    expect(response.status).toBe(422);
    expect(response.body.error).toContain("Google runtime connection");
    expect(mockAntigravityModels).not.toHaveBeenCalled();
  });

  it("lists Antigravity models for both Gemini API keys and Google sign-in on a cloud environment once qualified", async () => {
    const environments = await import("../services/environments.js");
    const cloud = { id: "env-cloud", companyId: "company-1", driver: "daytona" };
    vi.spyOn(environments, "environmentService").mockReturnValue({ getById: vi.fn(async () => cloud),
      findManagedSandboxEnvironment: vi.fn(async () => null), listBoundCompanyIds: vi.fn(async () => []) } as never);
    const catalog = [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }];
    mockAntigravityModels.mockResolvedValue(catalog);
    const app = await createApp();
    const url = (method: string) => `/api/companies/company-1/adapters/paperclip_runner/models?provider=acpx&acpxAgent=antigravity&environmentId=env-cloud&aiConnection=${
      encodeURIComponent(JSON.stringify({ provider: "google", method, mode: "responsible_user" }))}`;
    const apiKey = await requestApp(app, base => request(base).get(url("api_key")));
    expect(apiKey.status, JSON.stringify(apiKey.body)).toBe(200);
    expect(apiKey.body).toEqual(catalog);
    expect(mockAntigravityModels).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      binding: { provider: "google", method: "api_key", mode: "responsible_user" } }));
    mockAntigravityModels.mockClear();
    const signIn = await requestApp(app, base => request(base).get(url("subscription")));
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
    expect(signIn.body).toEqual(catalog);
    expect(mockAntigravityModels).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      binding: { provider: "google", method: "subscription", mode: "responsible_user" } }));
  });

  it.each(["create", "hire", "edit"])("admits qualified Antigravity %s without an operator candidate grant", async action => {
    const app = await createApp();
    const adapterConfig = { provider: "acpx", acpxAgent: "antigravity", model: "exact-antigravity-model" };
    const response = action === "edit"
      ? await requestApp(app, base => request(base).patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ adapterType: "paperclip_runner", adapterConfig }))
      : await requestApp(app, base => request(base).post(`/api/companies/company-1/${action === "hire" ? "agent-hires" : "agents"}`).send({ name: "Antigravity", adapterType: "paperclip_runner", adapterConfig }));
    expect(response.status, JSON.stringify(response.body)).toBe(action === "edit" ? 200 : 201);
  });

  it("creates a qualified Google Antigravity agent without an operator candidate grant or experimental Runner flag", async () => {
    const { QUALIFIED_ACPX_PROFILES } = await import("../vendor/paperclip-runner/index.js");
    expect(QUALIFIED_ACPX_PROFILES.antigravity.agentProfileVersion).toBe(2);
    expect(QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus).toBeUndefined();
    const adapterConfig = { provider: "acpx", acpxAgent: "antigravity", model: "exact-antigravity-model" };
    vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
    const app = await createApp();
    const created = await requestApp(app, base => request(base).post("/api/companies/company-1/agents").send({ name: "Antigravity agent", adapterType: "paperclip_runner", adapterConfig }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ adapterConfig: expect.objectContaining(adapterConfig) }), expect.any(Object));
    expect(JSON.stringify(mockAgentService.create.mock.calls)).not.toContain("paperclip.acpx-candidate-admission");
    mockAgentService.create.mockClear();
    const missingModel = await requestApp(app, base => request(base).post("/api/companies/company-1/agents").send({ name: "Antigravity agent", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity" } }));
    expect(missingModel.status, JSON.stringify(missingModel.body)).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("creates agents for dynamically registered external adapter types", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["some_other_adapter"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "External Agent",
          adapterType: "external_test",
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("external_test");
  });

  it("does not inject CODEX_HOME or OPENAI_API_KEY when creating a keyless codex_local agent", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Codex Agent",
          adapterType: "codex_local",
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = (adapterConfig.env as Record<string, unknown> | undefined) ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("does not re-inject CODEX_HOME or OPENAI_API_KEY when updating a keyless codex_local agent", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterConfig: { model: "gpt-5.4" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const env = (adapterConfig.env as Record<string, unknown> | undefined) ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("forwards a claude_local→process adapter move that drops the OAuth binding to the service unchanged", async () => {
    // The agent has the fixed Claude Code OAuth binding on the claude_local
    // adapter. A PATCH moves the agent to the process adapter and sends an empty
    // env in the same request. The route must forward the new adapter type and
    // the dropped binding to the service without a re-injection, so the
    // service-enforced binding invariant sees the removal and rejects it.
    const agentId = "11111111-1111-4111-8111-111111111111";
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId: "company-1",
      name: "Claude",
      urlKey: "claude",
      role: "engineer",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } } },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterType: "process",
          adapterConfig: { env: {} },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    // The route forwards the requested adapter type, so the service can see the
    // adapter move.
    expect(patch.adapterType).toBe("process");
    // The route does not re-inject the fixed binding from the prior config, so
    // the service invariant sees the removal.
    const env = ((patch.adapterConfig as Record<string, unknown>).env as Record<string, unknown> | undefined) ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("isolates CODEX_HOME when updating a codex_local agent to set its own OPENAI_API_KEY", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: {
            env: {
              OPENAI_API_KEY: "sk-test-key",
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBe("sk-test-key");
    expect(String(env.CODEX_HOME)).toContain(`/companies/company-1/agents/${agentId}/codex-home`);
  });

  it("allows codex_local agents to share the host Codex home", async () => {
    const app = await createApp();
    const sharedHome = path.join(os.homedir(), ".codex");
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Shared Codex",
          adapterType: "codex_local",
          adapterConfig: {
            env: {
              CODEX_HOME: sharedHome,
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.CODEX_HOME).toBe(sharedHome);
  });

  it("isolates CODEX_HOME when a codex_local agent sets its own OPENAI_API_KEY", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Keyed Codex",
          adapterType: "codex_local",
          adapterConfig: {
            env: {
              OPENAI_API_KEY: "sk-test-key",
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const agentId = String(createInput.id);
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBe("sk-test-key");
    expect(String(env.CODEX_HOME)).toContain(`/companies/company-1/agents/${agentId}/codex-home`);
  });

  it("restores a saved agent's redacted CODEX_HOME before testing its adapter", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const storedHome = "/paperclip/companies/company-1/agents/agent-1/codex-home";
    mockAgentService.getById.mockResolvedValue({
      ...(await mockAgentService.getById()),
      id: agentId,
      adapterType: "external_test",
      adapterConfig: { env: { CODEX_HOME: storedHome } },
    });
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          agentId,
          adapterConfig: { env: { CODEX_HOME: { type: "plain", value: "***REDACTED***" } } },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith(
      "company-1",
      { env: { CODEX_HOME: storedHome } },
      expect.objectContaining({ adapterType: "external_test" }),
    );
  });

  it("rejects redacted-value restoration from an incompatible saved agent", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/adapters/external_test/test-environment")
        .send({
          agentId: "11111111-1111-4111-8111-111111111111",
          adapterConfig: { env: { CODEX_HOME: { type: "plain", value: "***REDACTED***" } } },
        }),
    );

    expect(res.status).toBe(422);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
  });

  it("rejects unknown adapter types even when schema accepts arbitrary strings", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Missing Adapter",
          adapterType: missingAdapterType,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(`Unknown adapter type: ${missingAdapterType}`);
  });

  it("refuses to create an agent on an adapter the instance has disabled", async () => {
    // A disabled adapter is one the instance cannot run (e.g. curated out of
    // PAPERCLIP_ADAPTERS). Creating an agent on it "succeeds" and then every
    // run of that agent dies at lease time with "not in the configured adapter
    // registry", so the refusal belongs here, where it can name the choices.
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["external_test"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Disabled Harness", adapterType: "external_test" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain('Adapter "external_test" is not available on this instance');
    // The message must be actionable: it names what CAN be chosen.
    expect(message).toMatch(/Available adapters?: .+/);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("refuses to switch an existing agent onto a disabled adapter", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["external_test"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "external_test" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(
      'Adapter "external_test" is not available on this instance',
    );
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("still lets an agent already on a disabled adapter be edited", async () => {
    // Disabling an adapter must not make the agents that already use it
    // uneditable — only NEW selections of it are refused.
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["codex_local"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it.each(["pass", "fail"] as const)("tests saved legacy Codex on a disabled adapter and retains its %s runtime verdict", async (status) => {
    const adapterConfig = { model: "gpt-5.4", extraArgs: ["--legacy-setting"], env: { CODEX_HOME: "/saved-codex-home" } };
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterConfig });
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["codex_local"]);
    const probe = vi.fn(async () => ({ adapterType: "codex_local", status, testedAt: new Date(0).toISOString(),
      checks: status === "fail" ? [{ code: "adapter_auth_missing", level: "error" as const, message: "Sign in to the saved Codex account." }] : [] }));
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({ ...externalAdapter, type: "codex_local", testEnvironment: probe });
    try {
      const app = await createApp();
      const res = await requestApp(app, baseUrl => request(baseUrl)
        .post("/api/companies/company-1/adapters/codex_local/test-environment")
        .send({ agentId: "11111111-1111-4111-8111-111111111111", adapterConfig: {
          ...adapterConfig, env: { CODEX_HOME: { type: "plain", value: "***REDACTED***" } },
        } }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ adapterType: "codex_local", status });
      expect(probe).toHaveBeenCalledOnce();
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({ adapterType: "codex_local", config: adapterConfig }));
      expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith("company-1", adapterConfig, expect.objectContaining({ adapterType: "codex_local" }));
      expect(mockAgentService.create).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    } finally { await unregisterTestAdapter("codex_local"); }
  });

  it.each(["draft", "explicit legacy", "explicit auto", "explicit native", "changed harness"] as const)("rejects a disabled Codex setup selection for %s", async (mode) => {
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["codex_local"]);
    if (mode === "changed harness") mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "external_test" });
    const probe = vi.fn();
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({ ...externalAdapter, type: "codex_local", testEnvironment: probe });
    try {
      const runner = mode === "explicit legacy" ? "legacy" : mode === "explicit auto" ? "auto" : mode === "explicit native" ? "paperclip" : undefined;
      const app = await createApp();
      const res = await requestApp(app, baseUrl => request(baseUrl)
        .post("/api/companies/company-1/adapters/codex_local/test-environment")
        .send({ adapterConfig: {}, ...(mode === "draft" ? {} : { agentId: "11111111-1111-4111-8111-111111111111" }), ...(runner ? { runner } : {}) }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({ code: "agent_runner_unavailable" });
      expect(probe).not.toHaveBeenCalled();
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
    } finally { await unregisterTestAdapter("codex_local"); }
  });

  it("still rejects new Codex creation when its adapter is disabled", async () => {
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["codex_local"]);
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl)
      .post("/api/companies/company-1/agents").send({ name: "New Codex", adapterType: "codex_local" }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "agent_runner_unavailable" });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rechecks selection policy when a saved native adapter switches to an experimentally gated harness", async () => {
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false });
    const probe = vi.fn();
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({ ...externalAdapter, type: "paperclip_runner", testEnvironment: probe });
    try {
      const app = await createApp();
      const res = await requestApp(app, baseUrl => request(baseUrl)
        .post("/api/companies/company-1/adapters/paperclip_runner/test-environment")
        .send({ agentId: "11111111-1111-4111-8111-111111111111", adapterConfig: { provider: "acpx", acpxAgent: "cursor" } }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.details).toMatchObject({ code: "paperclip_runner_rollout_disabled" });
      expect(probe).not.toHaveBeenCalled();
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
    } finally { await unregisterTestAdapter("paperclip_runner"); }
  });

  it("defaults new Codex on a qualified Linux target while the experimental flag is off", async () => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "linux", architecture: "x64" } }));
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: true });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Native Codex", adapterType: "codex_local" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    expect(mockAgentService.create.mock.calls.at(-1)?.[2]).toMatchObject({ runnerResolved: true });
  });

  it("retains explicit legacy Codex and rejects incompatible automatic settings before persistence", async () => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "linux", architecture: "x64" } }));
    const app = await createApp();
    const legacy = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents").send({ name: "Legacy", adapterType: "codex_local", runner: "legacy", adapterConfig: { extraArgs: ["--search"] } }));
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "codex_local", adapterConfig: { extraArgs: ["--search"] } });
    mockAgentService.create.mockClear();
    const incompatible = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents").send({ name: "Custom", adapterType: "codex_local", adapterConfig: { extraArgs: ["--search"] } }));
    expect(incompatible.status).toBe(422);
    expect(incompatible.body.details).toMatchObject({ code: "agent_runner_config_incompatible", fields: ["extraArgs"] });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each(["auto", "legacy"] as const)("creates OpenCode through the public route with %s selection and the experimental flag off", async runner => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    const app = await createApp();
    const model = "openrouter/anthropic/claude-sonnet-4.6";
    const response = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents").send({ name: "OpenCode", adapterType: "opencode_local", runner, adapterConfig: { model } }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: runner === "legacy" ? "opencode_local" : "paperclip_runner", adapterConfig: runner === "legacy" ? { model } : { provider: "opencode", model, opencodePermissionMode: "allow" } });
  });

  it("allows model-free OpenCode only as an inactive setup draft", async () => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    const originalCreate = mockAgentService.create.getMockImplementation()!;
    mockAgentService.create.mockImplementation(async (...args) => ({ ...await originalCreate(...args), lifecycleHolds: ["setup"] }));
    const app = await createApp();
    const input = { name: "OpenCode draft", adapterType: "opencode_local", adapterConfig: {} };
    const draft = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents")
      .send({ ...input, setupId: "00000000-0000-4000-8000-000000000092" }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "" } });
    expect(mockAgentService.create.mock.calls.at(-1)?.[2]).toMatchObject({ setupOnly: true, runnerResolved: true });
    mockAgentService.create.mockClear();
    const active = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents")
      .send({ ...input, setupOnly: true }));
    expect(active.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("selects the native Cursor API controller from the ordinary held Cloud setup card without a Computer", async () => {
    const settings = { defaultEnvironmentId: null, experimental: { enableManagedSandboxOnly: true, enableNativeRunner: true } };
    mockInstanceSettingsService.get.mockResolvedValue(settings);
    mockInstanceSettingsService.getExperimental.mockResolvedValue(settings.experimental);
    const environments = await import("../services/environments.js");
    const findManaged = vi.fn(async () => null);
    const getEnvironment = vi.fn(async () => null);
    vi.spyOn(environments, "environmentService").mockReturnValue({ findManagedSandboxEnvironment: findManaged,
      getById: getEnvironment, listBoundCompanyIds: vi.fn(async () => []) } as never);
    const existing = { ...(await mockAgentService.getById()), adapterType: "process", adapterConfig: {},
      status: "paused", lifecycleState: "paused", pauseReason: "setup", lifecycleHolds: ["setup"] };
    mockAgentService.getById.mockResolvedValue(existing);
    const app = await createApp();
    const response = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      name: "Cursor setup", adapterType: "cursor_cloud", runner: "auto", adapterConfig: {}, metadata: { setupAdapterPending: false },
    }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ lifecycleState: "paused", pauseReason: "setup", lifecycleHolds: ["setup"] });
    expect(mockAgentService.update).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      adapterType: "paperclip_runner", defaultEnvironmentId: null,
      adapterConfig: expect.objectContaining({ provider: "cursor_cloud", lifecycleMode: "per_turn" }),
    }), expect.anything());
    expect(findManaged).not.toHaveBeenCalled();
    expect(getEnvironment).not.toHaveBeenCalled();
    mockAgentService.update.mockClear();
    mockAgentService.getById.mockResolvedValue({ ...existing, status: "idle", lifecycleState: "ready", pauseReason: null, lifecycleHolds: [] });
    const active = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      adapterType: "cursor_cloud", runner: "auto", adapterConfig: {}, setupOnly: true,
    }));
    expect(active.status).toBe(422);
    expect(active.body.details?.code).toBe("managed_sandbox_unavailable");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    const incompleteActive = await requestApp(app, base => request(base).patch(`/api/agents/${existing.id}`).send({
      adapterType: "paperclip_runner", runner: "paperclip", adapterConfig: { provider: "cursor_cloud" }, setupOnly: true,
    }));
    expect(incompleteActive.status).toBe(422);
    expect(incompleteActive.body.details?.code).toBe("paperclip_runner_cursor_cloud_model_required");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it.each(["auto", "legacy"] as const)("creates Pi through the public route with %s selection and the experimental flag off", async runner => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    const app = await createApp();
    const model = "openrouter/anthropic/claude-sonnet-4.6";
    const response = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents").send({ name: "Pi", adapterType: "pi_local", runner, adapterConfig: { model } }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: runner === "legacy" ? "pi_local" : "paperclip_runner", adapterConfig: runner === "legacy" ? { model } : { provider: "acpx", acpxAgent: "pi", model, piThinkingLevel: "low", acpxPermissionMode: "approve-all" } });
  });

  it("allows model-free Pi only as an inactive setup draft", async () => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    const originalCreate = mockAgentService.create.getMockImplementation()!;
    mockAgentService.create.mockImplementation(async (...args) => ({ ...await originalCreate(...args), lifecycleHolds: ["setup"] }));
    const app = await createApp();
    const input = { name: "Pi draft", adapterType: "pi_local", adapterConfig: {} };
    const draft = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents")
      .send({ ...input, setupId: "00000000-0000-4000-8000-000000000092" }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "" } });
    expect(mockAgentService.create.mock.calls.at(-1)?.[2]).toMatchObject({ setupOnly: true, runnerResolved: true });
    mockAgentService.create.mockClear();
    const active = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents")
      .send({ ...input, setupOnly: true }));
    expect(active.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("keeps Pi model selection empty when a provisional setup record changes harness", async () => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "process", adapterConfig: {}, status: "paused", lifecycleState: "paused", pauseReason: "setup", lifecycleHolds: ["setup"] });
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterType: "pi_local", runner: "auto", adapterConfig: {} }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "" } });
  });

  it("keeps Kimi draft models unset through the public create route", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const originalCreate = mockAgentService.create.getMockImplementation()!;
    mockAgentService.create.mockImplementation(async (...args) => ({ ...await originalCreate(...args), lifecycleHolds: ["setup"] }));
    const app = await createApp();
    const input = { name: "Kimi draft", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "kimi" } };
    const draft = await requestApp(app, base => request(base).post("/api/companies/company-1/agents")
      .send({ ...input, setupId: "00000000-0000-4000-8000-000000000092" }));
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const saved = mockAgentService.create.mock.calls.at(-1)?.[1];
    expect(saved).toMatchObject(input);
    expect(saved.adapterConfig.model).toBeUndefined();
    expect(mockAgentService.create.mock.calls.at(-1)?.[2]).toMatchObject({ setupOnly: true, runnerResolved: true });
    mockAgentService.create.mockClear();
    const active = await requestApp(app, base => request(base).post("/api/companies/company-1/agents").send(input));
    expect(active.status).toBe(422);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each([
    ["process", undefined, ""],
    ["kimi_local", "kimi-for-coding", "kimi-for-coding"],
    ["pi_local", "openrouter/anthropic/claude-sonnet-4.6", ""],
  ] as const)("preserves Kimi model selection only from the same harness: %s", async (previousAdapterType, previousModel, expectedModel) => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: previousAdapterType,
      adapterConfig: previousModel === undefined ? {} : { model: previousModel },
      status: "paused", lifecycleState: "paused", pauseReason: "setup", lifecycleHolds: ["setup"] });
    const app = await createApp();
    const response = await requestApp(app, base => request(base).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "kimi" } }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "kimi", model: expectedModel } });
  });

  it("persists an explicit Kimi model through the public create route", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();
    const input = { name: "Kimi", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "kimi", model: "kimi-for-coding" } };
    const response = await requestApp(app, base => request(base).post("/api/companies/company-1/agents").send(input));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(mockAgentService.create.mock.calls.at(-1)?.[1]).toMatchObject(input);
  });

  it.each([{ thinking: "high", status: 200 }, { thinking: "medium", status: 422 }, { command: "custom-pi", status: 422 }])("validates saved Pi settings during direct adapter conversion: %j", async ({ status, ...settings }) => {
    const selection = await import("../services/agent-runner-selection.js");
    vi.spyOn(selection, "resolveNewAgentRunnerForCompany").mockImplementation(async (_db, _companyId, input) =>
      selection.resolveNewAgentRunner({ ...input, target: { driver: "local", platform: "darwin", architecture: "arm64" } }));
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "pi_local", adapterConfig: { model: "openrouter/anthropic/claude-sonnet-4.5", ...settings } });
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterType: "paperclip_runner", adapterConfig: {} }));
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    if (status === 200) expect(mockAgentService.update.mock.calls.at(-1)?.[1]).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { acpxAgent: "pi", model: "openrouter/anthropic/claude-sonnet-4.5", piThinkingLevel: "high" } });
    else expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("keeps other native provider selection behind its existing flag", async () => {
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).post("/api/companies/company-1/agents").send({ name: "Native Cursor", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "cursor", model: "provider-model" } }));
    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ code: "paperclip_runner_rollout_disabled" });
  });
});

vi.mock("../services/agent-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-lifecycle.js")>();
  return { ...actual, createAgentLifecycle: () => ({
    requestHire: (...args: unknown[]) => mockAgentService.create(...args),
  }) };
});
