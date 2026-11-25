import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./recovery/service.js";
import { NativeProviderTerminalFailure } from "../vendor/paperclip-runner/index.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, nativeStartupFailureMessage } from "./native-runtime/native-session-executor.js";
import { antigravitySwarmRefusal, isAntigravitySwarmExecution, requestedAntigravitySwarmCommentId } from "./antigravity-swarm.js";

const antigravity = { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "gemini-3.8-flash-low" } };

describe("trusted /swarm for Google Antigravity", () => {
  it("is available only when the experimental flag is on, for a local Antigravity assignee", () => {
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity })).toBeNull();
    expect(antigravitySwarmRefusal({ enabled: false, agent: antigravity })).toMatch(/not turned on/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: null })).toMatch(/Google Antigravity agent/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: { adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } } }))
      .toMatch(/Google Antigravity agent/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, remote: true })).toMatch(/this computer/);
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, planning: true })).toMatch(/Plan mode/);
    // Helpers change files: only a standard task runs a swarm (allow-list), never ask or skill_test.
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, workMode: "standard" })).toBeNull();
    expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, workMode: "planning" })).toMatch(/Plan mode/);
    for (const workMode of ["ask", "skill_test", "something_new", null]) {
      expect(antigravitySwarmRefusal({ enabled: true, agent: antigravity, workMode }))
        .toBe("Swarm works only in a standard task: helpers change files, and this task's mode does not allow changes. Switch the task to Standard, then send /swarm.");
    }
  });

  it("reads a swarm request only from the wake's structured marker, never from comment text", () => {
    const id = "6f1c1b0e-5a52-4b0a-9a51-0d6c9c3b2f11";
    expect(requestedAntigravitySwarmCommentId({ antigravitySwarmCommentId: id })).toBe(id);
    expect(requestedAntigravitySwarmCommentId({ commentId: id, wakeCommentId: id })).toBeNull();
    expect(requestedAntigravitySwarmCommentId({ antigravitySwarmCommentId: "/swarm do it" })).toBeNull();
    expect(requestedAntigravitySwarmCommentId(null)).toBeNull();
  });

  it("recognises only the Antigravity swarm execution, so other runs keep their prompt supplements", () => {
    expect(isAntigravitySwarmExecution({ provider: { kind: "acpx", agent: "antigravity", mode: "swarm" } })).toBe(true);
    expect(isAntigravitySwarmExecution({ provider: { kind: "acpx", agent: "antigravity" } })).toBe(false);
    expect(isAntigravitySwarmExecution({ provider: { kind: "acpx", agent: "cursor", mode: "swarm" } })).toBe(false);
  });

  it("does not automatically replay a refused /swarm (the user sends /swarm again or presses Retry)", () => {
    expect(classifyContinuationFailure({ errorCode: "antigravity_swarm_unavailable", resultJson: null } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  // Live run6: a swarm turn that ended with no result became "native_session_interrupted",
  // showed the Runner's raw continuation text, and recovery started two more billed swarms.
  it("settles a swarm turn the route failed by its own code as a plain, person-retried failure", () => {
    const message = "The swarm ended without doing any work. Send /swarm again to retry.";
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn", category: "unknown", retryability: "unknown", message } as const;
    const failure = new NativeProviderTerminalFailure("ANTIGRAVITY_SWARM_NO_RESULT", false, message, providerFailure as never);
    const code = nativeSessionFailureSourceCode(failure);
    expect(code).toBe("antigravity_swarm_unavailable");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toMatchObject({ phase: "terminal_failure", failureCode: "antigravity_swarm_unavailable", nextAttemptAt: null });
    expect(nativeStartupFailureMessage(code, `native_session_recovery_failed: ${message}`, providerFailure)).toBe(message);
    expect(classifyContinuationFailure({ errorCode: code, resultJson: null } as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    // A lost CLI process is an interruption and still recovers on its own.
    expect(nativeSessionFailureSourceCode(new NativeProviderTerminalFailure("ACPX_PROVIDER_PROCESS_LOST", true, "lost"))).not.toBe("antigravity_swarm_unavailable");
  });
});
