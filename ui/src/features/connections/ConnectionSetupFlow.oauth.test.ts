// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ToolApplication, ToolConnection } from "@paperclipai/shared";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  isConnectionDefinitionUnavailable,
  isVercelConnectUnavailable,
  readConnectionIntentOAuthOutcome,
  retainedReconnectMatches,
  requestedConnectionSetupResolution,
  requestedConnectionEntry,
} from "./ConnectionSetupFlow";

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

  it("ends unavailable retained reconnects instead of leaving them loading", () => {
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: null,
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("fallback");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 1,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("ready");
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

  it("does not apply fresh-setup availability to an exact retained reconnect", () => {
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: true,
    })).toBe(false);
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: true,
    })).toBe(false);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: undefined,
      reconnectSourceMatches: true,
    })).toBe(true);
  });
});

describe("retained reconnect target matching", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;
  const application = { id: "app-1", applicationKey: "custom-mcp" } as ToolApplication;

  it("accepts a generic reconnect only for its exact retained application", () => {
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-other",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(false);
  });

  it("keeps curated reconnects bound to their provider", () => {
    const curated = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;
    expect(retainedReconnectMatches({
      requestedAppKey: "github",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: "notion",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(false);
  });
});
