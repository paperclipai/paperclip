import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { assertRunProjectGitHubAccess } from "./project-run-github-access.js";

function grantDb(fullNames: string[] = ["org/repo"]) {
  const rows = [{
    tenant: { github: { repositories: fullNames.map(fullName => ({ id: "123", fullName })) } },
  }];
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return {
    db: { select } as unknown as Db,
    select,
    from,
    where,
    setRepositoryId(id: string) {
      rows[0]!.tenant.github.repositories.forEach(repository => { repository.id = id; });
    },
  };
}
const run = {
  companyId: "company-test",
  agentId: "agent-test",
  runId: "run-test",
};
const token = "synthetic-github-token-never-leak";
const available = () => ({
  status: "available",
  env: { PAPERCLIP_GIT_TOKEN: token },
  grantId: "grant-test",
  connectionId: "connection-test",
  identityContextId: "identity-test",
  revision: 3,
});
const liveRepositoryResponse = (id: number) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ id }) });

describe("run project GitHub access policy", () => {
  it.each([
    "https://github.com/org/repo.git",
    "https://www.github.com/org/repo.git",
    "ssh://git@github.com/org/repo.git",
    "git@github.com:org/repo.git",
    "git@www.github.com:org/repo.git",
  ])("checks connection state for GitHub repository %s", async (repoUrl) => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: [repoUrl] }, resolve, request)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("https://api.github.com/repos/org/repo", expect.objectContaining({
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ["revoked", { status: "unavailable" }],
    ["missing", { status: "absent" }],
  ])("rejects a GitHub run when its provider authorization is %s", async (_label, result) => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(result);
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve))
      .rejects.toThrow(/reconnect/i);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not expose provider errors or credential material in the reconnect error", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockRejectedValue(new Error(`provider failed with ${token}`));
    let caught: unknown;
    try {
      await assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["git@github.com:org/repo.git"] }, resolve);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect((caught as Error).message).not.toContain(token);
  });

  it("checks GitHub access in a mixed GitHub, Azure, and local repository set", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const repoUrls = [
      "https://dev.azure.com/org/project/_git/repo",
      "/workspace/local-repository",
      "git@github.com:org/repo.git",
    ];
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls }, resolve, request)).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not resolve provider access when there are no GitHub repositories", async () => {
    const { db } = grantDb();
    const resolve = vi.fn();
    const repoUrls = [
      "https://dev.azure.com/org/project/_git/repo",
      "https://gitlab.com/org/repo.git",
      "/workspace/local-repository",
    ];
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls }, resolve)).resolves.toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("does not allow host credentials for a linked GitHub project even if a connection appeared later", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    await expect(assertRunProjectGitHubAccess(db, { ...run, hostGitHub: true, repoUrls: ["https://github.com/org/repo"] }, resolve))
      .rejects.toThrow(/reconnect/i);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([403, 404])("fails safely when GitHub repository lookup returns %i", async statusCode => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue({ ok: false, status: statusCode }) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
  });

  it("rechecks caller authorization after repository lookup", async () => {
    const { db } = grantDb();
    const resolve = vi.fn()
      .mockResolvedValueOnce(available())
      .mockResolvedValueOnce({ ...available(), status: "unavailable", env: {} });
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["git@github.com:org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("denies repositories outside the selected grant before making a live lookup", async () => {
    const { db, select } = grantDb(["org/another-repo"]);
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(123)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(select).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it("denies when the live GitHub repository ID differs from the grant catalog", async () => {
    const { db } = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockResolvedValue(liveRepositoryResponse(456)) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("denies if the grant catalog repository ID changes during the live request", async () => {
    const catalog = grantDb();
    const resolve = vi.fn().mockResolvedValue(available());
    const request = vi.fn().mockImplementation(async () => {
      catalog.setRepositoryId("456");
      return liveRepositoryResponse(123);
    }) as unknown as typeof fetch;
    await expect(assertRunProjectGitHubAccess(catalog.db, { ...run, repoUrls: ["https://github.com/org/repo.git"] }, resolve, request))
      .rejects.toThrow("Project GitHub authorization is unavailable. Reconnect an authorized connection.");
    expect(request).toHaveBeenCalledTimes(1);
  });

});
