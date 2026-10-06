/**
 * Regression tests for the working directory and workspace environment of the
 * hermes-local adapter.
 *
 * Paperclip realizes an execution workspace (a project checkout or an issue
 * worktree) for each run and passes it as `context.paperclipWorkspace`. The
 * adapter must start Hermes in that directory, as the other local adapters do.
 * Before this, Hermes started in the server directory and the agent had to
 * search the machine for its repository.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Intercept runChildProcess so the tests can inspect its options without
// spawning a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Avoid real file reads and writes in execute().
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const WORKSPACE_ENV_KEYS = [
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_SOURCE",
  "PAPERCLIP_WORKSPACE_STRATEGY",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACE_REPO_URL",
  "PAPERCLIP_WORKSPACE_REPO_REF",
  "PAPERCLIP_WORKSPACE_BRANCH",
  "PAPERCLIP_WORKSPACE_WORKTREE_PATH",
  "PAPERCLIP_WORKSPACES_JSON",
  "AGENT_HOME",
] as const;

const WORKTREE = "/srv/paperclip/projects/demo/worktrees/issue-42";
const AGENT_HOME = "/srv/paperclip/workspaces/agent-1";

function makeCtx(context: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      ...config,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
      ...context,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

async function runOptions(context: Record<string, unknown>, config: Record<string, unknown> = {}) {
  await execute(makeCtx(context, config) as any);
  const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
  return call[3] as { cwd: string; env: Record<string, string> };
}

describe("hermes-local adapter workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The test runner may itself run inside a Paperclip agent run.
    for (const key of WORKSPACE_ENV_KEYS) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts in the realized execution workspace and exports its details", async () => {
    const opts = await runOptions({
      paperclipWorkspace: {
        cwd: WORKTREE,
        source: "task_session",
        strategy: "git_worktree",
        workspaceId: "workspace-1",
        repoUrl: "https://example.com/acme/demo.git",
        repoRef: "origin/main",
        branchName: "fix/issue-42",
        worktreePath: WORKTREE,
        agentHome: AGENT_HOME,
      },
    });

    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.env).toMatchObject({
      PAPERCLIP_WORKSPACE_CWD: WORKTREE,
      PAPERCLIP_WORKSPACE_SOURCE: "task_session",
      PAPERCLIP_WORKSPACE_STRATEGY: "git_worktree",
      PAPERCLIP_WORKSPACE_ID: "workspace-1",
      PAPERCLIP_WORKSPACE_REPO_URL: "https://example.com/acme/demo.git",
      PAPERCLIP_WORKSPACE_REPO_REF: "origin/main",
      PAPERCLIP_WORKSPACE_BRANCH: "fix/issue-42",
      PAPERCLIP_WORKSPACE_WORKTREE_PATH: WORKTREE,
      AGENT_HOME,
    });
  });

  it("prefers the realized workspace over a configured cwd", async () => {
    const opts = await runOptions(
      { paperclipWorkspace: { cwd: WORKTREE, source: "project_primary", agentHome: AGENT_HOME } },
      { cwd: "/srv/static-checkout" },
    );

    expect(opts.cwd).toBe(WORKTREE);
    expect(opts.env.PAPERCLIP_WORKSPACE_CWD).toBe(WORKTREE);
  });

  it("keeps a configured cwd when the run only has the agent home", async () => {
    const opts = await runOptions(
      { paperclipWorkspace: { cwd: AGENT_HOME, source: "agent_home", agentHome: AGENT_HOME } },
      { cwd: "/srv/static-checkout" },
    );

    expect(opts.cwd).toBe("/srv/static-checkout");
    expect(opts.env.PAPERCLIP_WORKSPACE_CWD).toBeUndefined();
    expect(opts.env.AGENT_HOME).toBe(AGENT_HOME);
  });

  it("uses the agent home when the run has no project workspace and no configured cwd", async () => {
    const opts = await runOptions({
      paperclipWorkspace: { cwd: AGENT_HOME, source: "agent_home", agentHome: AGENT_HOME },
    });

    expect(opts.cwd).toBe(AGENT_HOME);
    expect(opts.env.PAPERCLIP_WORKSPACE_SOURCE).toBe("agent_home");
  });

  it("falls back to the configured cwd, then to the process directory, without a workspace", async () => {
    const configured = await runOptions({}, { cwd: "/srv/static-checkout" });
    expect(configured.cwd).toBe("/srv/static-checkout");
    expect(configured.env.PAPERCLIP_WORKSPACE_CWD).toBeUndefined();

    const legacy = await runOptions({}, { workspaceDir: "/srv/legacy-dir" });
    expect(legacy.cwd).toBe("/srv/legacy-dir");

    const none = await runOptions({});
    expect(none.cwd).toBe(".");
  });

  it("ignores a workspace entry that is not an object", async () => {
    const opts = await runOptions({ paperclipWorkspace: "not-an-object" }, { cwd: "/srv/static-checkout" });

    expect(opts.cwd).toBe("/srv/static-checkout");
  });

  it("exports the other workspaces of the project as JSON", async () => {
    const hints = [
      { workspaceId: "workspace-1", cwd: WORKTREE },
      { workspaceId: "workspace-2", cwd: "/srv/paperclip/projects/demo/mobile" },
    ];
    const opts = await runOptions({
      paperclipWorkspace: { cwd: WORKTREE, source: "task_session" },
      paperclipWorkspaces: hints,
    });

    expect(JSON.parse(opts.env.PAPERCLIP_WORKSPACES_JSON)).toEqual(hints);
  });

  it("keeps the workspace list below the environment size limit", async () => {
    const hints = Array.from({ length: 2000 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      cwd: `/srv/paperclip/projects/demo/workspaces/${"nested/".repeat(10)}workspace-${index}`,
    }));
    const opts = await runOptions({
      paperclipWorkspace: { cwd: WORKTREE, source: "task_session" },
      paperclipWorkspaces: hints,
    });

    const exported = JSON.parse(opts.env.PAPERCLIP_WORKSPACES_JSON);
    expect(opts.env.PAPERCLIP_WORKSPACES_JSON.length).toBeLessThanOrEqual(32 * 1024);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(hints.length);
    expect(exported).toEqual(hints.slice(0, exported.length));
  });

  it("keeps the workspaces of referenced projects when the list is too long", async () => {
    const own = Array.from({ length: 2000 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      cwd: `/srv/paperclip/projects/demo/workspaces/${"nested/".repeat(10)}workspace-${index}`,
    }));
    const referenced = [
      { workspaceId: "ref-1", cwd: "/srv/paperclip/projects/other/ref-1", projectId: "project-2" },
      { workspaceId: "ref-2", cwd: "/srv/paperclip/projects/other/ref-2", projectId: "project-3" },
    ];
    const opts = await runOptions({
      paperclipWorkspace: { cwd: WORKTREE, source: "task_session", projectId: "project-1" },
      paperclipWorkspaces: [...own, ...referenced],
    });

    const exported = JSON.parse(opts.env.PAPERCLIP_WORKSPACES_JSON) as Array<{ workspaceId: string }>;
    expect(opts.env.PAPERCLIP_WORKSPACES_JSON.length).toBeLessThanOrEqual(32 * 1024);
    expect(exported.slice(-2).map((hint) => hint.workspaceId)).toEqual(["ref-1", "ref-2"]);
    expect(exported.length).toBeGreaterThan(2);
    expect(exported.length).toBeLessThan(own.length + referenced.length);
    expect(exported.slice(0, -2)).toEqual(own.slice(0, exported.length - 2));
  });

  it("treats a hint of the anchor project as a hint of the project itself", async () => {
    const own = Array.from({ length: 2000 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      cwd: `/srv/paperclip/projects/demo/workspaces/${"nested/".repeat(10)}workspace-${index}`,
      projectId: "project-1",
    }));
    const opts = await runOptions({
      paperclipWorkspace: { cwd: WORKTREE, source: "task_session", projectId: "project-1" },
      paperclipWorkspaces: own,
    });

    const exported = JSON.parse(opts.env.PAPERCLIP_WORKSPACES_JSON);
    expect(exported).toEqual(own.slice(0, exported.length));
  });

  it("trims a very long workspace list in one pass", async () => {
    const hints = Array.from({ length: 20000 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      cwd: `/srv/paperclip/projects/demo/workspaces/workspace-${index}`,
    }));
    const started = Date.now();
    const opts = await runOptions({
      paperclipWorkspace: { cwd: WORKTREE, source: "task_session" },
      paperclipWorkspaces: hints,
    });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(opts.env.PAPERCLIP_WORKSPACES_JSON.length).toBeLessThanOrEqual(32 * 1024);
    expect(JSON.parse(opts.env.PAPERCLIP_WORKSPACES_JSON).length).toBeGreaterThan(0);
  });

  it("drops workspace variables inherited from another run", async () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_CWD", "/srv/other-run/workspace");
    vi.stubEnv("PAPERCLIP_WORKSPACE_BRANCH", "other-run-branch");
    vi.stubEnv("PAPERCLIP_WORKSPACES_JSON", '[{"cwd":"/srv/other-run/workspace"}]');

    const opts = await runOptions(
      { paperclipWorkspace: { cwd: AGENT_HOME, source: "agent_home", agentHome: AGENT_HOME } },
      { cwd: "/srv/static-checkout" },
    );

    expect(opts.cwd).toBe("/srv/static-checkout");
    expect(opts.env.PAPERCLIP_WORKSPACE_CWD).toBeUndefined();
    expect(opts.env.PAPERCLIP_WORKSPACE_BRANCH).toBeUndefined();
    expect(opts.env.PAPERCLIP_WORKSPACES_JSON).toBeUndefined();
  });

  it("replaces inherited workspace variables with the values of this run", async () => {
    vi.stubEnv("PAPERCLIP_WORKSPACE_CWD", "/srv/other-run/workspace");

    const opts = await runOptions({ paperclipWorkspace: { cwd: WORKTREE, source: "task_session" } });

    expect(opts.env.PAPERCLIP_WORKSPACE_CWD).toBe(WORKTREE);
  });

  it("keeps workspace variables that the adapter configuration sets", async () => {
    const opts = await runOptions({}, { env: { PAPERCLIP_WORKSPACE_CWD: "/srv/configured-checkout" } });

    expect(opts.env.PAPERCLIP_WORKSPACE_CWD).toBe("/srv/configured-checkout");
  });
});
