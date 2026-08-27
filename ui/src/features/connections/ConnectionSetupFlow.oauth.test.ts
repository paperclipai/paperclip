// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { readConnectionIntentOAuthOutcome } from "./ConnectionSetupFlow";

const origin = "https://paperclip.test";
const interactionId = "interaction-123";

function event(data: unknown, eventOrigin = origin) {
  return { origin: eventOrigin, data };
}

describe("connection intent OAuth window messages", () => {
  it.each(["connected", "declined", "failed"] as const)(
    "accepts a matching %s outcome",
    (outcome) => {
      expect(
        readConnectionIntentOAuthOutcome(
          event({
            type: "paperclip.connection-intent.oauth",
            interactionId,
            outcome,
          }),
          origin,
          interactionId,
        ),
      ).toBe(outcome);
    },
  );

  it.each([
    [
      "foreign origin",
      event(
        {
          type: "paperclip.connection-intent.oauth",
          interactionId,
          outcome: "connected",
        },
        "https://attacker.test",
      ),
    ],
    [
      "wrong interaction",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId: "other",
        outcome: "connected",
      }),
    ],
    [
      "wrong message type",
      event({ type: "other", interactionId, outcome: "connected" }),
    ],
    [
      "unknown outcome",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId,
        outcome: "authorized",
      }),
    ],
    ["non-object payload", event("connected")],
  ])("ignores a %s message", (_label, candidate) => {
    expect(
      readConnectionIntentOAuthOutcome(candidate, origin, interactionId),
    ).toBeNull();
  });
});
