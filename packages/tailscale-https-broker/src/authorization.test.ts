import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  authorizePeer,
  authorizeRemoval,
  generateLeaseHandle,
  handlesEqual,
} from "./authorization.js";
import type { LeaseRecord } from "./types.js";

const policy = {
  allowedUids: new Set([999]),
  allowedGids: new Set([987]),
};

describe("authorizePeer (complete mediation)", () => {
  it("accepts the exact allowlisted identity", () => {
    expect(() => authorizePeer({ uid: 999, gid: 987, pid: 1 }, policy)).not.toThrow();
  });

  it("rejects wrong uid, wrong gid, and missing creds", () => {
    expect(() => authorizePeer({ uid: 1000, gid: 987, pid: 1 }, policy)).toThrow(AuthorizationError);
    expect(() => authorizePeer({ uid: 999, gid: 100, pid: 1 }, policy)).toThrow(/gid/);
    expect(() => authorizePeer({ uid: Number.NaN, gid: 987, pid: 1 }, policy)).toThrow();
  });
});

describe("lease handles", () => {
  it("generates unguessable, distinct, url-safe handles", () => {
    const a = generateLeaseHandle();
    const b = generateLeaseHandle();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(handlesEqual(a, a)).toBe(true);
    expect(handlesEqual(a, b)).toBe(false);
  });
});

describe("authorizeRemoval (ownership binding)", () => {
  const lease: LeaseRecord = {
    handle: "handle-aaaaaaaaaaaaaaaa",
    runtimeId: "2af79bb1-ecc5-4410-8438-091be135a921",
    peerUid: 999,
    peerGid: 987,
    ports: [42010, 52010],
    purposes: ["app", "vite_hmr"],
    state: "exposed",
    generation: 1,
    createdAtIso: "2026-08-11T00:00:00.000Z",
    expiresAtIso: null,
  };
  const peer = { uid: 999, gid: 987, pid: 42 };

  it("authorizes an exact handle + runtime + peer match", () => {
    expect(authorizeRemoval([lease], { runtimeId: lease.runtimeId, handle: lease.handle }, peer)).toBe(lease);
  });

  it("rejects random/stale handles", () => {
    expect(() =>
      authorizeRemoval([lease], { runtimeId: lease.runtimeId, handle: "random-handle-xxxxxx" }, peer),
    ).toThrow(/invalid_handle|stale/);
  });

  it("rejects runtime A removing runtime B's lease", () => {
    expect(() =>
      authorizeRemoval([lease], { runtimeId: "00000000-0000-0000-0000-000000000000", handle: lease.handle }, peer),
    ).toThrow(/runtime/);
  });

  it("rejects a wrong peer identity even with the right handle", () => {
    expect(() =>
      authorizeRemoval([lease], { runtimeId: lease.runtimeId, handle: lease.handle }, { uid: 1000, gid: 987, pid: 7 }),
    ).toThrow(/peer/);
  });
});
