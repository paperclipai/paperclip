import { describe, expect, it, vi } from "vitest";
import { listRegisteredRepositoryProviders } from "./repository-provider-registry.js";

describe("repository provider discovery", () => {
  it("combines providers without losing connection failures or provider identities", async () => {
    const github = vi.fn().mockResolvedValue({ repositories: [{ id: "1", fullName: "z/repo", url: "https://github.com/z/repo", connections: [] }], connections: [{ id: "g", name: "GitHub" }], connectionCount: 1, failedConnectionCount: 0 });
    const azure = vi.fn().mockResolvedValue({ repositories: [{ id: "azure-devops:1", provider: "azure-devops", fullName: "a/repo", url: "https://dev.azure.com/a/p/_git/repo", connections: [] }], connections: [{ id: "a", name: "Azure" }], connectionCount: 1, failedConnectionCount: 1 });
    const result = await listRegisteredRepositoryProviders([{ id: "github", list: github }, { id: "azure-devops", list: azure }]);
    expect(result.repositories.map((repo) => repo.id)).toEqual(["azure-devops:1", "1"]);
    expect(result.connections?.map((connection) => connection.id)).toEqual(["g", "a"]);
    expect(result).toMatchObject({ connectionCount: 2, failedConnectionCount: 1 });
  });

  it("propagates a provider failure rather than silently reporting an empty catalog", async () => {
    await expect(listRegisteredRepositoryProviders([{ id: "failed", list: async () => { throw new Error("unavailable"); } }])).rejects.toThrow("unavailable");
  });
});
