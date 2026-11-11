import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createNativeRemoteLaunchIntent, launchNativeRemoteRunnerOnce, NativeRemoteLaunchHandoffError } from "./native-remote-launch-handoff.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, nativeSessionRecoveryProjection } from "./native-session-executor.js";

describe("classic remote launch failure classification", () => {
  const permanent = ["native_remote_launch_intent_invalid", "native_remote_launch_identity_mismatch",
    "native_remote_launch_configuration_changed", "native_remote_launch_path_unsafe"] as const;

  it.each(permanent)("retains the named %s cause and stops same-run retries", code => {
    const failure = new NativeRemoteLaunchHandoffError(code);
    const source = nativeSessionFailureSourceCode(failure);
    expect(source).toBe("native_provider_state_incompatible");
    const disposition = nativeSessionFailureDisposition(1, new Date(), source);
    expect(disposition).toEqual({ phase: "terminal_failure", failureCode: source, nextAttemptAt: null });
    expect(nativeSessionRecoveryProjection({ ...disposition, agentId: "agent" })).toMatchObject({
      issueStatus: "blocked", recoveryOwner: { kind: "board" },
    });
    expect(failure.code).toBe(code);
    expect(failure.message).toBe(code);
    expect(nativeSessionFailureSourceCode(new Error(code))).toBe("native_session_interrupted");
  });

  it.each(["native_remote_launch_receipt_pending", "native_remote_launch_receipt_unavailable",
    "native_remote_launch_process_exited", "native_remote_launch_fingerprint_unavailable"] as const)(
    "does not turn %s into permanent saved-state incompatibility", code => {
      const source = nativeSessionFailureSourceCode(new NativeRemoteLaunchHandoffError(code));
      expect(source).toBe("native_session_interrupted");
      expect(nativeSessionFailureDisposition(1, new Date(), source)).toMatchObject({ phase: "retryable_failure" });
    },
  );

  it("classifies an actual changed launch configuration without replacing saved intent, checkpoint or workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-remote-launch-failure-"));
    try {
      const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
        normalizedSessionId: "session", turnId: "turn", itemId: "item" };
      const stateDirectory = join(root, "runner");
      const spec: RunnerProcessLaunchSpec = { command: process.execPath, cwd: root, environment: { BOOTSTRAP_TICKET: "original-controlled-ticket" },
        args: ["--runner-id", identity.runnerInstanceId, "--environment-lease-id", identity.environmentLeaseId,
          "--run-id", identity.runId, "--session-id", identity.normalizedSessionId, "--turn-id", identity.turnId,
          "--item-id", identity.itemId, "--runner-version", "fixture-v1", "--runner-digest", `sha256:${"a".repeat(64)}`,
          "--state-dir", stateDirectory] };
      const intent = createNativeRemoteLaunchIntent({ identity, checkpoint: { headerSha256: "b".repeat(64), cursorSha256: "c".repeat(64), partsSha256: "d".repeat(64) },
        remoteCwd: root, remoteBinary: process.execPath, stateDirectory, processIdentityPath: join(stateDirectory, "process.identity"),
        diagnosticsDirectory: join(root, "diagnostics"), runnerVersion: "fixture-v1", runnerDigest: `sha256:${"a".repeat(64)}`, spec });
      const saved = { "launch-intent.json": JSON.stringify(intent), "checkpoint.json": JSON.stringify({ identity, checkpoint: intent.checkpoint }), "work.txt": "retained workspace content\n" };
      for (const [name, bytes] of Object.entries(saved)) await writeFile(join(root, name), bytes);
      const execute = vi.fn();
      const failure = await launchNativeRemoteRunnerOnce({ runner: { execute }, intent,
        spec: { ...spec, environment: { BOOTSTRAP_TICKET: "different-controlled-ticket" } } }).catch(error => error);
      expect(failure).toBeInstanceOf(NativeRemoteLaunchHandoffError);
      expect(failure.code).toBe("native_remote_launch_configuration_changed");
      const source = nativeSessionFailureSourceCode(failure);
      expect(source).toBe("native_provider_state_incompatible");
      expect(nativeSessionFailureDisposition(1, new Date(), source)).toEqual({ phase: "terminal_failure", failureCode: source, nextAttemptAt: null });
      expect(execute).not.toHaveBeenCalled();
      for (const [name, bytes] of Object.entries(saved)) expect(await readFile(join(root, name), "utf8")).toBe(bytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
