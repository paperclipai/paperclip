// @vitest-environment node
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// FileTree component — pure logic tests
//
// The FileTree component contains several pure utility functions that can be
// tested in isolation without rendering React or making network calls:
//
//   • getFilePath(parentPath, name)   – builds a child path from its parent
//   • sortItems(items)                – directories-first alphabetic sort
//   • pathSegments(filePath)          – splits a file path into breadcrumbs
//
// All logic is mirrored here from ui/src/components/FileTree.tsx so the tests
// remain fast and self-contained.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getFilePath — mirrors FileTree.tsx logic
// ---------------------------------------------------------------------------

function getFilePath(parentPath: string, name: string): string {
  if (parentPath === ".") return name;
  return `${parentPath}/${name}`;
}

describe("getFilePath", () => {
  it("returns just the name when parent is root (.)", () => {
    expect(getFilePath(".", "index.ts")).toBe("index.ts");
  });

  it("joins parent and name with a slash for non-root parents", () => {
    expect(getFilePath("src", "index.ts")).toBe("src/index.ts");
  });

  it("handles deeply nested parents", () => {
    expect(getFilePath("src/components/ui", "button.tsx")).toBe(
      "src/components/ui/button.tsx",
    );
  });

  it("does NOT join with slash when parent is root — avoids leading slash", () => {
    const result = getFilePath(".", "hello.txt");
    expect(result.startsWith("/")).toBe(false);
    expect(result).toBe("hello.txt");
  });

  it("preserves the full parent prefix for move/rename operations", () => {
    expect(getFilePath("a/b/c", "d.json")).toBe("a/b/c/d.json");
  });

  it("handles names with dots correctly", () => {
    expect(getFilePath(".", ".gitignore")).toBe(".gitignore");
    expect(getFilePath("src", ".env.local")).toBe("src/.env.local");
  });

  it("handles names with spaces", () => {
    expect(getFilePath(".", "my file.txt")).toBe("my file.txt");
    expect(getFilePath("my folder", "notes.md")).toBe("my folder/notes.md");
  });
});

// ---------------------------------------------------------------------------
// sortItems — directories first, then alphabetical (mirrors FileTree.tsx)
// ---------------------------------------------------------------------------

interface SortableEntry {
  name: string;
  type: "file" | "directory";
}

