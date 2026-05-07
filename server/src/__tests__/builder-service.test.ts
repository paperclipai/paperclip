import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BuilderProposal,
  BuilderProviderSettings,
  BuilderSession,
  BuilderSessionDetail,
} from "@paperclipai/shared";

const companyId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

const mockSessionStore = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSessionDetail: vi.fn(),
  getSession: vi.fn(),
  listMessages: vi.fn(),
  createSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  setSessionState: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
  appendMessage: vi.fn(),
  applyTotals: vi.fn(),
}));

const mockSettingsStore = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
}));

const mockProposalService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  pendingCount: vi.fn(),
  apply: vi.fn(),
  reject: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockRunBuilderTurn = vi.hoisted(() => vi.fn());
const mockGetBuilderToolCatalog = vi.hoisted(() => vi.fn(() => new Map()));

vi.mock("../services/builder/session-store.js", () => ({
  builderSessionStore: () => mockSessionStore,
}));

vi.mock("../services/builder/settings-store.js", () => ({
  builderProviderSettingsStore: () => mockSettingsStore,
}));

vi.mock("../services/builder/proposal-service.js", () => ({
  proposalService: () => mockProposalService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/builder/runner.js", () => ({
  runBuilderTurn: mockRunBuilderTurn,
}));

vi.mock("../services/builder/tool-registry.js", () => ({
  getBuilderToolCatalog: mockGetBuilderToolCatalog,
}));

vi.mock("../services/builder/adapter-executor.js", () => ({
  BUILDER_SUPPORTED_ADAPTER_TYPES: [
    "claude_local",
    "codex_local",
    "openclaw_gateway",
    "otto_agent",
  ],
}));

import { builderService } from "../services/builder/index.js";

