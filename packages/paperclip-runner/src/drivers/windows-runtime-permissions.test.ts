import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
const directory = vi.hoisted(() => ({ realpath: vi.fn(), lstat: vi.fn() }));
vi.mock("node:fs/promises", () => directory);
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: execute });
  return { execFile };
});

beforeEach(() => {
  vi.resetModules();
  execute.mockReset().mockResolvedValue({ stdout: '"runtime user","S-1-5-21-123"\n', stderr: "" });
  directory.realpath.mockReset().mockImplementation(async (root: string) => root);
  directory.lstat.mockReset().mockResolvedValue({ dev: 42, ino: 9, isDirectory: () => true, isSymbolicLink: () => false });
});

describe("Windows runtime snapshot permissions", () => {
  it.each(["FAT", "FAT32", "exFAT"])("retains the attribute/sandbox path when %s cannot store ACLs", async filesystem => {
    const failure = Object.assign(new Error("Persistent ACLs unsupported"), { code: 1 });
    execute.mockResolvedValueOnce({ stdout: '"runtime user","S-1-5-21-123"\n' }).mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ stdout: JSON.stringify({ filesystem, volume: "volume-42" }) });
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await expect(setWindowsRuntimeTreeReadOnly("D:\\runtime\\skills", true)).resolves.toBe("no_persistent_acls");
    const calls = execute.mock.calls.length;
    await expect(setWindowsRuntimeTreeReadOnly("D:\\runtime\\repositories", false)).resolves.toBe("no_persistent_acls");
    expect(execute).toHaveBeenCalledTimes(calls);
  });
  it("probes the resolved volume rather than trusting a mountpoint's drive letter", async () => {
    directory.realpath.mockResolvedValue("D:\\actual\\skills");
    execute.mockResolvedValueOnce({ stdout: '"runtime user","S-1-5-21-123"\n' })
      .mockRejectedValueOnce(Object.assign(new Error("ACL unsupported"), { code: 1 }))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ filesystem: "FAT32", volume: "volume-42" }) });
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await expect(setWindowsRuntimeTreeReadOnly("C:\\mounted\\skills", true)).resolves.toBe("no_persistent_acls");
    expect(execute.mock.calls.at(-1)?.[2]?.env.PAPERCLIP_RUNTIME_VOLUME_PROBE).toBe("D:\\actual\\skills");
  });
  it("does not reuse FAT capability evidence after a volume identity changes", async () => {
    execute.mockResolvedValueOnce({ stdout: '"runtime user","S-1-5-21-123"\n' })
      .mockRejectedValueOnce(new Error("ACL unsupported"))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ filesystem: "FAT32", volume: "volume-42" }) });
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await expect(setWindowsRuntimeTreeReadOnly("D:\\runtime\\skills", true)).resolves.toBe("no_persistent_acls");
    directory.lstat.mockResolvedValue({ dev: 43, ino: 10, isDirectory: () => true, isSymbolicLink: () => false });
    const denied = new Error("NTFS ACL denied");
    execute.mockRejectedValueOnce(denied).mockResolvedValueOnce({ stdout: JSON.stringify({ filesystem: "NTFS", volume: "volume-43" }) });
    await expect(setWindowsRuntimeTreeReadOnly("D:\\runtime\\skills", true)).rejects.toBe(denied);
  });
  it.each(["NTFS", "ReFS", "unknown"])("does not suppress a real ACL error on %s", async filesystem => {
    const failure = Object.assign(new Error("ACL operation denied"), { code: 5 });
    execute.mockResolvedValueOnce({ stdout: '"runtime user","S-1-5-21-123"\n' }).mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ stdout: JSON.stringify({ filesystem, volume: "volume-42" }) });
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await expect(setWindowsRuntimeTreeReadOnly("D:\\runtime\\skills", true)).rejects.toBe(failure);
  });
  it("removes an owned inheritance-root deny without visiting every descendant", async () => {
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await setWindowsRuntimeTreeReadOnly("C:\\runtime\\repositories", false, { recursive: false });
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(["C:\\runtime\\repositories", "/remove:d", "*S-1-5-21-123", "/L", "/Q"]);
  });
  it("allows a large snapshot cleanup to outlast the observed thirty-second cutoff without success-output overflow", async () => {
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await setWindowsRuntimeTreeReadOnly("C:\\runtime\\skills", false);
    expect(execute).toHaveBeenLastCalledWith(expect.stringMatching(/icacls\.exe$/),
      expect.arrayContaining(["/remove:d", "*S-1-5-21-123", "/T", "/C", "/L", "/Q"]),
      expect.objectContaining({ windowsHide: true, timeout: 300_000 }));
  });

  it("keeps the write-denial scope when sealing a snapshot", async () => {
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await setWindowsRuntimeTreeReadOnly("C:\\runtime\\skills", true);
    expect(execute.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([
      "C:\\runtime\\skills", "/deny", "*S-1-5-21-123:(OI)(CI)(WD,AD,WEA,WA)",
    ]));
  });

  it("still fails closed on an ACL command error", async () => {
    const failure = Object.assign(new Error("ACL operation denied"), { code: 5 });
    execute.mockResolvedValueOnce({ stdout: '"runtime user","S-1-5-21-123"\n', stderr: "" }).mockRejectedValueOnce(failure);
    const { setWindowsRuntimeTreeReadOnly } = await import("./windows-runtime-permissions.js");
    await expect(setWindowsRuntimeTreeReadOnly("C:\\runtime\\skills", false)).rejects.toBe(failure);
  });
});
