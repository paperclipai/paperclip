import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("muse_local session codec", () => {
  it("keeps the remote execution identity so remote sessions can resume", () => {
    const params = { sessionId: "s-1", cwd: "/remote/ws", remoteExecution: { kind: "remote", transport: "ssh", host: "h" } };
    expect(sessionCodec.serialize(params)).toMatchObject({ sessionId: "s-1", cwd: "/remote/ws", remoteExecution: { kind: "remote", transport: "ssh", host: "h" } });
    expect(sessionCodec.deserialize(params)).toMatchObject({ remoteExecution: { kind: "remote", transport: "ssh", host: "h" } });
  });

  it("omits the identity for local sessions", () => {
    expect(sessionCodec.serialize({ sessionId: "s-1", cwd: "/ws" })).not.toHaveProperty("remoteExecution");
  });
});
