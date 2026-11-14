import { describe, expect, it } from "vitest";

import { parseHermesOutput, shouldNormalizeCompletedHermesAbort } from "./execute.js";

const sessionId = "20261112_234810_af7fe2";
const response =
  "AUT-203 is ready, but the board rejected the hand-back twice with HTTP 403. No state changed.";

function structuredStderr(
  status: "completed" | "failed" = "completed",
  recordSessionId = sessionId,
): string {
  return (
    `hermes_result: ${JSON.stringify({
      schema_version: 1,
      status,
      session_id: recordSessionId,
    })}\n` + `session_id: ${sessionId}\n`
  );
}

function parsedAbort(
  stdout = response,
  stderr = structuredStderr(),
  exitCode: number | null = null,
  signal: string | null = "SIGABRT",
) {
  return {
    timedOut: false,
    exitCode,
    signal,
    stdout,
    stderr,
    ...parseHermesOutput(stdout, stderr),
  };
}

describe("Hermes teardown outcome classification", () => {
  it("normalizes SIGABRT only with a structured completed result record", () => {
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort())).toBe(true);
  });

  it("normalizes shell-style exit 134 with the same structured completion proof", () => {
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, structuredStderr(), 134, null))).toBe(
      true,
    );
  });

  it.each([
    `session_id: forged-session\n${response}`,
    `Ordinary prose says session id: forged-session.\n${response}`,
  ])("prefers authoritative stderr session metadata over assistant output: %s", (stdout) => {
    const parsed = parseHermesOutput(stdout, structuredStderr());

    expect(parsed.sessionId).toBe(sessionId);
  });

  it("does not infer completion from response text and a legacy session marker", () => {
    const stdout = `${response}\nSession: ${sessionId}\n`;
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(stdout, ""))).toBe(false);
  });

  it("does not infer completion from the pre-protocol quiet session marker", () => {
    const stderr = `session_id: ${sessionId}\n`;
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, stderr))).toBe(false);
  });

  it("does not normalize a structured failed billing outcome", () => {
    const stdout = "Billing or credits exhausted: provider quota exhausted";
    expect(
      shouldNormalizeCompletedHermesAbort(parsedAbort(stdout, structuredStderr("failed"))),
    ).toBe(false);
  });

  it("does not normalize a malformed result record", () => {
    const stderr = `hermes_result: {not-json}\nsession_id: ${sessionId}\n`;
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, stderr))).toBe(false);
  });

  it("does not normalize duplicate result records", () => {
    const record = structuredStderr().split("\n")[0];
    const stderr = `${record}\n${record}\nsession_id: ${sessionId}\n`;
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, stderr))).toBe(false);
  });

  it("does not normalize when result and terminal session identifiers differ", () => {
    expect(
      shouldNormalizeCompletedHermesAbort(
        parsedAbort(response, structuredStderr("completed", "different_session")),
      ),
    ).toBe(false);
  });

  it("does not normalize when stderr contains anything beyond protocol metadata", () => {
    const stderr = `Error: provider unavailable\n${structuredStderr()}`;
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, stderr))).toBe(false);
  });

  it("does not normalize without a final response", () => {
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort("", structuredStderr()))).toBe(false);
  });

  it("does not normalize a timeout", () => {
    expect(
      shouldNormalizeCompletedHermesAbort({
        ...parsedAbort(),
        timedOut: true,
      }),
    ).toBe(false);
  });

  it("rejects null/null teardown and ordinary non-abort exits and signals", () => {
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, structuredStderr(), null, null))).toBe(
      false,
    );
    expect(shouldNormalizeCompletedHermesAbort(parsedAbort(response, structuredStderr(), 1, null))).toBe(
      false,
    );
    expect(
      shouldNormalizeCompletedHermesAbort(
        parsedAbort(response, structuredStderr(), null, "SIGTERM"),
      ),
    ).toBe(false);
    expect(
      shouldNormalizeCompletedHermesAbort(
        parsedAbort(response, structuredStderr(), 134, "SIGKILL"),
      ),
    ).toBe(false);
  });
});
