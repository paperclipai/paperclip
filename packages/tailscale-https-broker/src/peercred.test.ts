import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { PeerResolutionError, createPeerResolver } from "./peercred.js";

const socket = {} as Socket;

describe("createPeerResolver", () => {
  it("returns the actual native identity for admission before authorization", () => {
    const resolve = createPeerResolver({
      soPeercred: () => ({ uid: 1000, gid: 987, pid: 42 }),
    });

    expect(resolve(socket)).toEqual({ uid: 1000, gid: 987, pid: 42 });
  });

  it("fails closed when native credentials are unavailable", () => {
    const resolve = createPeerResolver({ soPeercred: () => null });

    expect(() => resolve(socket)).toThrow(PeerResolutionError);
  });

  it("fails closed on malformed native credentials", () => {
    const resolve = createPeerResolver({
      soPeercred: () => ({ uid: Number.NaN, gid: 987, pid: 42 }),
    });

    expect(() => resolve(socket)).toThrow(/invalid/);
  });
});
