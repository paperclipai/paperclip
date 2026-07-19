import { describe, expect, it } from "vitest";
import { MAX_DELEGATION_DEPTH } from "./delegation-origin.js";
import {
  clampToolsByClearance,
  clearanceForMembershipRole,
  clearanceRank,
  decideInvocationClearance,
  effectiveClearance,
  meetsMinRequesterRole,
  normalizeClearanceRole,
  readRunRequester,
  type OriginAuthzContext,
  type RequesterClearanceInput,
} from "./requester-clearance.js";

describe("readRunRequester (NEO-447)", () => {
  it("reads a well-formed requester snapshot", () => {
    expect(
      readRunRequester({
        requester: { userId: "u-1", channelUserId: "cliq-9", channelId: "ch-1", source: "cliq" },
      }),
    ).toEqual({ userId: "u-1", channelUserId: "cliq-9", channelId: "ch-1", source: "cliq" });
  });

  it("returns null for missing/malformed snapshots", () => {
    expect(readRunRequester(null)).toBeNull();
    expect(readRunRequester(undefined)).toBeNull();
    expect(readRunRequester("nope")).toBeNull();
    expect(readRunRequester({})).toBeNull();
    expect(readRunRequester({ requester: "spoof" })).toBeNull();
    expect(readRunRequester({ requester: 42 })).toBeNull();
  });

  it("normalizes empty/non-string ids to null (unresolved, never a truthy principal)", () => {
    expect(readRunRequester({ requester: { userId: "" } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: "   " } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: 123 } })?.userId).toBeNull();
    expect(readRunRequester({ requester: { userId: null } })?.userId).toBeNull();
  });
});

describe("clearanceForMembershipRole (NEO-447)", () => {
  it("maps human membership roles onto the MCP clearance ladder", () => {
    expect(clearanceForMembershipRole("owner")).toBe("board");
    expect(clearanceForMembershipRole("admin")).toBe("board");
    expect(clearanceForMembershipRole("operator")).toBe("member");
    expect(clearanceForMembershipRole("viewer")).toBe("guest");
  });

  it("resolves unknown/absent roles to null (UNRESOLVED — caller floors)", () => {
    expect(clearanceForMembershipRole("superuser")).toBeNull();
    expect(clearanceForMembershipRole("")).toBeNull();
    expect(clearanceForMembershipRole(null)).toBeNull();
    expect(clearanceForMembershipRole(undefined)).toBeNull();
  });
});

// NEO-568 (563a): effective-clearance MIN engine ported from the fork.

const userOrigin = (role: string, depth = 1): OriginAuthzContext => ({
  kind: "user",
  userId: "u-1",
  role,
  depth,
});

const base: RequesterClearanceInput = {
  agentAuthority: "board",
  requestingUserRole: null,
  autonomousAllowed: false,
  invocationSource: "heartbeat",
  origin: null,
};

describe("clearanceRank / normalizeClearanceRole (NEO-568)", () => {
  it("orders guest < member < board and floors unknowns to -1", () => {
    expect(clearanceRank("guest")).toBe(0);
    expect(clearanceRank("member")).toBe(1);
    expect(clearanceRank("board")).toBe(2);
    expect(clearanceRank("superuser")).toBe(-1);
    expect(clearanceRank(null)).toBe(-1);
    expect(clearanceRank(undefined)).toBe(-1);
  });

  it("normalizes only known roles", () => {
    expect(normalizeClearanceRole("member")).toBe("member");
    expect(normalizeClearanceRole("owner")).toBeNull();
    expect(normalizeClearanceRole(null)).toBeNull();
  });
});

