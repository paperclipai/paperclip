// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import {
  FILE_VIEWER_NAVIGATE_OPTIONS,
  readBrowseStateFromSearch,
  readFileViewerStateFromSearch,
  shouldNavigateFileViewerSearch,
  writeBrowseStateToSearch,
  writeFolderViewerStateToSearch,
  writeFileViewerStateToSearch,
} from "./FileViewerContext";

describe("FILE_VIEWER_NAVIGATE_OPTIONS", () => {
  it("preserves page scroll when the viewer updates URL search params", () => {
    expect(FILE_VIEWER_NAVIGATE_OPTIONS.preventScrollReset).toBe(true);
    expect(FILE_VIEWER_NAVIGATE_OPTIONS.replace).toBe(false);
  });
});

describe("shouldNavigateFileViewerSearch", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("uses the browser URL search when router state is stale", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: "?browse=1" } },
    });

    expect(shouldNavigateFileViewerSearch("", "")).toBe(true);
  });

  it("keeps no-op navigation suppressed when the browser URL already matches", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: "" } },
    });

    expect(shouldNavigateFileViewerSearch("", "?browse=1")).toBe(false);
  });
});

describe("readFileViewerStateFromSearch", () => {
  it("returns null when no file param is present", () => {
    expect(readFileViewerStateFromSearch("")).toBeNull();
    expect(readFileViewerStateFromSearch("?other=1")).toBeNull();
  });

  it("reads file, line, column, workspace from the search", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts&line=42&column=3&workspace=project");
    expect(state).toEqual({
      path: "ui/src/a.ts",
      line: 42,
      column: 3,
      workspace: "project",
      projectId: null,
      workspaceId: null,
    });
  });

  it("defaults to auto workspace when param missing", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts");
    expect(state?.workspace).toBe("auto");
  });

  it("clamps invalid workspace to auto", () => {
    const state = readFileViewerStateFromSearch("?file=ui/src/a.ts&workspace=bogus");
    expect(state?.workspace).toBe("auto");
  });

  it("treats invalid line/column as null", () => {
    const state = readFileViewerStateFromSearch("?file=x.ts&line=abc&column=-1");
    expect(state?.line).toBeNull();
    expect(state?.column).toBeNull();
  });
});

describe("writeFileViewerStateToSearch", () => {
  it("sets all params when opening", () => {
    const next = writeFileViewerStateToSearch(
      "?existing=1",
      {
        path: "ui/src/a.ts",
        line: 42,
        column: 3,
        workspace: "project",
        projectId: null,
        workspaceId: null,
      },
    );
    const params = new URLSearchParams(next);
    expect(params.get("file")).toBe("ui/src/a.ts");
    expect(params.get("line")).toBe("42");
    expect(params.get("column")).toBe("3");
    expect(params.get("workspace")).toBe("project");
    expect(params.get("existing")).toBe("1");
  });

  it("omits workspace when auto", () => {
    const next = writeFileViewerStateToSearch(
      "",
      { path: "a.ts", line: null, column: null, workspace: "auto", projectId: null, workspaceId: null },
    );
    expect(next.includes("workspace")).toBe(false);
  });

  it("round-trips explicit target project workspace params", () => {
    const targetPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/README.md";
    const next = writeFileViewerStateToSearch(
      "?existing=1",
      {
        path: targetPath,
        line: 7,
        column: null,
        workspace: "auto",
        projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
        workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
      },
    );
    const state = readFileViewerStateFromSearch(next);
    expect(state).toEqual({
      path: targetPath,
      line: 7,
      column: null,
      workspace: "auto",
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    });
  });

  it("clears viewer params when closing", () => {
    const next = writeFileViewerStateToSearch(
      "?file=a.ts&line=1&column=2&workspace=project&projectId=project-1&workspaceId=workspace-1&keep=yes",
      null,
    );
    const params = new URLSearchParams(next);
    expect(params.get("file")).toBeNull();
    expect(params.get("line")).toBeNull();
    expect(params.get("column")).toBeNull();
    expect(params.get("workspace")).toBeNull();
    expect(params.get("projectId")).toBeNull();
    expect(params.get("workspaceId")).toBeNull();
    expect(params.get("keep")).toBe("yes");
  });

  it("clears browse-origin viewer params when closing a selected file", () => {
    const next = writeFileViewerStateToSearch(
      "?tab=thread&browse=1&q=FileViewer&folder=ui/src&file=ui/src/FileViewer.tsx&line=4",
      null,
    );
    const params = new URLSearchParams(next);
    expect(params.get("file")).toBeNull();
    expect(params.get("line")).toBeNull();
    expect(params.get("browse")).toBeNull();
    expect(params.get("q")).toBeNull();
    expect(params.get("folder")).toBeNull();
    expect(params.get("tab")).toBe("thread");
  });

  it("returns empty string when no params remain", () => {
    const next = writeFileViewerStateToSearch("?file=a.ts", null);
    expect(next).toBe("");
  });
});

describe("folder browse search state", () => {
  it("round-trips explicit target folder browse params", () => {
    const targetPath = "content-os/cases/active/2026-06-06-pap-10199-bundled-skills/";
    const next = writeFolderViewerStateToSearch("?tab=thread", {
      path: targetPath,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    });

    expect(readFileViewerStateFromSearch(next)).toBeNull();
    expect(readBrowseStateFromSearch(next)).toEqual({
      q: null,
      folderPath: targetPath,
      projectId: "17acae7d-9d0c-46bf-9c82-be9694ac3461",
      workspaceId: "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2",
    });
  });

  it("updates browse params without closing the active file preview", () => {
    const next = writeBrowseStateToSearch(
      "?tab=thread&file=ui/src/components/FileViewerSheet.tsx&line=5&browse=1",
      {
        q: " FileViewerSheet ",
        folderPath: "ui/src/components",
        projectId: null,
        workspaceId: null,
      },
    );

    const params = new URLSearchParams(next);
    expect(params.get("file")).toBe("ui/src/components/FileViewerSheet.tsx");
    expect(params.get("line")).toBe("5");
    expect(params.get("browse")).toBe("1");
    expect(params.get("q")).toBe("FileViewerSheet");
    expect(params.get("folder")).toBe("ui/src/components");
    expect(params.get("tab")).toBe("thread");
  });

  it("clears browse params while preserving the file preview", () => {
    const next = writeBrowseStateToSearch(
      "?file=ui/src/components/FileViewerSheet.tsx&browse=1&q=FileViewerSheet&folder=ui/src/components",
      { q: null, folderPath: null },
    );

    const params = new URLSearchParams(next);
    expect(params.get("file")).toBe("ui/src/components/FileViewerSheet.tsx");
    expect(params.get("browse")).toBe("1");
    expect(params.get("q")).toBeNull();
    expect(params.get("folder")).toBeNull();
  });
});
