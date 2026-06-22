import { describe, expect, it } from "vitest";
import {
  issueWorkProductMetadataSchema,
  createIssueWorkProductSchema,
} from "./validators/work-product.js";

describe("work product metadata with resource ref", () => {
  it("accepts valid workspace file ref in metadata", () => {
    const result = issueWorkProductMetadataSchema.parse({
      resourceRef: {
        kind: "workspace_file",
        issueId: "123e4567-e89b-12d3-a456-426614174000",
        workspaceKind: "execution_workspace",
        workspaceId: "223e4567-e89b-12d3-a456-426614174001",
        relativePath: "src/components/App.tsx",
        line: 42,
        column: 10,
        displayPath: "src/components/App.tsx:42:10",
      },
    });

    expect(result.resourceRef?.kind).toBe("workspace_file");
    expect(result.resourceRef?.issueId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(result.resourceRef?.relativePath).toBe("src/components/App.tsx");
  });

  it("accepts workspace file ref without line/column", () => {
    const result = issueWorkProductMetadataSchema.parse({
      resourceRef: {
        kind: "workspace_file",
        issueId: "123e4567-e89b-12d3-a456-426614174000",
        workspaceKind: "project_workspace",
        workspaceId: "223e4567-e89b-12d3-a456-426614174001",
        relativePath: "README.md",
        displayPath: "README.md",
      },
    });

    expect(result.resourceRef?.line).toBeUndefined();
    expect(result.resourceRef?.column).toBeUndefined();
  });

  it("accepts null resourceRef", () => {
    const result = issueWorkProductMetadataSchema.parse({
      resourceRef: null,
    });

    expect(result.resourceRef).toBeNull();
  });

  it("accepts undefined resourceRef", () => {
    const result = issueWorkProductMetadataSchema.parse({});

    expect(result.resourceRef).toBeUndefined();
  });

  it("rejects invalid resourceRef missing kind", () => {
    expect(() => {
      issueWorkProductMetadataSchema.parse({
        resourceRef: {
          issueId: "123e4567-e89b-12d3-a456-426614174000",
          workspaceKind: "execution_workspace",
          workspaceId: "223e4567-e89b-12d3-a456-426614174001",
          relativePath: "src/components/App.tsx",
          displayPath: "src/components/App.tsx",
        },
      });
    }).toThrow();
  });

  it("rejects invalid workspaceKind", () => {
    expect(() => {
      issueWorkProductMetadataSchema.parse({
        resourceRef: {
          kind: "workspace_file",
          issueId: "123e4567-e89b-12d3-a456-426614174000",
          workspaceKind: "invalid_kind",
          workspaceId: "223e4567-e89b-12d3-a456-426614174001",
          relativePath: "src/components/App.tsx",
          displayPath: "src/components/App.tsx",
        },
      });
    }).toThrow();
  });

  it("rejects invalid issueId (not UUID)", () => {
    expect(() => {
      issueWorkProductMetadataSchema.parse({
        resourceRef: {
          kind: "workspace_file",
          issueId: "not-a-uuid",
          workspaceKind: "execution_workspace",
          workspaceId: "223e4567-e89b-12d3-a456-426614174001",
          relativePath: "src/components/App.tsx",
          displayPath: "src/components/App.tsx",
        },
      });
    }).toThrow();
  });
});

describe("create issue work product with resource ref", () => {
  it("accepts work product with resourceRef in metadata", () => {
    const result = createIssueWorkProductSchema.parse({
      type: "artifact",
      provider: "paperclip",
      title: "Build output",
      status: "active",
      metadata: {
        resourceRef: {
          kind: "workspace_file",
          issueId: "123e4567-e89b-12d3-a456-426614174000",
          workspaceKind: "execution_workspace",
          workspaceId: "223e4567-e89b-12d3-a456-426614174001",
          relativePath: "dist/index.js",
          displayPath: "dist/index.js",
        },
      },
    });

    expect((result.metadata as any)?.resourceRef?.kind).toBe("workspace_file");
  });

  it("accepts work product without resourceRef in metadata", () => {
    const result = createIssueWorkProductSchema.parse({
      type: "pull_request",
      provider: "github",
      title: "Feature PR",
      status: "active",
      metadata: {
        prNumber: 123,
      },
    });

    expect(result.metadata?.resourceRef).toBeUndefined();
  });
});
