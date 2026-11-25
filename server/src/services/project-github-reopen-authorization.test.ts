import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { authorizeProjectGitHubReopen } from "./project-run-github-access.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  service: vi.fn(),
}));

vi.mock("./project-git-authorization.js", () => ({
  projectGitAuthorizationService: mocks.service,
}));

const input = {
  companyId: "company-test",
  projectId: "project-test",
  repoUrl: "https://github.com/org/repo.git",
};
const token = "synthetic-reopen-token-do-not-leak";
const repositoryId = "12345";

type Workspace = { id: string; repoUrl: string | null; metadata: Record<string, unknown> | null };
function workspaceDb(snapshots: Workspace[][]) {
  let queryIndex = 0;
  const whereCalls: ReturnType<typeof vi.fn>[] = [];
  const select = vi.fn(() => {
    const rows = snapshots[Math.min(queryIndex++, snapshots.length - 1)] ?? [];
    const where = vi.fn().mockResolvedValue(rows);
    whereCalls.push(where);
    return { from: vi.fn().mockReturnValue({ where }) };
  });
  return { db: { select } as unknown as Db, select, whereCalls };
}

const workspace = (id = repositoryId): Workspace => ({
  id: "workspace-test",
  repoUrl: input.repoUrl,
  metadata: { repositoryProvider: "github", repositoryId: id, githubRepositoryId: id },
});
const liveResponse = (id: string | number = repositoryId) => ({ ok: true, json: vi.fn().mockResolvedValue({ id }) });

describe("project GitHub reopen authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.service.mockReturnValue({ resolve: mocks.resolve });
  });

  it("reopens with active project consent when the stored ID matches the live GitHub ID", async () => {
    const { db, whereCalls } = workspaceDb([[workspace()], [workspace()]]);
    mocks.resolve.mockResolvedValue(token);
    const request = vi.fn().mockResolvedValue(liveResponse()) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).resolves.toBe(token);
    expect(mocks.service).toHaveBeenCalledWith(db);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenNthCalledWith(1, {
      ...input,
      workspaceId: "workspace-test",
      expectedRepository: "org/repo",
      expectedRepositoryId: repositoryId,
      requireConnected: true,
    }, { projectId: input.projectId, workspaceId: "workspace-test", operation: "prepare" });
    expect(request).toHaveBeenCalledWith("https://api.github.com/repos/org/repo", expect.objectContaining({
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
    expect(whereCalls).toHaveLength(2);
  });

  it("accepts legacy workspace metadata with repositoryId and no provider fields", async () => {
    const legacyWorkspace: Workspace = {
      id: "legacy-workspace-test",
      repoUrl: input.repoUrl,
      metadata: { repositoryId },
    };
    const { db } = workspaceDb([[legacyWorkspace], [legacyWorkspace]]);
    mocks.resolve.mockResolvedValue(token);
    const request = vi.fn().mockResolvedValue(liveResponse()) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).resolves.toBe(token);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "legacy-workspace-test",
      expectedRepository: "org/repo",
      expectedRepositoryId: repositoryId,
      requireConnected: true,
    }), expect.any(Object));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no saved repository identity", [{ ...workspace(), metadata: null }]],
    ["no active project consent", [workspace()]],
  ])("rejects %s without exposing credentials", async (_label, rows) => {
    const snapshots = _label === "no active project consent" ? [rows as Workspace[], rows as Workspace[]] : [rows as Workspace[]];
    const { db } = workspaceDb(snapshots);
    if (_label === "no active project consent") mocks.resolve.mockResolvedValue(null);
    const request = vi.fn().mockResolvedValue(liveResponse()) as unknown as typeof fetch;

    let caught: unknown;
    try { await authorizeProjectGitHubReopen(db, input, request); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Project GitHub authorization is unavailable. Reconnect and reselect the repository.");
    expect((caught as Error).message).not.toContain(token);
    if (_label === "no saved repository identity") {
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } else {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("rejects when the selected authorization's repository catalog no longer contains the stored ID", async () => {
    const { db } = workspaceDb([[workspace()]]);
    mocks.resolve.mockRejectedValue(new Error(`catalog denied ${token}`));
    const request = vi.fn() as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).rejects.toThrow(
      "Project GitHub authorization is unavailable. Reconnect and reselect the repository.",
    );
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ expectedRepositoryId: repositoryId }), expect.any(Object));
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a live GitHub repository ID that differs from the stored ID", async () => {
    const { db } = workspaceDb([[workspace()]]);
    mocks.resolve.mockResolvedValue(token);
    const request = vi.fn().mockResolvedValue(liveResponse("67890")) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).rejects.toThrow(/reconnect and reselect/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects if workspace repository identity changes after the GitHub API response", async () => {
    const { db, whereCalls } = workspaceDb([[workspace()], [workspace("67890")]]);
    mocks.resolve.mockResolvedValue(token);
    const request = vi.fn().mockResolvedValue(liveResponse()) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).rejects.toThrow(/reconnect and reselect/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(whereCalls).toHaveLength(2);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects if project consent resolves to a different token after the GitHub API response", async () => {
    const { db } = workspaceDb([[workspace()], [workspace()]]);
    mocks.resolve.mockResolvedValueOnce(token).mockResolvedValueOnce("rotated-token");
    const request = vi.fn().mockResolvedValue(liveResponse()) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).rejects.toThrow(/reconnect and reselect/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a GitHub API 403 without leaking token or response details", async () => {
    const { db } = workspaceDb([[workspace()]]);
    mocks.resolve.mockResolvedValue(token);
    const request = vi.fn().mockResolvedValue({ ok: false, status: 403, body: { cancel: vi.fn() } }) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubReopen(db, input, request)).rejects.toThrow(
      "Project GitHub authorization is unavailable. Reconnect and reselect the repository.",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
