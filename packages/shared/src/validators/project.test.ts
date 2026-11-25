import { describe, expect, it } from "vitest";
import { createProjectSchema, projectRepositoryIdsSchema } from "./project.js";

describe("project repository ID validation", () => {
  it("accepts legacy numeric GitHub IDs and provider-prefixed Azure DevOps UUIDs", () => {
    const repositoryIds = [
      "123456789",
      "9".repeat(200),
      "azure-devops:550e8400-e29b-41d4-a716-446655440000",
      "azure-devops:550e8400-e29b-01d4-a716-446655440000",
      "azure-devops:my-org:550e8400-e29b-01d4-a716-446655440000",
    ];
    expect(projectRepositoryIdsSchema.parse(repositoryIds)).toEqual(repositoryIds);
    expect(createProjectSchema.safeParse({ name: "Project", repositoryIds }).success).toBe(true);
  });

  it("accepts bounded IDs for future providers without making the prefix an authorization grant", () => {
    expect(projectRepositoryIdsSchema.parse(["gitlab:group-repo_123"])).toEqual(["gitlab:group-repo_123"]);
    expect(projectRepositoryIdsSchema.safeParse([`gitlab:${"x".repeat(129)}`]).success).toBe(false);
    expect(projectRepositoryIdsSchema.safeParse(Array.from({ length: 101 }, (_, index) => String(index))).success).toBe(true);
  });

  it("rejects malformed Azure DevOps UUIDs and unsafe provider IDs", () => {
    for (const repositoryId of [
      "",
      "azure-devops:123",
      "azure-devops:not-a-uuid",
      "gitlab:",
      "git lab:repo",
      "gitlab:repo/with/slash",
    ]) {
      expect(projectRepositoryIdsSchema.safeParse([repositoryId]).success).toBe(false);
    }
  });
});
