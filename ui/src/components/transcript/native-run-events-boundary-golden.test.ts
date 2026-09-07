import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

import {
  localIntegrityBoundaryGolden as fixture,
  localIntegrityEventsFor,
} from "../../../../packages/paperclip-runner/test-support/local-integrity-boundary-golden";
import { nativeRunEventsToTranscript } from "./native-run-events";

function persistedEventsFor(
  profile: (typeof fixture.profiles)[number],
): HeartbeatRunEvent[] {
  return localIntegrityEventsFor(profile).map((prpEvent) => {
    return {
      id: prpEvent.sourceSeq,
      companyId: "73000000-0000-4000-8000-000000000001",
      runId: profile.runId,
      agentId: "73000000-0000-4000-8000-000000000201",
      seq: prpEvent.sourceSeq,
      eventType: prpEvent.eventType,
      stream: "system",
      level: "info",
      color: null,
      message: null,
      payload: { prpEvent },
      createdAt: new Date(prpEvent.emittedAt),
    } satisfies HeartbeatRunEvent;
  });
}

describe("canonical native event UI boundary corpus", () => {
  it.each(fixture.profiles)(
    "projects $id without losing identities, channels, structured input, or terminal state",
    (profile) => {
      const persistedEvents = persistedEventsFor(profile);
      for (const event of persistedEvents) {
        const envelope = event.payload?.prpEvent as Record<string, unknown>;
        expect(envelope.eventType).toBe(event.eventType);
        expect(envelope.sourceEventId).toBe(
          `${profile.id}:${fixture.events[event.seq - 1]!.sourceEventId}`,
        );
      }

      const transcript = nativeRunEventsToTranscript(persistedEvents);
      const assistant = transcript.filter(
        (entry) => entry.kind === "assistant",
      );
      expect(assistant).toEqual(
        fixture.expected.assistantItems.map((expected) =>
          expect.objectContaining({
            kind: "assistant",
            itemId: expected.itemId,
            channel: expected.channel,
            text: expected.text,
          }),
        ),
      );
      expect(
        assistant.filter((entry) => entry.channel === "final"),
      ).toHaveLength(1);

      expect(transcript.filter((entry) => entry.kind === "thinking")).toEqual([
        expect.objectContaining({
          itemId: fixture.expected.reasoningItemId,
          lifecycle: "completed",
          channel: "detail",
          text: "Verified event identity.",
        }),
      ]);

      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "tool_call",
          toolUseId: fixture.expected.toolExecutionId,
          name: "Bash",
          input: { command: "boundary-check" },
        }),
      );
      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "tool_result",
          toolUseId: fixture.expected.toolExecutionId,
          content: "boundary-ok",
          isError: false,
        }),
      );

      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "tool_call",
          toolUseId: `plan:${fixture.expected.planId}`,
          name: "plan",
          input: {
            eventType: "plan.updated",
            summary: "Keep every boundary lossless.",
          },
        }),
      );
      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "tool_result",
          toolUseId: `plan:${fixture.expected.planId}`,
          content: "Keep every boundary lossless.",
          isError: false,
        }),
      );

      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "runtime_request",
          requestId: fixture.expected.questionRequestId,
          requestType: "input",
          status: "pending",
          questionSet: expect.objectContaining({
            schema: "paperclip.question_set.v1",
            questions: [expect.objectContaining({ id: "boundary-mode" })],
          }),
        }),
      );
      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "result",
          subtype: "paperclip_runner_usage",
          inputTokens: 20,
          outputTokens: 6,
          cachedTokens: 2,
          costUsd: 0.01,
        }),
      );
      expect(
        transcript.filter((entry) => entry.kind === "run_terminal"),
      ).toEqual([
        expect.objectContaining({
          turnState: "completed",
          runState: fixture.expected.runTerminalState,
          disposition: "done",
        }),
      ]);
    },
  );
});
