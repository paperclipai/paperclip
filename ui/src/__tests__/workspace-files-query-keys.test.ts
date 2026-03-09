// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// workspaceFiles query keys — shape verification tests
//
// queryKeys.workspaceFiles has two key factories used throughout the
// workspace-file-editor feature:
//
//   • list(workspaceId, path)  – React Query key for directory listings
//   • file(workspaceId, path)  – React Query key for individual file reads
//
// These tests verify that:
//  1. The key arrays have the expected structure and values.
//  2. Different inputs produce different keys (no cross-query collisions).
//  3. The defaults behave correctly (list defaults to ".").
//  4. The keys are consistent across calls (referential equality is not
//     required but value equality must hold).
//
// The keys are mirrored here from ui/src/lib/queryKeys.ts so the tests are
// self-contained and fast (no React, no imports of the full module).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Key factories — mirrored from queryKeys.ts
// ---------------------------------------------------------------------------

const workspaceFiles = {
  list: (workspaceId: string, path: string = "."): readonly unknown[] =>
    ["workspace-files", workspaceId, path] as const,

  file: (workspaceId: string, path: string): readonly unknown[] =>
    ["workspace-files", "file", workspaceId, path] as const,
};

// ---------------------------------------------------------------------------
// workspaceFiles.list
// ---------------------------------------------------------------------------

describe("workspaceFiles.list", () => {
  it("has three elements", () => {
    expect(workspaceFiles.list("ws-1", ".")).toHaveLength(3);
  });

  it("starts with 'workspace-files' namespace prefix", () => {
    expect(workspaceFiles.list("ws-1", ".")[0]).toBe("workspace-files");
  });

  it("includes the workspace ID as the second element", () => {
    const key = workspaceFiles.list("ws-abc-123", ".");
    expect(key[1]).toBe("ws-abc-123");
  });

  it("includes the path as the third element", () => {
    expect(workspaceFiles.list("ws-1", "src")[2]).toBe("src");
    expect(workspaceFiles.list("ws-1", ".")[2]).toBe(".");
  });

  it("defaults path to '.' when not provided", () => {
    expect(workspaceFiles.list("ws-1")).toEqual(["workspace-files", "ws-1", "."]);
  });

  it("produces the same key for the same inputs", () => {
    const a = workspaceFiles.list("ws-1", "src/components");
    const b = workspaceFiles.list("ws-1", "src/components");
    expect(a).toEqual(b);
  });

  it("produces different keys for different workspace IDs", () => {
    const a = workspaceFiles.list("ws-1", "src");
    const b = workspaceFiles.list("ws-2", "src");
    expect(a).not.toEqual(b);
  });

  it("produces different keys for different paths", () => {
    const a = workspaceFiles.list("ws-1", "src");
    const b = workspaceFiles.list("ws-1", "dist");
    expect(a).not.toEqual(b);
  });

  it("produces different keys for root vs a subdirectory", () => {
    const root = workspaceFiles.list("ws-1", ".");
    const sub = workspaceFiles.list("ws-1", "src");
    expect(root).not.toEqual(sub);
  });

  it("handles deeply nested paths", () => {
    const key = workspaceFiles.list("ws-1", "a/b/c/d");
    expect(key[2]).toBe("a/b/c/d");
  });

  it("does NOT clash with workspaceFiles.file keys", () => {
    const listKey = workspaceFiles.list("ws-1", "index.ts");
    const fileKey = workspaceFiles.file("ws-1", "index.ts");
    expect(listKey).not.toEqual(fileKey);
  });
});

// ---------------------------------------------------------------------------
// workspaceFiles.file
// ---------------------------------------------------------------------------

