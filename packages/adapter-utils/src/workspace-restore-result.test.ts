import { describe, expect, it } from "vitest";
import { applyWorkspaceRestoreFailure, withWorkspaceRestore } from "./workspace-restore-result.js";
import type { AdapterExecutionResult } from "./types.js";

const completed: AdapterExecutionResult = {
  exitCode: 0, signal: null, timedOut: false,
  summary: "The plan is ready.", sessionId: "session", usage: { inputTokens: 4, outputTokens: 9 },
  resultJson: { requestId: "request" },
};
const unsafe = new Error("Daytona syncOut refusing tarball link whose target escapes the extraction dir: .claude/skills/paperclip -> /tmp/private-clone/secret-key");

describe("workspace restore settlement", () => {
  it("retains the completed result and safe member while excluding the unsafe target", async () => {
    const result = await withWorkspaceRestore(async () => completed, async () => { throw unsafe; });
    expect(result).toMatchObject({
      summary: completed.summary, sessionId: "session", usage: completed.usage,
      errorCode: "workspace_restore_failed", timedOut: false,
      resultJson: { requestId: "request", workspaceRestoreFailure: "restore_unsafe_archive",
        workspaceRestorePath: ".claude/skills/paperclip", finalResponseRecorded: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-clone|secret-key|\/tmp/);
    expect(applyWorkspaceRestoreFailure(result)).toBe(result);
  });

  it("retains the previous execution failure and restore classification", async () => {
    const result = await withWorkspaceRestore(async () => ({ ...completed, exitCode: 2, errorCode: "model_error", errorMessage: "Model request failed." }), async () => { throw unsafe; });
    expect(result.errorMessage).toContain("Model request failed.");
    expect(result.errorMessage).toContain("Workspace restore failed.");
    expect(result.resultJson?.executionBeforeRestore).toMatchObject({ errorCode: "model_error", exitCode: 2 });
  });

  it("retains a thrown execution error when restore also fails", async () => {
    const result = await withWorkspaceRestore(async () => { throw new Error("Process failed."); }, async () => { throw unsafe; });
    expect(result.errorMessage).toContain("Process failed.");
    expect(result.resultJson).toMatchObject({ finalResponseRecorded: false, executionBeforeRestore: { errorCode: "adapter_failed" } });
  });

  it("keeps timeout evidence while making restore the terminal failure phase", async () => {
    const result = await withWorkspaceRestore(async () => ({ ...completed, timedOut: true }), async () => { throw unsafe; });
    expect(result.timedOut).toBe(false);
    expect(result.resultJson?.executionBeforeRestore).toMatchObject({ timedOut: true });
  });

  it("preserves the original result or thrown error after a clean restore", async () => {
    expect(await withWorkspaceRestore(async () => completed, async () => {})).toBe(completed);
    const error = new Error("execution failed");
    await expect(withWorkspaceRestore(async () => { throw error; }, async () => {})).rejects.toBe(error);
  });

  it.each(["/tmp/private/file", "../escape", "C:\\private\\file"])("omits unsafe member %s", async (member) => {
    const result = await withWorkspaceRestore(async () => completed, async () => {
      throw new Error(`Daytona syncOut refusing tarball link whose target escapes the extraction dir: ${member} -> /secret`);
    });
    expect(result.resultJson?.workspaceRestorePath).toBeUndefined();
  });
});
