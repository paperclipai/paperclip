import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

describe("plugin SDK test harness", () => {
  it("returns scoped execution workspace metadata with the read capability", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-execution-workspace-metadata",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Execution Workspace Metadata",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["execution.workspaces.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });
    harness.seed({
      executionWorkspaces: [{
        id: "workspace-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-1",
        path: "/tmp/paperclip-test",
        cwd: "/tmp/paperclip-test",
        repoUrl: "https://example.com/repo.git",
        baseRef: "main",
        branchName: "feature/test",
        providerType: "git_worktree",
        providerMetadata: { sandboxId: "sandbox-1" },
      }],
    });

    await expect(harness.ctx.executionWorkspaces.get("workspace-1", "company-1")).resolves.toMatchObject({
      id: "workspace-1",
      cwd: "/tmp/paperclip-test",
      branchName: "feature/test",
      providerMetadata: { sandboxId: "sandbox-1" },
    });
    await expect(harness.ctx.executionWorkspaces.get("workspace-1", "company-2")).resolves.toBeNull();
  });

  it("requires execution.workspaces.read before returning workspace metadata", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-missing-execution-workspace-read",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Workspace Read Capability",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });

    await expect(harness.ctx.executionWorkspaces.get("workspace-1", "company-1")).rejects.toThrow(
      "missing required capability 'execution.workspaces.read'",
    );
  });

  it("requires skills.managed capability before resetting a missing declaration", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-missing-managed-skill-capability",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Managed Skill Capability",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
      skills: [{
        skillKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
      }],
    };
    const harness = createTestHarness({ manifest });

    await expect(harness.ctx.skills.managed.reset("unknown-skill", "company-1")).rejects.toThrow(
      "missing required capability 'skills.managed'",
    );
  });

  it("requires access and authorization capabilities for permission SDK calls", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-missing-access-authz-capability",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Access Capability",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });

    await expect((harness.ctx as any).access.members.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'access.members.read'",
    );
    await expect((harness.ctx as any).authorization.grants.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'authorization.grants.read'",
    );
    await expect((harness.ctx as any).authorization.audit.search({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'authorization.audit.read'",
    );
  });

  it("returns tombstone-safe deleted comments from the in-memory issue helper", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-comment-redaction",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Comment Redaction",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issue.comments.read"],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [{
        id: "issue-1",
        companyId: "company-1",
        title: "Comment redaction",
        status: "todo",
        priority: "medium",
      }],
      issueComments: [{
        id: "comment-1",
        companyId: "company-1",
        issueId: "issue-1",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        body: "secret plugin-visible body",
        presentation: { kind: "system_notice", tone: "warning" },
        metadata: { version: 1, sections: [{ rows: [{ type: "text", text: "secret plugin metadata" }] }] },
        deletedAt: new Date("2026-06-03T12:00:00.000Z"),
        deletedByType: "user",
        deletedByUserId: "user-1",
        createdAt: new Date("2026-06-03T11:00:00.000Z"),
        updatedAt: new Date("2026-06-03T12:00:00.000Z"),
      }],
    });

    const comments = await harness.ctx.issues.listComments("issue-1", "company-1");

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "comment-1",
      body: "",
      presentation: null,
      metadata: null,
      deletedByUserId: "user-1",
    });
    expect(JSON.stringify(comments)).not.toContain("secret plugin-visible body");
    expect(JSON.stringify(comments)).not.toContain("secret plugin metadata");
  });
});
