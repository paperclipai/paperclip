// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ToolApplication, ToolConnection } from "@paperclipai/shared";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { readConnectionIntentOAuthOutcome, requestedConnectionEntry } from "./ConnectionSetupFlow";

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

describe("retained reconnect definition lookup", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;

  it("restores a hidden provider only for its exact retained application", () => {
    const githubApplication = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;

    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: connection,
      applications: [githubApplication],
    })?.slug).toBe("github");
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [],
      reconnectConnection: connection,
      applications: [githubApplication],
    })).toBeNull();
  });

  it("does not expose a hidden provider without an exact reconnect target", () => {
    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: null,
      applications: [],
    })).toBeNull();
    const visibleNotion = getConnectableAppDefinition("notion")!;
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [visibleNotion],
      reconnectConnection: null,
      applications: [],
    })).toBe(visibleNotion);
  });
});
