import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUN_TEMP_SO_RE, ELF_MAGIC, reapBunTempSharedLibs } from "./bun-cleanup.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.allSettled(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
  vi.restoreAllMocks();
});

async function makeTmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-bun-cleanup-test-"));
  cleanupPaths.add(dir);
  return dir;
}

/** Write a minimal ELF header (8 bytes: \x7fELF + padding). */
async function writeElfFile(filePath: string) {
  await fs.writeFile(filePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
}

describe("reapBunTempSharedLibs", () => {
  it("deletes files matching Bun mkstemp pattern", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("deletes files with variant hex prefix", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".abc123def45678900-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("does not delete non-matching .so files", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = "mylib.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("does not delete non-matching hidden files", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f-config.json";
    const filePath = path.join(tmpdir, fileName);
    await fs.writeFile(filePath, "{}");

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("returns 0 for empty directory", async () => {
    const tmpdir = await makeTmpdir();

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
  });

  it("skips files that fail to unlink with EBUSY", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
      if (typeof p === "string" && p === filePath) {
        const err = new Error("EBUSY") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
    });

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    expect(unlinkSpy).toHaveBeenCalledWith(filePath);
  });

  it("skips files that fail to unlink with ENOENT", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
      if (typeof p === "string" && p === filePath) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
    });

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    expect(unlinkSpy).toHaveBeenCalledWith(filePath);
  });

  it("uses the provided tmpdir path", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    // Also create a file in the real tmpdir that should NOT be cleaned
    const otherDir = await makeTmpdir();
    const otherFile = path.join(otherDir, ".3ef7f1ffe5bfeeef-00000000.so");
    await writeElfFile(otherFile);

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(1);
    await expect(fs.access(filePath)).rejects.toThrow();
    // The file in otherDir should still exist
    await expect(fs.access(otherFile)).resolves.toBeUndefined();
  });

  it("does not delete matching filename without ELF magic", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await fs.writeFile(filePath, "not an elf");

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("skips files that fail to unlink with EPERM", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
      if (typeof p === "string" && p === filePath) {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
    });

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    expect(unlinkSpy).toHaveBeenCalledWith(filePath);
  });

  it("re-throws unexpected errors from unlink", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await writeElfFile(filePath);

    vi.spyOn(fs, "unlink").mockImplementation(async (p) => {
      if (typeof p === "string" && p === filePath) {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
    });

    await expect(reapBunTempSharedLibs(tmpdir)).rejects.toThrow("EACCES");
  });

  it("returns 0 for nonexistent tmpdir", async () => {
    const count = await reapBunTempSharedLibs("/tmp/paperclip-bun-cleanup-nonexistent-xyz-999");

    expect(count).toBe(0);
  });

  it("continues processing when one file has an I/O error during read", async () => {
    const tmpdir = await makeTmpdir();
    const goodFileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const goodFilePath = path.join(tmpdir, goodFileName);
    const badFileName = ".aaaaaaaaaaaaaaaa-00000000.so";
    const badFilePath = path.join(tmpdir, badFileName);
    await writeElfFile(goodFilePath);
    await writeElfFile(badFilePath);

    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (p) => {
      if (typeof p === "string" && p === badFilePath) {
        throw new Error("EMFILE: file table overflow") as NodeJS.ErrnoException;
      }
      return realOpen(p);
    });

    const count = await reapBunTempSharedLibs(tmpdir);

    // Bad file is skipped, good file is still reaped.
    expect(count).toBe(1);
    await expect(fs.access(goodFilePath)).rejects.toThrow();
    expect(openSpy).toHaveBeenCalledWith(badFilePath);
  });

  it("does not delete matching filename with fewer than 4 bytes", async () => {
    const tmpdir = await makeTmpdir();
    const fileName = ".3ef7f1ffe5bfeeef-00000000.so";
    const filePath = path.join(tmpdir, fileName);
    await fs.writeFile(filePath, Buffer.from([0x7f])); // Only 1 byte — not enough for ELF magic

    const count = await reapBunTempSharedLibs(tmpdir);

    expect(count).toBe(0);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });
});

describe("BUN_TEMP_SO_RE", () => {
  it("matches Bun mkstemp pattern", () => {
    expect(BUN_TEMP_SO_RE.test(".3ef7f1ffe5bfeeef-00000000.so")).toBe(true);
  });

  it("matches variant hex prefix", () => {
    expect(BUN_TEMP_SO_RE.test(".abc123def45678900-00000000.so")).toBe(true);
  });

  it("does not match non-hidden .so files", () => {
    expect(BUN_TEMP_SO_RE.test("mylib.so")).toBe(false);
  });

  it("does not match hidden non-.so files", () => {
    expect(BUN_TEMP_SO_RE.test(".3ef7f-config.json")).toBe(false);
  });

  it("rejects hex prefix with fewer than 16 characters", () => {
    expect(BUN_TEMP_SO_RE.test(".abc1234567890-00000000.so")).toBe(false);
  });

  it("accepts hex prefix with exactly 16 characters", () => {
    expect(BUN_TEMP_SO_RE.test(".abc1234567890000-00000000.so")).toBe(true);
  });
});

describe("ELF_MAGIC", () => {
  it("contains the \\x7fELF magic bytes", () => {
    expect(ELF_MAGIC).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  });
});
