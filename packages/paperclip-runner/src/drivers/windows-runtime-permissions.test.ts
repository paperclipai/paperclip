import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: execute });
  return { execFile };
});

beforeEach(() => {
  vi.resetModules();
  execute.mockReset().mockResolvedValue({ stdout: '"runtime user","S-1-5-21-123"\n', stderr: "" });
});

describe("Windows runtime snapshot permissions", () => {
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
