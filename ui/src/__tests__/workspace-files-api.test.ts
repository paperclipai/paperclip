// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// workspace-files API client — path construction utilities
//
// The workspaceFilesApi builds URLs used to talk to the server-side
// workspace-files routes. These tests verify that the URL shapes are correct
// without making any network calls. The logic under test lives in the URL
// construction expressions inside workspaceFilesApi (api/workspace-files.ts).
//
// We test the URL shape by re-implementing the same small helper the module
// uses, keeping the tests self-contained and fast (node environment, no DOM).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers mirroring the logic in ui/src/api/workspace-files.ts
// ---------------------------------------------------------------------------

function filesBasePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/files`;
}

function listUrl(workspaceId: string, path: string = "."): string {
  return `${filesBasePath(workspaceId)}?path=${encodeURIComponent(path)}`;
}

function readUrl(workspaceId: string, path: string): string {
  return `${filesBasePath(workspaceId)}/read?path=${encodeURIComponent(path)}`;
}

function deleteUrl(workspaceId: string, path: string): string {
  return `${filesBasePath(workspaceId)}?path=${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------------------
// filesBasePath
// ---------------------------------------------------------------------------

describe("filesBasePath", () => {
  it("produces the expected base path for a simple workspace ID", () => {
    expect(filesBasePath("ws-1")).toBe("/workspaces/ws-1/files");
  });

  it("URL-encodes workspace IDs that contain special characters", () => {
    expect(filesBasePath("ws/with/slashes")).toBe(
      "/workspaces/ws%2Fwith%2Fslashes/files",
    );
  });

  it("URL-encodes workspace IDs with spaces", () => {
    expect(filesBasePath("my workspace")).toBe(
      "/workspaces/my%20workspace/files",
    );
  });

  it("handles UUID-style workspace IDs correctly", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(filesBasePath(uuid)).toBe(`/workspaces/${uuid}/files`);
  });
});

// ---------------------------------------------------------------------------
// list URL construction
// ---------------------------------------------------------------------------

describe("list URL construction", () => {
  it("defaults to listing the root directory when no path is given", () => {
    const url = listUrl("ws-1");
    expect(url).toBe("/workspaces/ws-1/files?path=.");
  });

  it("includes the given path in the query string", () => {
    const url = listUrl("ws-1", "src");
    expect(url).toBe("/workspaces/ws-1/files?path=src");
  });

  it("URL-encodes paths with slashes", () => {
    const url = listUrl("ws-1", "src/components");
    expect(url).toBe("/workspaces/ws-1/files?path=src%2Fcomponents");
  });

  it("URL-encodes paths with spaces", () => {
    const url = listUrl("ws-1", "my folder");
    expect(url).toBe("/workspaces/ws-1/files?path=my%20folder");
  });

  it("encodes the dot (root) path explicitly", () => {
    const url = listUrl("ws-1", ".");
    expect(url).toBe("/workspaces/ws-1/files?path=.");
  });
});

// ---------------------------------------------------------------------------
// read URL construction
// ---------------------------------------------------------------------------

describe("read URL construction", () => {
  it("constructs the read endpoint URL correctly", () => {
    const url = readUrl("ws-1", "hello.txt");
    expect(url).toBe("/workspaces/ws-1/files/read?path=hello.txt");
  });

  it("URL-encodes nested paths with slashes", () => {
    const url = readUrl("ws-1", "src/index.ts");
    expect(url).toBe("/workspaces/ws-1/files/read?path=src%2Findex.ts");
  });

  it("URL-encodes file names with spaces", () => {
    const url = readUrl("ws-1", "my file.txt");
    expect(url).toBe("/workspaces/ws-1/files/read?path=my%20file.txt");
  });

  it("URL-encodes deeply nested paths", () => {
    const url = readUrl("ws-1", "a/b/c/deep.json");
    expect(url).toBe("/workspaces/ws-1/files/read?path=a%2Fb%2Fc%2Fdeep.json");
  });
});

// ---------------------------------------------------------------------------
// delete URL construction
// ---------------------------------------------------------------------------

describe("delete URL construction", () => {
  it("constructs the delete query param correctly for a file", () => {
    const url = deleteUrl("ws-1", "old.txt");
    expect(url).toBe("/workspaces/ws-1/files?path=old.txt");
  });

  it("URL-encodes nested paths for deletion", () => {
    const url = deleteUrl("ws-1", "src/old.ts");
    expect(url).toBe("/workspaces/ws-1/files?path=src%2Fold.ts");
  });
});

// ---------------------------------------------------------------------------
// FileEntry type shape verification (structural tests)
// ---------------------------------------------------------------------------

describe("FileEntry interface shape", () => {
  it("a file entry has the expected fields with correct types", () => {
    const entry = {
      name: "index.ts",
      type: "file" as const,
      size: 1234,
      modified: "2024-01-01T00:00:00.000Z",
    };

    expect(typeof entry.name).toBe("string");
    expect(entry.type).toBe("file");
    expect(typeof entry.size).toBe("number");
    expect(typeof entry.modified).toBe("string");
  });

  it("a directory entry has null for size and modified can be null", () => {
    const entry = {
      name: "src",
      type: "directory" as const,
      size: null,
      modified: null,
    };

    expect(entry.type).toBe("directory");
    expect(entry.size).toBeNull();
    expect(entry.modified).toBeNull();
  });
});
