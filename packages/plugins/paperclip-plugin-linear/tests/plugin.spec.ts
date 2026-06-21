import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  ACTION_KEYS,
  DATA_KEYS,
  STATE_KEYS,
  JOB_KEYS,
  TOOL_NAMES,
  LINEAR_OAUTH,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Mock external modules — linear.ts and sync.ts make HTTP calls
// ---------------------------------------------------------------------------

vi.mock("../src/linear.js", () => ({
  exchangeCodeForToken: vi.fn().mockResolvedValue({
    access_token: "lin_token_123",
    token_type: "Bearer",
  }),
  revokeToken: vi.fn().mockResolvedValue(undefined),
  isRateLimitError: vi.fn().mockImplementation((err: unknown) => String(err).includes("RATELIMITED")),
  getTeams: vi.fn().mockResolvedValue([
    { id: "team-1", key: "LUC", name: "Lucitra" },
  ]),
  getHighestIssueNumber: vi.fn().mockResolvedValue(42),
  searchIssues: vi.fn().mockResolvedValue({
    totalCount: 1,
    issues: [
      {
        id: "lin-iss-1",
        identifier: "LUC-1",
        title: "Test issue",
        state: { name: "In Progress", type: "started" },
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: { name: "Alice" },
      },
    ],
  }),
  getIssue: vi.fn().mockResolvedValue({
    id: "lin-iss-1",
    identifier: "LUC-1",
    title: "Test issue",
    state: { name: "In Progress", type: "started" },
    url: "https://linear.app/lucitra/issue/LUC-1",
    assignee: { name: "Alice" },
  }),
  getIssueByIdentifier: vi.fn().mockResolvedValue({
    id: "lin-iss-1",
    identifier: "LUC-1",
    title: "Test issue",
    state: { name: "In Progress", type: "started" },
    url: "https://linear.app/lucitra/issue/LUC-1",
    assignee: null,
  }),
  registerWebhook: vi.fn().mockResolvedValue({
    id: "lin-webhook-1",
    enabled: true,
  }),
  listIssuesByIds: vi.fn().mockResolvedValue([]),
  listIssueLabels: vi.fn().mockResolvedValue([
    {
      id: "issue-label-1",
      name: "bug",
      color: "#d73a49",
      team: { id: "team-1", key: "LUC", name: "Lucitra" },
    },
  ]),
  createIssueLabel: vi.fn().mockResolvedValue({
    id: "issue-label-new",
    name: "scope:test",
    color: "#6366f1",
    team: { id: "team-1", key: "LUC", name: "Lucitra" },
  }),
  listProjectLabels: vi.fn().mockResolvedValue([
    {
      id: "project-label-1",
      name: "backend",
      color: "#0366d6",
    },
  ]),
  createIssue: vi.fn().mockResolvedValue({
    id: "lin-iss-new",
    identifier: "LUC-43",
    title: "New issue",
    url: "https://linear.app/lucitra/issue/LUC-43",
    state: { name: "Backlog", type: "backlog" },
  }),
  attachmentLinkURL: vi.fn().mockResolvedValue({
    success: true,
    attachmentId: "att-1",
  }),
  ensureProjectLink: vi.fn().mockResolvedValue({
    success: true,
    projectLink: {
      id: "project-link-1",
      url: "https://paperclip.test/LUC/projects/proj-1",
      label: "Paperclip project",
    },
    created: true,
    updated: false,
  }),
  listProjectLinks: vi.fn().mockResolvedValue([]),
  createProjectLink: vi.fn().mockResolvedValue({
    success: true,
    projectLink: { id: "project-link-1", url: "https://paperclip.test/LUC/projects/proj-1", label: "Paperclip project" },
  }),
  updateProjectLink: vi.fn().mockResolvedValue({
    success: true,
    projectLink: { id: "project-link-1", url: "https://paperclip.test/LUC/projects/proj-1", label: "Paperclip project" },
  }),
  createProject: vi.fn().mockResolvedValue({
    id: "lin-proj-1",
    name: "Test Project",
  }),
  parseLinearIssueRef: vi.fn().mockImplementation((ref: string) => {
    const match = ref.match(/^([A-Z]+-\d+)$/);
    return match ? { identifier: match[1] } : null;
  }),
  listOpenIssues: vi.fn().mockResolvedValue({ issues: [], hasNextPage: false }),
  listProjects: vi.fn().mockResolvedValue([]),
  updateIssue: vi.fn().mockResolvedValue({}),
  updateProject: vi.fn().mockResolvedValue({}),
  getWorkflowStates: vi.fn().mockResolvedValue([]),
  markDuplicate: vi.fn().mockResolvedValue({ success: true, issueRelationId: null, alreadyRelated: false }),
  listProjectMilestones: vi.fn().mockResolvedValue([]),
  listProjectIssuesWithMilestone: vi.fn().mockResolvedValue({ issues: [], hasNextPage: false, endCursor: null }),
  listIssuesByMilestone: vi.fn().mockResolvedValue({ issues: [], hasNextPage: false, endCursor: null }),
  createProjectMilestone: vi.fn().mockResolvedValue({ id: "lin-ms-new", name: "New Milestone", description: null, targetDate: null }),
}));

const syncModule = vi.hoisted(() => ({
  getLink: vi.fn().mockResolvedValue(null),
  getLinkByLinear: vi.fn().mockResolvedValue(null),
  createLink: vi.fn().mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({
    ...params,
    lastSyncAt: new Date().toISOString(),
    lastLinearStateType: params.linearStateType,
    lastCommentSyncAt: null,
  })),
  removeLink: vi.fn().mockResolvedValue(true),
  getProjectLink: vi.fn().mockResolvedValue(null),
  getProjectLinkByLinear: vi.fn().mockResolvedValue(null),
  syncToLinear: vi.fn().mockResolvedValue(undefined),
  syncFromLinear: vi.fn().mockResolvedValue(undefined),
  syncProjectToLinear: vi.fn().mockResolvedValue(undefined),
  syncProjectFromLinear: vi.fn().mockResolvedValue("updated"),
  isHostWriteUnavailableError: vi.fn().mockImplementation((err: unknown) => String(err).includes("missing, expired, or unknown invocation scope")),
  isPaperclipIssueNotFoundError: vi.fn().mockImplementation((err: unknown) => String(err).includes("Issue not found")),
  bridgeCommentToLinear: vi.fn().mockResolvedValue(undefined),
  paperclipProjectStateToLinear: vi.fn().mockReturnValue("planned"),
  linearProjectStateToPaperclip: vi.fn().mockReturnValue("backlog"),
  createProjectLink: vi.fn().mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({
    ...params,
    lastSyncAt: new Date().toISOString(),
  })),
  removeProjectLink: vi.fn().mockResolvedValue(true),
  getMilestoneLink: vi.fn().mockResolvedValue(null),
  getMilestoneLinkByLinear: vi.fn().mockResolvedValue(null),
  createMilestoneLink: vi.fn().mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({ ...params })),
}));

