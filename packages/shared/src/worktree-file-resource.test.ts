import { describe, expect, it } from "vitest";
import {
  worktreeFileAvailabilityRequestSchema,
  worktreeFileAvailabilityResponseSchema,
} from "./validators/worktree-file-resource.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const worktreeId = "22222222-2222-4222-8222-222222222222";

describe("worktree file availability schemas", () => {
  it("accepts at most 100 resource queries", () => {
    const query = { path: "src/app.ts", workspace: "auto" as const };
    expect(worktreeFileAvailabilityRequestSchema.safeParse({ queries: Array.from({ length: 100 }, () => query) }).success).toBe(true);
    expect(worktreeFileAvailabilityRequestSchema.safeParse({ queries: Array.from({ length: 101 }, () => query) }).success).toBe(false);
  });

  it("rejects malformed paths and incomplete targets", () => {
    expect(worktreeFileAvailabilityRequestSchema.safeParse({ queries: [{ path: "src/\u0000app.ts" }] }).success).toBe(false);
    expect(worktreeFileAvailabilityRequestSchema.safeParse({ queries: [{ path: "src/app.ts", projectId }] }).success).toBe(false);
    expect(worktreeFileAvailabilityRequestSchema.safeParse({
      queries: [{ path: "src/app.ts", projectId, workspaceId: worktreeId }],
    }).success).toBe(true);
  });

  it("parses normalized openable and unavailable results", () => {
    const parsed = worktreeFileAvailabilityResponseSchema.parse({
      kind: "workspace_file_availability",
      results: [
        {
          query: { path: "src/app.ts", workspace: "project", projectId: null, workspaceId: null },
          openable: true,
          resource: {
            kind: "file",
            provider: "local_fs",
            title: "app.ts",
            displayPath: "src/app.ts",
            workspaceLabel: "Primary workspace",
            workspaceKind: "project_workspace",
            workspaceId: worktreeId,
            projectId,
            projectName: "Project",
            contentType: "text/plain; charset=utf-8",
            byteSize: 12,
            previewKind: "text",
            capabilities: { preview: true, download: true, listChildren: false },
          },
        },
        {
          query: { path: "missing.ts", workspace: "auto", projectId: null, workspaceId: null },
          openable: false,
          unavailableReason: "not_found",
          resource: null,
        },
      ],
    });

    expect(parsed.results.map((result) => result.openable)).toEqual([true, false]);
  });
});
