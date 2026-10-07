import { describe, expect, it, vi } from "vitest";
import { classifyWorkspaceRestoreFailure } from "./workspace-restore-merge.js";
import {
  getWorkspaceRestoreDiagnostic, preserveWorkspaceRestoreErrorDiagnostic, recordWorkspaceRestoreDiagnostic,
  sanitizeWorkspaceRestoreDiagnostic, withWorkspaceRestoreDiagnostics, withWorkspaceRestoreStep, withWorkspaceRestoreGitCommand,
  type WorkspaceRestoreDiagnostic,
} from "./workspace-restore-diagnostics.js";

describe("workspace restore diagnostics", () => {
  it.each([new Error("shared nested failure"), "shared primitive failure"])("selects an unlabelled nested failure without retaining a later task's step (%s)", async (error) => {
    const sink = vi.fn();
    const snapshots: Array<WorkspaceRestoreDiagnostic | undefined> = [];
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => {
      await Promise.allSettled([
        withWorkspaceRestoreDiagnostics("workspace", async () => { throw error; }, sink, (value) => { snapshots[0] = value; }),
        withWorkspaceRestoreDiagnostics("asset", () => withWorkspaceRestoreStep("asset_restore", async () => { throw error; }), sink,
          (value) => { snapshots[1] = value; }),
      ]);
      recordWorkspaceRestoreDiagnostic(error, snapshots[0]);
      throw error;
    }, sink)).rejects.toBe(error);
    expect(snapshots[1]?.step).toBe("asset_restore");
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual(typeof error === "object" ? { phase: "workspace", errorCode: "unknown" } : undefined);
    expect(sink).toHaveBeenCalledExactlyOnceWith('[paperclip] Workspace restore diagnostic: {"phase":"workspace","errorCode":"unknown"}\n');
  });

  it("keeps logging when a diagnostic consumer fails", async () => {
    const error = new Error("restore failed");
    const sink = vi.fn();
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => { throw error; }, sink,
      () => { throw new Error("consumer failed"); })).rejects.toBe(error);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("retains a nested step and bounded Git fields across an existing wrapper without a cause", async () => {
    const source = Object.assign(new Error("private command/path"), { code: 1, stderr: "private stderr" });
    const wrapper = new Error("existing wrapper");
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("directory_merge", async () => {
      try {
        await withWorkspaceRestoreStep("git_integration", async () => { throw source; });
      } catch (error) { throw preserveWorkspaceRestoreErrorDiagnostic(wrapper, error); }
    }))).rejects.toBe(wrapper);
    expect(wrapper).not.toHaveProperty("cause");
    expect(Object.keys(wrapper)).toEqual([]);
    expect(getWorkspaceRestoreDiagnostic(wrapper)).toEqual({ phase: "workspace", step: "git_integration", errorCode: "unknown", exitCode: 1 });
  });

  it("attributes a reused error to the later failed retry step", async () => {
    const error = new Error("same failure");
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => {
      await withWorkspaceRestoreStep("git_import", async () => { throw error; }).catch(() => {});
      await withWorkspaceRestoreStep("git_export", async () => { throw error; });
    })).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)?.step).toBe("git_export");
    await expect(withWorkspaceRestoreDiagnostics("asset", async () => { throw error; })).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "asset", errorCode: "unknown" });
  });

  it("isolates concurrent steps even when their errors share identity", async () => {
    const error = new Error("shared error");
    const sink = vi.fn();
    await Promise.allSettled([
      withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_import", async () => { throw error; }), sink),
      withWorkspaceRestoreDiagnostics("asset", () => withWorkspaceRestoreStep("asset_restore", async () => { throw error; }), sink),
    ]);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line.split(": ")[1]))).toEqual(expect.arrayContaining([
      { phase: "workspace", step: "git_import", errorCode: "unknown" },
      { phase: "asset", step: "asset_restore", errorCode: "unknown" },
    ]));
  });

  it("starts a fresh scope for later work inherited from a completed async context", async () => {
    const error = new Error("later failure");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let later!: Promise<unknown>;
    const sink = vi.fn();
    await withWorkspaceRestoreDiagnostics("workspace", async () => {
      later = gate.then(() => withWorkspaceRestoreDiagnostics("asset", () =>
        withWorkspaceRestoreStep("asset_restore", async () => { throw error; }), sink)).catch((value) => value);
    }, sink);
    release();
    expect(await later).toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "asset", step: "asset_restore", errorCode: "unknown" });
    expect(sink).toHaveBeenCalledTimes(1);
  });

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

