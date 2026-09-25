import { describe, expect, it, vi } from "vitest";
import { classifyWorkspaceRestoreFailure } from "./workspace-restore-merge.js";
import { withWorkspaceRestoreDiagnostics } from "./workspace-restore-diagnostics.js";

describe("workspace restore diagnostics", () => {
  it("leaves successful restores silent", async () => {
    const sink = vi.fn();
    expect(await withWorkspaceRestoreDiagnostics("workspace", async () => 42, sink)).toBe(42);
    expect(sink).not.toHaveBeenCalled();
  });

  it("records bounded cause fields without copying messages or arbitrary codes", async () => {
    const sink = vi.fn();
    const error = Object.assign(new Error("private path and credential"), {
      code: "private-code", url: "https://private.invalid/secret", body: "private body",
      cause: Object.assign(new Error("private cause"), { code: "ECONNRESET", statusCode: 503, exitCode: 7 }),
    });
    await expect(withWorkspaceRestoreDiagnostics("asset", async () => { throw error; }, sink)).rejects.toBe(error);
    expect(sink).toHaveBeenCalledExactlyOnceWith(
      '[paperclip] Workspace restore diagnostic: {"phase":"asset","errorCode":"ECONNRESET","httpStatus":503,"exitCode":7}\n',
    );
  });

  it.each([null, "private string", { code: "token", status: "401", exitCode: Infinity }, { status: 200, exitCode: -1 }])(
    "omits unrecognized diagnostic values (%j)", async (error) => {
      const sink = vi.fn();
      await expect(withWorkspaceRestoreDiagnostics("asset", async () => { throw error; }, sink)).rejects.toBe(error);
      expect(sink).toHaveBeenCalledExactlyOnceWith(
        '[paperclip] Workspace restore diagnostic: {"phase":"asset","errorCode":"unknown"}\n',
      );
    },
  );

  it("bounds cause traversal even when it cycles", async () => {
    const error = Object.assign(new Error("private"), { cause: null as unknown, code: "ENOENT" });
    error.cause = error;
    const sink = vi.fn();
    await expect(withWorkspaceRestoreDiagnostics("asset", async () => { throw error; }, sink)).rejects.toBe(error);
    expect(sink.mock.calls[0]?.[0]).toContain('"errorCode":"ENOENT"');
  });

  it.each(["EACCES", "WORKSPACE_RESTORE_UNSAFE_ARCHIVE"])("preserves %s when logging fails", async (code) => {
    const error = Object.assign(new Error("private"), { code });
    const classification = classifyWorkspaceRestoreFailure(error);
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => { throw error; }, async () => { throw new Error("sink failed"); }))
      .rejects.toBe(error);
    expect(classifyWorkspaceRestoreFailure(error)).toBe(classification);
  });

  it("keeps the restore error even if a provider diagnostic getter throws", async () => {
    const error = Object.defineProperty(Object.assign(new Error("original"), {
      statusCode: 503, cause: { code: "ECONNRESET" },
    }), "code", { get() { throw new Error("getter failed"); } });
    const sink = vi.fn();
    await expect(withWorkspaceRestoreDiagnostics("asset", async () => { throw error; }, sink)).rejects.toBe(error);
    expect(sink).toHaveBeenCalledExactlyOnceWith(
      '[paperclip] Workspace restore diagnostic: {"phase":"asset","errorCode":"ECONNRESET","httpStatus":503}\n',
    );
  });

  it("uses valid fallback statuses when preferred fields are invalid", async () => {
    const error = { status: "failed", statusCode: 503, exitCode: "failed", code: 7 };
    const sink = vi.fn();
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => { throw error; }, sink)).rejects.toBe(error);
    expect(sink).toHaveBeenCalledExactlyOnceWith(
      '[paperclip] Workspace restore diagnostic: {"phase":"workspace","errorCode":"unknown","httpStatus":503,"exitCode":7}\n',
    );
  });

  it("logs nested failures once while preserving independent concurrent and later diagnostics", async () => {
    const error = Object.assign(new Error("nested failure"), { code: "ENOENT" });
    const sink = vi.fn();
    const fail = async () => { await Promise.resolve(); throw error; };
    const results = await Promise.allSettled([
      withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreDiagnostics("workspace", fail, sink), sink),
      withWorkspaceRestoreDiagnostics("asset", fail, sink),
    ]);
    expect(results).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line.split(": ")[1]).phase).sort()).toEqual(["asset", "workspace"]);
    await expect(withWorkspaceRestoreDiagnostics("workspace", fail, sink)).rejects.toBe(error);
    expect(sink).toHaveBeenCalledTimes(3);
  });
});
