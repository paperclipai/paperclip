import { describe, expect, it } from "vitest";
import { prepareWorkspaceRepositorySchema } from "@paperclipai/shared";
import { resolveTaskRepository, taskRepositoryRelativePath, assertRepositoryRetryMatches } from "../services/execution-workspace-repositories.js";

const repository = { id: "123", fullName: "team/source", url: "https://github.com/team/source", connections: [] };
describe("task repository acquisition authority", () => {
  it("requires a currently authorized catalog ID, including on retry after revocation", () => {
    expect(resolveTaskRepository({ kind: "catalog", id: "123" }, [repository])).toMatchObject({ catalogRepositoryId: "123" });
    expect(() => resolveTaskRepository({ kind: "catalog", id: "123" }, [])).toThrow(/no longer available/);
    expect(() => resolveTaskRepository({ kind: "catalog", id: "other-company-repo" }, [repository])).toThrow(/no longer available/);
  });
  it("normalizes HTTPS URLs and never accepts credentials, alternate hosts, or shell paths", () => {
    expect(resolveTaskRepository({ kind: "url", url: "https://github.com/team/source.git" }, [repository])).toMatchObject({ catalogRepositoryId: "123", repositoryIdentity: repository.url });
    expect(resolveTaskRepository({ kind: "url", url: "https://github.com/public/repo" }, [])).toMatchObject({ catalogRepositoryId: null });
    for (const url of ["git@github.com:team/source", "https://token@github.com/team/source", "https://evil.example/team/source", "file:///tmp/source", "https://github.com/team/source?q=secret"]) {
      expect(() => resolveTaskRepository({ kind: "url", url }, [])).toThrow(/HTTPS GitHub/);
    }
  });
  it("converges repository aliases into a stable contained path and rejects conflicting refs", () => {
    const source = resolveTaskRepository({ kind: "catalog", id: "123" }, [repository]);
    const alias = resolveTaskRepository({ kind: "url", url: "https://github.com/TEAM/SOURCE.git" }, [repository]);
    expect(taskRepositoryRelativePath(source.repositoryIdentity)).toBe(taskRepositoryRelativePath(alias.repositoryIdentity));
    expect(taskRepositoryRelativePath(source.repositoryIdentity)).toMatch(/^\.paperclip-repositories\/task-repo-[a-f0-9]{24}$/);
    const receipt = { repositoryIdentity: source.repositoryIdentity, requestedRef: "main" };
    expect(() => assertRepositoryRetryMatches(receipt, source.repositoryIdentity, "main")).not.toThrow();
    expect(() => assertRepositoryRetryMatches(receipt, source.repositoryIdentity, "release")).toThrow(/different ref/);
    expect(() => assertRepositoryRetryMatches(receipt, "another", "main")).toThrow(/conflicts/);
  });
  it("accepts refs as data while rejecting options and traversal", () => {
    const parse = (ref: string) => prepareWorkspaceRepositorySchema.parse({ repository: { kind: "catalog", id: "123" }, requestKey: "retry", ref });
    expect(parse("feature/task-files").ref).toBe("feature/task-files");
    for (const ref of ["--upload-pack=sh", "../main", "a..b", "main;echo x", "refs//heads/main"]) expect(() => parse(ref)).toThrow();
  });
});
