import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GIT_STREAMING_FILE_COUNT, GIT_STREAMING_PARENT, gitStreamingEvidence, gitStreamingFilename, gradeGitFinalization, gradeGitStreamingInventory } from "./daytona-git-streaming.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), readdir: vi.fn() }));

describe("Daytona Git filename boundary oracle", () => {
  const names = Array.from({ length: GIT_STREAMING_FILE_COUNT }, (_, index) => gitStreamingFilename(index));
  it("independently proves the generated manifest exceeds the old 32 MiB bound", () => {
    expect(gradeGitStreamingInventory(names)).toEqual({ generatedFiles: 60_000, filenameBytes: 39_828_890 });
  });
  it("rejects a missing file and a plausible duplicate replacement", () => {
    expect(() => gradeGitStreamingInventory(names.slice(1))).toThrow("missing 1");
    expect(() => gradeGitStreamingInventory([names[1]!, ...names.slice(1)])).toThrow("duplicate");
  });
  it("rejects stale copies from an earlier turn, even with the complete inventory", async () => {
    vi.mocked(readdir).mockResolvedValue(names as never);
    let contents = "base";
    vi.mocked(readFile).mockImplementation(async filename => String(filename).includes(GIT_STREAMING_PARENT) ? contents : path.basename(String(filename)));
    await expect(gitStreamingEvidence("/fixture", 1)).resolves.toMatchObject({ verifiedContents: 60_000 });
    await expect(gitStreamingEvidence("/fixture", 2)).rejects.toThrow("changed generated file contents");
    contents = "base-turn-2";
    await expect(gitStreamingEvidence("/fixture", 2)).resolves.toMatchObject({ verifiedContents: 60_000 });
    await expect(gitStreamingEvidence("/fixture", 3)).rejects.toThrow("changed generated file contents");
    contents = "base-turn-3";
    await expect(gitStreamingEvidence("/fixture", 3)).resolves.toMatchObject({ verifiedContents: 60_000 });
  });
});

describe("Git copyback finalization oracle", () => {
  const clean = () => ({
    runs: [{ id: "run-1", status: "succeeded", nativePhase: "committed", resultJson: {
      finalizationPhase: "committed", workspaceFinalizeStatus: "succeeded", nextAttemptAt: null as string | null, failureCode: null as string | null,
    }, runnerProfileJson: { nativeExecutionInput: { session: { lifecyclePolicy: { mode: "warm", idleTimeoutMs: 1_200_000 } } } } }],
    operations: [{ heartbeatRunId: "run-1" as string | null, status: "succeeded" }],
    recovery: { active: null, actions: [] as Array<{ status: string; wakePolicy: { kind: string } }> },
    scheduledRetry: null,
  });
  it("accepts matching durable committed receipts", () => {
    expect(gradeGitFinalization(clean())).toEqual({ passed: true, failures: [] });
  });
  it("rejects the environment's default idle policy overriding the heavy fixture", () => {
    const observed = clean();
    observed.runs[0]!.runnerProfileJson.nativeExecutionInput.session.lifecyclePolicy.idleTimeoutMs = 300_000;
    expect(gradeGitFinalization(observed).failures).toEqual(["Run run-1 did not admit the required 20-minute warm idle policy"]);
  });
  it("rejects the observed success/finalization retry contradiction", () => {
    const observed = clean();
    observed.runs[0]!.nativePhase = "retryable_failure";
    observed.runs[0]!.resultJson.finalizationPhase = "retryable_failure";
    observed.runs[0]!.resultJson.nextAttemptAt = "2026-09-27T22:04:26.756Z";
    observed.operations.push({ heartbeatRunId: "run-1", status: "running" });
    observed.recovery.actions.push({ status: "active", wakePolicy: { kind: "resume_native_run" } });
    expect(gradeGitFinalization(observed).failures).toHaveLength(4);
  });
  it("rejects a stale active sync even when the run is committed", () => {
    const observed = clean();
    observed.operations.push({ heartbeatRunId: "run-1", status: "running" });
    expect(gradeGitFinalization(observed).passed).toBe(false);
  });
  it("rejects active workspace cleanup receipts without a run ID", () => {
    const observed = clean();
    observed.operations.push({ heartbeatRunId: null, status: "running" });
    expect(gradeGitFinalization(observed).failures).toContain("The workspace still has an active operation");
    observed.operations[1]!.status = "succeeded";
    expect(gradeGitFinalization(observed).passed).toBe(true);
  });
  it("rejects an active failure summary left on a committed run", () => {
    const observed = clean();
    observed.runs[0]!.resultJson.failureCode = "side_effect_planning_failed";
    expect(gradeGitFinalization(observed).failures).toEqual(["Run run-1 still projects an active finalization failure"]);
  });
  it("rejects missing finalization evidence", () => {
    const observed = clean();
    observed.operations = [];
    expect(gradeGitFinalization(observed).passed).toBe(false);
    expect(gradeGitFinalization({ ...observed, runs: [] }).passed).toBe(false);
  });
});
