import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, SkillPackageRestoreRecipe } from "@paperclipai/db";
import type { GitAuthInvocation } from "../services/git-credentials.js";
import type { GitSkillSnapshot } from "../services/skill-source-git-snapshot.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), openSnapshot: vi.fn() }));

vi.mock("../services/azure-project-git-credentials.js", () => ({
  resolveAzureDevOpsProjectGitCredentials: mocks.resolve,
}));
vi.mock("../services/skill-source-git-snapshot.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/skill-source-git-snapshot.js")>();
  return { ...actual, openGitSkillSnapshot: mocks.openSnapshot };
});
import { azureSkillPackageRecoveryReader } from "../services/azure-skill-package-recovery.js";

const companyId = "company-azure";
const projectId = "project-azure";
const workspaceId = "workspace-azure";
const bindingId = "binding-azure";
const sourceId = "source-azure";
const repositoryUrl = "https://dev.azure.com/contoso/Platform/_git/paperclip";
const repositoryId = "azure-devops:contoso:12345678-1234-1234-1234-1234567890ab";
const commitSha = "a".repeat(40);
const pat = "azure-package-recovery-pat-canary";

const recipe: SkillPackageRestoreRecipe = {
  version: 1, sourceId, repositoryId, repositoryUrl, commitSha, skillPath: "skills/one/SKILL.md", manifest: {
    format: "paperclip-skill-package/v1", contentHash: "0".repeat(64), totalBytes: 1,
    files: [{ path: "SKILL.md", kind: "skill", encoding: "utf8", executable: false, size: 1, sha256: "0".repeat(64) }],
  },
};
const binding = { id: bindingId, companyId, projectId, workspaceId, sourceId, active: true, repositoryUrl, trackingRef: "main" };
const workspace = { id: workspaceId, companyId, projectId, repoUrl: repositoryUrl,
  metadata: { repositoryProvider: "azure-devops", repositoryId } };
const eligibleRow = { binding, workspace };
const auth: GitAuthInvocation & { credentialSecretId: string; credentialSecretVersion: number } = {
  configArgs: [], env: { PAPERCLIP_AZURE_GIT_TOKEN: pat }, source: "managed_connection", secretName: null,
  connectionId: "connection-azure", grantId: "grant-azure", credentialSecretId: "credential-secret-azure", credentialSecretVersion: 1,
  repositoryAuthority: { provider: "azure-devops", url: repositoryUrl },
};

function fakeDb(leftRows: unknown[][], innerRows: unknown[][] = []) {
  let leftIndex = 0, innerIndex = 0;
  const select = vi.fn((_selection?: unknown) => {
    const query: Record<string, unknown> = {};
    let joinKind: "left" | "inner" | null = null;
    query.from = vi.fn(() => query);
    query.innerJoin = vi.fn(() => { joinKind = "inner"; return query; });
    query.leftJoin = vi.fn(() => { joinKind = "left"; return query; });
    query.where = vi.fn(async () => joinKind === "left" ? leftRows[leftIndex++] ?? [] : innerRows[innerIndex++] ?? []);
    return query;
  });
  return { select } as unknown as Db;
}

function snapshotFixture(overrides: Partial<GitSkillSnapshot> = {}): GitSkillSnapshot {
  return { commitSha, treeSha: "b".repeat(40), entries: [], readBlob: vi.fn(async () => Buffer.alloc(0)),
    release: vi.fn(async () => undefined), ...overrides };
}

