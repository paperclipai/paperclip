import { describe, expect, it } from "vitest";
import { normalizeAgentskySession, sessionCodec } from "./session.js";

describe("agentsky_cloud session codec", () => {
  it("round-trips a full session", () => {
    const params = {
      agentSlug: "slug-1",
      sessionId: "sess-1",
      harness: "claude_code",
      model: "claude-opus-5",
      apiBaseUrl: "https://staging.agentsky.dev",
      lastEventCursor: "c42",
      attached: true,
    };
    const serialized = sessionCodec.serialize(params);
    expect(serialized).toEqual(params);
    expect(sessionCodec.deserialize(serialized)).toEqual(params);
  });

  it("drops optional fields that are empty and defaults harness/model to empty strings", () => {
    const normalized = normalizeAgentskySession({
      agentSlug: " slug-1 ",
      sessionId: "sess-1",
      apiBaseUrl: "",
      lastEventCursor: "  ",
      attached: false,
    });
    expect(normalized).toEqual({
      agentSlug: "slug-1",
      sessionId: "sess-1",
      harness: "",
      model: "",
    });
  });

  it("rejects params without a session id or agent slug", () => {
    expect(sessionCodec.deserialize({ agentSlug: "slug-1" })).toBeNull();
    expect(sessionCodec.deserialize({ sessionId: "sess-1" })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.deserialize("sess-1")).toBeNull();
  });

  it("uses the session id as the display id", () => {
    expect(
      sessionCodec.getDisplayId?.({
        agentSlug: "slug-1",
        sessionId: "sess-1",
        harness: "hermes",
        model: "deepseek-v4-pro",
      }),
    ).toBe("sess-1");
    expect(sessionCodec.getDisplayId?.(null)).toBeNull();
  });
});
