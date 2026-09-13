import { describe, expect, it, vi } from "vitest";
import {
  boardApiKeys,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  type Db,
} from "@paperclipai/db";
import { BOARD_API_KEY_SCOPE_PRESETS } from "@paperclipai/shared";
import { grantsForHumanRole } from "./company-member-roles.js";
import { boardAuthService } from "./board-auth.js";

describe("boardAuthService touchBoardApiKey", () => {
  it("retries the audit write after a transient failure", async () => {
    const writes = [
      Promise.reject(new Error("transient")),
      Promise.resolve([{ id: "key-1" }]),
    ];
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => writes.shift(),
        }),
      }),
    }));
    const service = boardAuthService({ update } as unknown as Db);

    await expect(service.touchBoardApiKey("key-1")).rejects.toThrow("transient");
    await expect(service.touchBoardApiKey("key-1")).resolves.toEqual({ id: "key-1" });

    expect(update).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight audit write across concurrent touches", async () => {
    let releaseWrite: (() => void) | undefined;
    const write = new Promise<Array<{ id: string }>>((resolve) => {
      releaseWrite = () => resolve([{ id: "key-1" }]);
    });
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => write,
        }),
      }),
    }));
    const service = boardAuthService({ update } as unknown as Db);

    const first = service.touchBoardApiKey("key-1");
    const second = service.touchBoardApiKey("key-1");
    releaseWrite?.();
    await Promise.all([first, second]);

    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("boardAuthService createNamedBoardApiKey", () => {
  const companyId = "00000000-0000-4000-8000-000000000001";
  const userId = "user-1";

  function creationDb(options: {
    instanceAdmin?: boolean;
    membershipRole?: "viewer" | "operator" | "admin" | "owner";
    grants?: string[];
  }) {
    const insert = vi.fn((table: unknown) => {
      expect(table).toBe(boardApiKeys);
      return {
        values: () => ({
          returning: () => Promise.resolve([{
            id: "key-1",
            name: "automation",
            tokenPrefix: "pcp_board_prefix",
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
          }]),
        }),
      };
    });
    const select = vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === instanceUserRoles) {
            return Promise.resolve(options.instanceAdmin ? [{ id: "admin-role" }] : []);
          }
          if (table === companyMemberships) {
            return Promise.resolve(options.membershipRole
              ? [{ companyId, membershipRole: options.membershipRole }]
              : []);
          }
          if (table === principalPermissionGrants) {
            return Promise.resolve((options.grants ?? []).map((permissionKey) => ({
              companyId,
              permissionKey,
            })));
          }
          throw new Error("Unexpected authority table");
        },
      }),
    }));
    return { db: { select, insert } as unknown as Db, insert };
  }

  it("rejects an instance-admin capability for a non-admin owner", async () => {
    const { db, insert } = creationDb({ membershipRole: "operator" });
    const service = boardAuthService(db);

    await expect(service.createNamedBoardApiKey({
      userId,
      name: "automation",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [companyId],
        permissions: ["companies:read"],
        instanceCapabilities: ["instance_admin"],
      },
    })).rejects.toMatchObject({ status: 403 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects permissions outside the owner's live granular grants", async () => {
    const { db, insert } = creationDb({
      membershipRole: "operator",
      grants: ["agents:create"],
    });
    const service = boardAuthService(db);

    await expect(service.createNamedBoardApiKey({
      userId,
      name: "automation",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [companyId],
        permissions: ["agents:write"],
        instanceCapabilities: [],
      },
    })).rejects.toMatchObject({ status: 403 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects administrative membership permissions for an operator", async () => {
    const { db, insert } = creationDb({
      membershipRole: "operator",
      grants: ["tasks:assign"],
    });
    const service = boardAuthService(db);

    await expect(service.createNamedBoardApiKey({
      userId,
      name: "automation",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [companyId],
        permissions: ["secrets:manage"],
        instanceCapabilities: [],
      },
    })).rejects.toMatchObject({ status: 403 });
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts the recommended company-automation preset for a default owner", async () => {
    const { db, insert } = creationDb({
      membershipRole: "owner",
      grants: grantsForHumanRole("owner").map((grant) => grant.permissionKey),
    });
    const service = boardAuthService(db);

    await expect(service.createNamedBoardApiKey({
      userId,
      name: "automation",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [companyId],
        permissions: [...BOARD_API_KEY_SCOPE_PRESETS.company_automation.permissions],
        instanceCapabilities: [],
      },
    })).resolves.toMatchObject({ id: "key-1" });
    expect(insert).toHaveBeenCalledOnce();
  });

  it("accepts the recommended company-automation preset for a default admin", async () => {
    const { db, insert } = creationDb({
      membershipRole: "admin",
      grants: grantsForHumanRole("admin").map((grant) => grant.permissionKey),
    });
    const service = boardAuthService(db);

    await expect(service.createNamedBoardApiKey({
      userId,
      name: "automation",
      scopeConfig: {
        version: 1,
        kind: "scoped",
        companyIds: [companyId],
        permissions: [...BOARD_API_KEY_SCOPE_PRESETS.company_automation.permissions],
        instanceCapabilities: [],
      },
    })).resolves.toMatchObject({ id: "key-1" });
    expect(insert).toHaveBeenCalledOnce();
  });
});
