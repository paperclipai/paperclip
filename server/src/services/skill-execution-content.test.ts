import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({ version: vi.fn(), assertSkill: vi.fn(), withIsolatedPackage: vi.fn(), lock: vi.fn() }));
vi.mock("./skill-access.js", () => ({ skillAccessService: () => ({ assertSkill: mocks.assertSkill }) }));
vi.mock("./skill-package-store.js", () => ({ skillPackageStore: () => mocks }));
vi.mock("./skill-package-runtime.js", () => ({ skillPackageRuntime: () => ({}) }));
vi.mock("./skill-version-cache.js", () => ({ withSkillVersionCacheLock: mocks.lock }));
import { skillExecutionContent } from "./skill-execution-content.js";

describe("admitted repository reads", () => {
  const reference = { companyId: "company", skillId: "skill", versionId: "version", snapshotId: "snapshot", entryPath: "skills/one/SKILL.md" };
  const version = { companyId: "company", companySkillId: "skill", id: "version", repositorySnapshotId: "snapshot", repositorySkillPath: reference.entryPath };
  it("rechecks authority and immutable identity before using owned isolated storage", async () => {
    vi.clearAllMocks();
    mocks.version.mockResolvedValue(version);
    mocks.withIsolatedPackage.mockImplementation(async (_company, _snapshot, consume) => consume("/owned/private", { files: [] }));
    const consume = vi.fn().mockResolvedValue("read");
    expect(await skillExecutionContent({} as Db).withRepositoryVersion(reference, consume)).toBe("read");
    expect(mocks.assertSkill).toHaveBeenCalledWith("company", "skill");
    expect(mocks.version).toHaveBeenCalledWith("company", "skill", "version");
    expect(mocks.withIsolatedPackage.mock.calls[0]!.slice(0, 2)).toEqual(["company", "snapshot"]);
    expect(consume).toHaveBeenCalledWith("/owned/private", { files: [] });
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it.each(["companyId", "companySkillId", "id", "repositorySnapshotId", "repositorySkillPath"])("refuses mismatched %s without reading bytes", async field => {
    vi.clearAllMocks();
    mocks.version.mockResolvedValue({ ...version, [field]: "other" });
    await expect(skillExecutionContent({} as Db).withRepositoryVersion(reference, vi.fn())).rejects.toThrow("repository");
    expect(mocks.withIsolatedPackage).not.toHaveBeenCalled();
  });
  it("does not acquire storage or a company lock for a denied skill", async () => {
    vi.clearAllMocks();
    mocks.assertSkill.mockRejectedValueOnce(new Error("denied"));
    await expect(skillExecutionContent({} as Db).withRepositoryVersion(reference, vi.fn())).rejects.toThrow("denied");
    expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.withIsolatedPackage).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it("rechecks every assigned entrypoint before sharing one repository read", async () => {
    vi.clearAllMocks();
    const second = { ...reference, skillId: "second", versionId: "second-version", entryPath: "skills/two/SKILL.md" };
    mocks.version.mockResolvedValueOnce(version).mockResolvedValueOnce({ ...version, companySkillId: "second", id: "second-version", repositorySkillPath: "changed/SKILL.md" });
    await expect(skillExecutionContent({} as Db).withRepositoryVersion(reference, vi.fn(), [second])).rejects.toThrow("repository");
    expect(mocks.assertSkill).toHaveBeenCalledWith("company", "second");
    expect(mocks.withIsolatedPackage).not.toHaveBeenCalled();
  });
});
