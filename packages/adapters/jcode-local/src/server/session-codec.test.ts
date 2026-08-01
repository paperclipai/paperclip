import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("jcode sessionCodec", () => {
  it("normalizes session params with cwd", () => {
    const parsed = sessionCodec.deserialize({
      session_id: "jcode-session-1",
      folder: "/tmp/jcode",
      remoteExecution: {
        transport: "sandbox",
        remoteCwd: "/remote/jcode",
      },
    });

    expect(parsed).toEqual({
      sessionId: "jcode-session-1",
      cwd: "/tmp/jcode",
      remoteExecution: {
        transport: "sandbox",
        remoteCwd: "/remote/jcode",
      },
    });
    expect(sessionCodec.serialize(parsed)).toEqual({
      sessionId: "jcode-session-1",
      cwd: "/tmp/jcode",
      remoteExecution: {
        transport: "sandbox",
        remoteCwd: "/remote/jcode",
      },
    });
    expect(sessionCodec.getDisplayId?.(parsed)).toBe("jcode-session-1");
  });

  it("rejects params without a session id", () => {
    expect(sessionCodec.deserialize({ cwd: "/tmp/jcode" })).toBeNull();
    expect(sessionCodec.serialize({ cwd: "/tmp/jcode" })).toBeNull();
  });
});
