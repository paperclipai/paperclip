import { describe, expect, it } from "vitest";

import { createWorkspaceRestoreTeardown } from "./workspace-restore-teardown.js";

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
