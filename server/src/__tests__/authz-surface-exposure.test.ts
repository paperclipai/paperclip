import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { assertSurfaceExposed } from "../routes/authz.js";
import { HttpError } from "../errors.js";

function reqWithActor(actor: Record<string, unknown>): Request {
  return { actor } as unknown as Request;
}

const exposedNone = vi.fn(async () => [] as const);
const exposedMembers = async () => ["company.members"] as const;

describe("assertSurfaceExposed", () => {
  it("bypasses local_trusted implicit actors without reading the policy", async () => {
    exposedNone.mockClear();
    await assertSurfaceExposed(
      reqWithActor({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true }),
      "company.secrets",
      exposedNone,
    );
    expect(exposedNone).not.toHaveBeenCalled();
  });

  it("bypasses instance admins without reading the policy", async () => {
    exposedNone.mockClear();
    await assertSurfaceExposed(
      reqWithActor({ type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true }),
      "company.secrets",
      exposedNone,
    );
    expect(exposedNone).not.toHaveBeenCalled();
  });

  it("bypasses agent actors (agent access is governed by agent scopes)", async () => {
    await expect(
      assertSurfaceExposed(
        reqWithActor({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" }),
        "company.secrets",
        async () => [],
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["owner", "admin", "operator", "viewer"] as const)(
    "allows a %s member on an exposed surface",
    async (membershipRole) => {
      await expect(
        assertSurfaceExposed(
          reqWithActor({
            type: "board",
            userId: "user-1",
            source: "session",
            isInstanceAdmin: false,
            companyIds: ["company-1"],
            memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
          }),
          "company.members",
          exposedMembers,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["owner", "admin", "operator", "viewer"] as const)(
    "rejects a %s member on a hidden surface with a typed 403",
    async (membershipRole) => {
      const attempt = assertSurfaceExposed(
        reqWithActor({
          type: "board",
          userId: "user-1",
          source: "session",
          isInstanceAdmin: false,
          companyIds: ["company-1"],
          memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
        }),
        "company.secrets",
        exposedMembers,
      );
      await expect(attempt).rejects.toMatchObject({
        status: 403,
        details: { code: "surface_not_exposed", surface: "company.secrets" },
      });
      await expect(attempt).rejects.toBeInstanceOf(HttpError);
    },
  );

  it("rejects unauthenticated actors on a hidden surface", async () => {
    await expect(
      assertSurfaceExposed(reqWithActor({ type: "none", source: "none" }), "company.invites", async () => []),
    ).rejects.toMatchObject({ status: 403 });
  });
});
