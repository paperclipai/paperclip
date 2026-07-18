import { describe, expect, it } from "vitest";
import {
  MAX_DELEGATION_DEPTH,
  autonomousOrigin,
  effectiveOriginClearance,
  originFromPriorRun,
  propagateOrigin,
  readRunOrigin,
  seedOriginFromRequester,
  unresolvedOrigin,
} from "./delegation-origin.js";

describe("NEO-448 Phase 3: delegation origin snapshot", () => {
  describe("readRunOrigin", () => {
    it("returns null when contextSnapshot has no origin (pre-Phase-3 run)", () => {
      expect(readRunOrigin(null)).toBeNull();
      expect(readRunOrigin({})).toBeNull();
      expect(readRunOrigin({ origin: null })).toBeNull();
    });

    it("reads a valid user origin verbatim", () => {
      const origin = readRunOrigin({
        origin: { kind: "user", userId: "user-1", clearance: "member", depth: 2 },
      });
      expect(origin).toEqual({ kind: "user", userId: "user-1", clearance: "member", depth: 2 });
    });

    it("reads an autonomous origin", () => {
      expect(readRunOrigin({ origin: { kind: "autonomous", depth: 1 } })).toEqual({
        kind: "autonomous",
        userId: null,
        clearance: null,
        depth: 1,
      });
    });

    it("fails closed to unresolved on malformed origins", () => {
      expect(readRunOrigin({ origin: "board" })?.kind).toBe("unresolved");
      expect(readRunOrigin({ origin: { kind: "user", userId: "", depth: 0 } })?.kind).toBe("unresolved");
      expect(readRunOrigin({ origin: { kind: "root", depth: 0 } })?.kind).toBe("unresolved");
    });

    it("fails closed past the depth cap on a non-numeric/negative depth", () => {
      const origin = readRunOrigin({ origin: { kind: "user", userId: "u", depth: -1 } });
      expect(origin?.kind).toBe("unresolved");
      expect(origin!.depth).toBeGreaterThan(MAX_DELEGATION_DEPTH);
    });

    it("drops an unknown clearance stamp to null (PEP re-derives fresh)", () => {
      const origin = readRunOrigin({
        origin: { kind: "user", userId: "u", clearance: "root", depth: 0 },
      });
      expect(origin).toEqual({ kind: "user", userId: "u", clearance: null, depth: 0 });
    });
  });

  describe("seed + propagate", () => {
    it("seeds a user origin at depth 0", () => {
      expect(seedOriginFromRequester({ userId: "user-1", clearance: "guest" })).toEqual({
        kind: "user",
        userId: "user-1",
        clearance: "guest",
        depth: 0,
      });
    });

    it("seeds unresolved when the channel sender is unmapped", () => {
      expect(seedOriginFromRequester({ userId: null, clearance: null }).kind).toBe("unresolved");
    });

    it("copies verbatim on same-agent continuation (no depth increment)", () => {
      const seed = seedOriginFromRequester({ userId: "u", clearance: "member" });
      expect(propagateOrigin(seed, { hop: false })).toEqual(seed);
    });

    it("increments depth on a cross-agent hop, identity immutable", () => {
      const seed = seedOriginFromRequester({ userId: "u", clearance: "guest" });
      const hop1 = propagateOrigin(seed, { hop: true });
      expect(hop1).toEqual({ kind: "user", userId: "u", clearance: "guest", depth: 1 });
    });

    it("caps stored depth just past MAX_DELEGATION_DEPTH", () => {
      let origin = seedOriginFromRequester({ userId: "u", clearance: "board" });
      for (let i = 0; i < MAX_DELEGATION_DEPTH + 10; i++) {
        origin = propagateOrigin(origin, { hop: true });
      }
      expect(origin.depth).toBe(MAX_DELEGATION_DEPTH + 1);
      expect(origin.userId).toBe("u");
    });
  });

  describe("originFromPriorRun", () => {
    it("prefers an explicit origin stamp", () => {
      const prior = {
        contextSnapshot: {
          origin: { kind: "user", userId: "seed-user", clearance: "guest", depth: 1 },
          requester: { userId: "other-user" },
        },
      };
      expect(originFromPriorRun(prior)?.userId).toBe("seed-user");
    });

    it("seeds from the prior run's requester when no stamp exists (pre-Phase-3 rows)", () => {
      const prior = { contextSnapshot: { requester: { userId: "req-user" } } };
      expect(originFromPriorRun(prior)).toEqual({
        kind: "user",
        userId: "req-user",
        clearance: null,
        depth: 0,
      });
    });

    it("falls back to unresolved for a requester without userId (unmapped channel sender)", () => {
      const prior = { contextSnapshot: { requester: { channelUserId: "cliq-123" } } };
      expect(originFromPriorRun(prior)?.kind).toBe("unresolved");
    });

    it("treats a run with neither origin nor requester as autonomous", () => {
      expect(originFromPriorRun({ contextSnapshot: { wakeReason: "timer" } })).toEqual(
        autonomousOrigin(),
      );
    });
  });

  describe("effectiveOriginClearance (MIN of stamp and fresh)", () => {
    it("a revoked membership dominates to null (fail closed)", () => {
      expect(effectiveOriginClearance("board", null)).toBeNull();
    });
    it("a missing seed stamp defers to fresh", () => {
      expect(effectiveOriginClearance(null, "member")).toBe("member");
    });
    it("a post-seed promotion never widens the chain", () => {
      expect(effectiveOriginClearance("guest", "board")).toBe("guest");
    });
    it("a post-seed demotion takes effect immediately", () => {
      expect(effectiveOriginClearance("board", "member")).toBe("member");
    });
  });

  describe("unresolvedOrigin", () => {
    it("clamps depth into the observable range", () => {
      expect(unresolvedOrigin(-5).depth).toBe(0);
      expect(unresolvedOrigin(1000).depth).toBe(MAX_DELEGATION_DEPTH + 1);
    });
  });
});
