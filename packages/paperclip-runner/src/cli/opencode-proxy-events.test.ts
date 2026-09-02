import { describe, expect, it } from "vitest";

import {
  shouldAnnounceOpenCodeProxyTurn,
  shouldForwardOpenCodeProxyItem,
} from "./opencode-proxy-events.js";

describe("OpenCode runnerd proxy event boundary", () => {
  it("drops only the duplicate session-scoped model item", () => {
    expect(
      shouldForwardOpenCodeProxyItem({ kind: "model" }),
    ).toBe(false);
    expect(
      shouldForwardOpenCodeProxyItem({
        turnId: "turn-1",
        kind: "model",
      }),
    ).toBe(true);
    expect(
      shouldForwardOpenCodeProxyItem({ kind: "agentMessage" }),
    ).toBe(true);
  });

  it("announces one outer turn when SSE wins the response race", () => {
    const announced = new Set<string>();
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(true);
    expect(shouldAnnounceOpenCodeProxyTurn(announced, "turn-1")).toBe(false);
    expect([...announced]).toEqual(["turn-1"]);
  });
});
