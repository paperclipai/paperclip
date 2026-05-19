import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintVersion } from "@paperclipai/shared";

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", async () => {
    const actual = await vi.importActual<typeof import("../services/index.js")>(
      "../services/index.js",
    );
    return {
      ...actual,
      approvalService: () => mockApprovalService,
      secretService: () => mockSecretService,
      agentService: () => mockAgentService,
      companySkillService: () => mockCompanySkillService,
      logActivity: mockLogActivity,
    };
  });
}

function fakeVersion(): BlueprintVersion {
  return {
    ref: "test-blueprint@1",
    key: "test-blueprint",
    version: "1",
    title: "Test Blueprint",
    category: "engineering",
    description: "Test blueprint for routing.",
    status: "published",
    systemPromptTemplate: "You are a test agent.",
    configSchema: {
      version: 1,
      fields: [
        { key: "displayName", label: "Display name", type: "string", required: false },
      ],
    },
    requiredSkillRefs: [],
    mcpBundleRefs: [],
    permissionPolicies: [],
    requiredSecretInputs: ["ANTHROPIC_API_KEY_INPUT"],
    requiredProviderKeys: ["ANTHROPIC_API_KEY"],
    runtimeDefaults: { adapter: "claude", modelProfile: "balanced" },
    budget: { maxRunsPerDay: 5, maxSpendCentsPerDay: 500 },
    validationContract: ["no live"],
    source: { kind: "custom", ref: "test-blueprint@1" },
  };
}

async function makeApp(opts: {
  enabled: boolean;
  providerKeys?: string[];
  actor?: Record<string, unknown>;
}) {
  const [{ errorHandler }, { blueprintRoutes }, { blueprintCatalogService }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/blueprints.js"),
    import("../services/blueprint-catalog.js"),
  ]);

  const catalog = blueprintCatalogService({} as any, {
    enabled: opts.enabled,
    versions: [fakeVersion()],
    providerKeyResolver: () => opts.providerKeys ?? [],
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = opts.actor ?? {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    };
    next();
  });
  app.use("/api", blueprintRoutes({} as any, { catalog }));
  app.use(errorHandler);
  return app;
}

