import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeFsTool } from "../src/server/fs-tools.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("executeFsTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "fs-tools-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("fs_write_file writes content and fs_read_file reads it back", async () => {
    const writeResult = await executeFsTool("fs_write_file", {
      path: "hello.txt",
      content: "Hello, World!",
    }, cwd);
    expect(writeResult.isError).toBe(false);

    const readResult = await executeFsTool("fs_read_file", { path: "hello.txt" }, cwd);
    expect(readResult.isError).toBe(false);
    expect(readResult.content).toContain("Hello, World!");
  });

  it("fs_list_directory lists entries", async () => {
    writeFileSync(path.join(cwd, "a.txt"), "a");
    writeFileSync(path.join(cwd, "b.txt"), "b");

    const result = await executeFsTool("fs_list_directory", { path: "." }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.txt");
  });

  it("fs_glob finds matching files", async () => {
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "src", "main.ts"), "");
    writeFileSync(path.join(cwd, "src", "util.ts"), "");
    writeFileSync(path.join(cwd, "readme.md"), "");

    const result = await executeFsTool("fs_glob", { pattern: "**/*.ts" }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("main.ts");
    expect(result.content).toContain("util.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("fs_grep finds pattern in files", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "TODO: fix this\nDone\n");

    const result = await executeFsTool("fs_grep", {
      pattern: "TODO",
      path: ".",
    }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("TODO");
  });

  it("blocks path traversal on fs_read_file", async () => {
    const result = await executeFsTool("fs_read_file", {
      path: "../../../etc/passwd",
    }, cwd);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path traversal blocked");
  });

  it("blocks path traversal on fs_write_file", async () => {
    const result = await executeFsTool("fs_write_file", {
      path: "../evil.txt",
      content: "x",
    }, cwd);
    expect(result.isError).toBe(true);
  });
});