describe("Azure immutable skill package recovery reader", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns an Azure reader and rechecks current project authorization around exact-SHA snapshot retrieval", async () => {
    const db = fakeDb([[eligibleRow], [eligibleRow], [eligibleRow], [eligibleRow], [eligibleRow]], [[eligibleRow], [eligibleRow], [eligibleRow]]);
    const snapshot = snapshotFixture();
    mocks.resolve.mockResolvedValue(auth);
    mocks.openSnapshot.mockResolvedValue(snapshot);

    const reader = await azureSkillPackageRecoveryReader(db, companyId, recipe);
    expect(reader.provider).toBe("azure-devops");
    const input = { repositoryUrl, ref: commitSha, commitSha };
    await reader.openSnapshot(input);
    // The same immutable SHA may be served from the snapshot cache; every call
    // still obtains current authority before and after consulting that cache.
    await reader.openSnapshot(input);

    expect(mocks.resolve).toHaveBeenCalledTimes(9);
    expect(mocks.resolve).toHaveBeenNthCalledWith(1, db, { companyId, projectId, repoUrl: repositoryUrl });
    expect(mocks.resolve).toHaveBeenNthCalledWith(9, db, { companyId, projectId, repoUrl: repositoryUrl });
    expect(mocks.resolve.mock.calls.every(([, input]) => input.projectId === projectId && input.repoUrl === repositoryUrl)).toBe(true);
    expect(mocks.resolve.mock.calls.every(([receivedDb]) => receivedDb === db)).toBe(true);
    expect(mocks.openSnapshot).toHaveBeenCalledTimes(2);
    for (const [snapshotInput] of mocks.openSnapshot.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(snapshotInput).toMatchObject({ repositoryUrl, ref: commitSha, commitSha, token: "", providerAuth: auth,
        cacheScope: `${companyId}:${projectId}:${sourceId}` });
      expect(snapshotInput.token).toBe("");
      expect(snapshotInput.repositoryUrl).not.toContain(pat);
      expect((snapshotInput.providerAuth as GitAuthInvocation).env.PAPERCLIP_AZURE_GIT_TOKEN).toBe(pat);
    }
    expect(snapshot.release).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive project binding", []],
    ["different source", []],
    ["different repository URL", [{ binding: { ...binding, repositoryUrl: "https://dev.azure.com/contoso/Platform/_git/other" }, workspace }]],
    ["workspace URL mismatch", [{ binding, workspace: { ...workspace, repoUrl: "https://dev.azure.com/contoso/Platform/_git/other" } }]],
    ["provider metadata mismatch", [{ binding, workspace: { ...workspace, metadata: { ...workspace.metadata, repositoryProvider: "github" } } }]],
    ["repository identity mismatch", [{ binding, workspace: { ...workspace, metadata: { ...workspace.metadata, repositoryId: "azure-devops:contoso:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } } }]],
  ])("rejects %s before resolving or passing credentials", async (_name, rows) => {
    const db = fakeDb([rows]);
    await expect(azureSkillPackageRecoveryReader(db, companyId, recipe)).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it("does not open a snapshot when the current project grant is revoked", async () => {
    const db = fakeDb([[eligibleRow]]);
    mocks.resolve.mockRejectedValue(new Error("Project Azure DevOps authorization is unavailable. Reconnect or select a connection."));
    await expect(azureSkillPackageRecoveryReader(db, companyId, recipe)).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.openSnapshot.mock.calls)).not.toContain(pat);
  });

  it("refuses an authorization invocation for a different repository without embedding the PAT in URL or token fields", async () => {
    const db = fakeDb([[eligibleRow], [eligibleRow]], [[eligibleRow]]);
    mocks.resolve.mockResolvedValue({ ...auth, repositoryAuthority: { provider: "azure-devops", url: "https://dev.azure.com/contoso/Platform/_git/other" } });
    mocks.openSnapshot.mockImplementation(async input => {
      if (input.providerAuth?.repositoryAuthority?.url !== recipe.repositoryUrl) throw new Error("Invalid Azure DevOps snapshot request.");
      return snapshotFixture();
    });
    const reader = await azureSkillPackageRecoveryReader(db, companyId, recipe);

    await expect(reader.openSnapshot({ repositoryUrl, ref: commitSha, commitSha })).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.openSnapshot).toHaveBeenCalledOnce();
    expect(mocks.openSnapshot.mock.calls[0]?.[0]).toMatchObject({ token: "" });
    expect(mocks.openSnapshot.mock.calls[0]?.[0].repositoryUrl).toBe(repositoryUrl);
  });

  it("releases a fetched snapshot when a grant changes during the authorization recheck", async () => {
    const db = fakeDb([[eligibleRow], [eligibleRow]], [[eligibleRow]]);
    const snapshot = snapshotFixture();
    mocks.resolve.mockResolvedValueOnce(auth).mockResolvedValueOnce(auth).mockResolvedValueOnce(auth)
      .mockRejectedValueOnce(new Error("Project Azure DevOps authorization is unavailable. Reconnect or select a connection."));
    mocks.openSnapshot.mockResolvedValue(snapshot);
    const reader = await azureSkillPackageRecoveryReader(db, companyId, recipe);

    await expect(reader.openSnapshot({ repositoryUrl, ref: commitSha, commitSha })).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.resolve).toHaveBeenCalledTimes(4);
    expect(snapshot.release).toHaveBeenCalledOnce();
  });

  it("releases the snapshot if the active project binding changes during recheck", async () => {
    const db = fakeDb([[eligibleRow], [eligibleRow], []], [[eligibleRow]]);
    const snapshot = snapshotFixture();
    mocks.resolve.mockResolvedValue(auth);
    mocks.openSnapshot.mockResolvedValue(snapshot);
    const reader = await azureSkillPackageRecoveryReader(db, companyId, recipe);

    await expect(reader.openSnapshot({ repositoryUrl, ref: commitSha, commitSha })).rejects.toThrow(/authorization is unavailable/i);
    expect(snapshot.release).toHaveBeenCalledOnce();
  });

  it("rejects attempts to recover a different or mutable revision before resolving credentials", async () => {
    const db = fakeDb([[eligibleRow]], [[eligibleRow]]);
    mocks.resolve.mockResolvedValue(auth);
    const reader = await azureSkillPackageRecoveryReader(db, companyId, recipe);
    await expect(reader.openSnapshot({ repositoryUrl, ref: "main", commitSha })).rejects.toThrow(/authorization is unavailable/i);
    await expect(reader.openSnapshot({ repositoryUrl, ref: commitSha, commitSha: "c".repeat(40) })).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a shared source before snapshot fetch when any active project's grant is revoked", async () => {
    const secondProjectId = "project-with-revoked-grant";
    const secondBinding = { ...binding, id: "binding-other", projectId: secondProjectId, workspaceId: "workspace-other" };
    const secondWorkspace = { ...workspace, id: secondBinding.workspaceId, projectId: secondProjectId };
    const db = fakeDb([[eligibleRow, { binding: secondBinding, workspace: secondWorkspace }]]);
    mocks.resolve.mockResolvedValueOnce(auth).mockRejectedValueOnce(new Error("Project Azure DevOps authorization is unavailable. Reconnect or select a connection."));

    await expect(azureSkillPackageRecoveryReader(db, companyId, recipe)).rejects.toThrow(/authorization is unavailable/i);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenNthCalledWith(1, db, { companyId, projectId, repoUrl: repositoryUrl });
    expect(mocks.resolve).toHaveBeenNthCalledWith(2, db, { companyId, projectId: secondProjectId, repoUrl: repositoryUrl });
    expect(mocks.openSnapshot).not.toHaveBeenCalled();
  });
});
