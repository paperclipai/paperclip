import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeSymlink } from "./safe-symlink.js";

describe("safeSymlink", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "safe-symlink-test-"));
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("creates a working link to a directory without elevated privileges", async () => {
    const sourceDir = path.join(scratch, "src");
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, "marker.txt"), "ok", "utf8");

    const linkPath = path.join(scratch, "link");
    await safeSymlink(sourceDir, linkPath);

    const lst = await fs.lstat(linkPath);
    // Junctions report as symbolic links via lstat on Windows.
    expect(lst.isSymbolicLink()).toBe(true);
    const contents = await fs.readFile(path.join(linkPath, "marker.txt"), "utf8");
    expect(contents).toBe("ok");
  });

  it("creates a working link to a file", async () => {
    const sourceFile = path.join(scratch, "src.txt");
    await fs.writeFile(sourceFile, "hello", "utf8");

    const linkPath = path.join(scratch, "link.txt");
    await safeSymlink(sourceFile, linkPath);

    const lst = await fs.lstat(linkPath);
    expect(lst.isSymbolicLink()).toBe(true);
    const contents = await fs.readFile(linkPath, "utf8");
    expect(contents).toBe("hello");
  });
});