function makeSession(overrides: Partial<BuilderSession> = {}): BuilderSession {
  const now = new Date("2026-05-06T10:00:00.000Z");
  return {
    id: sessionId,
    companyId,
    createdByUserId: "board-user",
    title: "",
    adapterType: "claude_local",
    model: "legacy-model",
    state: "active",
    archivedAt: null,
    inputTokensTotal: 0,
    outputTokensTotal: 0,
    costCentsTotal: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSettings(
  overrides: Partial<BuilderProviderSettings> = {},
): BuilderProviderSettings {
  const now = new Date("2026-05-06T10:00:00.000Z");
  return {
    companyId,
    adapterType: "codex_local",
    adapterConfig: { model: "gpt-new" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSessionDetail(
  overrides: Partial<BuilderSessionDetail> = {},
): BuilderSessionDetail {
  return {
    ...makeSession(),
    messages: [],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<BuilderProposal> = {}): BuilderProposal {
  const now = new Date("2026-05-06T10:00:00.000Z");
  return {
    id: "proposal-1",
    companyId,
    sessionId,
    messageId: "message-1",
    kind: "hire_agent",
    payload: { name: "Carmen" },
    status: "pending",
    appliedActivityId: null,
    approvalId: null,
    decidedByUserId: null,
    decidedAt: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("builder service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionStore.getSession.mockResolvedValue(makeSession());
    mockSessionStore.appendMessage.mockResolvedValue({
      id: "msg-user-1",
      sessionId,
      companyId,
      sequence: 0,
      role: "user",
      content: { text: "Plan the release rollout." },
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      createdAt: new Date("2026-05-06T10:01:00.000Z"),
    });
    mockSessionStore.updateSessionTitle.mockResolvedValue(undefined);
    mockSettingsStore.get.mockResolvedValue(makeSettings());
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { model: "gpt-new", cwd: "/tmp/company" },
    });
    mockRunBuilderTurn.mockResolvedValue({
      newMessages: [],
      usage: { inputTokens: 10, outputTokens: 4, costCents: 3 },
      truncated: false,
    });
  });

  it("uses the latest company settings for an existing session and derives the first prompt title", async () => {
    mockSessionStore.getSession.mockResolvedValue(
      makeSession({
        title: "",
        adapterType: "claude_local",
        model: "legacy-model",
      }),
    );

    const service = builderService({} as never);
    await service.sendMessage({
      companyId,
      sessionId,
      actor: { type: "user", id: "board-user" },
      text: "Plan the release rollout.",
    });

    expect(mockSessionStore.updateSessionTitle).toHaveBeenCalledWith(
      sessionId,
      "Plan the release rollout.",
    );
    expect(mockRunBuilderTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        sessionId,
        adapterConfig: {
          adapterType: "codex_local",
          adapterConfig: { model: "gpt-new", cwd: "/tmp/company" },
        },
      }),
    );
  });

  it("creates sessions even when the Builder adapter config does not include a model", async () => {
    mockSettingsStore.get.mockResolvedValue(
      makeSettings({
        adapterType: "openclaw_gateway",
        adapterConfig: { url: "wss://gateway.example" },
      }),
    );
    mockSessionStore.createSession.mockResolvedValue(
      makeSession({
        adapterType: "openclaw_gateway",
        model: "",
      }),
    );

    const service = builderService({} as never);
    await service.createSession({
      companyId,
      createdByUserId: "board-user",
      title: "Builder via gateway",
    });

    expect(mockSessionStore.createSession).toHaveBeenCalledWith({
      companyId,
      createdByUserId: "board-user",
      title: "Builder via gateway",
      adapterType: "openclaw_gateway",
      model: "",
    });
  });

  it("sends messages with model-less remote Builder adapters", async () => {
    mockSettingsStore.get.mockResolvedValue(
      makeSettings({
        adapterType: "openclaw_gateway",
        adapterConfig: { url: "wss://gateway.example" },
      }),
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { url: "wss://gateway.example" },
    });

    const service = builderService({} as never);
    await service.sendMessage({
      companyId,
      sessionId,
      actor: { type: "user", id: "board-user" },
      text: "Use the remote gateway builder.",
    });

    expect(mockRunBuilderTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterConfig: {
          adapterType: "openclaw_gateway",
          adapterConfig: { url: "wss://gateway.example" },
        },
      }),
    );
  });

  it("locks the resolved config for a running turn even if settings change later", async () => {
    let currentSettings = makeSettings({
      adapterType: "claude_local",
      adapterConfig: { model: "model-a" },
    });
    mockSessionStore.getSession.mockResolvedValue(
      makeSession({ title: "Existing title" }),
    );
    mockSettingsStore.get.mockImplementation(async () => currentSettings);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(
      async (_company, adapterConfig) => ({
        config: adapterConfig as Record<string, unknown>,
      }),
    );

    let resolveRun: ((value: {
      newMessages: [];
      usage: { inputTokens: number; outputTokens: number; costCents: number };
      truncated: boolean;
    }) => void) | null = null;
    mockRunBuilderTurn.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );

    const service = builderService({} as never);
    const pending = service.sendMessage({
      companyId,
      sessionId,
      actor: { type: "user", id: "board-user" },
      text: "Keep going",
    });

    await Promise.resolve();
    await Promise.resolve();

    currentSettings = makeSettings({
      adapterType: "codex_local",
      adapterConfig: { model: "model-b" },
    });

    resolveRun?.({
      newMessages: [],
      usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
      truncated: false,
    });
    await pending;

    expect(mockSettingsStore.get).toHaveBeenCalledTimes(1);
    expect(mockRunBuilderTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterConfig: {
          adapterType: "claude_local",
          adapterConfig: { model: "model-a" },
        },
      }),
    );
    expect(mockSessionStore.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("adds effective runtime metadata to listed sessions and session detail", async () => {
    mockSessionStore.listSessions.mockResolvedValue([
      makeSession({ adapterType: "claude_local", model: "legacy-model" }),
    ]);
    mockSessionStore.getSessionDetail.mockResolvedValue(
      makeSessionDetail({ adapterType: "claude_local", model: "legacy-model" }),
    );
    mockSettingsStore.get.mockResolvedValue(
      makeSettings({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-current" },
      }),
    );

    const service = builderService({} as never);
    const sessions = await service.listSessions(companyId, { includeArchived: true });
    const detail = await service.getSessionDetail(companyId, sessionId);

    expect(sessions).toEqual([
      expect.objectContaining({
        model: "legacy-model",
        effectiveRuntimeConfig: expect.objectContaining({
          adapterType: "codex_local",
          model: "gpt-current",
          source: "company_settings",
        }),
      }),
    ]);
    expect(mockSessionStore.listSessions).toHaveBeenCalledWith(companyId, {
      includeArchived: true,
    });
    expect(detail).toEqual(
      expect.objectContaining({
        model: "legacy-model",
        effectiveRuntimeConfig: expect.objectContaining({
          adapterType: "codex_local",
          model: "gpt-current",
          source: "company_settings",
        }),
      }),
    );
  });

  it("includes OpenClaw and Otto in the Builder tool catalog adapter list", () => {
    const service = builderService({} as never);
    const catalog = service.getToolCatalog(companyId);

    expect(catalog.supportedAdapterTypes).toEqual(
      expect.arrayContaining(["openclaw_gateway", "otto_agent"]),
    );
  });

  it("adds approval handoff metadata to proposal reads", async () => {
    mockProposalService.list.mockResolvedValue([
      makeProposal({
        id: "proposal-approval",
        approvalId: "approval-1",
      }),
    ]);
    mockProposalService.get.mockResolvedValue(
      makeProposal({
        id: "proposal-approval",
        approvalId: "approval-1",
      }),
    );

    const service = builderService({} as never);
    const list = await service.listProposals(companyId, { sessionId });
    const detail = await service.getProposal(companyId, "proposal-approval");

    expect(list[0]).toEqual(
      expect.objectContaining({
        handoff: expect.objectContaining({
          kind: "approval",
          href: "/approvals/approval-1",
          approvalId: "approval-1",
        }),
      }),
    );
    expect(detail).toEqual(
      expect.objectContaining({
        handoff: expect.objectContaining({
          kind: "approval",
          href: "/approvals/approval-1",
          approvalId: "approval-1",
        }),
      }),
    );
  });

  it("rejects new messages for archived sessions", async () => {
    mockSessionStore.getSession.mockResolvedValue(
      makeSession({ archivedAt: new Date("2026-05-06T10:05:00.000Z") }),
    );

    const service = builderService({} as never);
    await expect(
      service.sendMessage({
        companyId,
        sessionId,
        actor: { type: "user", id: "board-user" },
        text: "Keep going",
      }),
    ).rejects.toThrow("Session is archived and cannot accept new messages");

    expect(mockSessionStore.appendMessage).not.toHaveBeenCalled();
    expect(mockRunBuilderTurn).not.toHaveBeenCalled();
  });

  it("archives and restores sessions through the session store", async () => {
    const service = builderService({} as never);

    const archived = await service.archiveSession(companyId, sessionId);
    const restored = await service.restoreSession(companyId, sessionId);

    expect(mockSessionStore.archiveSession).toHaveBeenCalledWith(sessionId, expect.any(Date));
    expect(mockSessionStore.restoreSession).toHaveBeenCalledWith(sessionId, expect.any(Date));
    expect(archived).toEqual(expect.objectContaining({ archivedAt: expect.any(Date) }));
    expect(restored).toEqual(expect.objectContaining({ archivedAt: null }));
  });

  it("returns entity handoff metadata from inline apply results", async () => {
    mockProposalService.apply.mockResolvedValue(
      Object.assign(
        makeProposal({
          id: "proposal-issue",
          kind: "create_issue",
          status: "applied",
        }),
        {
          entityType: "issue",
          entityId: "issue-123",
        },
      ),
    );

    const service = builderService({} as never);
    const proposal = await service.applyProposal(companyId, "proposal-issue", "board-user");

    expect(proposal).toEqual(
      expect.objectContaining({
        handoff: expect.objectContaining({
          kind: "entity",
          href: "/issues/issue-123",
          entityType: "issue",
          entityId: "issue-123",
        }),
      }),
    );
  });
});
