import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import {
  buildTranscriptFromRunEvents,
  hasStructuredTranscriptEvents,
} from "./run-events";

function makeEvent(
  overrides: Partial<HeartbeatRunEvent>,
): HeartbeatRunEvent {
  return {
    id: 1,
    companyId: "company-1",
    runId: "run-1",
    agentId: "agent-1",
    seq: 1,
    eventType: "transcript.stdout",
    stream: "stdout",
    level: "info",
    color: null,
    message: null,
    payload: null,
    createdAt: new Date("2026-03-14T12:00:00.000Z"),
    ...overrides,
  };
}

describe("run event transcript helpers", () => {
  it("detects when structured transcript events are present", () => {
    expect(
      hasStructuredTranscriptEvents([
        makeEvent({ eventType: "adapter.invoke" }),
        makeEvent({ eventType: "assistant.message" }),
      ]),
    ).toBe(true);
  });

  it("keeps stderr-only transcripts in the legacy transcript mode", () => {
    expect(
      hasStructuredTranscriptEvents([
        makeEvent({ eventType: "adapter.invoke" }),
        makeEvent({ eventType: "transcript.stderr", stream: "stderr" }),
      ]),
    ).toBe(false);
  });

  it("rebuilds command execution and assistant transcript entries", () => {
    const entries = buildTranscriptFromRunEvents([
      makeEvent({
        seq: 1,
        eventType: "command.execution.started",
        payload: {
          input: {
            id: "cmd-1",
            command: "pnpm -r typecheck",
          },
        },
      }),
      makeEvent({
        id: 2,
        seq: 2,
        eventType: "command.execution.completed",
        payload: {
          toolUseId: "cmd-1",
          command: "pnpm -r typecheck",
          status: "completed",
          exitCode: 0,
          outputSnippet: "All good",
          isError: false,
        },
      }),
      makeEvent({
        id: 3,
        seq: 3,
        eventType: "assistant.message",
        message: "Ready for review.",
        payload: { text: "Ready for review." },
      }),
    ]);

    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: "2026-03-14T12:00:00.000Z",
        name: "command_execution",
        input: {
          id: "cmd-1",
          command: "pnpm -r typecheck",
        },
      },
      {
        kind: "tool_result",
        ts: "2026-03-14T12:00:00.000Z",
        toolUseId: "cmd-1",
        content: "command: pnpm -r typecheck\nstatus: completed\nexit_code: 0\n\nAll good",
        isError: false,
      },
      {
        kind: "assistant",
        ts: "2026-03-14T12:00:00.000Z",
        text: "Ready for review.",
        delta: false,
      },
    ]);
  });
});
