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
  createIssue: vi.fn().mockResolvedValue({
    id: "lin-iss-new",
    identifier: "LUC-43",
    title: "New issue",
    url: "https://linear.app/lucitra/issue/LUC-43",
    state: { name: "Backlog", type: "backlog" },
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
  syncProjectFromLinear: vi.fn().mockResolvedValue(undefined),
  bridgeCommentToLinear: vi.fn().mockResolvedValue(undefined),
  paperclipProjectStateToLinear: vi.fn().mockReturnValue("planned"),
  linearProjectStateToPaperclip: vi.fn().mockReturnValue("backlog"),
  createProjectLink: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/sync.js", () => syncModule);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("paperclip-plugin-linear", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
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
        { entityId: "proj-1" },
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
        { entityId: "iss-new" },
      );

      expect(createIssue).toHaveBeenCalledOnce();
      expect(syncModule.createLink).toHaveBeenCalledOnce();
      expect(harness.activity.some((a) => a.message === "issue.pushed_to_linear")).toBe(true);
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
  });

  // -----------------------------------------------------------------------
  // Webhook: duplicate prevention
  // -----------------------------------------------------------------------

  describe("webhook: duplicate issue prevention", () => {
    it("creates a Paperclip issue from Linear webhook", async () => {
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
      });

      expect(harness.activity.some((a) => a.message === "issue.synced_from_linear")).toBe(true);
      expect(syncModule.createLink).toHaveBeenCalled();
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
      });

      // createLink should NOT have been called again
      expect(syncModule.createLink.mock.calls.length).toBe(createLinkCallsBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Jobs
  // -----------------------------------------------------------------------

  describe("jobs", () => {
    it("registers periodic-sync job", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
        "lin_token_123",
      );
      await expect(harness.runJob(JOB_KEYS.periodicSync)).resolves.not.toThrow();
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
});
