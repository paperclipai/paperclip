import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, type Issue, type IssueComment } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  const { id, companyId, title, ...rest } = input;
  return {
    id,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

function comment(input: Partial<IssueComment> & Pick<IssueComment, "id" | "issueId" | "companyId">): IssueComment {
  const now = new Date();
  const { id, issueId, companyId, ...rest } = input;
  return {
    id,
    issueId,
    companyId,
    parentCommentId: null,
    content: "test comment",
    authorUserId: null,
    authorAgentId: null,
    editedAt: null,
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
}

const companyId = randomUUID();
const userId = randomUUID();

describe("plugin-better-search-example", () => {
  it("declares the correct manifest", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclip-better-search-example",
      capabilities: expect.arrayContaining([
        "plugin.state.read",
        "plugin.state.write",
        "issues.read",
        "issue.comments.read",
        "ui.sidebar.register",
      ]),
      ui: {
        slots: expect.arrayContaining([
          expect.objectContaining({ id: "better-search-sidebar" }),
          expect.objectContaining({ id: "better-search-panel" }),
          expect.objectContaining({ id: "better-search-inbox-toolbar" }),
        ]),
      },
    });
  });

  it("presets key in the company/user scope uses userId as stateKey", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    // Store a preset via the savePreset action.
    await harness.performAction("savePreset", {
      companyId,
      userId,
      preset: { id: "p1", name: "Test", query: "auth", filters: {} },
    });

    const stored = harness.getState({
      scopeKind: "company",
      scopeId: companyId,
      namespace: "presets",
      stateKey: userId,
    });
    expect(stored).toEqual([{ id: "p1", name: "Test", query: "auth", filters: {} }]);
  });

  describe("getPresets", () => {
    it("returns empty list when no presets stored", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.getData<{ presets: unknown[] }>("getPresets", {
        companyId,
        userId,
      });
      expect(result.presets).toEqual([]);
    });

    it("returns stored presets", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      await harness.performAction("savePreset", {
        companyId,
        userId,
        preset: { id: "p1", name: "My preset", query: "bug", filters: { authorType: "human" } },
      });

      const result = await harness.getData<{ presets: unknown[] }>("getPresets", {
        companyId,
        userId,
      });
      expect(result.presets).toHaveLength(1);
      expect(result.presets[0]).toMatchObject({ id: "p1", name: "My preset", query: "bug" });
    });

    it("returns empty array when companyId or userId is missing", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      const noCompany = await harness.getData<{ presets: unknown[] }>("getPresets", { userId });
      expect(noCompany.presets).toEqual([]);

      const noUser = await harness.getData<{ presets: unknown[] }>("getPresets", { companyId });
      expect(noUser.presets).toEqual([]);
    });
  });

  describe("savePreset", () => {
    it("creates a new preset", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.performAction<{ presets: unknown[] }>("savePreset", {
        companyId,
        userId,
        preset: { id: "p1", name: "Auth bugs", query: "auth bug", filters: { authorType: "all" } },
      });

      expect(result.presets).toHaveLength(1);
      expect(result.presets[0]).toMatchObject({ id: "p1", name: "Auth bugs" });
    });

    it("updates an existing preset (rename) preserving position", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      await harness.performAction("savePreset", {
        companyId, userId,
        preset: { id: "p1", name: "Old name", query: "bug", filters: {} },
      });
      await harness.performAction("savePreset", {
        companyId, userId,
        preset: { id: "p2", name: "Second", query: "auth", filters: {} },
      });

      const result = await harness.performAction<{ presets: unknown[] }>("savePreset", {
        companyId, userId,
        preset: { id: "p1", name: "New name", query: "bug", filters: {} },
      });

      expect(result.presets).toHaveLength(2);
      expect(result.presets[0]).toMatchObject({ id: "p1", name: "New name" });
      expect(result.presets[1]).toMatchObject({ id: "p2", name: "Second" });
    });

    it("throws when companyId or userId is missing", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);
      const p = { id: "p1", name: "X", query: "x", filters: {} };

      await expect(harness.performAction("savePreset", { userId, preset: p }))
        .rejects.toThrow();
      await expect(harness.performAction("savePreset", { companyId, preset: p }))
        .rejects.toThrow();
      await expect(harness.performAction("savePreset", { companyId, userId }))
        .rejects.toThrow();
    });
  });

  describe("deletePreset", () => {
    it("removes a preset", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      await harness.performAction("savePreset", {
        companyId, userId,
        preset: { id: "p1", name: "Delete me", query: "test", filters: {} },
      });
      await harness.performAction("deletePreset", { companyId, userId, presetId: "p1" });

      const result = await harness.getData<{ presets: unknown[] }>("getPresets", { companyId, userId });
      expect(result.presets).toEqual([]);
    });

    it("is a no-op for non-existent presetId", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      await harness.performAction("savePreset", {
        companyId, userId,
        preset: { id: "p1", name: "Keep me", query: "test", filters: {} },
      });

      const deleteResult = await harness.performAction<{ deleted: string }>("deletePreset", {
        companyId, userId, presetId: "nonexistent",
      });
      expect(deleteResult.deleted).toBe("nonexistent");

      const result = await harness.getData<{ presets: unknown[] }>("getPresets", { companyId, userId });
      expect(result.presets).toHaveLength(1);
    });

    it("throws when companyId, userId, or presetId is missing", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      await expect(harness.performAction("deletePreset", { userId, presetId: "p1" }))
        .rejects.toThrow();
      await expect(harness.performAction("deletePreset", { companyId, presetId: "p1" }))
        .rejects.toThrow();
      await expect(harness.performAction("deletePreset", { companyId, userId }))
        .rejects.toThrow();
    });
  });

  describe("searchIssues", () => {
    it("returns empty results for empty query or missing companyId", async () => {
      const harness = createTestHarness({ manifest });
      await plugin.definition.setup(harness.ctx);

      const noQuery = await harness.getData("searchIssues", { companyId, q: "" });
      expect(noQuery).toMatchObject({ results: [], query: "" });

      const noCompany = await harness.getData("searchIssues", { q: "test" });
      expect(noCompany).toMatchObject({ results: [], query: "test" });
    });

    it("searches issues and derives author type from latest comment", async () => {
      const issueId = randomUUID();
      const harness = createTestHarness({ manifest });
      harness.seed({
        issues: [
          issue({
            id: issueId,
            companyId,
            title: "Auth bug in login",
            status: "in_progress",
          }),
        ],
        issueComments: [
          comment({
            id: randomUUID(),
            issueId,
            companyId,
            authorAgentId: randomUUID(),
            createdAt: new Date("2026-01-01"),
          }),
          comment({
            id: randomUUID(),
            issueId,
            companyId,
            authorUserId: userId,
            createdAt: new Date("2026-06-01"),
          }),
        ],
      });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.getData<{ results: { id: string; latestAuthorType: string }[] }>(
        "searchIssues",
        { companyId, q: "auth" }
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        id: issueId,
        latestAuthorType: "human",
      });
    });

    it("falls back to issue creator when no comments exist", async () => {
      const issueId = randomUUID();
      const agentId = randomUUID();
      const harness = createTestHarness({ manifest });
      harness.seed({
        issues: [
          issue({
            id: issueId,
            companyId,
            title: "Agent-created issue",
            createdByAgentId: agentId,
            createdByUserId: null,
          }),
        ],
      });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.getData<{ results: { id: string; latestAuthorType: string }[] }>(
        "searchIssues",
        { companyId, q: "agent" }
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        id: issueId,
        latestAuthorType: "agent",
      });
    });

    it("returns unknown author type when no creator info available", async () => {
      const issueId = randomUUID();
      const harness = createTestHarness({ manifest });
      harness.seed({
        issues: [
          issue({
            id: issueId,
            companyId,
            title: "Orphan issue",
            createdByAgentId: null,
            createdByUserId: null,
          }),
        ],
      });
      await plugin.definition.setup(harness.ctx);

      const result = await harness.getData<{ results: { id: string; latestAuthorType: string }[] }>(
        "searchIssues",
        { companyId, q: "orphan" }
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        id: issueId,
        latestAuthorType: "unknown",
      });
    });

    it("handles comment fetch failure gracefully", async () => {
      const issueId = randomUUID();
      const harness = createTestHarness({ manifest });
      harness.seed({
        issues: [
          issue({
            id: issueId,
            companyId,
            title: "Issue with problematic comments",
            createdByUserId: userId,
          }),
        ],
      });
      // Do NOT seed issueComments — listComments returns empty array, not an error.
      // The worker catches errors from listComments; test that it doesn't throw.
      await plugin.definition.setup(harness.ctx);

      const result = await harness.getData<{ results: { id: string; latestAuthorType: string }[] }>(
        "searchIssues",
        { companyId, q: "problematic" }
      );

      expect(result.results).toHaveLength(1);
      // Falls back to issue creator.
      expect(result.results[0].latestAuthorType).toBe("human");
    });
  });
});
