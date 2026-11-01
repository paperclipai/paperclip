import { describe, expect, it, vi } from "vitest";

import { createWorkspaceRestoreTeardown } from "./workspace-restore-teardown.js";
import { withWorkspaceRestoreDiagnostics, withWorkspaceRestoreStep } from "./workspace-restore-diagnostics.js";
import { workspaceRestoreCancelledError } from "./workspace-restore-merge.js";

// One row per adapter's two message strings, taken verbatim from
// claude-local, codex-local, and gemini-local. The factory's contract must
// hold identically for each pair.
const ADAPTER_MESSAGE_PAIRS = [
  {
    adapter: "claude-local",
    startMessage: "[paperclip] Restoring workspace changes from the sandbox.\n",
    failurePrefix: "[paperclip] Claude ACP teardown workspace restore failed",
  },
  {
    adapter: "codex-local",
    startMessage: "[paperclip] Restoring workspace changes and Codex auth from the sandbox.\n",
    failurePrefix: "[paperclip] Codex ACP teardown restore/copy-back failed",
  },
  {
    adapter: "gemini-local",
    startMessage: "[paperclip] Restoring workspace changes from the sandbox.\n",
    failurePrefix: "[paperclip] Gemini ACP teardown workspace restore failed",
  },
];

describe.each(ADAPTER_MESSAGE_PAIRS)("createWorkspaceRestoreTeardown ($adapter)", ({ startMessage, failurePrefix }) => {
  it("keeps concurrent settlements separate when a provider reuses an error", async () => {
    const error = Object.assign(new Error("private-restore-path"), { code: 1 });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const first = createWorkspaceRestoreTeardown({
      stagedRuntime: { restoreWorkspace: () => withWorkspaceRestoreDiagnostics("workspace", () =>
        withWorkspaceRestoreStep("git_import", async () => { throw error; }), async () => { started(); await gate; }) },
      onLog: async () => {}, startMessage, failurePrefix,
    })();
    await waiting;
    const second = await createWorkspaceRestoreTeardown({
      stagedRuntime: { restoreWorkspace: () => withWorkspaceRestoreDiagnostics("asset", () =>
        withWorkspaceRestoreStep("asset_restore", async () => { throw error; })) },
      onLog: async () => {}, startMessage, failurePrefix,
    })();
    release();
    expect(await first).toEqual({ ok: false, code: "restore_failed", diagnostic: {
      phase: "workspace", step: "git_import", errorCode: "unknown", exitCode: 1,
    } });
    expect(second).toEqual({ ok: false, code: "restore_failed", diagnostic: {
      phase: "asset", step: "asset_restore", errorCode: "unknown", exitCode: 1,
    } });
  });

  it("forwards the signal passed at call time over the one captured at construction", async () => {
    // The ACP engine caches the step with the staged runtime and reuses it on
    // a compatible resume, so the construction-time signal belongs to the
    // first run. Stopping a later run must stop its own restore.
    const seen: Array<AbortSignal | null | undefined> = [];
    const first = new AbortController();
    const second = new AbortController();
    const teardown = createWorkspaceRestoreTeardown({
      stagedRuntime: { restoreWorkspace: async (_progress, signal) => { seen.push(signal); } },
      onLog: async () => {}, startMessage, failurePrefix,
      signal: first.signal,
    });
    await teardown(second.signal);
    await teardown();
    expect(seen[0]).toBe(second.signal);
    expect(seen[1]).toBe(first.signal);
  });

  it("logs the start message to stdout and returns ok on a clean restore", async () => {
    const logLines: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const teardown = createWorkspaceRestoreTeardown({
      stagedRuntime: { restoreWorkspace: async () => {} },
      onLog: async (stream, chunk) => {
        logLines.push({ stream, chunk });
      },
      startMessage,
      failurePrefix,
    });

    const outcome = await teardown();

    expect(outcome).toEqual({ ok: true });
    expect(logLines).toEqual([{ stream: "stdout", chunk: startMessage }]);
  });

  it("classifies a thrown EACCES error and sanitizes the stderr line", async () => {
    const logLines: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    // A host filesystem path that must never reach the run log.
    const secretHostPath = "/home/host-user/.secret-project/workspace";
    const thrown: NodeJS.ErrnoException = new Error(`EACCES: permission denied, open '${secretHostPath}'`);
    thrown.code = "EACCES";
    const teardown = createWorkspaceRestoreTeardown({
      stagedRuntime: {
        restoreWorkspace: async () => {
          throw thrown;
        },
      },
      onLog: async (stream, chunk) => {
        logLines.push({ stream, chunk });
      },
      startMessage,
      failurePrefix,
    });

    const outcome = await teardown();

    expect(outcome).toEqual({ ok: false, code: "restore_permission_denied" });
    const stderrLines = logLines.filter((line) => line.stream === "stderr");
    expect(stderrLines).toEqual([
      {
        stream: "stderr",
        chunk: `${failurePrefix}: the restore could not write to the workspace (permission denied)\n`,
      },
    ]);
    for (const line of logLines) {
      expect(line.chunk).not.toContain(secretHostPath);
      expect(line.chunk).not.toContain(thrown.message);
    }
  });
});

describe("createWorkspaceRestoreTeardown signal forwarding (TOG-25014)", () => {
  const startMessage = "[paperclip] Restoring workspace changes from the sandbox.\n";

  it("forwards the run signal to the staged restore", async () => {
    const restoreWorkspace = vi.fn(async () => {});
    const controller = new AbortController();
    const teardown = createWorkspaceRestoreTeardown({
      stagedRuntime: { restoreWorkspace },
      onLog: async () => {},
      startMessage,
      failurePrefix: "[paperclip] Test teardown workspace restore failed",
      signal: controller.signal,
    });

    const outcome = await teardown();

    expect(outcome).toEqual({ ok: true });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(restoreWorkspace).toHaveBeenCalledWith(expect.any(Function), controller.signal);
  });

  it("reports a cancelled staged restore as a skip on stdout, not a failure", async () => {
    const logLines: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const controller = new AbortController();
    controller.abort(new Error("test stop"));
    const teardown = createWorkspaceRestoreTeardown({
      stagedRuntime: {
        restoreWorkspace: async () => {
          throw workspaceRestoreCancelledError();
        },
      },
      onLog: async (stream, chunk) => {
        logLines.push({ stream, chunk });
      },
      startMessage,
      failurePrefix: "[paperclip] Test teardown workspace restore failed",
      signal: controller.signal,
    });

    const outcome = await teardown();

    expect(outcome).toEqual({ ok: false, code: "restore_failed" });
    expect(logLines).toEqual([
      { stream: "stdout", chunk: startMessage },
      { stream: "stdout", chunk: "[paperclip] Skipping workspace restore: run was cancelled.\n" },
    ]);
  });
});
