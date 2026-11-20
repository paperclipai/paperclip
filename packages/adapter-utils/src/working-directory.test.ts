import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAbsoluteDirectory } from "./server-utils.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("working directory preflight", () => {
  it.each(["EACCES", "EPERM"])("identifies an unsearchable existing cwd before spawn (%s)", async code => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-"));
    try {
      const permission = Object.assign(new Error("Access denied"), { code });
      const access = vi.spyOn(fs, "access").mockRejectedValueOnce(permission);
      const mkdir = vi.spyOn(fs, "mkdir");
      await expect(ensureAbsoluteDirectory(root, { createIfMissing: true })).rejects.toMatchObject({
        code, cause: permission,
        message: `Working directory cannot be entered by the current runtime user: "${root}" (${code})`,
      });
      expect(access).toHaveBeenCalledWith(root, constants.X_OK);
      expect(mkdir).not.toHaveBeenCalled();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("accepts a searchable read-only workspace without requesting write access", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-"));
    try {
      await fs.chmod(root, 0o500);
      const access = vi.spyOn(fs, "access");
      await ensureAbsoluteDirectory(root, { createIfMissing: true });
      expect(access).toHaveBeenCalledExactlyOnceWith(root, constants.X_OK);
      expect((await fs.stat(root)).mode & 0o777).toBe(0o500);
    } finally { await fs.chmod(root, 0o700); await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves opt-in recursive creation and validates the created directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-"));
    const cwd = path.join(root, "new", "nested");
    try {
      await expect(ensureAbsoluteDirectory(cwd)).rejects.toThrow(`Working directory does not exist: "${cwd}"`);
      const access = vi.spyOn(fs, "access");
      await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
      expect((await fs.stat(cwd)).isDirectory()).toBe(true);
      expect(access).toHaveBeenCalledWith(cwd, constants.X_OK);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps the code and cause when a created directory cannot be entered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-"));
    const cwd = path.join(root, "created");
    try {
      const permission = Object.assign(new Error("Access denied"), { code: "EACCES" });
      vi.spyOn(fs, "access").mockRejectedValueOnce(permission);
      const denied = `Working directory cannot be entered by the current runtime user: "${cwd}" (EACCES)`;
      await expect(ensureAbsoluteDirectory(cwd, { createIfMissing: true })).rejects.toMatchObject({
        code: "EACCES", message: `Could not create working directory "${cwd}": ${denied}`,
        cause: { code: "EACCES", message: denied, cause: permission },
      });
      expect((await fs.stat(cwd)).isDirectory()).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("continues rejecting relative paths and files", async () => {
    await expect(ensureAbsoluteDirectory("relative")).rejects.toThrow("Working directory must be an absolute path");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-"));
    try {
      const file = path.join(root, "file"); await fs.writeFile(file, "fixture");
      await expect(ensureAbsoluteDirectory(file)).rejects.toThrow(`Working directory is not a directory: "${file}"`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
