import { describe, expect, it, vi } from "vitest";
import { accessService } from "../services/access.js";

describe("services/access.ts", () => {
  it("returns false for canUser when no userId is provided", async () => {
    const service = accessService({} as any);
    await expect(service.canUser("cmp-1", null, "agent.create")).resolves.toBe(false);
  });

  it("exposes access service methods", () => {
    const service = accessService({} as any);
    expect(service).toMatchObject({
      canUser: expect.any(Function),
      hasPermission: expect.any(Function),
      ensureMembership: expect.any(Function),
      setPrincipalPermission: expect.any(Function),
    });
  });

  it("returns false when membership is missing or inactive for hasPermission", async () => {
    const selectWhere = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "m-1",
          companyId: "cmp-1",
          principalType: "user",
          principalId: "user-1",
          status: "suspended",
        },
      ]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: selectWhere })),
      })),
    };
    const service = accessService(db as any);

    await expect(service.hasPermission("cmp-1", "user", "user-1", "agent.create")).resolves.toBe(false);
  });

  it("creates membership when ensureMembership finds no existing record", async () => {
    const selectWhere = vi.fn().mockResolvedValueOnce([]);
    const insertReturning = vi.fn().mockResolvedValue([
      {
        id: "membership-1",
        companyId: "cmp-1",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "operator",
      },
    ]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: selectWhere })),
      })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const service = accessService(db as any);

    const member = await service.ensureMembership("cmp-1", "user", "user-1", "operator", "active");
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(member).toMatchObject({
      companyId: "cmp-1",
      principalType: "user",
      principalId: "user-1",
      status: "active",
    });
  });

  it("deletes a principal grant when setPrincipalPermission disables it", async () => {
    const deleteWhere = vi.fn().mockResolvedValue([]);
    const db = {
      delete: vi.fn(() => ({ where: deleteWhere })),
    };
    const service = accessService(db as any);

    await service.setPrincipalPermission(
      "cmp-1",
      "user",
      "user-1",
      "agent.create",
      false,
      "board-user",
    );

    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