vi.mock("../src/sync.js", () => syncModule);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("paperclip-plugin-linear", () => {
  let harness: TestHarness;

  // Re-install hoisted syncModule defaults. `vi.clearAllMocks()` clears
  // call history but preserves implementations and queued one-shot
  // implementations. Reset first, then re-install defaults so tests that use
  // `mockResolvedValueOnce` cannot leak queue entries into later import tests.
  // Keep this list in sync with the hoisted block at the top of the file.
  function restoreSyncModuleDefaults() {
    for (const mock of Object.values(syncModule)) {
      mock.mockReset();
    }
    syncModule.getLink.mockResolvedValue(null);
    syncModule.getLinkByLinear.mockResolvedValue(null);
    syncModule.createLink.mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({
      ...params,
      lastSyncAt: new Date().toISOString(),
      lastLinearStateType: params.linearStateType,
      lastCommentSyncAt: null,
    }));
    syncModule.removeLink.mockResolvedValue(true);
    syncModule.getProjectLink.mockResolvedValue(null);
    syncModule.getProjectLinkByLinear.mockResolvedValue(null);
    syncModule.syncToLinear.mockResolvedValue(undefined);
    syncModule.syncFromLinear.mockResolvedValue(undefined);
    syncModule.syncProjectToLinear.mockResolvedValue(undefined);
    syncModule.syncProjectFromLinear.mockResolvedValue("updated");
    syncModule.isHostWriteUnavailableError.mockImplementation((err: unknown) => String(err).includes("missing, expired, or unknown invocation scope"));
    syncModule.isPaperclipIssueNotFoundError.mockImplementation((err: unknown) => String(err).includes("Issue not found"));
    syncModule.bridgeCommentToLinear.mockResolvedValue(undefined);
    syncModule.paperclipProjectStateToLinear.mockReturnValue("planned");
    syncModule.linearProjectStateToPaperclip.mockReturnValue("backlog");
    syncModule.createProjectLink.mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({
      ...params,
      lastSyncAt: new Date().toISOString(),
    }));
    syncModule.removeProjectLink.mockResolvedValue(true);
    syncModule.getMilestoneLink.mockResolvedValue(null);
    syncModule.getMilestoneLinkByLinear.mockResolvedValue(null);
    syncModule.createMilestoneLink.mockImplementation((_ctx: unknown, params: Record<string, unknown>) => ({ ...params }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreSyncModuleDefaults();
    harness = createTestHarness({
      manifest,
      config: {
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        teamId: "team-1",
        syncComments: true,
        syncDirection: "bidirectional",
        disableLinearOriginatedCreates: false,
      },
    });
    await plugin.definition.setup(harness.ctx);
  });

  // -----------------------------------------------------------------------
  // Setup & health
  // -----------------------------------------------------------------------

  it("logs startup messages", () => {
    const infoLogs = harness.logs.filter((l) => l.level === "info");
    expect(infoLogs.some((l) => l.message.includes("starting"))).toBe(true);
    expect(infoLogs.some((l) => l.message.includes("ready"))).toBe(true);
  });

  it("reports healthy status", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });

  // -----------------------------------------------------------------------
  // OAuth actions
  // -----------------------------------------------------------------------

  describe("oauth-start", () => {
    it("generates an authorize URL with correct params", async () => {
      const result = await harness.performAction<{
        authorizeUrl: string;
        state: string;
      }>(ACTION_KEYS.oauthStart, {
        companyId: "comp-1",
        redirectUri: "http://localhost:3000/callback",
      });

      expect(result.authorizeUrl).toContain(LINEAR_OAUTH.authorizeUrl);
      expect(result.authorizeUrl).toContain("client_id=client-id-123");
      expect(result.authorizeUrl).toContain("response_type=code");
      expect(result.authorizeUrl).toContain("actor=app");
      const authUrl = new URL(result.authorizeUrl);
      expect(authUrl.searchParams.get("scope")).toBe("read,write,initiative:read,initiative:write");
      expect(authUrl.searchParams.get("scope")).not.toContain("admin");
      expect(result.state).toBeTruthy();
    });

    it("returns error when clientId is not configured", async () => {
      harness.setConfig({ linearClientId: "", linearClientSecret: "secret" });
      const result = await harness.performAction<{ error: string }>(
        ACTION_KEYS.oauthStart,
        { companyId: "comp-1", redirectUri: "http://localhost:3000/callback" },
      );
      expect(result.error).toContain("linearClientId not configured");
    });
  });

  describe("oauth-callback", () => {
    it("exchanges code for token and stores state", async () => {
      // First start OAuth to create a state token
      const start = await harness.performAction<{
        authorizeUrl: string;
        state: string;
      }>(ACTION_KEYS.oauthStart, {
        companyId: "comp-1",
        redirectUri: "http://localhost:3000/callback",
      });

      const result = await harness.performAction<{
        connected: boolean;
        teamId: string;
        teamKey: string;
      }>(ACTION_KEYS.oauthCallback, {
        code: "auth-code-xyz",
        state: start.state,
        redirectUri: "http://localhost:3000/callback",
      });

      expect(result.connected).toBe(true);
      expect(result.teamId).toBe("team-1");
      expect(result.teamKey).toBe("LUC");

      // Token should be stored in state
      const token = harness.getState({
        scopeKind: "instance",
        stateKey: STATE_KEYS.oauthToken,
      });
      expect(token).toBe("lin_token_123");
      expect(harness.getState({
        scopeKind: "instance",
        stateKey: STATE_KEYS.oauthActor,
      })).toBe("app");
    });

    it("registers the Linear webhook with the configured signing secret", async () => {
      const { registerWebhook } = await import("../src/linear.js");
      harness.setConfig({
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        paperclipBaseUrl: "https://paperclip.example.com/",
        linearWebhookSigningSecret: " lin_wh_test ",
        teamId: "team-1",
        syncComments: true,
        syncDirection: "bidirectional",
      });

      const start = await harness.performAction<{
        authorizeUrl: string;
        state: string;
      }>(ACTION_KEYS.oauthStart, {
        companyId: "comp-1",
        redirectUri: "http://localhost:3000/callback",
      });

      await harness.performAction(ACTION_KEYS.oauthCallback, {
        code: "auth-code-xyz",
        state: start.state,
        redirectUri: "http://localhost:3000/callback",
      });

      expect(registerWebhook).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        expect.objectContaining({
          teamId: "team-1",
          url: "https://paperclip.example.com/api/plugins/paperclip-plugin-linear/webhooks/linear-events",
          secret: "lin_wh_test",
        }),
      );
    });

    it("refreshes the Linear webhook when config changes", async () => {
      const { registerWebhook } = await import("../src/linear.js");
      const config = {
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        paperclipBaseUrl: "https://paperclip.example.com",
        linearWebhookSigningSecret: "lin_wh_changed",
        teamId: "team-1",
        syncComments: true,
        syncDirection: "bidirectional",
      };
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      harness.setConfig(config);

      await plugin.definition.onConfigChanged?.(config);

      expect(registerWebhook).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        expect.objectContaining({
          teamId: "team-1",
          url: "https://paperclip.example.com/api/plugins/paperclip-plugin-linear/webhooks/linear-events",
          secret: "lin_wh_changed",
        }),
      );
    });

    it("rejects invalid state token", async () => {
      const result = await harness.performAction<{ error: string }>(
        ACTION_KEYS.oauthCallback,
        { code: "auth-code-xyz", state: "bogus-state" },
      );
      expect(result.error).toContain("Invalid or expired OAuth state");
    });
  });

  describe("oauth-disconnect", () => {
    it("clears OAuth state", async () => {
      // Simulate a connected state
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.connected },
        { connectedAt: new Date().toISOString() },
      );

      const result = await harness.performAction<{ disconnected: boolean }>(
        ACTION_KEYS.oauthDisconnect,
      );

      expect(result.disconnected).toBe(true);
      expect(
        harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.oauthToken }),
      ).toBeUndefined();
      expect(
        harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.connected }),
      ).toBeUndefined();
    });
  });

  describe("oauth-status", () => {
    it("returns connected: false when not connected", async () => {
      const result = await harness.performAction<{ connected: boolean }>(
        ACTION_KEYS.oauthStatus,
      );
      expect(result.connected).toBe(false);
    });

    it("returns connected: true when state exists", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.connected },
        { connectedAt: new Date().toISOString(), teamId: "team-1" },
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const result = await harness.performAction<{
        connected: boolean;
        highestNumber?: number;
      }>(ACTION_KEYS.oauthStatus);

      expect(result.connected).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Data handlers
  // -----------------------------------------------------------------------

  describe("data: issue-link", () => {
    it("returns linked: false when no link exists", async () => {
      const result = await harness.getData<{ linked: boolean }>(
        DATA_KEYS.issueLink,
        { issueId: "iss-1" },
      );
      expect(result.linked).toBe(false);
    });
  });

  describe("data: connection-status", () => {
    it("returns connected: false with no state", async () => {
      const result = await harness.getData<{ connected: boolean }>(
        DATA_KEYS.connectionStatus,
      );
      expect(result.connected).toBe(false);
    });

    it("returns connected: true with state", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.connected },
        { connectedAt: "2025-01-01T00:00:00Z" },
      );
      const result = await harness.getData<{ connected: boolean }>(
        DATA_KEYS.connectionStatus,
      );
      expect(result.connected).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Agent tools
  // -----------------------------------------------------------------------

  describe("tool: search-linear-issues", () => {
    it("searches and returns formatted results", async () => {
      // Need a token in state for resolveToken
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      const result = await harness.executeTool(TOOL_NAMES.search, {
        query: "test",
      });

      expect(result.content).toContain("Found 1 issues");
      expect((result.data as any).issues[0].identifier).toBe("LUC-1");
    });
  });

  describe("tool: create-linear-issue", () => {
    it("creates an issue and returns identifier", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      const result = await harness.executeTool(TOOL_NAMES.create, {
        title: "New issue",
        description: "A test issue",
      });

      expect(result.content).toContain("LUC-43");
      expect((result.data as any).identifier).toBe("LUC-43");
    });
  });

  describe("tool: list-linear-issue-labels", () => {
    it("lists issue labels with optional filters", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      const { listIssueLabels } = await import("../src/linear.js");

      const result = await harness.executeTool(TOOL_NAMES.listIssueLabels, {
        query: "bug",
        teamId: "team-1",
        limit: 25,
      });

      expect(result.content).toContain("Found 1 Linear issue labels");
      expect((result.data as any).labels[0]).toMatchObject({
        id: "issue-label-1",
        name: "bug",
        color: "#d73a49",
        team: { id: "team-1", key: "LUC", name: "Lucitra" },
      });
      expect(listIssueLabels).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        { query: "bug", teamId: "team-1", limit: 25 },
      );
    });
  });

  describe("tool: list-linear-project-labels", () => {
    it("lists project labels with optional filters", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      const { listProjectLabels } = await import("../src/linear.js");

      const result = await harness.executeTool(TOOL_NAMES.listProjectLabels, {
        query: "back",
        limit: 10,
      });

      expect(result.content).toContain("Found 1 Linear project labels");
      expect((result.data as any).labels[0]).toMatchObject({
        id: "project-label-1",
        name: "backend",
        color: "#0366d6",
      });
      expect(listProjectLabels).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        { query: "back", limit: 10 },
      );
    });
  });

  describe("tool: unlink-linear-issue", () => {
    it("returns unlinked status", async () => {
      const result = await harness.executeTool(TOOL_NAMES.unlink, {
        paperclipIssueId: "iss-1",
      });
      expect((result.data as any).unlinked).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Events: bidirectional sync
  // -----------------------------------------------------------------------

  describe("issue.updated event", () => {
    it("skips updates from Linear source (prevents loop)", async () => {
      await harness.emit(
        "issue.updated",
        { id: "iss-1", status: "done", source: "linear" },
        { entityId: "iss-1" },
      );

      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });

    it("skips when no link exists", async () => {
      await harness.emit(
        "issue.updated",
        { id: "iss-1", status: "done" },
        { entityId: "iss-1" },
      );

      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });

    it("skips when no changes are present", async () => {
      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-1",
        syncDirection: "bidirectional",
      });

      await harness.emit(
        "issue.updated",
        { id: "iss-1" },
        { entityId: "iss-1" },
      );

      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });

    it("syncs to Linear when link exists and changes are present", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-1",
        syncDirection: "bidirectional",
      });

      await harness.emit(
        "issue.updated",
        { id: "iss-1", status: "done", title: "Updated title" },
        { entityId: "iss-1" },
      );

      expect(syncModule.syncToLinear).toHaveBeenCalledOnce();
    });

    it("passes Paperclip project moves through to issue sync", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-1",
        linearIdentifier: "BLO-1",
        linearUrl: "https://linear.app/blockcast/issue/BLO-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      });

      await harness.emit(
        "issue.updated",
        { id: "iss-1", projectId: "paperclip-proj-b", companyId: "comp-1" },
        { entityId: "iss-1", companyId: "comp-1" },
      );

      expect(syncModule.syncToLinear).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ projectId: "paperclip-proj-b" }),
        "lin_token_123",
        "team-1",
        expect.anything(),
      );
    });

    it("passes Paperclip label changes through to issue sync", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-1",
        linearIdentifier: "BLO-1",
        linearUrl: "https://linear.app/blockcast/issue/BLO-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      });

      await harness.emit(
        "issue.updated",
        { id: "iss-1", patch: { labelIds: ["label-a", "label-b"] }, companyId: "comp-1" },
        { entityId: "iss-1", companyId: "comp-1" },
      );

      expect(syncModule.syncToLinear).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ labelIds: ["label-a", "label-b"] }),
        "lin_token_123",
        "team-1",
        expect.anything(),
      );
    });

    it("skips linked issues when the event company differs from the link company", async () => {
      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-1",
        syncDirection: "bidirectional",
      });

      await harness.emit(
        "issue.updated",
        { id: "iss-1", status: "done", title: "Updated title", companyId: "comp-2" },
        { entityId: "iss-1", companyId: "comp-2" },
      );

      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });
  });

  describe("issue.comment.created event", () => {
    it("does not bridge when syncComments is false", async () => {
      harness.setConfig({
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        syncComments: false,
      });

      await harness.emit(
        "issue.comment.created",
        { issueId: "iss-1", body: "Hello" },
        { entityId: "iss-1" },
      );

      expect(syncModule.bridgeCommentToLinear).not.toHaveBeenCalled();
    });

    it("bridges comment to Linear when link exists", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-1",
        syncDirection: "bidirectional",
      });

      await harness.emit(
        "issue.comment.created",
        { issueId: "iss-1", body: "Hello from Paperclip", authorName: "Bob" },
        { entityId: "iss-1" },
      );

      expect(syncModule.bridgeCommentToLinear).toHaveBeenCalledOnce();
    });

    it("skips when no link exists for the issue", async () => {
      await harness.emit(
        "issue.comment.created",
        { issueId: "iss-1", body: "Hello" },
        { entityId: "iss-1" },
      );

      expect(syncModule.bridgeCommentToLinear).not.toHaveBeenCalled();
    });
  });

  describe("project.created event", () => {
    it("creates a Linear project and link when no existing link", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { createProject } = await import("../src/linear.js");

      await harness.emit(
        "project.created",
        { id: "proj-1", name: "New Project", status: "active" },
        { entityId: "proj-1", companyId: "comp-1" },
      );

      expect(createProject).toHaveBeenCalledOnce();
      expect(syncModule.createProjectLink).toHaveBeenCalledOnce();
      expect(harness.activity.length).toBeGreaterThan(0);
    });

    it("skips when source is linear (prevents loop)", async () => {
      const { createProject } = await import("../src/linear.js");

      await harness.emit(
        "project.created",
        { id: "proj-1", name: "New Project", source: "linear" },
        { entityId: "proj-1" },
      );

      expect(createProject).not.toHaveBeenCalled();
    });
  });

  describe("project.updated event", () => {
    it("skips when source is linear", async () => {
      await harness.emit(
        "project.updated",
        { id: "proj-1", name: "Updated", source: "linear" },
        { entityId: "proj-1" },
      );

      expect(syncModule.syncProjectToLinear).not.toHaveBeenCalled();
    });

    it("skips when no project link exists", async () => {
      await harness.emit(
        "project.updated",
        { id: "proj-1", name: "Updated" },
        { entityId: "proj-1" },
      );

      expect(syncModule.syncProjectToLinear).not.toHaveBeenCalled();
    });

    it("syncs to Linear when link exists and changes are present", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      syncModule.getProjectLink.mockResolvedValueOnce({
        paperclipProjectId: "proj-1",
        linearProjectId: "lin-proj-1",
        syncDirection: "bidirectional",
      });

      await harness.emit(
        "project.updated",
        { id: "proj-1", name: "Renamed Project", status: "completed" },
        { entityId: "proj-1" },
      );

      expect(syncModule.syncProjectToLinear).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Jobs
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Additional actions
  // -----------------------------------------------------------------------

  describe("list-teams", () => {
    it("returns teams from Linear API", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const result = await harness.performAction<{
        teams: Array<{ id: string; key: string; name: string }>;
      }>(ACTION_KEYS.listTeams);

      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].key).toBe("LUC");
    });
  });

  describe("configure", () => {
    it("updates the stored team ID", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const result = await harness.performAction<{ ok: boolean }>(
        ACTION_KEYS.configure,
        { teamId: "team-1" },
      );

      expect(result.ok).toBe(true);
      expect(
        harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId }),
      ).toBe("team-1");
    });
  });

  describe("trigger-import", () => {
    it("stores companyId before running import", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      // Patch ctx.labels (Lucitra extension not in published SDK harness)
      (harness.ctx as any).labels = {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: "label-1", name: "test" }),
      };

      const result = await harness.performAction<{
        imported: number;
        skipped: number;
        labels: number;
        projects: number;
      }>(ACTION_KEYS.triggerImport, { companyId: "comp-1" });

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
      expect(
        harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.companyId }),
      ).toBe("comp-1");
    });

    it("skips if import was already completed", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      // Mark import as already done
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: "initial-import-done" },
        "2025-01-01T00:00:00Z",
      );

      const result = await harness.performAction<{
        imported: number;
        skipped: number;
      }>(ACTION_KEYS.triggerImport, { companyId: "comp-1" });

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe("import-issue: Paperclip back-link", () => {
    it("fires attachmentLinkURL after creating the Paperclip mirror when paperclipBaseUrl is configured", async () => {
      // Configure base URL on this harness instance so the back-link path triggers.
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true, // swallow API failures in test
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      // ctx.issues.list returns empty (dedup-by-originId check passes).
      // ctx.issues.create returns an issue with a known identifier.
      // ctx.issues.update is a no-op (the status-update branch may fire).
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1001",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      expect(attachmentLinkURL).toHaveBeenCalledOnce();
      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg).toMatchObject({
        issueId: "lin-iss-1",
        url: "https://paperclip.test/LUC/issues/LUC-1001",
        title: "Paperclip mirror: LUC-1001",
        subtitle: "LUC-1001 - Test issue",
        iconUrl: "https://paperclip.test/favicon-32x32.png",
        groupBySource: true,
        metadata: {
          source: "paperclip",
          sourceType: "paperclip",
          service: "paperclip",
          paperclipIssueId: "pcp-iss-1",
          paperclipIdentifier: "LUC-1001",
          linearIdentifier: "LUC-1",
          url: "https://paperclip.test/LUC/issues/LUC-1001",
        },
      });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Paperclip issue", value: "LUC-1001" });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Linear issue", value: "LUC-1" });
      expect(callArg.createAsUser).toBeUndefined();
      expect(callArg.displayIconUrl).toBeUndefined();
    });

    it("uses app actor attribution when the OAuth token was authorized as the app", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthActor },
        "app",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-app-actor",
        identifier: "LUC-1006",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg).toMatchObject({
        issueId: "lin-iss-1",
        url: "https://paperclip.test/LUC/issues/LUC-1006",
        createAsUser: "Paperclip",
        displayIconUrl: "https://paperclip.test/favicon-32x32.png",
      });
    });

    it("does not use app actor attribution for linearTokenRef connections", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "",
          linearClientSecret: "",
          linearTokenRef: "secret-uuid-actor",
          linearOAuthActor: "app",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthActor },
        "app",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-token-ref",
        identifier: "LUC-1007",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg).toMatchObject({
        issueId: "lin-iss-1",
        url: "https://paperclip.test/LUC/issues/LUC-1007",
      });
      expect(callArg.createAsUser).toBeUndefined();
      expect(callArg.displayIconUrl).toBeUndefined();
    });

    it("skips the back-link when paperclipBaseUrl is explicitly empty", async () => {
      harness.setConfig({ paperclipBaseUrl: "" });
      // companyId must be set so the action reaches the back-link block —
      // otherwise the test trivially passes via getCompanyId's early return.
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1002",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      expect(attachmentLinkURL).not.toHaveBeenCalled();
    });

    it("fails the import loudly when attachmentLinkURL throws and linearBacklinkBestEffort is false (default)", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          // linearBacklinkBestEffort omitted -> defaults to false
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1003",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Linear 500: attachmentLinkURL failed"),
      );

      await expect(
        harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" }),
      ).rejects.toThrow(/Linear 500: attachmentLinkURL failed/);
    });

    it("swallows attachmentLinkURL errors and emits warn when linearBacklinkBestEffort is true", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1004",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Linear 503: temporarily unavailable"),
      );

      const result = await harness.performAction<{ imported: boolean }>(
        ACTION_KEYS.importIssue,
        { linearRef: "LUC-1" },
      );

      expect(result.imported).toBe(true);
      const warnLogs = harness.logs.filter(
        (l) => l.level === "warn" && l.message.includes("Failed to add Paperclip back-link"),
      );
      expect(warnLogs.length).toBeGreaterThan(0);
    });

    it("emits warn and skips the back-link when created.identifier is null", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-null",
        identifier: null,
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      expect(attachmentLinkURL).not.toHaveBeenCalled();
      const warnLogs = harness.logs.filter(
        (l) => l.level === "warn" && l.message.includes("null identifier"),
      );
      expect(warnLogs.length).toBeGreaterThan(0);
    });

    it("normalizes a trailing slash on paperclipBaseUrl to produce a single-slash URL", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test/",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValue([] as never);
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1005",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await harness.performAction(ACTION_KEYS.importIssue, { linearRef: "LUC-1" });

      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg.url).toBe("https://paperclip.test/LUC/issues/LUC-1005");
    });

    it("does not add a Linear human assignee to an exact-title Paperclip issue that already has an agent assignee", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      harness.seed({
        issues: [
          {
            id: "pc-iss-agent",
            companyId: "comp-1",
            identifier: "LUC-99",
            title: "Test issue",
            status: "todo",
            priority: "low",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          } as never,
        ],
      });

      const { getIssueByIdentifier } = await import("../src/linear.js");
      (getIssueByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "lin-iss-1",
        identifier: "LUC-1",
        title: "Test issue",
        description: null,
        state: { name: "Backlog", type: "backlog" },
        priority: 3,
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: { name: "Alice", email: "alice@example.com" },
        project: null,
        labels: { nodes: [] },
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
      });
      vi.spyOn(harness.ctx.users, "findByEmail").mockResolvedValue({
        id: "user-1",
        email: "alice@example.com",
        name: "Alice",
      });
      const update = vi.spyOn(harness.ctx.issues, "update");

      const result = await harness.performAction<{ relinked: boolean; paperclipIssueId: string }>(
        ACTION_KEYS.importIssue,
        { linearRef: "LUC-1" },
      );

      expect(result).toMatchObject({ relinked: true, paperclipIssueId: "pc-iss-agent" });
      expect(update).toHaveBeenCalledWith(
        "pc-iss-agent",
        expect.not.objectContaining({ assigneeUserId: expect.anything() }),
        "comp-1",
      );
    });
  });

  describe("trigger-sync", () => {
    it("runs full sync and returns result", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );

      const result = await harness.performAction<{
        synced: number;
        errors: number;
      }>(ACTION_KEYS.triggerSync);

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("skips project drift for links outside the scoped Paperclip company", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { listProjects } = await import("../src/linear.js");
      (listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: "lin-proj-current",
          name: "Current company project",
          description: "Current description",
          state: "started",
          url: "https://linear.app/test/project/current",
        },
        {
          id: "lin-proj-other",
          name: "Other company project",
          description: "Other description",
          state: "started",
          url: "https://linear.app/test/project/other",
        },
      ]);

      const currentLink = {
        paperclipProjectId: "pc-proj-current",
        paperclipCompanyId: "comp-1",
        linearProjectId: "lin-proj-current",
        linearProjectName: "Current company project",
        syncDirection: "bidirectional" as const,
        lastSyncAt: new Date().toISOString(),
        lastLinearState: "started",
        lastLinearDescription: "Current description",
      };
      const otherCompanyLink = {
        paperclipProjectId: "pc-proj-other",
        paperclipCompanyId: "comp-2",
        linearProjectId: "lin-proj-other",
        linearProjectName: "Other company project",
        syncDirection: "bidirectional" as const,
        lastSyncAt: new Date().toISOString(),
        lastLinearState: "started",
        lastLinearDescription: "Other description",
      };

      syncModule.getProjectLinkByLinear.mockImplementation(async (_ctx: unknown, linearProjectId: string) => {
        if (linearProjectId === "lin-proj-current") return currentLink;
        if (linearProjectId === "lin-proj-other") return otherCompanyLink;
        return null;
      });

      await harness.performAction(ACTION_KEYS.triggerSync);

      expect(syncModule.syncProjectFromLinear).toHaveBeenCalledTimes(1);
      expect(syncModule.syncProjectFromLinear).toHaveBeenCalledWith(
        expect.anything(),
        currentLink,
        expect.objectContaining({ id: "lin-proj-current" }),
      );
      expect(
        harness.logs.some(
          (entry) =>
            entry.level === "info"
            && entry.message.includes("Project sync: 1 synced, 0 created, 0 errors, 1 skipped (other company)"),
        ),
      ).toBe(true);
    });

    it("adopts an existing Paperclip project by name during project catch-up instead of creating a duplicate", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      harness.seed({
        companies: [
          {
            id: "comp-1",
            name: "Blockcast",
            issuePrefix: "BLO",
          } as never,
        ],
        projects: [
          {
            id: "pc-proj-demand",
            companyId: "comp-1",
            urlKey: "demand-smb-2",
            name: "Demand: SMB 2",
            status: "active",
          } as never,
        ],
      });

      const { listProjects } = await import("../src/linear.js");
      (listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: "lin-proj-demand",
          name: "Demand: SMB 2",
          description: "Linear project",
          state: "started",
          url: "https://linear.app/test/project/demand-smb-2",
        },
      ]);
      const createProjectSpy = vi.spyOn(harness.ctx.projects, "create");

      await harness.performAction(ACTION_KEYS.triggerSync);

      expect(createProjectSpy).not.toHaveBeenCalled();
      expect(syncModule.createProjectLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        paperclipProjectId: "pc-proj-demand",
        paperclipCompanyId: "comp-1",
        linearProjectId: "lin-proj-demand",
        linearProjectName: "Demand: SMB 2",
      }));
    });

    it("reconciles linked Paperclip issue status, project, and labels back to Linear", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-issue-1` },
        {
          paperclipIssueId: "pc-issue-1",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-issue-1",
          linearIdentifier: "BLO-1",
          linearUrl: "https://linear.app/blockcast/issue/BLO-1",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        },
      );
      harness.seed({
        issues: [
          {
            id: "pc-issue-1",
            companyId: "comp-1",
            projectId: "pc-project-current",
            title: "Paperclip current",
            status: "done",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            labelIds: ["label-scope"],
          } as never,
        ],
      });
      const { listIssuesByIds } = await import("../src/linear.js");
      (listIssuesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: "lin-issue-1",
          identifier: "BLO-1",
          title: "Linear stale",
          description: null,
          state: { name: "Todo", type: "unstarted" },
          priority: 3,
          url: "https://linear.app/blockcast/issue/BLO-1",
          assignee: null,
          labels: { nodes: [] },
          project: { id: "lin-project-old", name: "Old", description: null, state: "started" },
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        },
      ]);

      const result = await harness.performAction<{
        reconciled: number;
        errors: number;
        scanned: number;
        complete: boolean;
      }>(ACTION_KEYS.reconcileLinearMirrors, { companyId: "comp-1", resetCursor: true });

      expect(result).toMatchObject({
        reconciled: 1,
        errors: 0,
        scanned: 1,
        complete: true,
      });
      expect(syncModule.syncToLinear).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          paperclipIssueId: "pc-issue-1",
          linearIssueId: "lin-issue-1",
          lastLinearStateType: "unstarted",
        }),
        {
          status: "done",
          projectId: "pc-project-current",
          labelIds: ["label-scope"],
        },
        "lin_token_123",
        "team-1",
        expect.objectContaining({ force: true }),
      );
    });

    it("skips linked Linear issues from another team during mirror reconciliation", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-issue-egy` },
        {
          paperclipIssueId: "pc-issue-egy",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-issue-egy",
          linearIdentifier: "EGY-216",
          linearUrl: "https://linear.app/blockcast/issue/EGY-216",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        },
      );
      harness.seed({
        issues: [
          {
            id: "pc-issue-egy",
            companyId: "comp-1",
            projectId: "pc-project-current",
            title: "Paperclip EGY current",
            status: "done",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            labelIds: [],
          } as never,
        ],
      });
      const { listIssuesByIds } = await import("../src/linear.js");
      (listIssuesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: "lin-issue-egy",
          identifier: "EGY-216",
          title: "Foreign team issue",
          description: null,
          team: { id: "team-egy", name: "Egypt", key: "EGY" },
          state: { name: "Todo", type: "unstarted" },
          priority: 3,
          url: "https://linear.app/blockcast/issue/EGY-216",
          assignee: null,
          labels: { nodes: [] },
          project: null,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        },
      ]);

      const result = await harness.performAction<{
        reconciled: number;
        errors: number;
        scanned: number;
        skippedOtherTeam: number;
        complete: boolean;
      }>(ACTION_KEYS.reconcileLinearMirrors, { companyId: "comp-1", resetCursor: true });

      expect(result).toMatchObject({
        reconciled: 0,
        errors: 0,
        scanned: 1,
        skippedOtherTeam: 1,
        complete: true,
      });
      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });

    it("pauses mirror reconciliation without advancing the cursor when Linear rate limits", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-issue-1` },
        {
          paperclipIssueId: "pc-issue-1",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-issue-1",
          linearIdentifier: "BLO-1",
          linearUrl: "https://linear.app/blockcast/issue/BLO-1",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        },
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-issue-2` },
        {
          paperclipIssueId: "pc-issue-2",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-issue-2",
          linearIdentifier: "BLO-2",
          linearUrl: "https://linear.app/blockcast/issue/BLO-2",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        },
      );

      const { listIssuesByIds } = await import("../src/linear.js");
      (listIssuesByIds as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Linear API error: 400 {\"extensions\":{\"code\":\"RATELIMITED\"}}"),
      );

      const result = await harness.performAction<{
        errors: number;
        scanned: number;
        rateLimited: boolean;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.reconcileLinearMirrors, {
        companyId: "comp-1",
        resetCursor: true,
        maxPerRun: 25,
      });
      const cursor = await harness.ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.linearMirrorReconcileOffset,
      });

      expect(result).toMatchObject({
        errors: 2,
        scanned: 2,
        rateLimited: true,
        complete: false,
        nextOffset: 0,
      });
      expect(cursor).toBe(0);
      expect(syncModule.syncToLinear).not.toHaveBeenCalled();
    });

    it("advances the mirror reconciliation cursor past completed entries before a rate limit", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      for (const suffix of ["1", "2", "3"]) {
        await harness.ctx.state.set(
          { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}pc-issue-${suffix}` },
          {
            paperclipIssueId: `pc-issue-${suffix}`,
            paperclipCompanyId: "comp-1",
            linearIssueId: `lin-issue-${suffix}`,
            linearIdentifier: `BLO-${suffix}`,
            linearUrl: `https://linear.app/blockcast/issue/BLO-${suffix}`,
            syncDirection: "bidirectional",
            lastSyncAt: "2020-01-01T00:00:00.000Z",
            lastLinearStateType: "unstarted",
            lastCommentSyncAt: null,
          },
        );
      }

      harness.seed({
        issues: ["1", "2", "3"].map((suffix) => ({
          id: `pc-issue-${suffix}`,
          companyId: "comp-1",
          projectId: "pc-project-current",
          title: `Paperclip issue ${suffix}`,
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          labelIds: [],
        } as never)),
      });

      const { listIssuesByIds } = await import("../src/linear.js");
      (listIssuesByIds as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        ["1", "2", "3"].map((suffix) => ({
          id: `lin-issue-${suffix}`,
          identifier: `BLO-${suffix}`,
          title: `Linear issue ${suffix}`,
          description: null,
          team: { id: "team-1", name: "Blockcast", key: "BLO" },
          state: { name: "Todo", type: "unstarted" },
          priority: 3,
          url: `https://linear.app/blockcast/issue/BLO-${suffix}`,
          assignee: null,
          labels: { nodes: [] },
          project: null,
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        })),
      );
      syncModule.syncToLinear
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Linear API error: 400 {\"extensions\":{\"code\":\"RATELIMITED\"}}"));

      const result = await harness.performAction<{
        reconciled: number;
        errors: number;
        scanned: number;
        rateLimited: boolean;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.reconcileLinearMirrors, {
        companyId: "comp-1",
        resetCursor: true,
        maxPerRun: 25,
      });
      const cursor = await harness.ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.linearMirrorReconcileOffset,
      });

      expect(result).toMatchObject({
        reconciled: 1,
        errors: 1,
        scanned: 3,
        rateLimited: true,
        complete: false,
        nextOffset: 1,
      });
      expect(cursor).toBe(1);
      expect(syncModule.syncToLinear).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Config validation
  // -----------------------------------------------------------------------

  describe("onValidateConfig", () => {
    it("warns when no auth is configured", async () => {
      const result = await plugin.definition.onValidateConfig!({});
      expect(result.ok).toBe(true);
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toContain("OAuth credentials");
    });

    it("passes when linearClientId is set", async () => {
      const result = await plugin.definition.onValidateConfig!({
        linearClientId: "abc",
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("passes when linearTokenRef is set", async () => {
      const result = await plugin.definition.onValidateConfig!({
        linearTokenRef: "secret-uuid-123",
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Token resolution
  // -----------------------------------------------------------------------

  describe("resolveToken via config secret ref", () => {
    it("resolves token from linearTokenRef config", async () => {
      harness.setConfig({
        linearClientId: "",
        linearClientSecret: "",
        linearTokenRef: "secret-uuid-abc",
        teamId: "team-1",
        syncComments: true,
        syncDirection: "bidirectional",
      });

      // Search tool internally calls resolveToken
      const result = await harness.executeTool(TOOL_NAMES.search, {
        query: "test",
      });

      // Should succeed — resolved via ctx.secrets.resolve
      expect(result.content).toContain("Found");
    });

    it("caches and coalesces linearTokenRef secret resolution", async () => {
      harness.setConfig({
        linearClientId: "",
        linearClientSecret: "",
        linearTokenRef: "secret-uuid-cache",
        teamId: "team-1",
        syncComments: true,
        syncDirection: "bidirectional",
      });
      const resolveSpy = vi.spyOn(harness.ctx.secrets, "resolve");

      const [first, second] = await Promise.all([
        harness.executeTool(TOOL_NAMES.search, { query: "first" }),
        harness.executeTool(TOOL_NAMES.search, { query: "second" }),
      ]);
      const third = await harness.executeTool(TOOL_NAMES.search, { query: "third" });

      expect(first.content).toContain("Found");
      expect(second.content).toContain("Found");
      expect(third.content).toContain("Found");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith("secret-uuid-cache");
    });
  });

  // -----------------------------------------------------------------------
  // Data: issue-link with existing link
  // -----------------------------------------------------------------------

  describe("data: issue-link with existing link", () => {
    it("returns full linear issue data when link exists and API succeeds", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/lucitra/issue/LUC-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2025-01-01T00:00:00Z",
      });

      const result = await harness.getData<{
        linked: boolean;
        linear: { identifier: string; title: string };
        syncDirection: string;
      }>(DATA_KEYS.issueLink, { issueId: "iss-1" });

      expect(result.linked).toBe(true);
      expect(result.linear.identifier).toBe("LUC-1");
      expect(result.linear.title).toBe("Test issue");
      expect(result.syncDirection).toBe("bidirectional");
    });

    it("returns cached data with fetchError when API fails", async () => {
      // No token = resolveToken will throw
      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/lucitra/issue/LUC-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2025-01-01T00:00:00Z",
      });

      const result = await harness.getData<{
        linked: boolean;
        fetchError: boolean;
        linear: { identifier: string };
      }>(DATA_KEYS.issueLink, { issueId: "iss-1" });

      expect(result.linked).toBe(true);
      expect(result.fetchError).toBe(true);
      expect(result.linear.identifier).toBe("LUC-1");
    });
  });

  // -----------------------------------------------------------------------
  // Tool: resolve-linear-binding
  // -----------------------------------------------------------------------

  describe("tool: resolve-linear-binding", () => {
    it("resolves plugin sync state to the bound Paperclip issue and project", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      harness.setConfig({ paperclipBaseUrl: "https://paperclip.test" });
      harness.seed({
        companies: [
          {
            id: "comp-1",
            name: "Blockcast",
            issuePrefix: "BLO",
          } as never,
        ],
        projects: [
          {
            id: "pc-proj-1",
            companyId: "comp-1",
            urlKey: "cloud-service",
            name: "Cloud Service",
            status: "active",
          } as never,
        ],
        issues: [
          {
            id: "pc-iss-1",
            companyId: "comp-1",
            projectId: "pc-proj-1",
            identifier: "BLO-3935",
            title: "Cloud service orchestration",
            status: "todo",
          } as never,
        ],
      });

      const { getIssueByIdentifier } = await import("../src/linear.js");
      (getIssueByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "lin-iss-1",
        identifier: "LUC-1",
        title: "Linear issue with divergent key",
        state: { name: "In Progress", type: "started" },
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: null,
        project: {
          id: "lin-proj-1",
          name: "Cloud Service",
          description: null,
          state: "started",
        },
      });
      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "pc-iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/lucitra/issue/LUC-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      });
      syncModule.getProjectLinkByLinear.mockResolvedValueOnce({
        paperclipProjectId: "pc-proj-1",
        paperclipCompanyId: "comp-1",
        linearProjectId: "lin-proj-1",
        linearProjectName: "Cloud Service",
        syncDirection: "bidirectional",
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearState: "started",
      });

      const result = await harness.executeTool(TOOL_NAMES.resolveBinding, {
        linearRef: "LUC-1",
      }, { companyId: "comp-1" });
      const data = result.data as any;

      expect(result.content).toContain("Linear LUC-1 is linked to Paperclip BLO-3935");
      expect(data.linked).toBe(true);
      expect(data.syncState).toBe("linked");
      expect(data.paperclip.issue).toMatchObject({
        id: "pc-iss-1",
        companyId: "comp-1",
        identifier: "BLO-3935",
        url: "https://paperclip.test/BLO/issues/BLO-3935",
      });
      expect(data.paperclip.project).toMatchObject({
        id: "pc-proj-1",
        name: "Cloud Service",
        url: "https://paperclip.test/BLO/projects/cloud-service",
      });
    });

    it("reports an unmapped Linear issue without guessing by issue number", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const result = await harness.executeTool(TOOL_NAMES.resolveBinding, {
        linearRef: "LUC-1",
      }, { companyId: "comp-1" });
      const data = result.data as any;

      expect(result.content).toContain("No Paperclip sync binding found for Linear LUC-1");
      expect(data.linked).toBe(false);
      expect(data.syncState).toBe("missing");
      expect(data.foundPaperclipMirror).toBe(false);
      expect(data.paperclip.issue).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Tool: set-linear-binding
  // -----------------------------------------------------------------------

  describe("tool: set-linear-binding", () => {
    it("sets an issue binding and infers the project binding from both issues", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      harness.setConfig({ paperclipBaseUrl: "https://paperclip.test" });
      harness.seed({
        companies: [
          {
            id: "comp-1",
            name: "Blockcast",
            issuePrefix: "BLO",
          } as never,
        ],
        projects: [
          {
            id: "pc-proj-1",
            companyId: "comp-1",
            urlKey: "cloud-service",
            name: "Cloud Service",
            status: "active",
          } as never,
        ],
        issues: [
          {
            id: "pc-iss-1",
            companyId: "comp-1",
            projectId: "pc-proj-1",
            identifier: "BLO-3935",
            title: "Cloud service orchestration",
            status: "todo",
          } as never,
        ],
      });

      const { attachmentLinkURL, ensureProjectLink, getIssueByIdentifier } = await import("../src/linear.js");
      (getIssueByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "lin-iss-1",
        identifier: "LUC-1",
        title: "Linear issue with divergent key",
        state: { name: "In Progress", type: "started" },
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: null,
        project: {
          id: "lin-proj-1",
          name: "Cloud Service",
          description: null,
          state: "started",
        },
      });

      const result = await harness.executeTool(TOOL_NAMES.setBinding, {
        linearRef: "LUC-1",
        paperclipIssueId: "pc-iss-1",
      }, { companyId: "comp-1" });
      const data = result.data as any;

      expect(result.content).toContain("issue LUC-1 -> BLO-3935");
      expect(result.content).toContain("project Cloud Service -> Cloud Service");
      expect(data.ok).toBe(true);
      expect(data.issueLinked).toBe(true);
      expect(data.projectLinked).toBe(true);
      expect(syncModule.createLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        paperclipIssueId: "pc-iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-1",
      }));
      expect(syncModule.createProjectLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        paperclipProjectId: "pc-proj-1",
        paperclipCompanyId: "comp-1",
        linearProjectId: "lin-proj-1",
        linearProjectName: "Cloud Service",
      }));
      expect(attachmentLinkURL).toHaveBeenCalledWith(expect.anything(), "lin_token_123", expect.objectContaining({
        issueId: "lin-iss-1",
        url: "https://paperclip.test/BLO/issues/BLO-3935",
        title: "Paperclip mirror: BLO-3935",
      }));
      expect(ensureProjectLink).toHaveBeenCalledWith(expect.anything(), "lin_token_123", expect.objectContaining({
        projectId: "lin-proj-1",
        url: "https://paperclip.test/BLO/projects/cloud-service",
        label: "Paperclip project",
      }));
    });
  });

  // -----------------------------------------------------------------------
  // Tool: link-linear-issue
  // -----------------------------------------------------------------------

  describe("tool: link-linear-issue", () => {
    it("links a Linear issue to a Paperclip issue", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const result = await harness.executeTool(TOOL_NAMES.link, {
        linearRef: "LUC-1",
        paperclipIssueId: "iss-1",
      });

      expect(result.content).toContain("Linked to LUC-1");
      expect((result.data as any).linked).toBe(true);
      expect(syncModule.createLink).toHaveBeenCalledOnce();
    });

    it("rejects invalid reference format", async () => {
      const result = await harness.executeTool(TOOL_NAMES.link, {
        linearRef: "not-valid",
        paperclipIssueId: "iss-1",
      });

      expect(result.content).toContain("Error");
      expect((result.data as any).error).toContain("Could not parse");
    });

    it("rejects when issue is already linked", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-1",
        linearIdentifier: "LUC-99",
        syncDirection: "bidirectional",
      });

      const result = await harness.executeTool(TOOL_NAMES.link, {
        linearRef: "LUC-1",
        paperclipIssueId: "iss-1",
      });

      expect(result.content).toContain("Error");
      expect((result.data as any).error).toContain("Already linked");
    });
  });

  // -----------------------------------------------------------------------
  // issue.created event (Paperclip → Linear)
  // -----------------------------------------------------------------------

  describe("issue.created event", () => {
    it("creates a Linear issue and link when no existing link", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        { id: "iss-new", title: "New Paperclip Issue", description: "Test", priority: "high" },
        { entityId: "iss-new", companyId: "comp-1" },
      );

      expect(createIssue).toHaveBeenCalledOnce();
      expect(syncModule.createLink).toHaveBeenCalledOnce();
      expect(harness.activity.some((a) => a.message === "issue.pushed_to_linear")).toBe(true);
    });

    it("skips Paperclip issues from a different company than the connected Linear company", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        "team-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        { id: "iss-other", title: "Other company issue", companyId: "comp-2" },
        { entityId: "iss-other", companyId: "comp-2" },
      );

      expect(createIssue).not.toHaveBeenCalled();
      expect(syncModule.createLink).not.toHaveBeenCalled();
      expect(harness.activity).toHaveLength(0);
    });

    it("skips when source is linear (prevents feedback loop)", async () => {
      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        { id: "iss-1", title: "From Linear", source: "linear" },
        { entityId: "iss-1" },
      );

      expect(createIssue).not.toHaveBeenCalled();
    });

    it("skips when issue is already linked", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-1",
        syncDirection: "bidirectional",
      });

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        { id: "iss-1", title: "Already Linked" },
        { entityId: "iss-1" },
      );

      expect(createIssue).not.toHaveBeenCalled();
    });

    it("skips when syncDirection is linear-to-paperclip", async () => {
      harness.setConfig({
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        syncDirection: "linear-to-paperclip",
      });

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        { id: "iss-1", title: "Should Skip" },
        { entityId: "iss-1" },
      );

      expect(createIssue).not.toHaveBeenCalled();
    });

    // BLO-3763/3764 regression: webhook-imported mirrors (created via the
    // Issue.create webhook handler with originKind=ORIGIN_KIND_SELF) must NOT
    // be pushed back to Linear. The `recentlyCreatedFromLinear` Set defense
    // races with this event handler — Set.add runs AFTER ctx.issues.create
    // resolves, but the event can fire in a microtask before that. The
    // originKind gate is race-safe because the field is persisted inside the
    // issue insert and surfaces via the event payload before the handler runs.
    //
    // Before the gate: filing an issue via Linear API spawned a duplicate
    // Linear issue 1.4–5s later (observed on 2026-05-11 across ~85 historical
    // pairs in the BLO backlog).
    it("BLO-3763/3764: skips when originKind=ORIGIN_KIND_SELF (race-safe webhook-mirror defense)", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        {
          id: "iss-mirror",
          title: "Webhook-imported mirror",
          originKind: "plugin:paperclip-plugin-linear",
        },
        { entityId: "iss-mirror" },
      );

      expect(createIssue).not.toHaveBeenCalled();
      expect(syncModule.createLink).not.toHaveBeenCalled();
    });

    it("BLO-3763/3764: skips when originKind has a sub-origin extension (forward-compat)", async () => {
      // `normalizePluginOriginKind` in plugin-host-services.ts permits
      // sub-origin extensions like `ORIGIN_KIND_SELF + ":<sub>"`. The gate
      // must accept those too, otherwise any future sub-origin path silently
      // bypasses the defense and re-opens the duplicate-loop.
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const { createIssue } = await import("../src/linear.js");

      await harness.emit(
        "issue.created",
        {
          id: "iss-mirror-sub",
          title: "Sub-origin webhook mirror",
          originKind: "plugin:paperclip-plugin-linear:backfill",
        },
        { entityId: "iss-mirror-sub" },
      );

      expect(createIssue).not.toHaveBeenCalled();
      expect(syncModule.createLink).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Webhook: project adoption
  // -----------------------------------------------------------------------

  describe("webhook: project adoption", () => {
    it("adopts an existing Paperclip project by name instead of creating a duplicate", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      harness.seed({
        companies: [
          {
            id: "comp-1",
            name: "Blockcast",
            issuePrefix: "BLO",
          } as never,
        ],
        projects: [
          {
            id: "pc-proj-demand",
            companyId: "comp-1",
            urlKey: "demand-smb-2",
            name: "Demand: SMB 2",
            status: "active",
          } as never,
        ],
      });

      const createProjectSpy = vi.spyOn(harness.ctx.projects, "create");
      const body = {
        action: "create",
        type: "Project",
        data: {
          id: "lin-proj-demand",
          name: "Demand: SMB 2",
          description: "Linear project",
          state: "started",
        },
      };

      await plugin.definition.onWebhook!({
        headers: {},
        rawBody: JSON.stringify(body),
        parsedBody: body,
        requestId: "test-webhook-project-adoption",
      });

      expect(createProjectSpy).not.toHaveBeenCalled();
      expect(syncModule.createProjectLink).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        paperclipProjectId: "pc-proj-demand",
        paperclipCompanyId: "comp-1",
        linearProjectId: "lin-proj-demand",
        linearProjectName: "Demand: SMB 2",
      }));
      expect(syncModule.syncProjectFromLinear).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paperclipProjectId: "pc-proj-demand" }),
        expect.objectContaining({ id: "lin-proj-demand", name: "Demand: SMB 2" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Webhook: duplicate prevention
  // -----------------------------------------------------------------------

  describe("webhook: duplicate issue prevention", () => {
    it("skips creating a Paperclip issue from Linear webhook by default", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const createSpy = vi.spyOn(harness.ctx.issues, "create");

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-default-skip-1",
            identifier: "LUC-49",
            title: "Skipped from Linear",
            description: "Test",
            priority: 3,
            state: { type: "started", name: "In Progress" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req-default-skip",
      });

      expect(createSpy).not.toHaveBeenCalled();
      expect(syncModule.createLink).not.toHaveBeenCalled();
      expect(harness.activity.some((a) => a.message === "issue.synced_from_linear")).toBe(false);
      expect(
        harness.logs.some(
          (l) => l.level === "info" &&
            l.message.includes("Skipping Linear issue.create webhook for LUC-49") &&
            l.message.includes("disableLinearOriginatedCreates=true"),
        ),
      ).toBe(true);
    });

    it("creates a Paperclip issue from Linear webhook when disableLinearOriginatedCreates is false", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-new-1",
            identifier: "LUC-50",
            title: "New from Linear",
            description: "Test",
            priority: 3,
            state: { type: "started", name: "In Progress" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      expect(harness.activity.some((a) => a.message === "issue.synced_from_linear")).toBe(true);
      expect(syncModule.createLink).toHaveBeenCalled();
    });

    it("syncs issue updates even when Linear-originated creates are disabled", async () => {
      harness.setConfig({ disableLinearOriginatedCreates: true });
      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "iss-linked-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-linked-1",
        linearIdentifier: "LUC-52",
        linearUrl: "https://linear.app/lucitra/issue/LUC-52",
        syncDirection: "bidirectional",
        lastLinearStateType: "backlog",
      });

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "update",
          data: {
            id: "lin-linked-1",
            identifier: "LUC-52",
            title: "Updated linked issue",
            state: { type: "started", name: "In Progress" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req-update-flag",
      });

      expect(syncModule.syncFromLinear).toHaveBeenCalledOnce();
    });

    it("bridges comments even when Linear-originated creates are disabled", async () => {
      harness.setConfig({ disableLinearOriginatedCreates: true });
      const paperclipIssue = await harness.ctx.issues.create({
        companyId: "comp-1",
        title: "Issue with Linear comments",
      });
      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: paperclipIssue.id,
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-linked-comment-1",
        linearIdentifier: "LUC-53",
        linearUrl: "https://linear.app/lucitra/issue/LUC-53",
        syncDirection: "bidirectional",
      });

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Comment",
          action: "create",
          data: {
            id: "lin-comment-flag-1",
            body: "Still sync me",
            issue: { id: "lin-linked-comment-1" },
            user: { name: "Linear Author" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req-comment-flag",
      });

      const comments = await harness.ctx.issues.listComments(paperclipIssue.id, "comp-1");
      expect(comments.some((c) => c.body.includes("Still sync me"))).toBe(true);
    });

    it("BLO-3780: writes Paperclip back-link on webhook-driven creation", async () => {
      // PR-130 (Blockcast/paperclip#130) wired the back-link write into the
      // polling import path only. The webhook handler creates the mirror
      // (Issue.create event) but originally did not call attachmentLinkURL —
      // so every fresh Linear ticket that hit the webhook path got no
      // auto back-link. This test pins the BLO-3780 fix: same shared
      // writePaperclipBackLink helper is invoked from the webhook path with
      // the same URL/title shape as the polling tests above.
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          disableLinearOriginatedCreates: false,
          // best-effort=true to avoid throwing if the mocked Linear fetch
          // returns something unexpected — assertion is on the call itself.
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      vi.spyOn(harness.ctx.issues, "create").mockResolvedValue({
        id: "pcp-iss-wh-1",
        identifier: "LUC-W100",
      } as never);
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-wh-1",
            identifier: "LUC-W1",
            title: "Webhook create",
            description: "test",
            priority: 3,
            state: { type: "started", name: "In Progress" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      expect(attachmentLinkURL).toHaveBeenCalledOnce();
      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg).toMatchObject({
        issueId: "lin-wh-1",
        url: "https://paperclip.test/LUC/issues/LUC-W100",
        title: "Paperclip mirror: LUC-W100",
        subtitle: "LUC-W100 - Webhook create",
        iconUrl: "https://paperclip.test/favicon-32x32.png",
        groupBySource: true,
        metadata: {
          source: "paperclip",
          sourceType: "paperclip",
          service: "paperclip",
          paperclipIssueId: "pcp-iss-wh-1",
          paperclipIdentifier: "LUC-W100",
          linearIdentifier: "LUC-W1",
          url: "https://paperclip.test/LUC/issues/LUC-W100",
        },
      });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Paperclip issue", value: "LUC-W100" });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Linear issue", value: "LUC-W1" });
    });

    it("skips duplicate webhook for the same Linear issue ID", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      // First call creates the link
      syncModule.getLinkByLinear.mockResolvedValueOnce(null);
      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-dup-1",
            identifier: "LUC-51",
            title: "First create",
            state: { type: "backlog" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      // Second call — link now exists so should be skipped
      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "iss-1",
        linearIssueId: "lin-dup-1",
        syncDirection: "bidirectional",
      });

      const createLinkCallsBefore = syncModule.createLink.mock.calls.length;

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-dup-1",
            identifier: "LUC-51",
            title: "Duplicate create",
            state: { type: "backlog" },
          },
        },
        headers: {},
        rawBody: "",
        // Distinct requestId from the first delivery so this test still
        // exercises the linearIssueId-based dedup path even if the plugin
        // later adds requestId-based idempotency (which would otherwise
        // mask a regression in the actual dedup mechanism being tested).
        requestId: "test-webhook-req-dup",
      });

      // createLink should NOT have been called again
      expect(syncModule.createLink.mock.calls.length).toBe(createLinkCallsBefore);
    });

    // 2026-05-03 cutover-incident regression. Under
    // companies.identifier_provider='linear', a manual `paperclipCreateIssue`
    // (or any non-plugin caller) goes through the host allocator → mints a
    // Linear issue + writes a `linear_issue_links` row → fires a Linear
    // `Issue.create` webhook back to the plugin. The webhook handler's
    // pre-existing dedup chain (`sync.getLinkByLinear`, `inFlightCreates`,
    // `existingByOrigin` filtered to `originKind='plugin:paperclip-plugin-linear'`)
    // missed the host-allocator mirror because its originKind is the caller's
    // (e.g. 'manual'), not the plugin's. The handler proceeded to create a
    // SECOND mirror, which minted ANOTHER Linear issue, which fired ANOTHER
    // webhook — runaway loop produced 305 noise Linear issues + 161 paperclip
    // rows in ~2 minutes.
    //
    // This test pins the new `ctx.issues.getByLinearIssueId` dedup branch.
    // If any future change to the dedup ordering or the link-table schema
    // re-opens the gap, this test catches it before the next deploy.
    it("regression — skips webhook create for host-allocator-mirrored issue (pre-existing linear_issue_links row)", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      // Seed a paperclip issue with originKind='manual' (the cutover-incident
      // shape) and a linear_issue_links row pointing at the inbound webhook's
      // Linear UUID. Without the new dedup, the webhook would create a
      // duplicate mirror and mint another Linear issue.
      const PAPERCLIP_ISSUE_ID = "iss-host-allocator-mirror";
      const LINEAR_ISSUE_ID = "lin-host-allocator-mirror-uuid";
      harness.seed({
        issues: [
          {
            id: PAPERCLIP_ISSUE_ID,
            companyId: "comp-1",
            identifier: "LUC-2569",
            originKind: "manual",
            title: "Host-allocator-mirrored manual create",
          } as never,
        ],
        linearIssueLinks: [
          {
            companyId: "comp-1",
            linearIssueId: LINEAR_ISSUE_ID,
            paperclipIssueId: PAPERCLIP_ISSUE_ID,
          },
        ],
      });

      // Plugin-state link is empty (host allocator path doesn't write it),
      // so `sync.getLinkByLinear` returns null — exactly the production
      // condition that exposed the gap.
      syncModule.getLinkByLinear.mockResolvedValueOnce(null);

      const createLinkCallsBefore = syncModule.createLink.mock.calls.length;

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: LINEAR_ISSUE_ID,
            identifier: "LUC-2569",
            title: "Webhook re-delivery for host-allocator mirror",
            state: { type: "backlog" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      // No new mirror should have been created. createLink stays untouched.
      expect(syncModule.createLink.mock.calls.length).toBe(createLinkCallsBefore);
    });
  });

  // -----------------------------------------------------------------------
  // BLO-2973: Comment webhook idempotency (no double-post on retry)
  // -----------------------------------------------------------------------

  describe("BLO-2973: comment webhook idempotency", () => {
    it("does not double-post when the same Linear comment webhook fires twice", async () => {
      // Set up: a paperclip issue + a link mapping it to the inbound Linear issue.
      const paperclipIssue = await harness.ctx.issues.create({
        companyId: "comp-1",
        title: "Issue with Linear comments",
      });
      syncModule.getLinkByLinear.mockResolvedValue({
        paperclipIssueId: paperclipIssue.id,
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-100",
        linearUrl: "https://linear.app/lucitra/issue/LUC-100",
        syncDirection: "bidirectional",
      });

      const commentPayload = {
        type: "Comment",
        action: "create" as const,
        data: {
          id: "lin-comment-uuid-42",
          body: "Hello from Linear",
          issue: { id: "lin-iss-1" },
          user: { name: "Linear Author" },
        },
      };

      // First webhook delivery — should create the bridged comment.
      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: commentPayload,
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      // Second delivery — Linear retried (or our retry layer fired again).
      // Should be detected as a duplicate via the embedded sentinel and skipped.
      // Distinct requestId so this test still exercises the comment-id
      // sentinel dedup path even if requestId-based idempotency lands later.
      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: commentPayload,
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req-retry",
      });

      const comments = await harness.ctx.issues.listComments(paperclipIssue.id, "comp-1");
      const bridged = comments.filter((c) => c.body.includes("(from Linear)"));
      expect(bridged).toHaveLength(1);
      // Sentinel must be present so future webhook deliveries can detect it.
      expect(bridged[0]!.body).toContain("<!-- linear-comment-id: lin-comment-uuid-42 -->");

      // (Per-test mock-reset cleanup removed — beforeEach now restores
      // syncModule defaults systematically via restoreSyncModuleDefaults.)
    });
  });

  // -----------------------------------------------------------------------
  // Jobs
  // -----------------------------------------------------------------------

  describe("jobs", () => {
    it("declares periodic-sync on a six-hour schedule", () => {
      const job = manifest.jobs?.find((candidate) => candidate.jobKey === JOB_KEYS.periodicSync);

      expect(job?.schedule).toBe("0 */6 * * *");
    });

    it("registers periodic-sync job", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await expect(harness.runJob(JOB_KEYS.periodicSync)).resolves.not.toThrow();
    });

    it("relinks an existing Paperclip project by name before creating a mirror", async () => {
      const linearModule = await import("../src/linear.js");
      vi.mocked(linearModule.listProjects).mockResolvedValueOnce([
        {
          id: "lin-project-1",
          name: "Supply Portal — Backend API & DB",
          description: "Canonical Linear project",
          state: "started",
          startDate: null,
          targetDate: null,
        },
      ]);
      syncModule.linearProjectStateToPaperclip.mockReturnValue("in_progress");

      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      vi.spyOn(harness.ctx.projects, "list").mockResolvedValueOnce([
        {
          id: "paperclip-project-1",
          companyId: "comp-1",
          name: "Supply Portal — Backend API & DB",
          description: null,
          status: "cancelled",
        } as never,
      ]);
      const updateProject = vi.spyOn(harness.ctx.projects, "update").mockResolvedValue({} as never);
      const createProject = vi.spyOn(harness.ctx.projects, "create").mockResolvedValue({ id: "new-project" } as never);

      await harness.runJob(JOB_KEYS.periodicSync);

      expect(syncModule.createProjectLink).toHaveBeenCalledWith(
        harness.ctx,
        expect.objectContaining({
          paperclipProjectId: "paperclip-project-1",
          linearProjectId: "lin-project-1",
          linearProjectName: "Supply Portal — Backend API & DB",
        }),
      );
      expect(updateProject).toHaveBeenCalledWith(
        "paperclip-project-1",
        expect.objectContaining({
          description: "Canonical Linear project",
          name: "Supply Portal — Backend API & DB",
          status: "in_progress",
        }),
        "comp-1",
      );
      expect(createProject).not.toHaveBeenCalled();
    });

    it("bulk import relinks a host-linked Paperclip issue before creating a duplicate", async () => {
      const linearModule = await import("../src/linear.js");
      const linearIssue = {
        id: "lin-issue-host-linked",
        identifier: "BLO-2955",
        title: "Supply Portal backend register endpoint",
        description: "Canonical Linear description",
        state: { name: "In Progress", type: "started" },
        priority: 2,
        url: "https://linear.app/blockc/issue/BLO-2955/supply-portal-backend-register-endpoint",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };
      vi.mocked(linearModule.listOpenIssues).mockResolvedValueOnce({
        issues: [linearIssue],
        hasNextPage: false,
        endCursor: null,
      });

      harness.seed({
        issues: [
          {
            id: "paperclip-host-linked",
            companyId: "comp-1",
            identifier: "BLO-3216",
            title: "Old title",
            status: "backlog",
            priority: "low",
            originKind: "manual",
            originId: null,
          } as never,
        ],
        linearIssueLinks: [
          {
            companyId: "comp-1",
            linearIssueId: "lin-issue-host-linked",
            paperclipIssueId: "paperclip-host-linked",
          },
        ],
      });
      const createIssue = vi.spyOn(harness.ctx.issues, "create");
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      await harness.performAction(ACTION_KEYS.triggerImport, { companyId: "comp-1" });

      expect(createIssue).not.toHaveBeenCalled();
      expect(syncModule.createLink).toHaveBeenCalledWith(
        harness.ctx,
        expect.objectContaining({
          paperclipIssueId: "paperclip-host-linked",
          linearIssueId: "lin-issue-host-linked",
          linearIdentifier: "BLO-2955",
        }),
      );
      const updated = await harness.ctx.issues.get("paperclip-host-linked", "comp-1");
      expect(updated).toMatchObject({
        title: "Supply Portal backend register endpoint",
        status: "backlog",
        priority: "high",
        originKind: "plugin:paperclip-plugin-linear",
        originId: "lin-issue-host-linked",
      });
    });

    it("bulk import relinks an exact-title Paperclip issue before creating a mirror", async () => {
      const linearModule = await import("../src/linear.js");
      const linearIssue = {
        id: "lin-issue-title-match",
        identifier: "BLO-2960",
        title: "Supply Portal backend SIWS auth",
        description: null,
        state: { name: "Backlog", type: "backlog" },
        priority: 3,
        url: "https://linear.app/blockc/issue/BLO-2960/supply-portal-backend-siws-auth",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };
      vi.mocked(linearModule.listOpenIssues).mockResolvedValueOnce({
        issues: [linearIssue],
        hasNextPage: false,
        endCursor: null,
      });

      harness.seed({
        issues: [
          {
            id: "paperclip-title-match",
            companyId: "comp-1",
            identifier: "BLO-3222",
            title: "Supply Portal backend SIWS auth",
            status: "cancelled",
            priority: "low",
            originKind: "manual",
            originId: null,
          } as never,
        ],
      });
      const createIssue = vi.spyOn(harness.ctx.issues, "create");

      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      await harness.performAction(ACTION_KEYS.triggerImport, { companyId: "comp-1" });

      expect(createIssue).not.toHaveBeenCalled();
      expect(syncModule.createLink).toHaveBeenCalledWith(
        harness.ctx,
        expect.objectContaining({
          paperclipIssueId: "paperclip-title-match",
          linearIssueId: "lin-issue-title-match",
          linearIdentifier: "BLO-2960",
        }),
      );
      const updated = await harness.ctx.issues.get("paperclip-title-match", "comp-1");
      expect(updated).toMatchObject({
        status: "backlog",
        priority: "medium",
        originKind: "plugin:paperclip-plugin-linear",
        originId: "lin-issue-title-match",
      });
    });

    it("syncs persisted Linear links without crawling every open Linear issue", async () => {
      const { listIssuesByIds, listOpenIssues } = await import("../src/linear.js");
      const linkOne = {
        paperclipIssueId: "pc-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-1",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/lucitra/issue/LUC-1",
        syncDirection: "bidirectional" as const,
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "backlog",
        lastCommentSyncAt: null,
      };
      const linkTwo = {
        paperclipIssueId: "pc-2",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-2",
        linearIdentifier: "LUC-2",
        linearUrl: "https://linear.app/lucitra/issue/LUC-2",
        syncDirection: "linear-to-paperclip" as const,
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      };
      const linearOne = {
        id: "lin-1",
        identifier: "LUC-1",
        title: "Linked one",
        description: null,
        state: { name: "Done", type: "completed" },
        priority: 2,
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };
      const linearTwo = {
        id: "lin-2",
        identifier: "LUC-2",
        title: "Linked two",
        description: null,
        state: { name: "In Progress", type: "started" },
        priority: 3,
        url: "https://linear.app/lucitra/issue/LUC-2",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };

      vi.mocked(listIssuesByIds).mockResolvedValueOnce([linearOne, linearTwo]);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${linkOne.paperclipIssueId}` },
        linkOne,
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${linkTwo.paperclipIssueId}` },
        linkTwo,
      );

      await expect(harness.runJob(JOB_KEYS.periodicSync)).resolves.not.toThrow();

      expect(listOpenIssues).not.toHaveBeenCalled();
      expect(listIssuesByIds).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        ["lin-1", "lin-2"],
      );
      expect(syncModule.getLinkByLinear).not.toHaveBeenCalled();
      expect(syncModule.syncFromLinear).toHaveBeenCalledWith(harness.ctx, linkOne, linearOne);
      expect(syncModule.syncFromLinear).toHaveBeenCalledWith(harness.ctx, linkTwo, linearTwo);
    });

    it("skips persisted Linear issue links from other companies during scoped full sync", async () => {
      const { listIssuesByIds } = await import("../src/linear.js");
      const currentLink = {
        paperclipIssueId: "pc-current",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-current",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/lucitra/issue/LUC-1",
        syncDirection: "bidirectional" as const,
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "backlog",
        lastCommentSyncAt: null,
      };
      const otherLink = {
        paperclipIssueId: "pc-other",
        paperclipCompanyId: "comp-2",
        linearIssueId: "lin-other",
        linearIdentifier: "PEN-1",
        linearUrl: "https://linear.app/penstock/issue/PEN-1",
        syncDirection: "bidirectional" as const,
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "backlog",
        lastCommentSyncAt: null,
      };
      const linearCurrent = {
        id: "lin-current",
        identifier: "LUC-1",
        title: "Current company",
        description: null,
        state: { name: "Done", type: "completed" },
        priority: 2,
        url: "https://linear.app/lucitra/issue/LUC-1",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };

      vi.mocked(listIssuesByIds).mockResolvedValueOnce([linearCurrent]);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${currentLink.paperclipIssueId}` },
        currentLink,
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${otherLink.paperclipIssueId}` },
        otherLink,
      );

      const result = await harness.performAction<{
        synced: number;
        errors: number;
        scanned: number;
        skippedOtherCompany: number;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.triggerSync, {}, { companyId: "comp-1" });

      expect(result).toMatchObject({
        synced: 1,
        errors: 0,
        scanned: 2,
        skippedOtherCompany: 1,
        complete: true,
        nextOffset: 0,
      });
      expect(listIssuesByIds).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        ["lin-current"],
      );
      expect(syncModule.syncFromLinear).toHaveBeenCalledTimes(1);
      expect(syncModule.syncFromLinear).toHaveBeenCalledWith(harness.ctx, currentLink, linearCurrent);
    });

    it("bounds periodic linked issue sync and resumes from the stored cursor", async () => {
      const { listIssuesByIds, listProjects } = await import("../src/linear.js");
      const issueCount = 125;
      const makeLink = (index: number) => {
        const padded = String(index).padStart(3, "0");
        return {
          paperclipIssueId: `pc-${padded}`,
          paperclipCompanyId: "comp-1",
          linearIssueId: `lin-${padded}`,
          linearIdentifier: `LUC-${index + 1}`,
          linearUrl: `https://linear.app/lucitra/issue/LUC-${index + 1}`,
          syncDirection: "bidirectional" as const,
          lastSyncAt: "2026-06-09T00:00:00.000Z",
          lastLinearStateType: "started",
          lastCommentSyncAt: null,
        };
      };
      const makeLinearIssue = (id: string) => {
        const index = Number(id.slice("lin-".length));
        return {
          id,
          identifier: `LUC-${index + 1}`,
          title: `Linked ${index + 1}`,
          description: null,
          state: { name: "In Progress", type: "started" },
          priority: 3,
          url: `https://linear.app/lucitra/issue/LUC-${index + 1}`,
          assignee: null,
          labels: { nodes: [] },
          project: null,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        };
      };

      vi.mocked(listIssuesByIds).mockImplementation(async (_fetch, _token, ids) => ids.map(makeLinearIssue));
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      for (let index = 0; index < issueCount; index++) {
        const link = makeLink(index);
        await harness.ctx.state.set(
          { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${link.paperclipIssueId}` },
          link,
        );
      }

      const first = await harness.performAction<{
        synced: number;
        errors: number;
        scanned: number;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.triggerSync);

      expect(first).toMatchObject({
        synced: 100,
        errors: 0,
        scanned: 100,
        complete: false,
        nextOffset: 100,
      });
      expect(syncModule.syncFromLinear).toHaveBeenCalledTimes(100);
      expect(harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.periodicLinkSyncOffset })).toBe(100);
      expect(listProjects).not.toHaveBeenCalled();

      const second = await harness.performAction<{
        synced: number;
        errors: number;
        scanned: number;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.triggerSync);

      expect(second).toMatchObject({
        synced: 25,
        errors: 0,
        scanned: 25,
        complete: true,
        nextOffset: 0,
      });
      expect(syncModule.syncFromLinear).toHaveBeenCalledTimes(125);
      expect(harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.periodicLinkSyncOffset })).toBe(0);
      expect(listProjects).toHaveBeenCalledTimes(1);
    });

    it("removes stale persisted links when the Linear issue is gone without skipping the shifted cursor", async () => {
      const { listIssuesByIds } = await import("../src/linear.js");
      const issueCount = 101;
      const makeLink = (index: number) => {
        const padded = String(index).padStart(3, "0");
        return {
          paperclipIssueId: `pc-${padded}`,
          paperclipCompanyId: "comp-1",
          linearIssueId: `lin-${padded}`,
          linearIdentifier: `LUC-${index + 1}`,
          linearUrl: `https://linear.app/lucitra/issue/LUC-${index + 1}`,
          syncDirection: "bidirectional" as const,
          lastSyncAt: "2026-06-09T00:00:00.000Z",
          lastLinearStateType: "started",
          lastCommentSyncAt: null,
        };
      };
      const makeLinearIssue = (id: string) => {
        const index = Number(id.slice("lin-".length));
        return {
          id,
          identifier: `LUC-${index + 1}`,
          title: `Linked ${index + 1}`,
          description: null,
          state: { name: "In Progress", type: "started" },
          priority: 3,
          url: `https://linear.app/lucitra/issue/LUC-${index + 1}`,
          assignee: null,
          labels: { nodes: [] },
          project: null,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        };
      };

      vi.mocked(listIssuesByIds).mockImplementation(async (_fetch, _token, ids) => (
        ids.filter((id) => id !== "lin-000").map(makeLinearIssue)
      ));
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      for (let index = 0; index < issueCount; index++) {
        const link = makeLink(index);
        await harness.ctx.state.set(
          { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${link.paperclipIssueId}` },
          link,
        );
      }

      const result = await harness.performAction<{
        synced: number;
        errors: number;
        scanned: number;
        complete: boolean;
        nextOffset: number;
      }>(ACTION_KEYS.triggerSync);

      expect(result).toMatchObject({
        synced: 99,
        errors: 0,
        scanned: 100,
        complete: false,
        nextOffset: 99,
      });
      expect(syncModule.removeLink).toHaveBeenCalledWith(harness.ctx, "pc-000");
      expect(harness.getState({ scopeKind: "instance", stateKey: STATE_KEYS.periodicLinkSyncOffset })).toBe(99);
    });

    it("removes stale persisted links when the Paperclip issue is gone", async () => {
      const { listIssuesByIds } = await import("../src/linear.js");
      const link = {
        paperclipIssueId: "pc-missing",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-stale",
        linearIdentifier: "LUC-404",
        linearUrl: "https://linear.app/lucitra/issue/LUC-404",
        syncDirection: "bidirectional" as const,
        lastSyncAt: "2026-06-09T00:00:00.000Z",
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      };
      const linearIssue = {
        id: "lin-stale",
        identifier: "LUC-404",
        title: "Gone in Paperclip",
        description: null,
        state: { name: "In Progress", type: "started" },
        priority: 3,
        url: "https://linear.app/lucitra/issue/LUC-404",
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "2026-06-09T00:00:00.000Z",
        updatedAt: "2026-06-09T00:00:00.000Z",
      };

      vi.mocked(listIssuesByIds).mockResolvedValueOnce([linearIssue]);
      syncModule.syncFromLinear.mockRejectedValueOnce(new Error("Issue not found"));
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.linkPrefix}${link.paperclipIssueId}` },
        link,
      );

      await expect(harness.runJob(JOB_KEYS.periodicSync)).resolves.not.toThrow();

      expect(syncModule.removeLink).toHaveBeenCalledWith(harness.ctx, "pc-missing");
    });

    it("backs off project drift updates after invocation-scope denial", async () => {
      const { listProjects } = await import("../src/linear.js");
      vi.mocked(listProjects).mockResolvedValueOnce([
        {
          id: "lin-proj-1",
          name: "Project one",
          description: null,
          state: "started",
          url: "https://linear.app/lucitra/project/project-one",
        },
        {
          id: "lin-proj-2",
          name: "Project two",
          description: null,
          state: "planned",
          url: "https://linear.app/lucitra/project/project-two",
        },
      ]);
      syncModule.getProjectLinkByLinear.mockImplementation(async (_ctx: unknown, linearProjectId: string) => ({
        paperclipProjectId: linearProjectId === "lin-proj-1" ? "pc-proj-1" : "pc-proj-2",
        paperclipCompanyId: "comp-1",
        linearProjectId,
        linearProjectName: linearProjectId === "lin-proj-1" ? "Project one" : "Project two",
        lastLinearState: "planned",
        syncDirection: "bidirectional",
        lastSyncAt: "2026-06-09T00:00:00.000Z",
      }));
      syncModule.syncProjectFromLinear.mockResolvedValueOnce("unavailable");

      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      await expect(harness.runJob(JOB_KEYS.periodicSync)).resolves.not.toThrow();

      expect(syncModule.syncProjectFromLinear).toHaveBeenCalledTimes(1);
      expect(syncModule.getProjectLinkByLinear).toHaveBeenCalledTimes(2);
    });

    it("registers initial-import job", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );
      await expect(harness.runJob(JOB_KEYS.initialImport)).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // backfill-backlinks action
  // -----------------------------------------------------------------------

  describe("backfill-backlinks action", () => {
    it("pages mirrors and writes one back-link per linked issue, then completes", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      // Two mirrored issues on first page, empty array on second (sweep done).
      vi.spyOn(harness.ctx.issues, "list")
        .mockResolvedValueOnce([
          { id: "pcp-1", identifier: "BLO-1", title: "Issue one" },
          { id: "pcp-2", identifier: "BLO-2", title: "Issue two" },
        ] as never)
        .mockResolvedValueOnce([] as never);

      // Both issues have links in sync state.
      syncModule.getLink
        .mockResolvedValueOnce({
          paperclipIssueId: "pcp-1",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-1",
          linearIdentifier: "LIN-1",
          linearUrl: "https://linear.app/t/LIN-1",
          syncDirection: "bidirectional",
          lastSyncAt: new Date().toISOString(),
          lastLinearStateType: "started",
          lastCommentSyncAt: null,
        })
        .mockResolvedValueOnce({
          paperclipIssueId: "pcp-2",
          paperclipCompanyId: "comp-1",
          linearIssueId: "lin-2",
          linearIdentifier: "LIN-2",
          linearUrl: "https://linear.app/t/LIN-2",
          syncDirection: "bidirectional",
          lastSyncAt: new Date().toISOString(),
          lastLinearStateType: "started",
          lastCommentSyncAt: null,
        });

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      const result = await harness.performAction<{ backfilled: number; done: boolean }>(
        ACTION_KEYS.backfillBackLinks,
        { companyId: "comp-1" },
      );

      expect(result.backfilled).toBe(2);
      expect(attachmentLinkURL).toHaveBeenCalledTimes(2);

      const calls = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![2]).toMatchObject({ url: "https://paperclip.test/BLO/issues/BLO-1" });
      expect(calls[1]![2]).toMatchObject({ url: "https://paperclip.test/BLO/issues/BLO-2" });
    });

    it("backfills Linear project external links from stored Paperclip project bindings", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      harness.seed({
        companies: [
          {
            id: "comp-1",
            name: "Blockcast",
            issuePrefix: "BLO",
          } as never,
        ],
        projects: [
          {
            id: "pc-proj-1",
            companyId: "comp-1",
            urlKey: "cloud-service",
            name: "Cloud Service",
            description: "Paperclip project description",
            status: "active",
          } as never,
        ],
      });
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-1` },
        {
          paperclipProjectId: "pc-proj-1",
          paperclipCompanyId: "comp-1",
          linearProjectId: "lin-proj-1",
          linearProjectName: "Cloud Service",
          syncDirection: "bidirectional",
          lastSyncAt: new Date().toISOString(),
          lastLinearState: "started",
        },
      );

      const { attachmentLinkURL, ensureProjectLink } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();
      (ensureProjectLink as ReturnType<typeof vi.fn>).mockClear();

      const result = await harness.performAction<{
        backfilled: number;
        issueBackfilled: number;
        projectBackfilled: number;
        projectsDone: boolean;
      }>(
        ACTION_KEYS.backfillBackLinks,
        { companyId: "comp-1" },
      );

      expect(result.issueBackfilled).toBe(0);
      expect(result.projectBackfilled).toBe(1);
      expect(result.backfilled).toBe(1);
      expect(result.projectsDone).toBe(true);
      expect(attachmentLinkURL).not.toHaveBeenCalled();
      expect(ensureProjectLink).toHaveBeenCalledTimes(1);
      expect(ensureProjectLink).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        {
          projectId: "lin-proj-1",
          url: "https://paperclip.test/BLO/projects/cloud-service",
          label: "Paperclip project",
          sortOrder: -100,
        },
      );
    });

    it("bounded + resumable: respects maxPerRun=1 and advances the offset cursor", async () => {
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      // Seed a non-zero starting offset to confirm resumability.
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: "backfill-backlink-offset" },
        5,
      );

      // Return one issue; the loop should stop after writing its back-link.
      vi.spyOn(harness.ctx.issues, "list").mockResolvedValueOnce([
        { id: "pcp-3", identifier: "BLO-3", title: "Issue three" },
      ] as never);

      syncModule.getLink.mockResolvedValueOnce({
        paperclipIssueId: "pcp-3",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-3",
        linearIdentifier: "LIN-3",
        linearUrl: "https://linear.app/t/LIN-3",
        syncDirection: "bidirectional",
        lastSyncAt: new Date().toISOString(),
        lastLinearStateType: "started",
        lastCommentSyncAt: null,
      });

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      const result = await harness.performAction<{ backfilled: number; offset: number }>(
        ACTION_KEYS.backfillBackLinks,
        { companyId: "comp-1", maxPerRun: 1 },
      );

      // Exactly one back-link written.
      expect(result.backfilled).toBe(1);
      expect(attachmentLinkURL).toHaveBeenCalledTimes(1);

      // Offset advanced from 5 to 6 (started at 5, scanned 1 issue).
      expect(result.offset).toBe(6);
      // Persisted cursor matches returned offset.
      expect(
        harness.getState({ scopeKind: "instance", stateKey: "backfill-backlink-offset" }),
      ).toBe(6);
    });

    it("returns immediately with done=true when paperclipBaseUrl is explicitly empty", async () => {
      harness.setConfig({ paperclipBaseUrl: "" });
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      const result = await harness.performAction<{ backfilled: number; done: boolean; note: string }>(
        ACTION_KEYS.backfillBackLinks,
        { companyId: "comp-1" },
      );

      expect(result.backfilled).toBe(0);
      expect(result.done).toBe(true);
      expect(result.note).toContain("paperclipBaseUrl not set");
      expect(attachmentLinkURL).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // BLO-2350: webhook-imported Linear issues must inherit projectId
  // -----------------------------------------------------------------------

  describe("BLO-2350: webhook import resolves projectId", () => {
    it("uses the linked Paperclip project when the Linear issue has a mapped project", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      // Mock the project link lookup: Linear project lin-proj-mapped is
      // linked to Paperclip project pap-proj-1.
      syncModule.getProjectLinkByLinear.mockImplementation(
        async (_ctx: unknown, linearProjectId: string) => {
          if (linearProjectId === "lin-proj-mapped") {
            return {
              paperclipProjectId: "pap-proj-1",
              paperclipCompanyId: "comp-1",
              linearProjectId,
              linearProjectName: "Mapped Project",
              syncDirection: "bidirectional",
              lastSyncAt: new Date().toISOString(),
              lastLinearState: "started",
            };
          }
          return null;
        },
      );

      const createSpy = vi.spyOn(harness.ctx.issues, "create");

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-iss-with-proj",
            identifier: "LUC-101",
            title: "Issue with mapped project",
            description: "Body",
            priority: 3,
            state: { type: "started", name: "In Progress" },
            project: { id: "lin-proj-mapped", name: "Mapped Project" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      expect(createSpy).toHaveBeenCalledOnce();
      const createInput = createSpy.mock.calls[0]![0];
      expect(createInput.projectId).toBe("pap-proj-1");
      expect(createInput.projectId).not.toBeNull();
    });

    it("falls back to defaultProjectId when the Linear issue has no project", async () => {
      harness.setConfig({
        linearClientId: "client-id-123",
        linearClientSecret: "client-secret-456",
        teamId: "team-1",
        defaultProjectId: "pap-proj-default",
        syncComments: true,
        syncDirection: "bidirectional",
        disableLinearOriginatedCreates: false,
      });

      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const createSpy = vi.spyOn(harness.ctx.issues, "create");

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-iss-no-proj",
            identifier: "LUC-102",
            title: "Issue with no project",
            priority: 3,
            state: { type: "backlog", name: "Backlog" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      expect(createSpy).toHaveBeenCalledOnce();
      const createInput = createSpy.mock.calls[0]![0];
      expect(createInput.projectId).toBe("pap-proj-default");
    });

    it("leaves projectId unset when no link and no defaultProjectId (with warn)", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      const createSpy = vi.spyOn(harness.ctx.issues, "create");

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "create",
          data: {
            id: "lin-iss-unmapped",
            identifier: "LUC-103",
            title: "Issue with unmapped project",
            priority: 3,
            state: { type: "backlog", name: "Backlog" },
            project: { id: "lin-proj-unknown", name: "Unknown" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-req",
      });

      expect(createSpy).toHaveBeenCalledOnce();
      const createInput = createSpy.mock.calls[0]![0];
      expect(createInput.projectId).toBeUndefined();
      expect(
        harness.logs.some(
          (l) => l.level === "warn" && l.message.includes("no projectId resolved"),
        ),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tool: mark-duplicate
  // -----------------------------------------------------------------------

  describe("tool: mark-duplicate", () => {
    it("happy path: marks dupe as duplicate of keeper", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const { getIssueByIdentifier, markDuplicate, parseLinearIssueRef } = await import("../src/linear.js");

      (parseLinearIssueRef as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => {
        if (ref === "BLO-1184") return { identifier: "BLO-1184" };
        if (ref === "BLO-2167") return { identifier: "BLO-2167" };
        return null;
      });

      (getIssueByIdentifier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "lin-dupe", identifier: "BLO-1184", title: "Dupe", state: { type: "cancelled" }, url: "https://linear.app/t/BLO-1184" })
        .mockResolvedValueOnce({ id: "lin-keep", identifier: "BLO-2167", title: "Keeper", state: { type: "started" }, url: "https://linear.app/t/BLO-2167" });

      (markDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        issueRelationId: "rel-1",
        alreadyRelated: false,
      });

      const result = await harness.executeTool(TOOL_NAMES.markDuplicate, {
        dupeRef: "BLO-1184",
        keeperRef: "BLO-2167",
      });

      expect(markDuplicate).toHaveBeenCalledWith(
        expect.any(Function),
        "lin_token_123",
        "lin-dupe",
        "lin-keep",
      );
      expect(result.content).toContain("Marked BLO-1184 as duplicate of BLO-2167");
      expect((result.data as any).success).toBe(true);
      expect((result.data as any).dupe).toBe("BLO-1184");
      expect((result.data as any).keeper).toBe("BLO-2167");
    });

    it("unresolved ref: returns error and does not call markDuplicate when dupe not found", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const { getIssueByIdentifier, markDuplicate, parseLinearIssueRef } = await import("../src/linear.js");

      (parseLinearIssueRef as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => {
        if (ref === "BLO-9999") return { identifier: "BLO-9999" };
        if (ref === "BLO-2167") return { identifier: "BLO-2167" };
        return null;
      });

      // dupe lookup returns null (not found)
      (getIssueByIdentifier as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      (markDuplicate as ReturnType<typeof vi.fn>).mockClear();

      const result = await harness.executeTool(TOOL_NAMES.markDuplicate, {
        dupeRef: "BLO-9999",
        keeperRef: "BLO-2167",
      });

      expect((result.data as any).error).toBeTruthy();
      expect(markDuplicate).not.toHaveBeenCalled();
    });

    it("success=false: surfaces the not-created warning without throwing", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );

      const { getIssueByIdentifier, markDuplicate, parseLinearIssueRef } = await import("../src/linear.js");

      (parseLinearIssueRef as ReturnType<typeof vi.fn>).mockImplementation((ref: string) => {
        if (ref === "BLO-1184") return { identifier: "BLO-1184" };
        if (ref === "BLO-2167") return { identifier: "BLO-2167" };
        return null;
      });

      (getIssueByIdentifier as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ id: "lin-dupe", identifier: "BLO-1184", title: "Dupe", state: { type: "cancelled" }, url: "https://linear.app/t/BLO-1184" })
        .mockResolvedValueOnce({ id: "lin-keep", identifier: "BLO-2167", title: "Keeper", state: { type: "started" }, url: "https://linear.app/t/BLO-2167" });

      // Linear returned success=false without throwing (and not already related).
      (markDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        issueRelationId: null,
        alreadyRelated: false,
      });

      const result = await harness.executeTool(TOOL_NAMES.markDuplicate, {
        dupeRef: "BLO-1184",
        keeperRef: "BLO-2167",
      });

      expect(result.content).toContain("success=false");
      expect(result.content).toContain("BLO-1184");
      expect(result.content).toContain("BLO-2167");
      expect((result.data as any).success).toBe(false);
      expect((result.data as any).alreadyRelated).toBe(false);
      expect((result.data as any).dupe).toBe("BLO-1184");
      expect((result.data as any).keeper).toBe("BLO-2167");
    });
  });

  // -----------------------------------------------------------------------
  // webhook Issue.update: Paperclip back-link
  // -----------------------------------------------------------------------

  describe("webhook Issue.update: Paperclip back-link", () => {
    it("fires attachmentLinkURL on update when paperclipBaseUrl is set and the issue is linked", async () => {
      // Build a fresh harness with paperclipBaseUrl so the back-link path triggers.
      harness = createTestHarness({
        manifest,
        config: {
          linearClientId: "client-id-123",
          linearClientSecret: "client-secret-456",
          teamId: "team-1",
          syncComments: true,
          syncDirection: "bidirectional",
          paperclipBaseUrl: "https://paperclip.test",
          linearBacklinkBestEffort: true,
        },
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-1",
      );

      // Seed an existing link so getLinkByLinear resolves for this update event.
      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "pcp-iss-1",
        paperclipCompanyId: "comp-1",
        linearIssueId: "lin-update-bl-1",
        linearIdentifier: "LUC-200",
        linearUrl: "https://linear.app/lucitra/issue/LUC-200",
        syncDirection: "bidirectional",
        lastLinearStateType: "started",
      });

      // Mock ctx.issues.get to return the Paperclip mirror's identifier + title.
      vi.spyOn(harness.ctx.issues, "get").mockResolvedValue({
        id: "pcp-iss-1",
        identifier: "LUC-1001",
        title: "Test issue",
      } as never);

      // Stub update so the extra-fields patch branch doesn't throw.
      vi.spyOn(harness.ctx.issues, "update").mockResolvedValue(undefined as never);

      // syncFromLinear is already a no-op mock; nothing extra needed.

      const { attachmentLinkURL } = await import("../src/linear.js");
      (attachmentLinkURL as ReturnType<typeof vi.fn>).mockClear();

      await plugin.definition.onWebhook!({
        endpointKey: "linear-events",
        parsedBody: {
          type: "Issue",
          action: "update",
          data: {
            id: "lin-update-bl-1",
            identifier: "LUC-200",
            title: "Updated title",
            state: { type: "started", name: "In Progress" },
          },
        },
        headers: {},
        rawBody: "",
        requestId: "test-webhook-update-backlink",
      });

      expect(attachmentLinkURL).toHaveBeenCalledOnce();
      const callArg = (attachmentLinkURL as ReturnType<typeof vi.fn>).mock.calls[0]![2];
      expect(callArg.url).toBe("https://paperclip.test/LUC/issues/LUC-1001");
    });
  });

  // ---------------------------------------------------------------------------
  // reconcile-milestones — Phase 1.5: Linear→PC issue-membership backfill
  // ---------------------------------------------------------------------------
  describe("reconcile-milestones phase 1.5 (Linear→PC issue membership)", () => {
    async function seedReconcileEnv(h: TestHarness) {
      await h.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_reconcile",
      );
      await h.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        "comp-reconcile",
      );
      // A project link: lin-proj-A ↔ pc-proj-A (needed for Phase 1 / Phase 2 iteration)
      await h.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.projectLinkPrefix}pc-proj-A` },
        {
          paperclipCompanyId: "comp-reconcile",
          paperclipProjectId: "pc-proj-A",
          linearProjectId: "lin-proj-A",
          linearProjectName: "Project A",
          syncDirection: "bidirectional",
          lastSyncAt: new Date().toISOString(),
        },
      );
    }

    async function seedMilestoneLink(h: TestHarness, opts: {
      pcMilestoneId: string;
      linearMilestoneId: string;
      name: string;
      pcProjectId: string;
    }) {
      await h.ctx.state.set(
        { scopeKind: "instance", stateKey: `${STATE_KEYS.milestoneLinkPrefix}${opts.pcMilestoneId}` },
        {
          paperclipMilestoneId: opts.pcMilestoneId,
          paperclipCompanyId: "comp-reconcile",
          paperclipProjectId: opts.pcProjectId,
          linearMilestoneId: opts.linearMilestoneId,
          linearMilestoneName: opts.name,
          lastSyncAt: new Date().toISOString(),
        },
      );
    }

    it("stamps milestoneId on a PC issue whose Linear mirror is attached to a mapped milestone", async () => {
      await seedReconcileEnv(harness);
      await seedMilestoneLink(harness, { pcMilestoneId: "pc-ms-1", linearMilestoneId: "lin-ms-1", name: "M1", pcProjectId: "pc-proj-A" });

      const { listIssuesByMilestone, listProjectMilestones } = await import("../src/linear.js");
      (listProjectMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-1", identifier: "LUC-1" }],
        hasNextPage: false,
        endCursor: null,
      });

      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "pc-iss-1",
        paperclipCompanyId: "comp-reconcile",
        linearIssueId: "lin-iss-1",
        linearIdentifier: "LUC-1",
        linearUrl: "https://linear.app/t/LUC-1",
        syncDirection: "bidirectional",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "unstarted",
        lastCommentSyncAt: null,
      });

      harness.seed({
        issues: [
          {
            id: "pc-iss-1",
            companyId: "comp-reconcile",
            projectId: "pc-proj-A",
            title: "T",
            status: "todo",
            priority: "low",
            milestoneId: null,
            assigneeAgentId: null,
            assigneeUserId: null,
          } as never,
        ],
      });

      const update = vi.spyOn(harness.ctx.issues, "update");

      const result = await harness.performAction<{ membershipBackfilled: number }>(
        ACTION_KEYS.reconcileMilestones,
        { companyId: "comp-reconcile" },
      );

      expect(result.membershipBackfilled).toBe(1);
      expect(update).toHaveBeenCalledWith(
        "pc-iss-1",
        expect.objectContaining({ milestoneId: "pc-ms-1" }),
        "comp-reconcile",
      );
    });

    it("stamps on steady state (0 imports this run) — the regression proof", async () => {
      // This is the exact scenario that was broken: milestoneLink exists from a prior run,
      // no milestones are imported this run, but an issue needs stamping.
      await seedReconcileEnv(harness);
      await seedMilestoneLink(harness, { pcMilestoneId: "pc-ms-ss", linearMilestoneId: "lin-ms-ss", name: "Steady", pcProjectId: "pc-proj-A" });

      const { listIssuesByMilestone, listProjectMilestones } = await import("../src/linear.js");
      // Phase 1 returns no new milestones (steady state)
      (listProjectMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "lin-ms-ss", name: "Steady", description: null, targetDate: null },
      ]);
      // Phase 1.5 uses listIssuesByMilestone directly by milestone ID
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-ss", identifier: "LUC-SS" }],
        hasNextPage: false,
        endCursor: null,
      });

      // getMilestoneLinkByLinear is used by Phase 1 only; Phase 1.5 reads state directly.
      syncModule.getMilestoneLinkByLinear.mockResolvedValue({
        paperclipMilestoneId: "pc-ms-ss",
        paperclipCompanyId: "comp-reconcile",
        paperclipProjectId: "pc-proj-A",
        linearMilestoneId: "lin-ms-ss",
        linearMilestoneName: "Steady",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
      });

      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "pc-iss-ss",
        paperclipCompanyId: "comp-reconcile",
        linearIssueId: "lin-iss-ss",
        linearIdentifier: "LUC-SS",
        linearUrl: "https://linear.app/t/LUC-SS",
        syncDirection: "bidirectional",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "unstarted",
        lastCommentSyncAt: null,
      });

      harness.seed({
        issues: [
          {
            id: "pc-iss-ss",
            companyId: "comp-reconcile",
            projectId: "pc-proj-A",
            title: "Steady-state issue",
            status: "todo",
            priority: "low",
            milestoneId: null, // null despite Linear attachment — the bug scenario
            assigneeAgentId: null,
            assigneeUserId: null,
          } as never,
        ],
      });

      const update = vi.spyOn(harness.ctx.issues, "update");

      const result = await harness.performAction<{ membershipBackfilled: number; imported: number }>(
        ACTION_KEYS.reconcileMilestones,
        { companyId: "comp-reconcile" },
      );

      expect(result.imported).toBe(0); // steady state: nothing new imported
      expect(result.membershipBackfilled).toBe(1); // but Phase 1.5 self-heals it
      expect(update).toHaveBeenCalledWith(
        "pc-iss-ss",
        expect.objectContaining({ milestoneId: "pc-ms-ss" }),
        "comp-reconcile",
      );
    });

    it("skips an issue whose Linear mirror has no PC link", async () => {
      await seedReconcileEnv(harness);
      await seedMilestoneLink(harness, { pcMilestoneId: "pc-ms-1", linearMilestoneId: "lin-ms-1", name: "M1", pcProjectId: "pc-proj-A" });

      const { listIssuesByMilestone, listProjectMilestones } = await import("../src/linear.js");
      (listProjectMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-2", identifier: "LUC-2" }],
        hasNextPage: false,
        endCursor: null,
      });

      syncModule.getLinkByLinear.mockResolvedValue(null); // no PC link

      const update = vi.spyOn(harness.ctx.issues, "update");

      const result = await harness.performAction<{ membershipBackfilled: number }>(
        ACTION_KEYS.reconcileMilestones,
        { companyId: "comp-reconcile" },
      );

      expect(result.membershipBackfilled).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });

    it("leaves milestoneId unchanged when it is already set on the PC issue", async () => {
      await seedReconcileEnv(harness);
      await seedMilestoneLink(harness, { pcMilestoneId: "pc-ms-1", linearMilestoneId: "lin-ms-1", name: "M1", pcProjectId: "pc-proj-A" });

      const { listIssuesByMilestone, listProjectMilestones } = await import("../src/linear.js");
      (listProjectMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-3", identifier: "LUC-3" }],
        hasNextPage: false,
        endCursor: null,
      });

      syncModule.getLinkByLinear.mockResolvedValueOnce({
        paperclipIssueId: "pc-iss-3",
        paperclipCompanyId: "comp-reconcile",
        linearIssueId: "lin-iss-3",
        linearIdentifier: "LUC-3",
        linearUrl: "https://linear.app/t/LUC-3",
        syncDirection: "bidirectional",
        lastSyncAt: "2020-01-01T00:00:00.000Z",
        lastLinearStateType: "unstarted",
        lastCommentSyncAt: null,
      });

      harness.seed({
        issues: [
          {
            id: "pc-iss-3",
            companyId: "comp-reconcile",
            projectId: "pc-proj-A",
            title: "T",
            status: "todo",
            priority: "low",
            milestoneId: "pc-ms-1", // already set
            assigneeAgentId: null,
            assigneeUserId: null,
          } as never,
        ],
      });

      const update = vi.spyOn(harness.ctx.issues, "update");

      const result = await harness.performAction<{ membershipBackfilled: number }>(
        ACTION_KEYS.reconcileMilestones,
        { companyId: "comp-reconcile" },
      );

      expect(result.membershipBackfilled).toBe(0);
      expect(update).not.toHaveBeenCalled();
    });

    it("paginates across multiple pages and stamps issues on each page", async () => {
      await seedReconcileEnv(harness);
      await seedMilestoneLink(harness, { pcMilestoneId: "pc-ms-1", linearMilestoneId: "lin-ms-1", name: "M1", pcProjectId: "pc-proj-A" });

      const { listIssuesByMilestone, listProjectMilestones } = await import("../src/linear.js");
      (listProjectMilestones as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      // Page 1: hasNextPage=true
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-p1", identifier: "LUC-P1" }],
        hasNextPage: true,
        endCursor: "cursor-1",
      });
      // Page 2: hasNextPage=false
      (listIssuesByMilestone as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        issues: [{ id: "lin-iss-p2", identifier: "LUC-P2" }],
        hasNextPage: false,
        endCursor: null,
      });

      syncModule.getLinkByLinear
        .mockResolvedValueOnce({
          paperclipIssueId: "pc-iss-p1",
          paperclipCompanyId: "comp-reconcile",
          linearIssueId: "lin-iss-p1",
          linearIdentifier: "LUC-P1",
          linearUrl: "https://linear.app/t/LUC-P1",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        })
        .mockResolvedValueOnce({
          paperclipIssueId: "pc-iss-p2",
          paperclipCompanyId: "comp-reconcile",
          linearIssueId: "lin-iss-p2",
          linearIdentifier: "LUC-P2",
          linearUrl: "https://linear.app/t/LUC-P2",
          syncDirection: "bidirectional",
          lastSyncAt: "2020-01-01T00:00:00.000Z",
          lastLinearStateType: "unstarted",
          lastCommentSyncAt: null,
        });

      harness.seed({
        issues: [
          { id: "pc-iss-p1", companyId: "comp-reconcile", projectId: "pc-proj-A", title: "P1", status: "todo", priority: "low", milestoneId: null, assigneeAgentId: null, assigneeUserId: null } as never,
          { id: "pc-iss-p2", companyId: "comp-reconcile", projectId: "pc-proj-A", title: "P2", status: "todo", priority: "low", milestoneId: null, assigneeAgentId: null, assigneeUserId: null } as never,
        ],
      });

      const result = await harness.performAction<{ membershipBackfilled: number }>(
        ACTION_KEYS.reconcileMilestones,
        { companyId: "comp-reconcile" },
      );

      expect(result.membershipBackfilled).toBe(2);
      // Verify cursor was passed on second call
      expect(listIssuesByMilestone).toHaveBeenCalledTimes(2);
      expect((listIssuesByMilestone as ReturnType<typeof vi.fn>).mock.calls[1][3]).toBe("cursor-1");
    });
  });
});
