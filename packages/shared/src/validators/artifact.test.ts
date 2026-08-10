import { describe, expect, it } from "vitest";
import { companyArtifactsQuerySchema, companyArtifactsResponseSchema } from "./artifact.js";

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "PAP-1",
  title: "Build artifacts",
};

const artifact = {
  id: "document:22222222-2222-4222-8222-222222222222",
  source: "document",
  mediaKind: "document",
  title: "Plan",
  previewText: "Artifact preview",
  contentType: "text/markdown",
  contentPath: null,
  openPath: null,
  downloadPath: null,
  issue,
  project: null,
  createdByAgent: null,
  updatedAt: "2026-06-06T12:00:00.000Z",
  href: "/PAP/issues/PAP-1#document-plan",
};

describe("companyArtifactsQuerySchema", () => {
  it("defaults to the existing flat artifact query", () => {
    expect(companyArtifactsQuerySchema.parse({})).toMatchObject({
      kind: "all",
      groupBy: "none",
      limit: 30,
    });
  });

  it("accepts grouped artifact query parameters", () => {
    expect(
      companyArtifactsQuerySchema.parse({
        groupBy: "parent_task",
        groupIssueId: issue.id,
        kind: "video",
        q: "render",
      }),
    ).toMatchObject({
      groupBy: "parent_task",
      groupIssueId: issue.id,
      kind: "video",
      q: "render",
    });
  });

  it("rejects invalid grouped artifact query parameters", () => {
    expect(() => companyArtifactsQuerySchema.parse({ groupBy: "agent" })).toThrow();
    expect(() => companyArtifactsQuerySchema.parse({ groupIssueId: "PAP-1" })).toThrow();
  });
});

describe("companyArtifactsResponseSchema", () => {
  it("accepts grouped artifact responses with selected group metadata", () => {
    const group = {
      id: `task:${issue.id}`,
      groupBy: "task",
      issue,
      title: issue.title,
      count: 1,
      mediaKinds: ["document"],
      previewArtifacts: [artifact],
      updatedAt: "2026-06-06T12:00:00.000Z",
      href: `/PAP/artifacts?groupBy=task&groupIssueId=${issue.id}`,
    };

    expect(
      companyArtifactsResponseSchema.parse({
        artifacts: [artifact],
        groups: [group],
        selectedGroup: group,
        nextCursor: null,
      }),
    ).toMatchObject({
      artifacts: [artifact],
      groups: [group],
      selectedGroup: group,
      nextCursor: null,
    });
  });
});
