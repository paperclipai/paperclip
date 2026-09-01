// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ResolvedWorktreeResource } from "@paperclipai/shared";
import {
  chunkWorktreeFileAvailabilityRefs,
  worktreeFileAvailabilityFromResult,
  worktreeFileAvailabilityKey,
  worktreeFileAvailabilityRef,
  worktreeFileAvailabilityTarget,
  WORKSPACE_FILE_AVAILABILITY_MAX_BATCH,
} from "./worktree-file-availability";

function resource(overrides: Partial<ResolvedWorktreeResource> = {}): ResolvedWorktreeResource {
  return {
    kind: "file",
    provider: "git_worktree",
    title: "a.ts",
    displayPath: "ui/src/a.ts",
    workspaceLabel: "Execution workspace",
    workspaceKind: "execution_workspace",
    workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    previewKind: "text",
    capabilities: { preview: true, download: true, listChildren: false },
    ...overrides,
  };
}

describe("workspaceFileAvailabilityRef", () => {
  it("drops line/column so anchors of the same file share one lookup", () => {
    const a = worktreeFileAvailabilityRef({ path: "ui/src/a.ts", line: 4, column: 2, raw: "ui/src/a.ts:4:2" });
    const b = worktreeFileAvailabilityRef({ path: "ui/src/a.ts", line: 90, column: null, raw: "ui/src/a.ts:90" });
    expect(worktreeFileAvailabilityKey(a)).toBe(worktreeFileAvailabilityKey(b));
  });

  it("defaults an unbound reference to the auto selector", () => {
    expect(worktreeFileAvailabilityRef({ path: "a/b.ts", line: null, column: null, raw: "a/b.ts" })).toEqual({
      path: "a/b.ts",
      workspace: "auto",
      projectId: null,
      workspaceId: null,
    });
  });

  it("keeps distinct targets on distinct keys", () => {
    const auto = worktreeFileAvailabilityKey({ path: "a/b.ts", workspace: "auto", projectId: null, workspaceId: null });
    const execution = worktreeFileAvailabilityKey({ path: "a/b.ts", workspace: "execution", projectId: null, workspaceId: null });
    const folder = worktreeFileAvailabilityKey({ path: "a/b.ts/", workspace: "auto", projectId: null, workspaceId: null });
    expect(new Set([auto, execution, folder]).size).toBe(3);
  });

  it("matches the server's dedup key ordering", () => {
    expect(worktreeFileAvailabilityKey({ path: "a/b.ts", workspace: "auto", projectId: null, workspaceId: null }))
      .toBe(JSON.stringify(["auto", null, null, "a/b.ts"]));
  });
});

describe("chunkWorkspaceFileAvailabilityRefs", () => {
  it("returns nothing for an empty list", () => {
    expect(chunkWorktreeFileAvailabilityRefs([])).toEqual([]);
  });

  it("keeps a batch at the cap in one request", () => {
    const refs = Array.from({ length: WORKSPACE_FILE_AVAILABILITY_MAX_BATCH }, (_, index) => index);
    expect(chunkWorktreeFileAvailabilityRefs(refs)).toHaveLength(1);
  });

  it("chunks only above the cap", () => {
    const refs = Array.from({ length: 250 }, (_, index) => index);
    expect(chunkWorktreeFileAvailabilityRefs(refs).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });
});

describe("workspaceFileAvailabilityTarget", () => {
  it("binds a project workspace by explicit ids", () => {
    expect(worktreeFileAvailabilityTarget(resource({
      workspaceKind: "project_workspace",
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      projectName: "Paperclip App",
    }))).toEqual({
      workspace: "project",
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
      projectName: "Paperclip App",
    });
  });

  it("binds an execution workspace by selector alone", () => {
    expect(worktreeFileAvailabilityTarget(resource())).toMatchObject({
      workspace: "execution",
      projectId: null,
      workspaceId: null,
    });
  });
});

describe("workspaceFileAvailabilityFromResult", () => {
  it("accepts an openable result with a resolved resource", () => {
    expect(worktreeFileAvailabilityFromResult({ openable: true, resource: resource() }).state).toBe("openable");
  });

  it("rejects a non-openable result and keeps the reason", () => {
    expect(worktreeFileAvailabilityFromResult({
      openable: false,
      unavailableReason: "not_found",
      resource: null,
    })).toEqual({ state: "unavailable", reason: "not_found" });
  });

  it("fails closed when a result claims openable without a resource", () => {
    expect(worktreeFileAvailabilityFromResult({ openable: true, resource: null }).state).toBe("unavailable");
  });

  it("fails closed for remote resources the viewer cannot preview", () => {
    expect(worktreeFileAvailabilityFromResult({
      openable: false,
      unavailableReason: "remote_workspace",
      resource: resource({ kind: "remote_resource", capabilities: { preview: false, download: false, listChildren: false } }),
    }).state).toBe("unavailable");
  });
});
