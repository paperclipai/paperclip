import { describe, expect, it } from "vitest";

import { validatePrpEvent } from "../protocol/replay-contract.js";
import {
  localIntegrityBoundaryGolden as fixture,
  localIntegrityEventsFor as eventsFor,
} from "../../test-support/local-integrity-boundary-golden.js";
import {
  rehydrateRunnerdItemNotification,
  rehydrateRunnerdPlanNotification,
  rehydrateRunnerdThreadTokenUsage,
  rehydrateRunnerdTurnNotification,
  rehydrateRunnerdUsageNotification,
} from "./runnerd-codex-transport.js";

describe("canonical local-provider boundary corpus", () => {
  it.each(fixture.profiles)(
    "keeps the $id top-level PRP v1 envelope valid",
    (profile) => {
      const events = eventsFor(profile);
      expect(events.map((event) => event.eventType)).toEqual(
        fixture.expected.eventTypes,
      );
      for (const event of events) {
        expect(validatePrpEvent(event), event.sourceEventId).toEqual({
          ok: true,
          event: expect.objectContaining({
            sourceEventId: event.sourceEventId,
            eventType: event.eventType,
            ...(event.itemId ? { itemId: event.itemId } : {}),
          }),
          issues: [],
        });
      }
    },
  );

  it.each(fixture.profiles)(
    "keeps $id-bound identities, channels, and discriminators through runnerd rehydration",
    (profile) => {
      const events = eventsFor(profile);
      const bySourceId = new Map(
        events.map((event) => [event.sourceEventId.split(":").at(-1), event]),
      );
      const item = (sourceEventId: string) => {
        const event = bySourceId.get(sourceEventId);
        if (!event) throw new Error(`missing golden event ${sourceEventId}`);
        return rehydrateRunnerdItemNotification(
          event.payload,
          profile.normalizedSessionId,
          fixture.turnId,
        );
      };

      for (const expected of fixture.expected.assistantItems) {
        const sourceEventId =
          expected.channel === "final"
            ? "final-completed"
            : "progress-completed";
        expect(item(sourceEventId)).toMatchObject({
          threadId: profile.normalizedSessionId,
          turnId: fixture.turnId,
          itemId: expected.itemId,
          channel: expected.channel,
          providerPhase:
            expected.channel === "final" ? "final_answer" : "commentary",
          item: {
            id: expected.itemId,
            type: "agentMessage",
            channel: expected.channel,
            phase: expected.channel === "final" ? "final_answer" : "commentary",
            text: expected.text,
          },
        });
      }

      expect(item("reasoning-completed")).toMatchObject({
        itemId: fixture.expected.reasoningItemId,
        item: {
          id: fixture.expected.reasoningItemId,
          type: "reasoning",
          channel: "detail",
          phase: "reasoning",
          text: "Verified event identity.",
        },
      });

      const plan = bySourceId.get("plan-updated")!;
      expect(
        rehydrateRunnerdPlanNotification(
          plan.payload,
          profile.normalizedSessionId,
          fixture.turnId,
        ),
      ).toMatchObject({
        threadId: profile.normalizedSessionId,
        turnId: fixture.turnId,
        planId: fixture.expected.planId,
        plan: [
          { step: "Normalize", status: "completed" },
          { step: "Project", status: "in_progress" },
        ],
      });

      const usage = bySourceId.get("usage-reported")!;
      const rehydratedUsage = rehydrateRunnerdUsageNotification(
        usage.payload,
        profile.normalizedSessionId,
        fixture.turnId,
      );
      expect(rehydratedUsage).toMatchObject({
        threadId: profile.normalizedSessionId,
        turnId: fixture.turnId,
        providerSessionId: "provider-session-boundary",
        runDeltaAvailable: true,
        tokenUsage: {
          total: { inputTokens: 40, outputTokens: 12 },
          runDelta: { inputTokens: 20, outputTokens: 6 },
        },
      });
      expect(
        rehydrateRunnerdThreadTokenUsage(
          (usage.payload.cumulative ?? null) as Record<string, unknown> | null,
        ),
      ).toEqual({ total: usage.payload.cumulative });

      const terminal = bySourceId.get("turn-completed")!;
      expect(
        rehydrateRunnerdTurnNotification(
          terminal.payload,
          profile.normalizedSessionId,
          fixture.turnId,
          "turn/completed",
        ),
      ).toMatchObject({
        threadId: profile.normalizedSessionId,
        turnId: "provider-turn-boundary-1",
        turn: {
          id: "provider-turn-boundary-1",
          status: "completed",
          error: null,
        },
      });

      expect(bySourceId.get("tool-started")).toMatchObject({
        itemId: fixture.expected.toolExecutionId,
        eventType: "tool.execution.started",
        payload: { executionId: fixture.expected.toolExecutionId },
      });
      expect(bySourceId.get("question-created")).toMatchObject({
        itemId: fixture.expected.questionRequestId,
        eventType: "runtime_request.created",
        payload: {
          request: {
            requestId: fixture.expected.questionRequestId,
            input: { schema: "paperclip.question_set.v1" },
          },
        },
      });
      expect(bySourceId.get("run-terminal")).toMatchObject({
        eventType: "run.terminal",
        payload: { runTerminalState: fixture.expected.runTerminalState },
      });
    },
  );
});