describe("effectiveClearance MIN(agent, requester, origin) (NEO-568)", () => {
  it("takes the MIN across agent authority, requester role, and origin role", () => {
    // board agent, member requester, board origin → member
    expect(
      effectiveClearance({ ...base, requestingUserRole: "member", origin: userOrigin("board") }),
    ).toBe("member");
    // board agent, board requester, guest origin → guest (no hop widens past origin)
    expect(
      effectiveClearance({ ...base, requestingUserRole: "board", origin: userOrigin("guest") }),
    ).toBe("guest");
    // member agent caps a board requester
    expect(
      effectiveClearance({ ...base, agentAuthority: "member", requestingUserRole: "board", origin: userOrigin("board") }),
    ).toBe("member");
  });

  it("floors an unmapped rank in the MIN to guest", () => {
    expect(
      effectiveClearance({ ...base, requestingUserRole: "member", origin: userOrigin("superuser") }),
    ).toBe("guest");
  });

  it("fails closed on an unresolved origin", () => {
    expect(
      effectiveClearance({
        ...base,
        requestingUserRole: "board",
        origin: { kind: "unresolved", userId: null, role: null, depth: 2 },
      }),
    ).toBe("guest");
  });

  it("fails closed when the delegation chain exceeds the depth cap", () => {
    expect(
      effectiveClearance({
        ...base,
        requestingUserRole: "board",
        origin: userOrigin("board", MAX_DELEGATION_DEPTH + 1),
      }),
    ).toBe("guest");
    // At the cap it is still allowed to MIN normally.
    expect(
      effectiveClearance({
        ...base,
        requestingUserRole: "board",
        origin: userOrigin("board", MAX_DELEGATION_DEPTH),
      }),
    ).toBe("board");
  });

  describe("autonomous (no human behind the request)", () => {
    it("floors a channel-sourced autonomous request to guest regardless of allowance", () => {
      expect(
        effectiveClearance({ ...base, invocationSource: "channel", autonomousAllowed: true }),
      ).toBe("guest");
    });

    it("grants agent authority only when autonomousAllowed, else guest floor", () => {
      expect(effectiveClearance({ ...base, autonomousAllowed: true, agentAuthority: "board" })).toBe("board");
      expect(effectiveClearance({ ...base, autonomousAllowed: true, agentAuthority: "member" })).toBe("member");
      expect(effectiveClearance({ ...base, autonomousAllowed: false })).toBe("guest");
    });

    it("treats a user origin as non-autonomous even without a direct requester role", () => {
      // requestingUserRole null but origin is a user → MIN(agent, originRole)
      expect(effectiveClearance({ ...base, origin: userOrigin("member") })).toBe("member");
    });
  });
});

describe("meetsMinRequesterRole (NEO-568)", () => {
  it("passes when effective clearance meets or exceeds the required floor", () => {
    expect(meetsMinRequesterRole("member", "member")).toBe(true);
    expect(meetsMinRequesterRole("board", "member")).toBe(true);
    expect(meetsMinRequesterRole("guest", "member")).toBe(false);
  });

  it("fails closed: an unmapped effective clearance never satisfies a real floor", () => {
    expect(meetsMinRequesterRole("superuser", "guest")).toBe(false);
    expect(meetsMinRequesterRole(null, "guest")).toBe(false);
  });
});

describe("clampToolsByClearance — catalog clamp (NEO-447/568)", () => {
  const tools = [
    { name: "read_doc", min: "guest" },
    { name: "post_message", min: "member" },
    { name: "delete_company", min: "board" },
  ];
  const clamp = (effective: string) => clampToolsByClearance(tools, effective, (t) => t.min).map((t) => t.name);

  it("hides tools whose required clearance exceeds the requester's effective clearance", () => {
    expect(clamp("guest")).toEqual(["read_doc"]);
    expect(clamp("member")).toEqual(["read_doc", "post_message"]);
    expect(clamp("board")).toEqual(["read_doc", "post_message", "delete_company"]);
  });

  it("an autonomous guest can only see the guest-gated tool", () => {
    const effective = effectiveClearance({ ...base, autonomousAllowed: false });
    expect(effective).toBe("guest");
    expect(clamp(effective)).toEqual(["read_doc"]);
  });
});

describe("decideInvocationClearance — invocation gate (NEO-448/568)", () => {
  it("allows when effective clearance meets the tool's required role", () => {
    const decision = decideInvocationClearance(
      { ...base, requestingUserRole: "member", origin: userOrigin("member") },
      "member",
    );
    expect(decision).toMatchObject({ allowed: true, effective: "member", requiredRole: "member" });
  });

  it("denies a member-gated tool to an autonomous heartbeat (floored to guest)", () => {
    const decision = decideInvocationClearance({ ...base, autonomousAllowed: false }, "member");
    expect(decision.allowed).toBe(false);
    expect(decision.effective).toBe("guest");
  });

  it("labels the taint ceiling, defaulting an unmapped required role to board (fail closed)", () => {
    expect(decideInvocationClearance(base, "guest").clearanceCeiling).toBe("guest");
    expect(decideInvocationClearance(base, "member").clearanceCeiling).toBe("member");
    expect(decideInvocationClearance(base, "board").clearanceCeiling).toBe("board");
    expect(decideInvocationClearance(base, "mystery").clearanceCeiling).toBe("board");
    expect(decideInvocationClearance(base, "mystery").requiredRole).toBe("board");
  });
});
