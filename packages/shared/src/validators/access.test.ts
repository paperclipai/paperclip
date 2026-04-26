import { describe, expect, it } from "vitest";
import {
  createCompanyInviteSchema,
  acceptInviteSchema,
  listJoinRequestsQuerySchema,
  claimJoinRequestApiKeySchema,
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
} from "./access.js";

describe("createCompanyInviteSchema", () => {
  it("accepts an empty object (all defaults)", () => {
    const result = createCompanyInviteSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults allowedJoinTypes to both", () => {
    const result = createCompanyInviteSchema.safeParse({});
    expect(result.success && result.data.allowedJoinTypes).toBe("both");
  });

  it("accepts valid join types", () => {
    for (const allowedJoinTypes of ["human", "agent", "both"]) {
      expect(createCompanyInviteSchema.safeParse({ allowedJoinTypes }).success).toBe(true);
    }
  });

  it("rejects an invalid join type", () => {
    expect(createCompanyInviteSchema.safeParse({ allowedJoinTypes: "robot" }).success).toBe(false);
  });

  it("accepts optional agentMessage", () => {
    const result = createCompanyInviteSchema.safeParse({
      agentMessage: "Welcome to the team!",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an agentMessage over 4000 characters", () => {
    expect(
      createCompanyInviteSchema.safeParse({ agentMessage: "a".repeat(4001) }).success,
    ).toBe(false);
  });
});

describe("acceptInviteSchema", () => {
  it("accepts a minimal human join request", () => {
    expect(acceptInviteSchema.safeParse({ requestType: "human" }).success).toBe(true);
  });

  it("accepts a minimal agent join request", () => {
    expect(acceptInviteSchema.safeParse({ requestType: "agent" }).success).toBe(true);
  });

  it("rejects an invalid requestType", () => {
    expect(acceptInviteSchema.safeParse({ requestType: "bot" }).success).toBe(false);
  });

  it("accepts agentName with max 120 chars", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", agentName: "a".repeat(120) }).success,
    ).toBe(true);
  });

  it("rejects agentName over 120 chars", () => {
    expect(
      acceptInviteSchema.safeParse({ requestType: "agent", agentName: "a".repeat(121) }).success,
    ).toBe(false);
  });
});

describe("listJoinRequestsQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(listJoinRequestsQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid status values", () => {
    for (const status of ["pending_approval", "approved", "rejected"]) {
      expect(listJoinRequestsQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("rejects an invalid status", () => {
    expect(listJoinRequestsQuerySchema.safeParse({ status: "cancelled" }).success).toBe(false);
  });

  it("accepts valid requestType values", () => {
    for (const requestType of ["human", "agent"]) {
      expect(listJoinRequestsQuerySchema.safeParse({ requestType }).success).toBe(true);
    }
  });
});

describe("claimJoinRequestApiKeySchema", () => {
  it("accepts a valid claim secret (16-256 chars)", () => {
    expect(
      claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(16) }).success,
    ).toBe(true);
  });

  it("rejects a short claim secret", () => {
    expect(
      claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(15) }).success,
    ).toBe(false);
  });

  it("rejects a long claim secret", () => {
    expect(
      claimJoinRequestApiKeySchema.safeParse({ claimSecret: "a".repeat(257) }).success,
    ).toBe(false);
  });
});

describe("createCliAuthChallengeSchema", () => {
  it("accepts a minimal challenge", () => {
    expect(createCliAuthChallengeSchema.safeParse({ command: "login" }).success).toBe(true);
  });

  it("rejects an empty command", () => {
    expect(createCliAuthChallengeSchema.safeParse({ command: "" }).success).toBe(false);
  });

  it("rejects a command over 240 chars", () => {
    expect(
      createCliAuthChallengeSchema.safeParse({ command: "a".repeat(241) }).success,
    ).toBe(false);
  });

  it("defaults requestedAccess to board", () => {
    const result = createCliAuthChallengeSchema.safeParse({ command: "login" });
    expect(result.success && result.data.requestedAccess).toBe("board");
  });

  it("accepts instance_admin_required access level", () => {
    const result = createCliAuthChallengeSchema.safeParse({
      command: "login",
      requestedAccess: "instance_admin_required",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional requestedCompanyId as UUID", () => {
    const result = createCliAuthChallengeSchema.safeParse({
      command: "login",
      requestedCompanyId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });
});

describe("resolveCliAuthChallengeSchema", () => {
  it("accepts a valid token", () => {
    expect(
      resolveCliAuthChallengeSchema.safeParse({ token: "a".repeat(16) }).success,
    ).toBe(true);
  });

  it("rejects a token under 16 characters", () => {
    expect(
      resolveCliAuthChallengeSchema.safeParse({ token: "short" }).success,
    ).toBe(false);
  });
});

describe("updateMemberPermissionsSchema", () => {
  it("accepts an empty grants array", () => {
    expect(updateMemberPermissionsSchema.safeParse({ grants: [] }).success).toBe(true);
  });

  it("accepts valid permission keys", () => {
    const result = updateMemberPermissionsSchema.safeParse({
      grants: [
        { permissionKey: "agents:create" },
        { permissionKey: "users:invite" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid permission key", () => {
    const result = updateMemberPermissionsSchema.safeParse({
      grants: [{ permissionKey: "superuser" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("updateUserCompanyAccessSchema", () => {
  it("accepts an empty companyIds array (default)", () => {
    const result = updateUserCompanyAccessSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.companyIds).toEqual([]);
  });

  it("accepts valid UUID company IDs", () => {
    const result = updateUserCompanyAccessSchema.safeParse({
      companyIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid company IDs", () => {
    expect(
      updateUserCompanyAccessSchema.safeParse({ companyIds: ["not-uuid"] }).success,
    ).toBe(false);
  });
});
