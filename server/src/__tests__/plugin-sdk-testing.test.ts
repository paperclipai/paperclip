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

    await expect(harness.ctx.access.members.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'access.members.read'",
    );
    await expect(harness.ctx.authorization.grants.list({ companyId: "company-1" })).rejects.toThrow(
      "missing required capability 'authorization.grants.read'",
    );
    await expect(harness.ctx.authorization.audit.search({ companyId: "company-1" })).rejects.toThrow(
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

  it("rejects a human-attributed comment when the actorUserId is not an active member", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-human-attributed-comment-unverified",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Human-Attributed Comment (unverified)",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issue.comments.create", "issue.comments.create_human_attributed"],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [{
        id: "issue-1",
        companyId: "company-1",
        title: "Human attribution",
        status: "todo",
        priority: "medium",
      }],
      // A suspended member must not satisfy the active-human-member check —
      // the harness mirrors the host's `requireActiveHumanMember` guard so a
      // plugin test cannot pass an attribution production would reject.
      accessMembers: [{
        id: "member-suspended",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        status: "suspended",
        membershipRole: "member",
        grants: [],
        createdAt: new Date("2026-06-03T11:00:00.000Z"),
        updatedAt: new Date("2026-06-03T11:00:00.000Z"),
      }],
    });

    await expect(
      harness.ctx.issues.createComment("issue-1", "relayed reply", "company-1", { actorUserId: "user-1" }),
    ).rejects.toThrow('actorUserId "user-1" is not an active human member of this company');
  });

  it("rejects a human-attributed comment when the actorUserId is a viewer-role (read-only) member", async () => {
    // LOOA-648: the harness mirrors the host's viewer write-bar so a plugin's
    // own test suite cannot pass an attribution production rejects. A viewer is
    // an active member but read-only in the web app.
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-human-attributed-comment-viewer",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Human-Attributed Comment (viewer)",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issue.comments.create", "issue.comments.create_human_attributed"],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [{
        id: "issue-1",
        companyId: "company-1",
        title: "Human attribution",
        status: "todo",
        priority: "medium",
      }],
      accessMembers: [{
        id: "member-viewer",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "viewer",
        grants: [],
        createdAt: new Date("2026-06-03T11:00:00.000Z"),
        updatedAt: new Date("2026-06-03T11:00:00.000Z"),
      }],
    });

    await expect(
      harness.ctx.issues.createComment("issue-1", "relayed reply", "company-1", { actorUserId: "user-1" }),
    ).rejects.toThrow("viewer (read-only) access");
  });

  it("attributes a comment to an active human member for a verified actorUserId", async () => {
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.test-human-attributed-comment-verified",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Human-Attributed Comment (verified)",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issue.comments.create", "issue.comments.create_human_attributed"],
      entrypoints: { worker: "./dist/worker.js" },
    };
    const harness = createTestHarness({ manifest });
    harness.seed({
      issues: [{
        id: "issue-1",
        companyId: "company-1",
        title: "Human attribution",
        status: "todo",
        priority: "medium",
      }],
      accessMembers: [{
        id: "member-active",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "member",
        grants: [],
        createdAt: new Date("2026-06-03T11:00:00.000Z"),
        updatedAt: new Date("2026-06-03T11:00:00.000Z"),
      }],
    });

    const comment = await harness.ctx.issues.createComment(
      "issue-1",
      "relayed reply",
      "company-1",
      { actorUserId: "user-1" },
    );

    expect(comment).toMatchObject({
      issueId: "issue-1",
      authorType: "user",
      authorUserId: "user-1",
      authorAgentId: null,
      body: "relayed reply",
    });
  });
});
