import { describe, expect, it } from "vitest";
import { resolveProjectRepositorySelection } from "./project-repository-selection.js";

describe("retained repository selections", () => {
  it("retains an existing disconnected provider but rejects new inaccessible selections", () => {
    const existing = [{ name: "org/project/repo", repoUrl: "https://dev.azure.com/org/project/_git/repo", metadata: {
      repositoryId: "azure-devops:123", repositoryProvider: "azure-devops", repositoryPrivate: true,
    } }];
    expect(resolveProjectRepositorySelection(["azure-devops:123"], [], existing)).toEqual([{ id: "azure-devops:123", provider: "azure-devops", fullName: "org/project/repo", url: existing[0].repoUrl, private: true, connections: [] }]);
    expect(() => resolveProjectRepositorySelection(["azure-devops:456"], [], existing)).toThrow(/no longer available/);
  });
});
