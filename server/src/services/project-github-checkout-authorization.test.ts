import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { authorizeProjectGitHubCheckout } from "./project-run-github-access.js";

const input = {
  companyId: "company-test",
  projectId: "project-test",
  agentId: "agent-test",
  runId: "run-test",
  repoUrl: "https://github.com/org/repo.git",
};
const token = "synthetic-github-token";
const available = () => ({
  status: "available",
  env: { PAPERCLIP_GIT_TOKEN: token },
  grantId: "grant-test",
  connectionId: "connection-test",
  identityContextId: "identity-test",
  revision: 3,
});

function workspaceDb(rows: Array<{ repoUrl: string | null; metadata: Record<string, unknown> | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as Db, select, from, where };
}

function grantDb() {
  const rows = [{ tenant: { github: { repositories: [{ id: "123", fullName: "org/repo" }] } } }];
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, where };
}

function checkoutDb(snapshots: Array<Array<{ repoUrl: string | null; metadata: Record<string, unknown> | null }>>) {
  const workspaceQueries = snapshots.map(rows => workspaceDb(rows));
  const grants = grantDb();
  let queryIndex = 0;
  const select = vi.fn(() => {
    const index = queryIndex++;
    return { from: index === 0 || index === 3
      ? workspaceQueries[index === 0 ? 0 : workspaceQueries.length - 1]!.from
      : grants.from };
  });
  return { db: { select } as unknown as Db, select, workspaceQueries, grants };
}

const liveRepositoryResponse = (id: number) => ({ ok: true, json: vi.fn().mockResolvedValue({ id }) });

describe("project GitHub checkout authorization", () => {
  it.each([
    { repoUrl: "git@github.com:org/repo.git", metadata: { repositoryProvider: "github", repositoryId: "123" } },
    { repoUrl: "https://www.github.com/ORG/REPO", metadata: { githubRepositoryId: "123" } },
  ])("authorizes normalized workspace identity $repoUrl", async workspace => {
    const { db, workspaceQueries } = checkoutDb([[workspace], [workspace]]);
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubCheckout(db, input, resolve, request)).resolves.toMatchObject({ grantId: "grant-test" });
    expect(workspaceQueries[0]!.where).toHaveBeenCalledTimes(1);
    expect(workspaceQueries[1]!.where).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing workspace", []],
    ["workspace for another repository", [{ repoUrl: "https://github.com/org/other.git", metadata: { repositoryProvider: "github", repositoryId: "123" } }]],
    ["workspace without repository identity", [{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github" } }]],
    ["non-numeric repository identity", [{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github", repositoryId: "org/repo" } }]],
  ])("rejects %s without resolving credentials or falling back", async (_label, rows) => {
    const { db } = workspaceDb(rows as Array<{ repoUrl: string | null; metadata: Record<string, unknown> | null }>);
    const resolve = vi.fn();
    const request = vi.fn() as unknown as typeof fetch;

    await expect(authorizeProjectGitHubCheckout(db, input, resolve, request)).rejects.toThrow(/reconnect and reselect/i);
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a persisted repository ID that differs from the authorized grant catalog", async () => {
    const { db } = checkoutDb([
      [{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github", repositoryId: "456" } }],
    ]);
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubCheckout(db, input, resolve, request)).rejects.toThrow(/reconnect/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects if the workspace repository identity changes during the authorization request", async () => {
    const { db, workspaceQueries } = checkoutDb([
      [{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github", repositoryId: "123" } }],
      [{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github", repositoryId: "456" } }],
    ]);
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;

    await expect(authorizeProjectGitHubCheckout(db, input, resolve, request)).rejects.toThrow(/reconnect and reselect/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(workspaceQueries[0]!.where).toHaveBeenCalledTimes(1);
    expect(workspaceQueries[1]!.where).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid repository URL before reading workspace authorization", async () => {
    const { db, select } = workspaceDb([{ repoUrl: input.repoUrl, metadata: { repositoryProvider: "github", repositoryId: "123" } }]);
    const resolve = vi.fn();

    await expect(authorizeProjectGitHubCheckout(db, { ...input, repoUrl: "https://github.com/org/repo?token=secret" }, resolve))
      .rejects.toThrow(/reconnect and reselect/i);
    expect(select).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
