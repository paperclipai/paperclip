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

describe("agent routes adapter validation: runner rollout and upgrades", () => {
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

  it("allows a new paperclip_runner selection while the rollout flag is on", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native Codex",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "codex",
            paperclipSkillSync: {
              desiredSkills: ["paperclipai/paperclip/paperclip", "company-1/reviewer"],
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          provider: "codex",
          model: "gpt-6.1-sol",
          codexPermissionMode: "never",
          // No stored lifecycle: the product default applies.
          paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] },
        }),
      }),
      expect.any(Object),
    );
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "paperclip_runner" }),
      expect.any(Object),
      expect.objectContaining({ entryFile: "AGENTS.md", replaceExisting: false }),
    );
  });

  it("saves and reopens native Cursor API setup under managed-only policy without a Computer", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableManagedSandboxOnly: true });
    let existing = { ...(await mockAgentService.getById()), adapterType: "cursor_cloud", adapterConfig: {}, defaultEnvironmentId: "33333333-3333-4333-8333-333333333333",
      status: "paused", lifecycleState: "paused", pauseReason: "setup", lifecycleHolds: ["setup"] };
    mockAgentService.getById.mockImplementation(async () => existing);
    mockAgentService.update.mockImplementation(async (_id, patch) => { existing = { ...existing, ...patch }; return existing; });
    const config = { model: "caller-model", repoUrl: "https://github.com/acme/repo", repoStartingRef: "feature",
      env: { CURSOR_API_KEY: { type: "secret_ref", secretId: "22222222-2222-4222-8222-222222222222", version: "latest" } } };
    const app = await createApp();
    const saved = await requestApp(app, baseUrl => request(baseUrl).patch(`/api/agents/${existing.id}`)
      .send({ adapterType: "cursor_cloud", runner: "paperclip", adapterConfig: config }));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: {
      provider: "cursor_cloud", model: config.model, repoUrl: config.repoUrl, repoRef: "feature", env: config.env, lifecycleMode: "per_turn",
    } });
    expect(saved.body.adapterConfig).not.toHaveProperty("codexPermissionMode");
    expect(saved.body.defaultEnvironmentId).toBeNull();
    const reopened = await requestApp(app, baseUrl => request(baseUrl).get(`/api/agents/${existing.id}/configuration`));
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.adapterConfig).toEqual(saved.body.adapterConfig);
    const resaved = await requestApp(app, baseUrl => request(baseUrl).patch(`/api/agents/${existing.id}`)
      .send({ adapterType: "paperclip_runner", runner: "paperclip", adapterConfig: reopened.body.adapterConfig }));
    expect(resaved.status, JSON.stringify(resaved.body)).toBe(200);
    const { resolvePaperclipRunnerNativeProviderInput } = await import("../services/native-runtime/provider-profile.js");
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "cursor_cloud_api", adapterConfig: resaved.body.adapterConfig }))
      .toMatchObject({ provider: "cursor_cloud", model: config.model, cursorCloud: { repos: [{ url: config.repoUrl, startingRef: "feature" }] } });
  });

  it.each(["dotAttachmentAccess", "dotWorkspaceAccess", "dotBindingId", "homeMode"])("refuses an agent granting itself the operator-owned setting %s", async key => {
    const app = await createApp({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId: "company-1", source: "agent_jwt" });
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ adapterConfig: { [key]: key === "homeMode" ? "preconfigured" : key === "dotBindingId" ? "another-binding" : true } }));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
  it.each(["create", "hire"])("refuses agent-authenticated homeMode on %s even with agent-management permission", async mode => {
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), permissions: { canCreateAgents: true } });
    const app = await createApp({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId: "company-1", source: "agent_jwt" });
    const response = await requestApp(app, baseUrl => request(baseUrl).post(mode === "create" ? "/api/companies/company-1/agents" : "/api/companies/company-1/agent-hires")
      .send({ name: "Runner", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { homeMode: "preconfigured" } }));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("Only an operator can configure Runner homeMode");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
  it.each(["replace", "adapter change", "rollback"])("refuses agent removal of operator homeMode through %s", async mode => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol", homeMode: "preconfigured" }, permissions: { canCreateAgents: true } });
    mockAgentService.getConfigRevision.mockResolvedValue({ afterConfig: {
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-6.1-sol" },
    } });
    const app = await createApp({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId: "company-1", source: "agent_jwt" });
    const response = await requestApp(app, baseUrl => mode === "rollback"
      ? request(baseUrl).post("/api/agents/11111111-1111-4111-8111-111111111111/config-revisions/33333333-3333-4333-8333-333333333333/rollback").send({})
      : request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111").send(mode === "replace"
        ? { replaceAdapterConfig: true, adapterConfig: { provider: "codex", model: "gpt-6.1-sol" } }
        : { adapterType: "claude_local" }));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("Only an operator can configure Runner homeMode");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });
  it.each(["agent", "board"] as const)("allows %s ordinary config updates while keeping homeMode operator-owned", async actor => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "gpt-6.1-sol", homeMode: "preconfigured" }, permissions: { canCreateAgents: true } });
    const app = actor === "agent"
      ? await createApp({ type: "agent", agentId: "11111111-1111-4111-8111-111111111111", companyId: "company-1", source: "agent_jwt" })
      : await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterConfig: { provider: "codex", model: "gpt-6.1-sol" }, replaceAdapterConfig: actor === "board" }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = mockAgentService.update.mock.calls.at(-1)?.[1].adapterConfig;
    expect(saved.homeMode).toBe(actor === "agent" ? "preconfigured" : undefined);
  });
  it("allows an operator to configure Runner homeMode", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-6.1-sol" } });
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterConfig: { homeMode: "preconfigured" } }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ adapterConfig: expect.objectContaining({ homeMode: "preconfigured" }) }), expect.anything());
  });
  it("allows an operator to configure Dot attachment access separately", async () => {
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ adapterConfig: { dotAttachmentAccess: true, dotWorkspaceAccess: false } }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ adapterConfig: expect.objectContaining({ dotAttachmentAccess: true, dotWorkspaceAccess: false }) }), expect.anything());
  });

  it.each(["create", "hire", "convert"])("saves an unpaired Dot configuration independently of the Runner rollout for %s while refusing task admission", async mode => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: true });
    const app = await createApp();
    const config = { provider: "openai_dot", lifecycleMode: "per_turn", allowUnmeteredProvider: true };
    const response = await requestApp(app, baseUrl => mode === "create"
      ? request(baseUrl).post("/api/companies/company-1/agents").send({ name: "Dot", adapterType: "paperclip_runner", adapterConfig: config })
      : mode === "hire" ? request(baseUrl).post("/api/companies/company-1/agent-hires").send({ name: "Dot", role: "engineer", adapterType: "paperclip_runner", adapterConfig: config })
      : request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ adapterType: "paperclip_runner", replaceAdapterConfig: true, adapterConfig: config }));
    expect(response.status, JSON.stringify(response.body)).toBe(mode === "convert" ? 200 : 201);
    const saved = mode === "hire" ? response.body.agent : response.body;
    expect(saved.adapterConfig).toMatchObject(config);
    expect(saved.adapterConfig.model).toBeUndefined();
    expect(saved.adapterConfig.codexPermissionMode).toBeUndefined();
    const { resolvePaperclipRunnerProviderProfile } = await import("../services/native-runtime/provider-profile.js");
    expect(() => resolvePaperclipRunnerProviderProfile(saved.adapterConfig)).toThrow(expect.objectContaining({ code: "paperclip_runner_dot_config_invalid" }));
  });

  it.each(["create", "hire", "convert"])("rejects a new Dot selection when only the general Runner rollout is enabled for %s", async mode => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableOpenAiDot: false });
    const app = await createApp();
    const body = { name: "Dot", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot", allowUnmeteredProvider: true } };
    const response = await requestApp(app, baseUrl => mode === "convert"
      ? request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111").send(body)
      : request(baseUrl).post(`/api/companies/company-1/${mode === "hire" ? "agent-hires" : "agents"}`).send(body));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({ code: "paperclip_runner_dot_disabled" });
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("allows an explicit Dot to Codex change without enabling other native providers", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false, enableOpenAiDot: true });
    mockAgentService.getById.mockResolvedValue({ ...(await mockAgentService.getById()), adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot", allowUnmeteredProvider: true } });
    const app = await createApp();
    const response = await requestApp(app, baseUrl => request(baseUrl).patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterConfig: { provider: "codex" }, replaceAdapterConfig: true }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).toMatchObject({ adapterConfig: { provider: "codex" } });
  });

  it.each([{ maxTurns: 5 }, { disableWebSearch: "invalid" }])("rejects a direct Grok conversion with incompatible saved settings %j", async unsupported => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterType: "grok_local",
      adapterConfig: { model: "grok-4.7", reasoningEffort: "high", ...unsupported } });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl).patch(`/api/agents/${existing.id}`)
      .send({ adapterType: "paperclip_runner" }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("translates compatible settings during a direct Grok conversion", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterType: "grok_local",
      adapterConfig: { model: "grok-4.7", reasoningEffort: "high", command: "grok", disableWebSearch: true } });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl).patch(`/api/agents/${existing.id}`)
      .send({ adapterType: "paperclip_runner" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = mockAgentService.update.mock.calls.at(-1)?.[1];
    expect(saved).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-4.7", reasoningEffort: "high", disableWebSearch: true } });
    expect(saved.adapterConfig).not.toHaveProperty("command");
  });

  it.each([undefined, "acpx"])("preserves an explicitly selected ACPX agent when converting Grok (provider: %s)", async provider => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterType: "grok_local", adapterConfig: { model: "grok-4.7" } });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl).patch(`/api/agents/${existing.id}`)
      .send({ adapterType: "paperclip_runner", replaceAdapterConfig: true,
        adapterConfig: { ...(provider ? { provider } : {}), acpxAgent: "claude", model: "claude-opus-5-5" } }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).toMatchObject({
      adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5" },
    });
  });

  it.each(["codex_local", "claude_local"])("upgrades an existing %s through runner selection with its saved settings", async adapterType => {
    const existing = await mockAgentService.getById();
    const env = { MIGRATION_MARKER: { type: "plain", value: "keep" } };
    const model = adapterType === "claude_local" ? "claude-sonnet-4-6" : "gpt-5.4";
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterType,
      adapterConfig: { model, effort: "medium", env, promptTemplate: "Keep these instructions", timeoutSec: 180 },
    });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ runner: "paperclip" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      adapterType: "paperclip_runner",
      adapterConfig: expect.objectContaining({ model, modelReasoningEffort: "medium", env,
        promptTemplate: "Keep these instructions", timeoutSec: 180,
        ...(adapterType === "claude_local" ? { provider: "acpx", acpxAgent: "claude" } : { provider: "codex" }),
      }),
    }), expect.objectContaining({ recordRevision: expect.objectContaining({ source: "patch" }) }));
    const patch = mockAgentService.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty("runner");
    expect(patch.adapterConfig).not.toHaveProperty("effort");
    expect(patch).not.toHaveProperty("runtimeConfig");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.updated", entityId: existing.id }));
  });

  it("leaves a legacy agent unchanged when upgrade settings are incompatible", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterConfig: { model: "gpt-5.4", extraArgs: ["--search"] } });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111").send({ runner: "paperclip" }));
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "agent_runner_config_incompatible", fields: ["extraArgs"] });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("upgrades a legacy Claude agent with a turn limit, warning instead of rejecting it", async () => {
    const existing = await mockAgentService.getById();
    const env = { ANTHROPIC_API_KEY: { type: "plain", value: "synthetic-fixture" } };
    mockAgentService.getById.mockResolvedValue({ ...existing, adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5-5", effort: "high", maxTurnsPerRun: 1000,
        dangerouslySkipPermissions: true, timeoutSec: 0, graceSec: 15, env } });
    const app = await createApp();
    const res = await requestApp(app, baseUrl => request(baseUrl)
      .patch(`/api/agents/${existing.id}`).send({ runner: "paperclip" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls[0][1];
    expect(patch.adapterType).toBe("paperclip_runner");
    expect(patch.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude-opus-5-5",
      modelReasoningEffort: "high", acpxPermissionMode: "approve-all", timeoutSec: 0, graceSec: 15, env });
    expect(patch.adapterConfig).not.toHaveProperty("maxTurnsPerRun");
    expect(res.body.configurationWarnings).toEqual([expect.objectContaining({ field: "maxTurnsPerRun", code: "runner_option_ignored" })]);
  });

  it("normalizes legacy skills and permissions when switching to paperclip_runner", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.5",
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip", "company-1/reviewer"],
        },
      },
    });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "paperclip_runner", replaceAdapterConfig: true, adapterConfig: {} }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "paperclip_runner",
        adapterConfig: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
          codexPermissionMode: "never",
          // No stored lifecycle: the product default applies.
          paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("uses the Codex default when a codex_local conversion has no model", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterType: "paperclip_runner",
          replaceAdapterConfig: true,
          adapterConfig: { model: "" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ model: "gpt-6.1-sol" }),
      }),
      expect.any(Object),
    );
  });

  it("converts Claude to ACPX Claude while retaining its model", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6" },
    });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterType: "paperclip_runner",
          replaceAdapterConfig: true,
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-4-6" });
  });

  it("accepts qualified local and managed providers on fresh runner agents and hires", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();
    const createResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native OpenCode",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "opencode",
            model: "openrouter/deepseek/deepseek-v4-flash-0731",
          },
        }),
    );
    const hireResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Native ACPX",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "acpx",
            acpxAgent: "claude",
            model: "claude-sonnet-5",
          },
        }),
    );
    const managedResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native Claude Managed",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "claude_managed",
            managedProfileId: "managed-primary",
            managedAgentsRetentionAcknowledged: true,
          },
        }),
    );
    const agentCoreResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Native AgentCore",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "aws_agentcore",
            agentCoreProfileId: "agentcore-primary",
            agentCoreRetentionAcknowledged: true,
          },
        }),
    );

    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    expect(hireResponse.status, JSON.stringify(hireResponse.body)).toBe(201);
    expect(managedResponse.status, JSON.stringify(managedResponse.body)).toBe(201);
    expect(agentCoreResponse.status, JSON.stringify(agentCoreResponse.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledTimes(4);
    expect(mockManagedAgentProfileService.requireQualified).toHaveBeenCalledWith(
      "company-1",
      "managed-primary",
    );
    expect(mockRemoteAgentProfileService.requireQualified).toHaveBeenCalledWith(
      "company-1",
      "agentcore-primary",
      "aws_bedrock_agentcore_harness",
    );
  });

  it.each([
    [
      "nonexistent Claude profile",
      "managed" as const,
      {
        provider: "claude_managed",
        managedProfileId: "managed-missing",
        managedAgentsRetentionAcknowledged: true,
      },
      "not_found" as const,
      404,
    ],
    [
      "disabled Claude profile",
      "managed" as const,
      {
        provider: "claude_managed",
        managedProfileId: "managed-disabled",
        managedAgentsRetentionAcknowledged: true,
      },
      "disabled" as const,
      409,
    ],
    [
      "drifted AgentCore profile",
      "remote" as const,
      {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-drifted",
        agentCoreRetentionAcknowledged: true,
      },
      "drifted" as const,
      409,
    ],
    [
      "cross-company AgentCore profile",
      "remote" as const,
      {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-other-company",
        agentCoreRetentionAcknowledged: true,
      },
      "not_found" as const,
      404,
    ],
  ])(
    "rejects a managed-provider selection with a %s",
    async (_label, service, adapterConfig, failure, expectedStatus) => {
      mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
      const app = await createApp();
      const { conflict, notFound } = await import("../errors.js");
      const error = failure === "not_found"
        ? notFound("Managed provider profile not found")
        : conflict(
            failure === "disabled"
              ? "Managed provider profile is not enabled and qualified"
              : "Managed provider profile configuration does not match its qualified revision",
          );
      const profileService = service === "managed"
        ? mockManagedAgentProfileService
        : mockRemoteAgentProfileService;
      profileService.requireQualified.mockRejectedValueOnce(error);

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/companies/company-1/agents")
          .send({
            name: "Invalid Managed Selection",
            adapterType: "paperclip_runner",
            adapterConfig,
          }),
      );

      expect(response.status, JSON.stringify(response.body)).toBe(expectedStatus);
      expect(profileService.requireQualified).toHaveBeenCalledWith(
        "company-1",
        service === "managed"
          ? adapterConfig.managedProfileId
          : adapterConfig.agentCoreProfileId,
        ...(service === "remote" ? ["aws_bedrock_agentcore_harness"] : []),
      );
      expect(mockAgentService.create).not.toHaveBeenCalled();
    },
  );

  it("defaults ACPX provider changes to Claude and preserves ordinary historical edits", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "historical" },
    });
    const app = await createApp();
    const ordinaryEdit = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ name: "Historical Runner" }),
    );
    const providerChange = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { provider: "acpx" } }),
    );

    expect(ordinaryEdit.status, JSON.stringify(ordinaryEdit.body)).toBe(200);
    expect(providerChange.status, JSON.stringify(providerChange.body)).toBe(200);
    expect(providerChange.body.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "claude", model: "historical" });
  });

  it.each([
    [
      "cleared managed profile",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { managedProfileId: "" },
      "paperclip_runner_claude_managed_profile_required",
    ],
    [
      "withdrawn managed retention",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { managedAgentsRetentionAcknowledged: false },
      "paperclip_runner_claude_managed_retention_required",
    ],
    [
      "unqualified managed model",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { model: "claude-opus-5" },
      "paperclip_runner_claude_managed_model_unqualified",
    ],
    [
      "invalid managed spend cap",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { maxSessionListCostUsd: 0 },
      "paperclip_runner_claude_managed_spend_cap_invalid",
    ],
    [
      "invalid Codex permission",
      { provider: "codex", codexPermissionMode: "never" },
      { codexPermissionMode: "unrestricted" },
      "paperclip_runner_codex_permission_mode_unqualified",
    ],
  ])(
    "rejects a same-provider Paperclip Runner edit with %s",
    async (_label, existingAdapterConfig, adapterConfigPatch, expectedCode) => {
      const existing = await mockAgentService.getById();
      mockAgentService.getById.mockResolvedValue({
        ...existing,
        adapterType: "paperclip_runner",
        adapterConfig: existingAdapterConfig,
      });
      const app = await createApp();
      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch("/api/agents/11111111-1111-4111-8111-111111111111")
          .send({ adapterConfig: adapterConfigPatch }),
      );

      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.details).toMatchObject({ code: expectedCode });
      expect(mockAgentService.update).not.toHaveBeenCalled();
    },
  );

  it("validates a merged same-provider runner config and preserves omitted fields", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 1,
      },
    });
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { maxSessionListCostUsd: 2 } }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledOnce();
    expect(mockAgentService.update.mock.calls[0]?.[1]).toMatchObject({
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 2,
      },
    });
  });

  it("rejects a same-provider rollback to an invalid runner config", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
    });
    mockAgentService.getConfigRevision.mockResolvedValue({
      afterConfig: {
        adapterType: "paperclip_runner",
        adapterConfig: {
          provider: "claude_managed",
          managedProfileId: "managed-primary",
          managedAgentsRetentionAcknowledged: false,
        },
        runtimeConfig: {},
      },
    });
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(
        "/api/agents/11111111-1111-4111-8111-111111111111/config-revisions/33333333-3333-4333-8333-333333333333/rollback",
      ),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "paperclip_runner_claude_managed_retention_required",
    });
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  it.each(["rejected", "warned"] as const)("checks a rollback's restored env and environment for protected keys (%s)", async outcome => {
    const existing = await mockAgentService.getById();
    const adapterConfig = { ...(existing.adapterConfig as Record<string, unknown>), env: { DESKTOP_SESSION: { type: "plain", value: "mine" } } };
    mockAgentService.getConfigRevision.mockResolvedValue({ afterConfig: {
      name: existing.name, role: existing.role, adapterType: existing.adapterType, adapterConfig,
      runtimeConfig: {}, defaultEnvironmentId: "computer-env", budgetMonthlyCents: existing.budgetMonthlyCents,
    } });
    mockAgentService.rollbackConfigRevision.mockResolvedValue({ ...existing, adapterConfig });
    const warning = { code: "protected_environment_variable", field: "adapterConfig.env.DESKTOP_SESSION", message: "notice" };
    if (outcome === "rejected") {
      const { unprocessable } = await import("../errors.js");
      mockCheckProtectedKeys.mockRejectedValue(unprocessable("protected", { code: "protected_environment_variable" }));
    } else mockCheckProtectedKeys.mockResolvedValue([warning]);
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/agents/11111111-1111-4111-8111-111111111111/config-revisions/33333333-3333-4333-8333-333333333333/rollback").send({}),
    );
    expect(mockCheckProtectedKeys).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ env: adapterConfig.env }), "computer-env");
    if (outcome === "rejected") {
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.details).toMatchObject({ code: "protected_environment_variable" });
      expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
    } else {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.configurationWarnings).toEqual([warning]);
    }
  });

  it("keeps an existing paperclip_runner agent editable after the flag is disabled", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ name: "Native Codex (recorded)" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledOnce();
  });
});

vi.mock("../services/agent-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-lifecycle.js")>();
  return { ...actual, createAgentLifecycle: () => ({
    requestHire: (...args: unknown[]) => mockAgentService.create(...args),
  }) };
});
