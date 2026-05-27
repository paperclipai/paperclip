import { describe, it, expect, vi } from "vitest";
import {
  parseIdTokenGroups,
  reconcileMicrosoftUser,
  loadMicrosoftRbacConfig,
} from "../auth/microsoft-rbac.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("parseIdTokenGroups", () => {
  it("extracts a string[] groups claim", () => {
    const idToken = makeJwt({
      sub: "u1",
      groups: ["980aeb78-a886-4dae-98bb-7a9893d20706", "675cb5f3-4a94-4514-96d8-9899587b19ed"],
    });
    expect(parseIdTokenGroups(idToken)).toEqual([
      "980aeb78-a886-4dae-98bb-7a9893d20706",
      "675cb5f3-4a94-4514-96d8-9899587b19ed",
    ]);
  });

  it("returns [] for a token with no groups claim", () => {
    const idToken = makeJwt({ sub: "u1", email: "a@b.com" });
    expect(parseIdTokenGroups(idToken)).toEqual([]);
  });

  it("returns [] for a token with a non-array groups claim (overage indicator)", () => {
    // When a user is in >200 groups, Entra returns `_claim_names` instead of
    // an inline array. We treat that as "no groups" here — the daily Graph
    // reconciler is responsible for over-200 cases.
    const idToken = makeJwt({ sub: "u1", _claim_names: { groups: "src1" } });
    expect(parseIdTokenGroups(idToken)).toEqual([]);
  });

  it("returns [] for malformed tokens (no panic)", () => {
    expect(parseIdTokenGroups(null)).toEqual([]);
    expect(parseIdTokenGroups("")).toEqual([]);
    expect(parseIdTokenGroups("not.a.jwt.atall")).toEqual([]);
    expect(parseIdTokenGroups("header.bm90LWpzb24.sig")).toEqual([]);
  });

  it("filters non-string entries out of the groups array", () => {
    const idToken = makeJwt({ groups: ["980aeb78", 123, null, "675cb5f3"] });
    expect(parseIdTokenGroups(idToken)).toEqual(["980aeb78", "675cb5f3"]);
  });
});

describe("loadMicrosoftRbacConfig", () => {
  it("falls back to production defaults when env vars are unset", () => {
    const saved = {
      a: process.env.MICROSOFT_BLOCKCAST_COMPANY_ID,
      b: process.env.MICROSOFT_SSH_USERS_GROUP_ID,
      c: process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID,
    };
    delete process.env.MICROSOFT_BLOCKCAST_COMPANY_ID;
    delete process.env.MICROSOFT_SSH_USERS_GROUP_ID;
    delete process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID;
    try {
      const cfg = loadMicrosoftRbacConfig();
      expect(cfg.blockcastCompanyId).toBe("aaced805-3491-4ee5-9b14-cdf70cb81d47");
      expect(cfg.sshUsersGroupId).toBe("980aeb78-a886-4dae-98bb-7a9893d20706");
      expect(cfg.adminAgentsGroupId).toBe("675cb5f3-4a94-4514-96d8-9899587b19ed");
    } finally {
      if (saved.a !== undefined) process.env.MICROSOFT_BLOCKCAST_COMPANY_ID = saved.a;
      if (saved.b !== undefined) process.env.MICROSOFT_SSH_USERS_GROUP_ID = saved.b;
      if (saved.c !== undefined) process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID = saved.c;
    }
  });

  it("honors env overrides for staging tenants", () => {
    process.env.MICROSOFT_BLOCKCAST_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
    process.env.MICROSOFT_SSH_USERS_GROUP_ID = "00000000-0000-0000-0000-000000000002";
    process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID = "00000000-0000-0000-0000-000000000003";
    try {
      const cfg = loadMicrosoftRbacConfig();
      expect(cfg.blockcastCompanyId).toBe("00000000-0000-0000-0000-000000000001");
      expect(cfg.sshUsersGroupId).toBe("00000000-0000-0000-0000-000000000002");
      expect(cfg.adminAgentsGroupId).toBe("00000000-0000-0000-0000-000000000003");
    } finally {
      delete process.env.MICROSOFT_BLOCKCAST_COMPANY_ID;
      delete process.env.MICROSOFT_SSH_USERS_GROUP_ID;
      delete process.env.MICROSOFT_ADMIN_AGENTS_GROUP_ID;
    }
  });
});

describe("reconcileMicrosoftUser (mocked db)", () => {
  function makeDb() {
    // Track inserts and existing rows via a simple in-memory store. The
    // shape mirrors what drizzle's chained API expects: select().from().
    // where().limit(); insert().values(); update().set().where().
    const store = {
      memberships: [] as Array<{ id: string; companyId: string; principalType: string; principalId: string; status: string; membershipRole: string | null }>,
      approvals: [] as Array<{ id: string; companyId: string; type: string; requestedByUserId: string; status: string; payload: Record<string, unknown> }>,
    };
    const db = {
      select: vi.fn().mockImplementation((_cols: any) => ({
        from: (table: any) => ({
          where: (_clause: any) => ({
            limit: (_n: number) => {
              if (table?._?.name === "company_memberships" || table === "company_memberships") {
                const m = store.memberships[0];
                return m ? [{ id: m.id, status: m.status }] : [];
              }
              if (table?._?.name === "approvals" || table === "approvals") {
                const a = store.approvals[0];
                return a ? [{ id: a.id }] : [];
              }
              return [];
            },
          }),
        }),
      })),
      insert: vi.fn().mockImplementation((table: any) => ({
        values: vi.fn().mockImplementation(async (row: any) => {
          const id = `id-${(store.memberships.length + store.approvals.length + 1)}`;
          if (table?._?.name === "company_memberships" || table === "company_memberships") {
            store.memberships.push({ id, ...row });
          } else if (table?._?.name === "approvals" || table === "approvals") {
            store.approvals.push({ id, ...row });
          }
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      })),
      _store: store,
    } as any;
    // Wire table names. The real drizzle objects expose their pg table name
    // via Symbol/`._`. We approximate by attaching a `.tableName` for the
    // imported tokens so the mock's `from` recognition works without a
    // schema graph.
    return db;
  }

  const cfg = {
    blockcastCompanyId: "co-blockcast",
    sshUsersGroupId: "g-ssh",
    adminAgentsGroupId: "g-admin",
  };

  it("inserts a new operator membership when user is in ssh-users", async () => {
    const db = makeDb();
    // Make the mock recognize the table identity by short-circuiting select to
    // always return empty (the membership doesn't exist yet).
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(true);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("does not re-insert when the operator membership already exists and is active", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => [{ id: "existing", status: "active" }],
        }),
      }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("re-activates an archived membership when user re-appears in ssh-users", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => [{ id: "existing", status: "archived" }],
        }),
      }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-ssh"], cfg);
    expect(result.addedMembership).toBe(true);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("creates a pending approval (not a grant) when user is in AdminAgents", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-admin"], cfg);
    expect(result.pendingAdminElevation).toBe(true);
    expect(result.addedMembership).toBe(false);
  });

  it("does not create a duplicate approval when one is already pending", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: () => [{ id: "existing-approval" }] }),
      }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-admin"], cfg);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("no-ops for a user in unrelated groups", async () => {
    const db = makeDb();
    db.select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => [] }) }),
    }));
    const result = await reconcileMicrosoftUser(db, "user-1", ["g-other"], cfg);
    expect(result.addedMembership).toBe(false);
    expect(result.pendingAdminElevation).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