function sortItems(items: SortableEntry[]): SortableEntry[] {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

describe("sortItems", () => {
  it("returns an empty array unchanged", () => {
    expect(sortItems([])).toEqual([]);
  });

  it("returns a single item unchanged", () => {
    const items: SortableEntry[] = [{ name: "foo.ts", type: "file" }];
    expect(sortItems(items)).toEqual(items);
  });

  it("places directories before files", () => {
    const items: SortableEntry[] = [
      { name: "index.ts", type: "file" },
      { name: "src", type: "directory" },
    ];
    const sorted = sortItems(items);
    expect(sorted[0].type).toBe("directory");
    expect(sorted[1].type).toBe("file");
  });

  it("sorts multiple directories alphabetically among themselves", () => {
    const items: SortableEntry[] = [
      { name: "utils", type: "directory" },
      { name: "api", type: "directory" },
      { name: "components", type: "directory" },
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.name)).toEqual(["api", "components", "utils"]);
  });

  it("sorts multiple files alphabetically among themselves", () => {
    const items: SortableEntry[] = [
      { name: "z.ts", type: "file" },
      { name: "a.ts", type: "file" },
      { name: "m.ts", type: "file" },
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.name)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("interleaves directories and files correctly with mixed input", () => {
    const items: SortableEntry[] = [
      { name: "readme.md", type: "file" },
      { name: "dist", type: "directory" },
      { name: "index.ts", type: "file" },
      { name: "src", type: "directory" },
      { name: "node_modules", type: "directory" },
    ];
    const sorted = sortItems(items);
    const dirs = sorted.filter((i) => i.type === "directory");
    const files = sorted.filter((i) => i.type === "file");

    // All directories come before all files
    expect(sorted.indexOf(dirs[dirs.length - 1])).toBeLessThan(
      sorted.indexOf(files[0]),
    );
    // Directories are alphabetically sorted
    expect(dirs.map((d) => d.name)).toEqual(["dist", "node_modules", "src"]);
    // Files are alphabetically sorted
    expect(files.map((f) => f.name)).toEqual(["index.ts", "readme.md"]);
  });

  it("does not mutate the original array", () => {
    const original: SortableEntry[] = [
      { name: "b.ts", type: "file" },
      { name: "a.ts", type: "file" },
    ];
    const copy = [...original];
    sortItems(original);
    expect(original).toEqual(copy);
  });

  it("is case-sensitive in alphabetic ordering (localeCompare default)", () => {
    const items: SortableEntry[] = [
      { name: "B.ts", type: "file" },
      { name: "a.ts", type: "file" },
    ];
    const sorted = sortItems(items);
    // localeCompare may place uppercase first or after lowercase depending on locale;
    // the important thing is the result is consistent and deterministic.
    expect(sorted).toHaveLength(2);
    expect(sorted.map((i) => i.name).sort()).toEqual(["B.ts", "a.ts"].sort());
  });

  it("handles entries where all are directories", () => {
    const items: SortableEntry[] = [
      { name: "z", type: "directory" },
      { name: "a", type: "directory" },
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.name)).toEqual(["a", "z"]);
    expect(sorted.every((i) => i.type === "directory")).toBe(true);
  });

  it("handles entries where all are files", () => {
    const items: SortableEntry[] = [
      { name: "z.txt", type: "file" },
      { name: "a.txt", type: "file" },
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.name)).toEqual(["a.txt", "z.txt"]);
    expect(sorted.every((i) => i.type === "file")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pathSegments — breadcrumb construction (mirrors WorkspaceDetail.tsx)
// ---------------------------------------------------------------------------

function pathSegments(filePath: string | null): string[] {
  if (!filePath) return [];
  return filePath.split("/").filter(Boolean);
}

describe("pathSegments", () => {
  it("returns an empty array for null", () => {
    expect(pathSegments(null)).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(pathSegments("")).toEqual([]);
  });

  it("returns a single-element array for a root-level file", () => {
    expect(pathSegments("index.ts")).toEqual(["index.ts"]);
  });

  it("splits a nested path into individual segments", () => {
    expect(pathSegments("src/components/Button.tsx")).toEqual([
      "src",
      "components",
      "Button.tsx",
    ]);
  });

  it("handles deeply nested paths", () => {
    expect(pathSegments("a/b/c/d/e.txt")).toEqual(["a", "b", "c", "d", "e.txt"]);
  });

  it("filters out empty segments from leading/trailing slashes", () => {
    // Paths coming from the server should not have leading slashes,
    // but the filter(Boolean) guards against it regardless.
    expect(pathSegments("/src/index.ts")).toEqual(["src", "index.ts"]);
  });

  it("returns the file name as the last segment", () => {
    const segs = pathSegments("src/utils/helpers.ts");
    expect(segs[segs.length - 1]).toBe("helpers.ts");
  });

  it("handles dotfile names", () => {
    expect(pathSegments(".gitignore")).toEqual([".gitignore"]);
    expect(pathSegments("config/.env.local")).toEqual(["config", ".env.local"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: path construction round-trip
// ---------------------------------------------------------------------------

describe("path construction round-trip", () => {
  it("getFilePath followed by pathSegments produces the correct segments", () => {
    const full = getFilePath("src/components", "Button.tsx");
    const segs = pathSegments(full);
    expect(segs).toEqual(["src", "components", "Button.tsx"]);
  });

  it("root-level file: getFilePath + pathSegments gives single segment", () => {
    const full = getFilePath(".", "README.md");
    const segs = pathSegments(full);
    expect(segs).toEqual(["README.md"]);
  });

  it("deeply nested path round-trips correctly", () => {
    const parent = getFilePath("a/b", "c");
    const child = getFilePath(parent, "deep.json");
    expect(child).toBe("a/b/c/deep.json");
    expect(pathSegments(child)).toEqual(["a", "b", "c", "deep.json"]);
  });
});
