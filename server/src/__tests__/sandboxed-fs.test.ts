import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSandboxedFilesRecursive,
  normalizeSandboxRelativePath,
  readSandboxedFile,
  resolvePathInSandbox,
} from "../lib/sandboxed-fs.js";

let tmpRoots: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandboxed-fs-"));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("normalizeSandboxRelativePath", () => {
  it("rejects empty paths", () => {
    expect(() => normalizeSandboxRelativePath("")).toThrow();
    expect(() => normalizeSandboxRelativePath("   ")).toThrow();
  });

  it("rejects parent-directory traversal", () => {
    expect(() => normalizeSandboxRelativePath("..")).toThrow();
    expect(() => normalizeSandboxRelativePath("../etc/passwd")).toThrow();
    expect(() => normalizeSandboxRelativePath("foo/../../bar")).toThrow();
  });

  it("strips leading slashes (matches existing codebase convention) and rejects NUL bytes", () => {
    expect(normalizeSandboxRelativePath("/foo/bar.md")).toBe("foo/bar.md");
    const raw = `foo${String.fromCharCode(0)}bar`;
    expect(() => normalizeSandboxRelativePath(raw)).toThrow();
  });

  it("normalizes backslashes and leading slashes", () => {
    expect(normalizeSandboxRelativePath("foo/bar.md")).toBe("foo/bar.md");
    expect(normalizeSandboxRelativePath("/foo/bar.md")).toBe("foo/bar.md");
    expect(normalizeSandboxRelativePath("foo\\bar.md")).toBe("foo/bar.md");
  });
});

describe("resolvePathInSandbox", () => {
  it("resolves valid relative paths under the root", async () => {
    const root = await makeTempDir();
    const resolved = resolvePathInSandbox(root, "foo/bar.md");
    expect(resolved.startsWith(path.resolve(root))).toBe(true);
    expect(resolved.endsWith(path.join("foo", "bar.md"))).toBe(true);
  });

  it("rejects traversal even when lexically valid components are present", async () => {
    const root = await makeTempDir();
    expect(() => resolvePathInSandbox(root, "../escape")).toThrow();
    expect(() => resolvePathInSandbox(root, "ok/../../escape")).toThrow();
  });
});

describe("listSandboxedFilesRecursive", () => {
  it("returns null when the root does not exist", async () => {
    const tmp = await makeTempDir();
    const missing = path.join(tmp, "does-not-exist");
    expect(await listSandboxedFilesRecursive(missing)).toBeNull();
  });

  it("returns [] for empty directories and ignores junk + symlinks", async () => {
    const root = await makeTempDir();
    const empty = await listSandboxedFilesRecursive(root);
    expect(empty).toEqual([]);

    await fs.writeFile(path.join(root, ".DS_Store"), "junk");
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules", "lib.js"), "// ignored");
    await fs.symlink("/etc/passwd", path.join(root, "danger.lnk")).catch(() => undefined);
    const after = await listSandboxedFilesRecursive(root);
    expect(after).toEqual([]);
  });

  it("walks nested directories and sorts the result", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, "memory"), { recursive: true });
    await fs.writeFile(path.join(root, "memory", "z.md"), "z");
    await fs.writeFile(path.join(root, "memory", "a.md"), "a");
    await fs.writeFile(path.join(root, "MEMORY.md"), "top");

    const files = await listSandboxedFilesRecursive(root);
    expect(files?.map((f) => f.path)).toEqual(["MEMORY.md", "memory/a.md", "memory/z.md"]);
    expect(files?.find((f) => f.path === "MEMORY.md")?.size).toBe(3);
  });
});

describe("readSandboxedFile", () => {
  it("returns null for missing files", async () => {
    const root = await makeTempDir();
    expect(await readSandboxedFile(root, "nope.md")).toBeNull();
  });

  it("rejects symlink escapes via real-path checking", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    const secretAbs = path.join(outside, "secret.md");
    await fs.writeFile(secretAbs, "TOP SECRET");

    // Create a symlink inside the sandbox that points outside.
    const linkPath = path.join(root, "leak.md");
    await fs.symlink(secretAbs, linkPath);

    await expect(readSandboxedFile(root, "leak.md")).rejects.toThrow();
  });

  it("reads files happily when they live inside the sandbox", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "hello.md"), "hi");
    const detail = await readSandboxedFile(root, "hello.md");
    expect(detail?.content).toBe("hi");
    expect(detail?.size).toBe(2);
    expect(detail?.path).toBe("hello.md");
  });
});