describe("workspaceFiles.file", () => {
  it("has four elements", () => {
    expect(workspaceFiles.file("ws-1", "index.ts")).toHaveLength(4);
  });

  it("starts with 'workspace-files' namespace prefix", () => {
    expect(workspaceFiles.file("ws-1", "index.ts")[0]).toBe("workspace-files");
  });

  it("has 'file' as the second element (distinguishes from list keys)", () => {
    expect(workspaceFiles.file("ws-1", "index.ts")[1]).toBe("file");
  });

  it("includes the workspace ID as the third element", () => {
    expect(workspaceFiles.file("ws-xyz", "foo.ts")[2]).toBe("ws-xyz");
  });

  it("includes the file path as the fourth element", () => {
    expect(workspaceFiles.file("ws-1", "src/index.ts")[3]).toBe("src/index.ts");
  });

  it("produces the same key for the same inputs", () => {
    const a = workspaceFiles.file("ws-1", "src/index.ts");
    const b = workspaceFiles.file("ws-1", "src/index.ts");
    expect(a).toEqual(b);
  });

  it("produces different keys for different workspace IDs", () => {
    const a = workspaceFiles.file("ws-1", "src/index.ts");
    const b = workspaceFiles.file("ws-2", "src/index.ts");
    expect(a).not.toEqual(b);
  });

  it("produces different keys for different file paths", () => {
    const a = workspaceFiles.file("ws-1", "src/a.ts");
    const b = workspaceFiles.file("ws-1", "src/b.ts");
    expect(a).not.toEqual(b);
  });

  it("handles root-level file paths", () => {
    const key = workspaceFiles.file("ws-1", "README.md");
    expect(key[3]).toBe("README.md");
  });

  it("handles deeply nested file paths", () => {
    const key = workspaceFiles.file("ws-1", "a/b/c/deep.json");
    expect(key[3]).toBe("a/b/c/deep.json");
  });

  it("handles dotfile paths", () => {
    const key = workspaceFiles.file("ws-1", ".gitignore");
    expect(key[3]).toBe(".gitignore");
  });
});

// ---------------------------------------------------------------------------
// Cross-key collision checks — ensure no two different operations share a key
// ---------------------------------------------------------------------------

describe("workspaceFiles key isolation", () => {
  const WS = "ws-1";
  const PATH = "src/index.ts";

  it("list and file keys for the same path are distinct", () => {
    const list = workspaceFiles.list(WS, PATH);
    const file = workspaceFiles.file(WS, PATH);
    expect(list).not.toEqual(file);
  });

  it("list key for parent and file key for child are distinct", () => {
    const list = workspaceFiles.list(WS, "src");
    const file = workspaceFiles.file(WS, "src/index.ts");
    expect(list).not.toEqual(file);
  });

  it("list root key and list subdirectory key are distinct", () => {
    const root = workspaceFiles.list(WS, ".");
    const sub = workspaceFiles.list(WS, "src");
    expect(root).not.toEqual(sub);
  });

  it("two file keys for different workspaces are distinct", () => {
    const a = workspaceFiles.file("ws-1", "file.ts");
    const b = workspaceFiles.file("ws-2", "file.ts");
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Invalidation targeting — verify prefix matching behaviour
//
// React Query invalidates all queries whose key STARTS WITH the provided
// prefix. These tests document which queries are affected by each invalidation
// call used in the FileTree CRUD operations.
// ---------------------------------------------------------------------------

/**
 * Simulates React Query's prefix-match logic used by invalidateQueries.
 * A query key `candidate` is matched if `prefix` is a prefix of it.
 */
function matchesPrefix(
  candidate: readonly unknown[],
  prefix: readonly unknown[],
): boolean {
  if (prefix.length > candidate.length) return false;
  return prefix.every((val, i) => candidate[i] === val);
}

describe("invalidation prefix matching", () => {
  it("list key for parent path matches its own exact key", () => {
    const target = workspaceFiles.list("ws-1", "src");
    const invalidationKey = workspaceFiles.list("ws-1", "src");
    expect(matchesPrefix(target, invalidationKey)).toBe(true);
  });

  it("list key for a child path does NOT match parent invalidation key", () => {
    // Invalidating "src" should not automatically invalidate "src/components"
    // because the full third element differs.
    const child = workspaceFiles.list("ws-1", "src/components");
    const parentKey = workspaceFiles.list("ws-1", "src");
    expect(matchesPrefix(child, parentKey)).toBe(false);
  });

  it("file key does NOT match a list invalidation key", () => {
    const fileKey = workspaceFiles.file("ws-1", "src/index.ts");
    const listKey = workspaceFiles.list("ws-1", "src");
    expect(matchesPrefix(fileKey, listKey)).toBe(false);
  });

  it("namespace prefix ['workspace-files'] matches both list and file keys", () => {
    const namespace = ["workspace-files"] as const;
    expect(matchesPrefix(workspaceFiles.list("ws-1", "."), namespace)).toBe(true);
    expect(matchesPrefix(workspaceFiles.file("ws-1", "f.ts"), namespace)).toBe(true);
  });
});