describe("blueprint routes", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.create.mockReset();
    mockSecretService.list.mockReset();
    mockAgentService.create.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.list.mockResolvedValue([]);
    mockCompanySkillService.list.mockReset();
    mockCompanySkillService.list.mockResolvedValue([]);
    mockLogActivity.mockReset();
  });

  it("returns enabled:false and no versions when feature flag is off (default-off)", async () => {
    const app = await makeApp({ enabled: false });
    const res = await request(app).get("/api/companies/company-1/blueprints");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, versions: [] });
  });

  it("returns 404 on instantiate when feature flag is off", async () => {
    const app = await makeApp({ enabled: false });
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({ config: {}, secretBindings: [] });
    expect(res.status).toBe(404);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("lists published versions when the catalog is enabled", async () => {
    const app = await makeApp({ enabled: true });
    const res = await request(app).get("/api/companies/company-1/blueprints");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0]).toMatchObject({ ref: "test-blueprint@1", key: "test-blueprint" });
  });

  it("returns version detail with config schema", async () => {
    const app = await makeApp({ enabled: true });
    const res = await request(app).get("/api/companies/company-1/blueprints/test-blueprint@1");
    expect(res.status).toBe(200);
    expect(res.body.configSchema).toEqual({
      version: 1,
      fields: [{ key: "displayName", label: "Display name", type: "string", required: false }],
    });
    expect(res.body.systemPromptTemplate).toBe("You are a test agent.");
  });

  it("rejects instantiate when provider key is missing (fail-closed) and never creates an agent", async () => {
    const app = await makeApp({ enabled: true, providerKeys: [] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: {},
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe("blocked");
    const codes = res.body.errors.map((error: { code: string }) => error.code);
    expect(codes).toContain("missing_provider_key");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects raw secret values in bindings", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([]);
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: {},
        secretBindings: [
          {
            inputName: "ANTHROPIC_API_KEY_INPUT",
            secretRef: "sk-ant-this-is-a-raw-key-and-should-be-rejected-aaaa bbb",
          },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { code: string }) => error.code)).toContain(
      "raw_secret_value_forbidden",
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("creates an approval (and no agent) on a valid instantiate", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    mockApprovalService.create.mockImplementation(async (_companyId, data) => ({
      id: "approval-1",
      companyId: "company-1",
      type: data.type,
      status: data.status,
      payload: data.payload,
      requestedByUserId: data.requestedByUserId,
      requestedByAgentId: data.requestedByAgentId ?? null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: { displayName: "Test" },
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
        notes: "Spinning up a test instance",
      });

    expect(res.status).toBe(201);
    expect(res.body.preview.status).toBe("ready");
    expect(res.body.preview.requiresApproval).toBe(true);
    expect(res.body.preview.evidence.approvalOnly).toBe(true);
    expect(res.body.preview.evidence.liveExternalActions).toBe(false);
    expect(res.body.preview.evidence.secretBindings).toEqual([
      { inputName: "ANTHROPIC_API_KEY_INPUT", secretId: "secret-1" },
    ]);
    // The user-supplied secretRef alias must never appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain("ANTHROPIC_API_KEY_INPUT\":\"ANTHROPIC_API_KEY_INPUT");
    expect(res.body.approval.payload.surface).toBe("agent_os_blueprint");
    expect(res.body.approval.payload.approvalOnly).toBe(true);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    const persistedPayload = mockApprovalService.create.mock.calls[0]?.[1]?.payload;
    expect(JSON.stringify(persistedPayload)).not.toMatch(/"secretRef"\s*:/);
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "blueprint.instantiate_requested" }),
    );
  });

  it("rejects raw secret values placed in config (not just bindings) and creates no approval", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    const rawValue = "sk-ant-api03-this-is-a-raw-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: { displayName: rawValue },
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
      "raw_secret_value_forbidden",
    );
    expect(JSON.stringify(res.body)).not.toContain(rawValue);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects raw secret values placed in notes and creates no approval or echo", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    const rawNoteSecret = "sk-ant-api03-notes-leak-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: { displayName: "Reviewer" },
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
        notes: `please use ${rawNoteSecret} for prod`,
      });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
      "raw_secret_value_forbidden",
    );
    expect(JSON.stringify(res.body)).not.toContain(rawNoteSecret);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects credential-shaped substrings wrapped in punctuation/quotes in notes (no approval, no echo)", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    const rawNoteSecret = "sk-ant-api03-quoted-notes-leak-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wrappedForms = [
      `please use "${rawNoteSecret}" for prod`,
      `(${rawNoteSecret}) is the key`,
      `token="${rawNoteSecret}";`,
    ];
    for (const notes of wrappedForms) {
      mockApprovalService.create.mockClear();
      mockAgentService.create.mockClear();
      const res = await request(app)
        .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
        .send({
          config: { displayName: "Reviewer" },
          secretBindings: [
            { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
          ],
          notes,
        });
      expect(res.status, `wrapped notes form should 422: ${notes}`).toBe(422);
      expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
        "raw_secret_value_forbidden",
      );
      expect(JSON.stringify(res.body)).not.toContain(rawNoteSecret);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
      expect(mockAgentService.create).not.toHaveBeenCalled();
    }
  });

  it("rejects credential-shaped substrings wrapped in punctuation/quotes in config string values (no approval, no echo)", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    const rawValue = "sk-ant-api03-quoted-config-leak-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wrappedForms = [
      `"${rawValue}"`,
      `(${rawValue})`,
      `token="${rawValue}"`,
    ];
    for (const wrappedValue of wrappedForms) {
      mockApprovalService.create.mockClear();
      mockAgentService.create.mockClear();
      const res = await request(app)
        .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
        .send({
          config: { displayName: wrappedValue },
          secretBindings: [
            { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
          ],
        });
      expect(res.status, `wrapped config form should 422: ${wrappedValue}`).toBe(422);
      expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
        "raw_secret_value_forbidden",
      );
      expect(JSON.stringify(res.body)).not.toContain(rawValue);
      expect(mockApprovalService.create).not.toHaveBeenCalled();
      expect(mockAgentService.create).not.toHaveBeenCalled();
    }
  });

  it("does not echo user-supplied config or secret bindings in 422 previews", async () => {
    const app = await makeApp({ enabled: true, providerKeys: [] });
    mockSecretService.list.mockResolvedValue([]);
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: { displayName: "innocuous-but-still-request-derived" },
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "anthropic-key-alias" },
        ],
        notes: "user-supplied-note",
      });
    expect(res.status).toBe(422);
    expect(res.body.evidence.config).toEqual({});
    expect(res.body.evidence.secretBindings).toEqual([]);
    expect(res.body.evidence.notes).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("anthropic-key-alias");
    expect(JSON.stringify(res.body)).not.toContain("user-supplied-note");
    expect(JSON.stringify(res.body)).not.toContain("innocuous-but-still-request-derived");
  });

  it("successfully instantiates a real ready-agent blueprint when company inventory satisfies it", async () => {
    const { INITIAL_READY_AGENT_BLUEPRINTS, readyAgentBlueprintToVersion } = await import(
      "@paperclipai/shared"
    );
    const reviewerBlueprint = INITIAL_READY_AGENT_BLUEPRINTS.find(
      (b) => b.key === "code-reviewer",
    );
    expect(reviewerBlueprint).toBeDefined();
    const realVersion = readyAgentBlueprintToVersion(reviewerBlueprint!);

    const [{ errorHandler }, { blueprintRoutes }, { blueprintCatalogService }] = await Promise.all([
      import("../middleware/index.js"),
      import("../routes/blueprints.js"),
      import("../services/blueprint-catalog.js"),
    ]);

    const catalog = blueprintCatalogService({} as any, {
      enabled: true,
      versions: [realVersion],
      providerKeyResolver: () => ["ANTHROPIC_API_KEY"],
    });

    mockSecretService.list.mockResolvedValue([]);
    mockCompanySkillService.list.mockResolvedValue(
      realVersion.requiredSkillRefs.map((key) => ({ key })),
    );
    mockAgentService.list.mockResolvedValue([]);
    mockApprovalService.create.mockImplementation(async (_companyId: string, data: any) => ({
      id: "approval-real",
      companyId: "company-1",
      type: data.type,
      status: data.status,
      payload: data.payload,
      requestedByUserId: data.requestedByUserId,
      requestedByAgentId: data.requestedByAgentId ?? null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      };
      next();
    });
    app.use("/api", blueprintRoutes({} as any, { catalog }));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/company-1/blueprints/${realVersion.ref}/instantiate`)
      .send({ config: {}, secretBindings: [] });

    expect(res.status).toBe(201);
    expect(res.body.preview.status).toBe("ready");
    expect(res.body.preview.evidence.blueprintKey).toBe("code-reviewer");
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("blocks instantiate when an agent for the same blueprint key already exists", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-existing", metadata: { agentOs: { blueprintKey: "test-blueprint" } } },
    ]);
    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: {},
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { code: string }) => e.code)).toContain(
      "duplicate_blueprint_instance",
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("redacts sensitive payload fields in the returned approval", async () => {
    const app = await makeApp({ enabled: true, providerKeys: ["ANTHROPIC_API_KEY"] });
    mockSecretService.list.mockResolvedValue([
      { id: "secret-1", name: "ANTHROPIC_API_KEY_INPUT", key: "anthropic-api-key-input" },
    ]);
    mockApprovalService.create.mockImplementation(async (_companyId, data) => ({
      id: "approval-1",
      companyId: "company-1",
      type: data.type,
      status: data.status,
      payload: { ...(data.payload as object), authorization: "Bearer leak-me" },
      requestedByUserId: data.requestedByUserId,
      requestedByAgentId: data.requestedByAgentId ?? null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const res = await request(app)
      .post("/api/companies/company-1/blueprints/test-blueprint@1/instantiate")
      .send({
        config: {},
        secretBindings: [
          { inputName: "ANTHROPIC_API_KEY_INPUT", secretRef: "ANTHROPIC_API_KEY_INPUT" },
        ],
      });

    expect(res.status).toBe(201);
    const payloadString = JSON.stringify(res.body.approval.payload);
    expect(payloadString).not.toContain("Bearer leak-me");
  });
});
