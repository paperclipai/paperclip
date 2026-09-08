import { describe, expect, it } from "vitest";

import {
  boundedOpenCodeTerminalError,
  openCodeProxyAssistantText,
  openCodeProxyItemNotification,
  openCodeProxyTerminalNotification,
  shouldAnnounceOpenCodeProxyTurn,
  shouldForwardOpenCodeProxyItem,
} from "./opencode-proxy-events.js";

describe("OpenCode runnerd proxy event boundary", () => {
  it("drops only the duplicate session-scoped model item", () => {
    expect(shouldForwardOpenCodeProxyItem({ kind: "model" })).toBe(false);
    expect(
      shouldForwardOpenCodeProxyItem({
        turnId: "turn-1",
        kind: "model",
      }),
    ).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ kind: "agentMessage" })).toBe(true);
  });

  it("announces one outer turn when SSE wins the response race", () => {
    const announced = new Set<string>();
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(true);
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(false);
    expect([...announced]).toEqual(["turn-1"]);
  });

  it("recognizes canonical progress messages without dropping legacy text events", () => {
    expect(
      openCodeProxyAssistantText({
        kind: "agentMessage",
        channel: "progress",
        providerPhase: "commentary",
        text: "Inspecting the workspace.",
      }),
    ).toBe("Inspecting the workspace.");
    expect(
      openCodeProxyAssistantText({
        kind: "text",
        text: "Legacy OpenCode text.",
      }),
    ).toBe("Legacy OpenCode text.");
    expect(
      openCodeProxyAssistantText({
        kind: "dynamicToolCall",
        text: "not assistant prose",
      }),
    ).toBeNull();

    expect(
      openCodeProxyItemNotification({
        eventType: "item.delta",
        threadId: "session-1",
        turnId: "turn-1",
        itemId: "message-1",
        payload: {
          kind: "agentMessage",
          channel: "progress",
          providerPhase: "commentary",
          text: "Inspecting the workspace.",
          item: {
            id: "message-1",
            type: "agentMessage",
            channel: "progress",
            phase: "commentary",
            text: "Inspecting the workspace.",
          },
        },
      }),
    ).toEqual({
      method: "item/agentMessage/delta",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        itemId: "message-1",
        kind: "agentMessage",
        channel: "progress",
        providerPhase: "commentary",
        text: "Inspecting the workspace.",
        delta: "Inspecting the workspace.",
        item: {
          id: "message-1",
          type: "agentMessage",
          channel: "progress",
          phase: "commentary",
          text: "Inspecting the workspace.",
        },
      },
    });
  });

  it("preserves actionable OpenCode failure details on the production facade frame", () => {
    expect(
      openCodeProxyTerminalNotification({
        eventType: "turn.failed",
        threadId: "session-1",
        turnId: "turn-1",
        payload: {
          status: "failed",
          error: {
            code: "provider_rate_limited",
            message: "The provider rejected this request.",
            retryAfterMs: 1_500,
          },
        },
      }),
    ).toEqual({
      method: "turn/failed",
      params: {
        threadId: "session-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            code: "provider_rate_limited",
            message: "The provider rejected this request.",
            retryAfterMs: 1_500,
          },
        },
      },
    });
  });

  it("bounds oversized OpenCode failure details without losing their diagnosis", () => {
    const error = boundedOpenCodeTerminalError({
      code: "provider_failure",
      message: "actionable failure",
      debug: "x".repeat(70 * 1024),
    });
    expect(error).toEqual({
      code: "provider_failure",
      message: "actionable failure",
      omitted: true,
      reason: "payload_limit",
    });
    expect(Buffer.byteLength(JSON.stringify(error), "utf8")).toBeLessThan(
      64 * 1024,
    );
  });
});
