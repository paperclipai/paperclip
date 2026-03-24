import { describe, expect, it, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      symlink: vi.fn(),
      link: vi.fn(),
      copyFile: vi.fn(),
    },
  };
});

const mockedSymlink = fs.symlink as unknown as ReturnType<typeof vi.fn>;
const mockedLink = fs.link as unknown as ReturnType<typeof vi.fn>;
const mockedCopyFile = fs.copyFile as unknown as ReturnType<typeof vi.fn>;

// Helper: dynamically import functions so the mock is in place.
async function loadSymlinkOrJunction() {
  const mod = await import("./server-utils.js");
  return mod.symlinkOrJunction;
}

async function loadSymlinkOrHardLink() {
  const mod = await import("./server-utils.js");
  return mod.symlinkOrHardLink;
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
    mockedLink.mockReset();
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

describe("symlinkOrHardLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedSymlink.mockReset();
    mockedLink.mockReset();
    mockedCopyFile.mockReset();
  });

  it("creates a symlink when symlink succeeds (no hard link fallback)", async () => {
    mockedSymlink.mockResolvedValueOnce(undefined);
    const symlinkOrHardLink = await loadSymlinkOrHardLink();
    await symlinkOrHardLink("/src/auth.json", "/tgt/auth.json");

    expect(mockedSymlink).toHaveBeenCalledTimes(1);
    expect(mockedSymlink).toHaveBeenCalledWith("/src/auth.json", "/tgt/auth.json");
    expect(mockedLink).not.toHaveBeenCalled();
  });

  it("falls back to hard link on Windows when symlink fails with EPERM", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("EPERM"));
      mockedLink.mockResolvedValueOnce(undefined);

      const symlinkOrHardLink = await loadSymlinkOrHardLink();
      await symlinkOrHardLink("C:\\src\\auth.json", "C:\\tgt\\auth.json");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedLink).toHaveBeenCalledTimes(1);
      expect(mockedLink).toHaveBeenCalledWith("C:\\src\\auth.json", "C:\\tgt\\auth.json");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("does NOT fall back to hard link on non-Windows when symlink fails with EPERM", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("EPERM"));

      const symlinkOrHardLink = await loadSymlinkOrHardLink();
      await expect(symlinkOrHardLink("/src/auth.json", "/tgt/auth.json")).rejects.toThrow("EPERM");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedLink).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("re-throws non-EPERM errors on Windows without hard link retry", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("ENOENT"));

      const symlinkOrHardLink = await loadSymlinkOrHardLink();
      await expect(symlinkOrHardLink("C:\\src\\auth.json", "C:\\tgt\\auth.json")).rejects.toThrow("ENOENT");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedLink).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  it("falls back to copyFile on Windows when hard link fails with EXDEV (cross-drive)", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });

    try {
      mockedSymlink.mockRejectedValueOnce(makeErrno("EPERM"));
      mockedLink.mockRejectedValueOnce(makeErrno("EXDEV"));
      mockedCopyFile.mockResolvedValueOnce(undefined);

      const symlinkOrHardLink = await loadSymlinkOrHardLink();
      await symlinkOrHardLink("D:\\src\\auth.json", "C:\\tgt\\auth.json");

      expect(mockedSymlink).toHaveBeenCalledTimes(1);
      expect(mockedLink).toHaveBeenCalledTimes(1);
      expect(mockedCopyFile).toHaveBeenCalledTimes(1);
      expect(mockedCopyFile).toHaveBeenCalledWith("D:\\src\\auth.json", "C:\\tgt\\auth.json");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });
});
