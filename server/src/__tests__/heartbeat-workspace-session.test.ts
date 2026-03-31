import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { agents } from "@paperclipai/db";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  buildExplicitResumeSessionOverride,
  formatRuntimeWorkspaceWarningLog,
  prioritizeProjectWorkspaceCandidatesForRun,
  parseSessionCompactionPolicy,
  recoverProjectWorkspaceFromManifest,
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

const ORIGINAL_PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
const ORIGINAL_PAPERCLIP_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_HOME === undefined) {
    delete process.env.PAPERCLIP_HOME;
  } else {
    process.env.PAPERCLIP_HOME = ORIGINAL_PAPERCLIP_HOME;
  }
  if (ORIGINAL_PAPERCLIP_INSTANCE_ID === undefined) {
    delete process.env.PAPERCLIP_INSTANCE_ID;
  } else {
    process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_PAPERCLIP_INSTANCE_ID;
  }
});

function buildResolvedWorkspace(overrides: Partial<ResolvedWorkspaceForRun> = {}): ResolvedWorkspaceForRun {
  return {
    cwd: "/tmp/project",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildAgent(adapterType: string, runtimeConfig: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    name: "Agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as typeof agents.$inferSelect;
}

describe("resolveRuntimeSessionParamsForWorkspace", () => {
  it("migrates fallback workspace sessions to project workspace when project cwd becomes available", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toMatchObject({
      sessionId: "session-1",
      cwd: "/tmp/new-project-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toContain("Attempting to resume session");
  });

  it("does not migrate when previous session cwd is not the fallback workspace", () => {
    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId: "agent-123",
      previousSessionParams: {
        sessionId: "session-1",
        cwd: "/tmp/some-other-cwd",
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({ cwd: "/tmp/new-project-cwd" }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/some-other-cwd",
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });

  it("does not migrate when resolved workspace id differs from previous session workspace id", () => {
    const agentId = "agent-123";
    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agentId);

    const result = resolveRuntimeSessionParamsForWorkspace({
      agentId,
      previousSessionParams: {
        sessionId: "session-1",
        cwd: fallbackCwd,
        workspaceId: "workspace-1",
      },
      resolvedWorkspace: buildResolvedWorkspace({
        cwd: "/tmp/new-project-cwd",
        workspaceId: "workspace-2",
      }),
    });

    expect(result.sessionParams).toEqual({
      sessionId: "session-1",
      cwd: fallbackCwd,
      workspaceId: "workspace-1",
    });
    expect(result.warning).toBeNull();
  });
});

describe("recoverProjectWorkspaceFromManifest", () => {
  it("recovers managed workspace cwd and metadata from a persisted manifest", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-manifest-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const workspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      workspaceId.slice(0, 32),
    );
    const repoDir = path.join(manifestDir, "repo");

    try {
      await fs.mkdir(repoDir, { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          mode: "git_worktree",
          agentId,
          projectId,
          taskKey,
          workspaceId,
          sourceProjectCwd: "/home/jake/vault/projects/tabula",
          sourceRepoRoot: "/home/jake/vault/projects/tabula",
          relativeCwd: null,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: "main",
          branchName: "paperclip/test",
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [workspaceId],
      });

      expect(recovered).toMatchObject({
        cwd: repoDir,
        workspaceId,
        repoUrl: "https://github.com/ryjm/tabula",
        repoRef: "main",
      });
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("uses relativeCwd from the persisted manifest when present", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-relative-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const workspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      workspaceId.slice(0, 32),
    );
    const repoDir = path.join(manifestDir, "repo");
    const relativeCwd = path.join("packages", "server");
    const nestedCwd = path.join(repoDir, relativeCwd);

    try {
      await fs.mkdir(nestedCwd, { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          mode: "git_worktree",
          agentId,
          projectId,
          taskKey,
          workspaceId,
          relativeCwd,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: null,
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [workspaceId],
      });

      expect(recovered?.cwd).toBe(nestedCwd);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it("ignores manifests that do not match a tracked workspace id", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-mismatch-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const agentId = "agent-123";
    const projectId = "3b01eb46-f0c5-4a09-80ea-46e634278706";
    const taskKey = "910d0062-299e-49b5-9bb5-c2580a2c6a3d";
    const manifestWorkspaceId = "0e79ea49-9a34-4777-9285-debd4acade93";
    const trackedWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const manifestDir = path.join(
      resolveDefaultAgentWorkspaceDir(agentId),
      "project-workspaces",
      projectId.slice(0, 32),
      `${taskKey.slice(0, 32)}-managed`,
      manifestWorkspaceId.slice(0, 32),
    );

    try {
      await fs.mkdir(path.join(manifestDir, "repo"), { recursive: true });
      await fs.writeFile(
        path.join(manifestDir, "paperclip-workspace.json"),
        JSON.stringify({
          projectId,
          taskKey,
          workspaceId: manifestWorkspaceId,
          relativeCwd: null,
          repoUrl: "https://github.com/ryjm/tabula",
          repoRef: null,
        }),
        "utf8",
      );

      const recovered = await recoverProjectWorkspaceFromManifest({
        agentId,
        projectId,
        taskKey,
        workspaceIds: [trackedWorkspaceId],
      });

      expect(recovered).toBeNull();
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("shouldResetTaskSessionForWake", () => {
  it("resets session context on assignment wake", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_assigned" })).toBe(true);
  });

  it("preserves session context on timer heartbeats", () => {
    expect(shouldResetTaskSessionForWake({ wakeSource: "timer" })).toBe(false);
  });

  it("preserves session context on manual on-demand invokes by default", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
      }),
    ).toBe(false);
  });

  it("resets session context when a fresh session is explicitly requested", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "manual",
        forceFreshSession: true,
      }),
    ).toBe(true);
  });

  it("does not reset session context on mention wake comment", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    ).toBe(false);
  });

  it("does not reset session context when commentId is present", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeReason: "issue_commented",
        commentId: "comment-2",
      }),
    ).toBe(false);
  });

  it("does not reset for comment wakes", () => {
    expect(shouldResetTaskSessionForWake({ wakeReason: "issue_commented" })).toBe(false);
  });

  it("does not reset when wake reason is missing", () => {
    expect(shouldResetTaskSessionForWake({})).toBe(false);
  });

  it("does not reset session context on callback on-demand invokes", () => {
    expect(
      shouldResetTaskSessionForWake({
        wakeSource: "on_demand",
        wakeTriggerDetail: "callback",
      }),
    ).toBe(false);
  });
});

