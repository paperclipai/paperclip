import { describe, expect, it, vi } from "vitest";

import {
  boundedOpenCodeTerminalError,
  openCodeProxyAssistantText,
  openCodeProxyItemNotification,
  openCodeProxyTerminalNotification,
  shouldAnnounceOpenCodeProxyTurn,
  shouldForwardOpenCodeProxyItem,
} from "./opencode-proxy-events.js";
import { createOpenCodeProxyOutput } from "./opencode-proxy-output.js";

describe("OpenCode runnerd proxy event boundary", () => {
  it("drops only the duplicate session-scoped model item", () => {
    expect(shouldForwardOpenCodeProxyItem({ payload: { kind: "model" } })).toBe(false);
    expect(
      shouldForwardOpenCodeProxyItem({
        turnId: "turn-1",
        payload: { kind: "model" },
      }),
    ).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ payload: { kind: "agentMessage" } })).toBe(true);
  });

  it("keeps per-token deltas runnerd discards from queueing ahead of a tool call", () => {
    const framesBeforeToolCall = (tokens: number) => {
      vi.useFakeTimers();
      try {
        const written: Array<{ method?: string }> = [];
        const output = createOpenCodeProxyOutput(frame => written.push(frame as { method?: string }));
        const forward = (eventType: "item.started" | "item.delta" | "item.completed", itemId: string, payload: Record<string, unknown>) => {
          if (shouldForwardOpenCodeProxyItem({ eventType, turnId: "turn-1", payload }))
            output.send(openCodeProxyItemNotification({ eventType, threadId: "thread-1", turnId: "turn-1", itemId, payload }));
        };
        for (let index = 0; index < tokens; index += 1) {
          forward("item.delta", "reasoning-1", { kind: "reasoning", channel: "detail", providerPhase: "reasoning", text: `token ${index} `,
            item: { id: "reasoning-1", type: "reasoning", text: `token ${index} ` } });
          forward("item.delta", "tool-1", { kind: "tool", text: `line ${index}\n`, item: { id: "tool-1", type: "tool", state: { status: "running" } } });
        }
        forward("item.completed", "reasoning-1", { kind: "reasoning", text: "Reasoning summary.",
          item: { id: "reasoning-1", type: "reasoning", text: "Reasoning summary." } });
        output.send({ id: "opencode-1", method: "item/tool/call", params: { tool: "search_api" } });
        const position = written.findIndex(frame => frame.method === "item/tool/call");
        expect(position).toBeGreaterThanOrEqual(0);
        expect(written.some(frame => frame.method === "item/delta")).toBe(false);
        expect(written.at(position - 1)).toMatchObject({ method: "item/completed", params: { kind: "reasoning" } });
        return position;
      } finally {
        vi.useRealTimers();
      }
    };
    expect(framesBeforeToolCall(1_000)).toBe(framesBeforeToolCall(1));
  });

  it("still forwards streamed assistant text for runnerd's live reply", () => {
    const payload = { kind: "agentMessage", channel: "progress", text: "Checking the plugin.", item: { type: "agentMessage" } };
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1", payload })).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1",
      payload: { kind: "text", text: "Legacy text part." } })).toBe(true);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.delta", turnId: "turn-1",
      payload: { kind: "reasoning", text: "Private reasoning" } })).toBe(false);
    expect(shouldForwardOpenCodeProxyItem({ eventType: "item.completed", turnId: "turn-1",
      payload: { kind: "reasoning", text: "Private reasoning" } })).toBe(true);
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