describe("Git integration diagnostic privacy and attribution", () => {
  async function capture(command: Parameters<typeof withWorkspaceRestoreGitCommand>[0], error: unknown) {
    let receipt: WorkspaceRestoreDiagnostic | undefined;
    const originalProperties = error && typeof error === "object" ? Object.getOwnPropertyDescriptors(error) : undefined;
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", () =>
      withWorkspaceRestoreGitCommand(command, async () => { throw error; })), undefined,
    (value) => { receipt = value; })).rejects.toBe(error);
    if (originalProperties) expect(Object.getOwnPropertyDescriptors(error)).toEqual(originalProperties);
    return receipt;
  }

  it.each([
    ["merge_tree", { code: 1, stdout: "a".repeat(40) + "\nprivate-file", stderr: "private-conflict-body" }, "merge_conflict"],
    ["merge_tree", { code: 1 }, "unknown"],
    ["merge_tree", { code: 1, stderr: `merge-tree: ${"a".repeat(40)} - not something we can merge\n` }, "invalid_object"],
    ["merge_tree", { code: 1, signal: "SIGTERM" }, "unknown"],
    ["merge_tree", { code: 1, killed: true }, "unknown"],
    ["merge_tree", { code: 128, stderr: "fatal: Not a valid object name private-object" }, "invalid_object"],
    ["merge_tree", { code: 128, stderr: `merge-tree: ${"a".repeat(40)} - not something we can merge\n` }, "invalid_object"],
    ["merge_base", { code: 128, stderr: "fatal: Not a valid commit name private-object" }, "invalid_object"],
    ["rev_parse", { code: 128, stderr: "fatal: bad object private-object" }, "invalid_object"],
    ["update_ref", { code: 128, stderr: `fatal: update_ref failed for ref 'private-ref': cannot lock ref 'private-ref': is at ${"a".repeat(40)} but expected ${"b".repeat(40)}\n` }, "ref_conflict"],
    ["update_ref", { code: 128, stderr: "fatal: Unable to create 'private-path.lock': File exists." }, "unknown"],
    ["update_ref", { code: "EACCES", stderr: "private-path" }, "permission_denied"],
    ["commit_tree", { code: "EPERM" }, "permission_denied"],
    ["commit_tree", { code: 1, stderr: "Permission denied private-path" }, "unknown"],
    ["symbolic_ref", { code: 1 }, "unknown"],
    ["merge_base", { code: 1 }, "unknown"],
    ["log", { code: 128, stderr: "localized or unrecognized private-text" }, "unknown"],
    ["log", { code: 128, stderr: "x".repeat(16 * 1024) + "\nfatal: bad object private-object" }, "unknown"],
    ["merge_tree", "private-string", "unknown"],
  ] as const)("classifies only supported %s evidence (%j)", async (command, error, kind) => {
    const receipt = await capture(command, error);
    expect(receipt).toMatchObject({ gitCommand: command, gitFailureKind: kind });
    expect(JSON.stringify(receipt)).not.toContain("private-");
    expect(Object.keys(receipt!).sort()).toEqual([
      "phase", "step", "errorCode", "gitCommand", "gitFailureKind",
      ...(typeof error === "object" && typeof error.code === "number" ? ["exitCode"] : []),
    ].sort());
  });

  it("treats throwing stderr getters as unknown and never replaces the original error", async () => {
    const error = Object.defineProperty(new Error("private-original"), "stderr", { get() { throw new Error("private-getter"); } });
    expect(await capture("commit_tree", error)).toEqual({ phase: "workspace", step: "git_integration",
      errorCode: "unknown", gitCommand: "commit_tree", gitFailureKind: "unknown" });
  });

  it("retains a nested command across wrappers and nested task diagnostics", async () => {
    const source = Object.assign(new Error("private-source"), { code: 1, stdout: "a".repeat(40) + "\n" });
    const wrapper = new Error("private-wrapper");
    const sink = vi.fn();
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("directory_merge", () =>
      withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", async () => {
        try { await withWorkspaceRestoreGitCommand("merge_tree", async () => { throw source; }); }
        catch (error) { throw preserveWorkspaceRestoreErrorDiagnostic(wrapper, error); }
      }), sink)), sink)).rejects.toBe(wrapper);
    expect(getWorkspaceRestoreDiagnostic(wrapper)).toEqual({ phase: "workspace", step: "git_integration",
      errorCode: "unknown", exitCode: 1, gitCommand: "merge_tree", gitFailureKind: "merge_conflict" });
    expect(wrapper).not.toHaveProperty("cause");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).not.toContain("private-");
  });

  it("keeps a nested identity probe failure instead of relabelling it as its ref transaction", async () => {
    const error = Object.assign(new Error("private-probe"), { code: 128, stderr: "private-probe-output" });
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", () =>
      withWorkspaceRestoreGitCommand("update_ref", () =>
        withWorkspaceRestoreGitCommand("symbolic_ref", async () => { throw error; }))))).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "workspace", step: "git_integration",
      errorCode: "unknown", exitCode: 128, gitCommand: "symbolic_ref", gitFailureKind: "unknown" });
  });

  it("does not retain a handled command's label on a later failed step or retry", async () => {
    const error = Object.assign(new Error("same error"), { code: 1 });
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => {
      await withWorkspaceRestoreStep("git_integration", () =>
        withWorkspaceRestoreGitCommand("merge_tree", async () => { throw error; })).catch(() => {});
      await withWorkspaceRestoreStep("index_reset", async () => { throw error; });
    })).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toEqual({ phase: "workspace", step: "index_reset", errorCode: "unknown", exitCode: 1 });
    await expect(withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", async () => {
      await withWorkspaceRestoreGitCommand("merge_tree", async () => { throw error; }).catch(() => {});
      await withWorkspaceRestoreGitCommand("update_ref", async () => { throw error; });
    }))).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toMatchObject({ gitCommand: "update_ref", gitFailureKind: "unknown" });
  });

  it("retains the selected parallel task's command when two errors share identity", async () => {
    const error = Object.assign(new Error("shared"), { code: 1, stdout: "a".repeat(40) + "\n" });
    const snapshots: WorkspaceRestoreDiagnostic[] = [];
    await expect(withWorkspaceRestoreDiagnostics("workspace", async () => {
      await Promise.allSettled((["merge_tree", "update_ref"] as const).map((command, index) =>
        withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", () =>
          withWorkspaceRestoreGitCommand(command, async () => { throw error; })), undefined,
        (receipt) => { snapshots[index] = receipt; })));
      recordWorkspaceRestoreDiagnostic(error, snapshots[0]);
      throw error;
    })).rejects.toBe(error);
    expect(snapshots.map(value => value.gitCommand)).toEqual(["merge_tree", "update_ref"]);
    expect(getWorkspaceRestoreDiagnostic(error)).toMatchObject({ gitCommand: "merge_tree", gitFailureKind: "merge_conflict" });
  });

  it("leaves successful or handled commands silent and preserves values", async () => {
    const sink = vi.fn();
    const value = {};
    expect(await withWorkspaceRestoreDiagnostics("workspace", () => withWorkspaceRestoreStep("git_integration", async () => {
      await withWorkspaceRestoreGitCommand("symbolic_ref", async () => { throw { code: 1 }; }).catch(() => {});
      return withWorkspaceRestoreGitCommand("update_ref", async () => value);
    }), sink)).toBe(value);
    expect(sink).not.toHaveBeenCalled();
    const error = new Error("outside restore");
    await expect(withWorkspaceRestoreGitCommand("log", async () => { throw error; })).rejects.toBe(error);
    expect(getWorkspaceRestoreDiagnostic(error)).toBeUndefined();
  });

  it.each([
    { phase: "asset", step: "git_integration", gitCommand: "merge_tree" },
    { phase: "workspace", step: "index_reset", gitCommand: "merge_tree" },
    { phase: "workspace", step: "git_integration", gitCommand: "private-command" },
  ])("does not decode Git metadata outside the closed integration contract (%j)", (value) => {
    const diagnostic = sanitizeWorkspaceRestoreDiagnostic({ ...value, gitFailureKind: "merge_conflict" });
    expect(diagnostic).not.toHaveProperty("gitCommand");
    expect(diagnostic).not.toHaveProperty("gitFailureKind");
  });

  it("revalidates persisted command and failure labels without copying extra fields", () => {
    expect(sanitizeWorkspaceRestoreDiagnostic({ phase: "workspace", step: "git_integration", gitCommand: "log",
      gitFailureKind: "private-reason", stderr: "private-text", args: ["private-args"] })).toEqual({
      phase: "workspace", step: "git_integration", errorCode: "unknown", gitCommand: "log", gitFailureKind: "unknown",
    });
  });
});