describe("buildExplicitResumeSessionOverride", () => {
  it("reuses saved task session params when they belong to the selected failed run", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "session-after",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "session-after",
        lastRunId: "run-1",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
        cwd: "/tmp/project",
      },
    });
  });

  it("falls back to the selected run session id when no matching task session params are available", () => {
    const result = buildExplicitResumeSessionOverride({
      resumeFromRunId: "run-1",
      resumeRunSessionIdBefore: "session-before",
      resumeRunSessionIdAfter: "session-after",
      taskSession: {
        sessionParamsJson: {
          sessionId: "other-session",
          cwd: "/tmp/project",
        },
        sessionDisplayId: "other-session",
        lastRunId: "run-2",
      },
      sessionCodec: codexSessionCodec,
    });

    expect(result).toEqual({
      sessionDisplayId: "session-after",
      sessionParams: {
        sessionId: "session-after",
      },
    });
  });
});

describe("formatRuntimeWorkspaceWarningLog", () => {
  it("emits informational workspace warnings on stdout", () => {
    expect(formatRuntimeWorkspaceWarningLog("Using fallback workspace")).toEqual({
      stream: "stdout",
      chunk: "[paperclip] Using fallback workspace\n",
    });
  });
});

describe("prioritizeProjectWorkspaceCandidatesForRun", () => {
  it("moves the explicitly selected workspace to the front", () => {
    const rows = [
      { id: "workspace-1", cwd: "/tmp/one" },
      { id: "workspace-2", cwd: "/tmp/two" },
      { id: "workspace-3", cwd: "/tmp/three" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-2").map((row) => row.id),
    ).toEqual(["workspace-2", "workspace-1", "workspace-3"]);
  });

  it("keeps the original order when no preferred workspace is selected", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, null).map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });

  it("keeps the original order when the selected workspace is missing", () => {
    const rows = [
      { id: "workspace-1" },
      { id: "workspace-2" },
    ];

    expect(
      prioritizeProjectWorkspaceCandidatesForRun(rows, "workspace-9").map((row) => row.id),
    ).toEqual(["workspace-1", "workspace-2"]);
  });
});

describe("parseSessionCompactionPolicy", () => {
  it("disables Paperclip-managed rotation by default for codex and claude local", () => {
    expect(parseSessionCompactionPolicy(buildAgent("codex_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
    expect(parseSessionCompactionPolicy(buildAgent("claude_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    });
  });

  it("keeps conservative defaults for adapters without confirmed native compaction", () => {
    expect(parseSessionCompactionPolicy(buildAgent("cursor"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
    expect(parseSessionCompactionPolicy(buildAgent("opencode_local"))).toEqual({
      enabled: true,
      maxSessionRuns: 200,
      maxRawInputTokens: 2_000_000,
      maxSessionAgeHours: 72,
    });
  });

  it("lets explicit agent overrides win over adapter defaults", () => {
    expect(
      parseSessionCompactionPolicy(
        buildAgent("codex_local", {
          heartbeat: {
            sessionCompaction: {
              maxSessionRuns: 25,
              maxRawInputTokens: 500_000,
            },
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 500_000,
      maxSessionAgeHours: 0,
    });
  });
});
