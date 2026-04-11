import { describe, expect, it } from "vitest";
import { computeHashFromFiles, type FileEntry } from "./instructions-hash.js";

describe("computeHashFromFiles", () => {
  it("returns null for empty file list", () => {
    expect(computeHashFromFiles([])).toBeNull();
  });

  it("returns a 64-char hex string for valid input", () => {
    const files: FileEntry[] = [{ path: "AGENTS.md", content: "# Agent" }];
    const hash = computeHashFromFiles(files);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces stable output for identical input", () => {
    const files: FileEntry[] = [
      { path: "AGENTS.md", content: "# Agent instructions" },
      { path: "SOUL.md", content: "# Soul" },
    ];
    const hash1 = computeHashFromFiles(files);
    const hash2 = computeHashFromFiles(files);
    expect(hash1).toBe(hash2);
  });

  it("produces the same hash regardless of input order", () => {
    const a: FileEntry = { path: "AGENTS.md", content: "agent" };
    const b: FileEntry = { path: "SOUL.md", content: "soul" };
    expect(computeHashFromFiles([a, b])).toBe(computeHashFromFiles([b, a]));
  });

  it("changes when file content changes", () => {
    const before: FileEntry[] = [{ path: "AGENTS.md", content: "v1" }];
    const after: FileEntry[] = [{ path: "AGENTS.md", content: "v2" }];
    expect(computeHashFromFiles(before)).not.toBe(computeHashFromFiles(after));
  });

  it("changes when a file is added", () => {
    const before: FileEntry[] = [{ path: "AGENTS.md", content: "agent" }];
    const after: FileEntry[] = [
      { path: "AGENTS.md", content: "agent" },
      { path: "SOUL.md", content: "soul" },
    ];
    expect(computeHashFromFiles(before)).not.toBe(computeHashFromFiles(after));
  });

  it("changes when a file is removed", () => {
    const before: FileEntry[] = [
      { path: "AGENTS.md", content: "agent" },
      { path: "SOUL.md", content: "soul" },
    ];
    const after: FileEntry[] = [{ path: "AGENTS.md", content: "agent" }];
    expect(computeHashFromFiles(before)).not.toBe(computeHashFromFiles(after));
  });

  it("changes when a file is renamed", () => {
    const before: FileEntry[] = [{ path: "OLD.md", content: "content" }];
    const after: FileEntry[] = [{ path: "NEW.md", content: "content" }];
    expect(computeHashFromFiles(before)).not.toBe(computeHashFromFiles(after));
  });
});
