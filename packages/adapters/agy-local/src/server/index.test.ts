import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("agy session codec", () => {
  it("round-trips conversation id and cwd", () => {
    const saved = sessionCodec.serialize({ sessionId: "abc", cwd: "/work" });
    expect(saved).toEqual({ sessionId: "abc", cwd: "/work" });
    expect(sessionCodec.deserialize(saved)).toEqual({ sessionId: "abc", cwd: "/work" });
  });

  it("accepts conversation_id aliases and rejects empty sessions", () => {
    expect(sessionCodec.deserialize({ conversation_id: "xyz" })).toEqual({ sessionId: "xyz" });
    expect(sessionCodec.deserialize({})).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });

  it("exposes the display id", () => {
    expect(sessionCodec.getDisplayId?.({ sessionId: "abc" })).toBe("abc");
  });
});
