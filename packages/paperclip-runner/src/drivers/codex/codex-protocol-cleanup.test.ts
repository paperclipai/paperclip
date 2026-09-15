import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("protocol-failure cleanup", () => {
  it.each(["immediate", "delayed", "successful"])(
    "contains %s background cleanup without hiding its outcome from the owner",
    (outcome) => {
      // Use Node's fatal unhandled-rejection policy in a separate process.
      // A test-runner rejection listener would conceal the controller crash.
      const source = `
        import assert from "node:assert/strict";
        import { CodexHarnessSession } from ${JSON.stringify(new URL("./codex-harness-session.ts", import.meta.url).href)};
        const cleanupError = new Error("Sandbox not found during cleanup");
        let closePromise;
        let cleanupAttempts = 0;
        const transport = {
          setServerRequestHandler() {},
          async *notifications() { throw new Error("Sandbox not found during monitoring"); },
          close() {
            if (!closePromise) {
              cleanupAttempts++;
              closePromise = ${JSON.stringify(outcome)} === "successful"
                ? Promise.resolve()
                : ${JSON.stringify(outcome)} === "delayed"
                  ? new Promise((_, reject) => setTimeout(() => reject(cleanupError), 10))
                  : Promise.reject(cleanupError);
            }
            return closePromise;
          },
        };
        const session = new CodexHarnessSession({
          transport, runId: "run-cleanup", normalizedSessionId: "session-cleanup",
          opened: { lineage: { threadId: "thread-cleanup" }, context: {} }, taskEnvelope: {},
          conversationMode: "task", resumed: false, activeTurnId: "turn-cleanup",
          sourceSequence: 0, now: () => new Date(), runnerInstanceId: "runner-cleanup",
          driverKind: "codex", capabilities: {}, goalCapability: "disabled",
          goalAvailability: "unavailable", goalReasonCode: null, goalReason: null,
          dynamicTools: [],
        });
        // The ordinary owner may only join cleanup on a later event-loop turn.
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(session.protocolFailed, true);
        assert.equal(session.protocolFailureCode, "notification_transport_failed");
        assert.equal(session.activeTurnId, null);
        const events = [];
        for await (const event of session.eventQueue) events.push(event);
        assert.equal(events.filter(event => event.eventType === "session.failed").length, 1);
        assert.equal(events.filter(event => event.eventType === "turn.failed").length, 1);
        assert.equal(events.some(event => event.eventType === "turn.completed"), false);
        session.failProtocol("duplicate_failure", "must not retry cleanup");
        if (${JSON.stringify(outcome)} === "successful") await session.close();
        else await assert.rejects(session.close(), error => error === cleanupError);
        assert.equal(cleanupAttempts, 1);
        process.stdout.write("HOST_ALIVE_CLEANUP_OUTCOME_PRESERVED");
      `;
      expect(execFileSync(process.execPath, [
        "--unhandled-rejections=strict", "--import", import.meta.resolve("tsx"),
        "--input-type=module", "--eval", source,
      ], { encoding: "utf8", timeout: 10_000 })).toBe("HOST_ALIVE_CLEANUP_OUTCOME_PRESERVED");
    },
  );
});
