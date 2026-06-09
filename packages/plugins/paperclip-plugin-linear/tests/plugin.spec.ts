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
  attachmentLinkURL: vi.fn().mockResolvedValue({
    success: true,
    attachmentId: "att-1",
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

  // Re-install hoisted syncModule defaults. `vi.clearAllMocks()` clears
  // call history but preserves implementations set via `mockResolvedValue`
  // — any test that overrides a default would otherwise leak its override
  // to subsequent tests (see BLO-2350 / BLO-2973 incident in the commit
  // log for this file). Keep this list in sync with the hoisted block
  // at the top of the file.
  function restoreSyncModuleDefaults() {
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
    syncModule.syncProjectFromLinear.mockResolvedValue(undefined);
    syncModule.bridgeCommentToLinear.mockResolvedValue(undefined);
    syncModule.paperclipProjectStateToLinear.mockReturnValue("planned");
    syncModule.linearProjectStateToPaperclip.mockReturnValue("backlog");
    syncModule.createProjectLink.mockResolvedValue({});
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
        url: "https://paperclip.test/issues/LUC-1001",
        title: "Paperclip mirror: LUC-1001",
        subtitle: "LUC-1001 - Test issue",
        metadata: {
          source: "paperclip",
          paperclipIssueId: "pcp-iss-1",
          paperclipIdentifier: "LUC-1001",
          linearIdentifier: "LUC-1",
          url: "https://paperclip.test/issues/LUC-1001",
        },
      });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Paperclip issue", value: "LUC-1001" });
      expect(callArg.metadata.attributes).toContainEqual({ name: "Linear issue", value: "LUC-1" });
    });

    it("skips the back-link when paperclipBaseUrl is not configured", async () => {
      // Default harness from outer beforeEach has no paperclipBaseUrl.
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
      expect(callArg.url).toBe("https://paperclip.test/issues/LUC-1005");
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
        url: "https://paperclip.test/issues/LUC-W100",
        title: "Paperclip mirror: LUC-W100",
        subtitle: "LUC-W100 - Webhook create",
        metadata: {
          source: "paperclip",
          paperclipIssueId: "pcp-iss-wh-1",
          paperclipIdentifier: "LUC-W100",
          linearIdentifier: "LUC-W1",
          url: "https://paperclip.test/issues/LUC-W100",
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
        status: "in_progress",
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
      expect(calls[0]![2]).toMatchObject({ url: "https://paperclip.test/issues/BLO-1" });
      expect(calls[1]![2]).toMatchObject({ url: "https://paperclip.test/issues/BLO-2" });
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

    it("returns immediately with done=true when paperclipBaseUrl is not configured", async () => {
      // Default harness (outer beforeEach) has no paperclipBaseUrl.
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
      expect(callArg.url).toBe("https://paperclip.test/issues/LUC-1001");
    });
  });
});
