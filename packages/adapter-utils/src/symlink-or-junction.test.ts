import { describe, expect, it, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      symlink: vi.fn(),
    },
  };
});

const mockedSymlink = fs.symlink as unknown as ReturnType<typeof vi.fn>;

// Helper: dynamically import the function so the mock is in place.
async function loadSymlinkOrJunction() {
  const mod = await import("./server-utils.js");
  return mod.symlinkOrJunction;
}

function makeErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: operation not permitted`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("symlinkOrJunction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedSymlink.mockReset();
  });

  it("creates a symlink on non-Windows without fallback", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    try {
      mockedSymlink.mockResolvedValueOnce(undefined);
      const symlinkOrJunction = await loadSymlinkOrJunction();
      await symlinkOrJunction("/src", "/tgt");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedSymlink).toHaveBeenCalledWith("/src", "/tgt");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("creates a symlink on Windows when symlink succeeds", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockResolvedValueOnce(undefined);
      const symlinkOrJunction = await loadSymlinkOrJunction();
      await symlinkOrJunction("C:\\src", "C:\\tgt");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedSymlink).toHaveBeenCalledWith("C:\\src", "C:\\tgt");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("falls back to junction on Windows when symlink fails with EPERM", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("EPERM"));
      mockedSymlink.mockResolvedValueOnce(undefined);

      const symlinkOrJunction = await loadSymlinkOrJunction();
      await symlinkOrJunction("C:\\src", "C:\\tgt");

      expect(mockedSymlink).toHaveBeenCalledTimes(2);
      expect(mockedSymlink).toHaveBeenNthCalledWith(1, "C:\\src", "C:\\tgt");
      expect(mockedSymlink).toHaveBeenNthCalledWith(2, "C:\\src", "C:\\tgt", "junction");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("does NOT fall back to junction on non-Windows when symlink fails with EPERM", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("EPERM"));

      const symlinkOrJunction = await loadSymlinkOrJunction();
      await expect(symlinkOrJunction("/src", "/tgt")).rejects.toThrow("EPERM");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("re-throws non-EPERM errors on Windows without junction retry", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("ENOENT"));

      const symlinkOrJunction = await loadSymlinkOrJunction();
      await expect(symlinkOrJunction("C:\\src", "C:\\tgt")).rejects.toThrow("ENOENT");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });
});
