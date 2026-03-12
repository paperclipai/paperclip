import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { accessService } from "../../services/access.js";
import { companies, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

describe("accessService", () => {
  let testDb: TestDb;
  let svc: ReturnType<typeof accessService>;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    svc = accessService(testDb.db);
  });

  async function seedCompany(name = "Test Co") {
    const [row] = await testDb.db
      .insert(companies)
      .values({ name, issuePrefix: `T${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    return row;
  }

  // ── ensureMembership ──────────────────────────────────────────────────

  describe("ensureMembership", () => {
    it("creates a new membership with default role 'contributor'", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId);
      expect(m).toBeDefined();
      expect(m!.companyId).toBe(co.id);
      expect(m!.principalType).toBe("user");
      expect(m!.principalId).toBe(userId);
      expect(m!.membershipRole).toBe("contributor");
      expect(m!.status).toBe("active");
    });

    it("returns existing membership when called again", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const first = await svc.ensureMembership(co.id, "user", userId);
      const second = await svc.ensureMembership(co.id, "user", userId);
      expect(second!.id).toBe(first!.id);
    });

    it("updates role/status if they differ", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId, "contributor", "active");
      const updated = await svc.ensureMembership(co.id, "user", userId, "admin", "active");
      expect(updated!.membershipRole).toBe("admin");
    });
  });

  // ── getMembership ─────────────────────────────────────────────────────

  describe("getMembership", () => {
    it("returns membership when found", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      const m = await svc.getMembership(co.id, "user", userId);
      expect(m).not.toBeNull();
      expect(m!.principalId).toBe(userId);
    });

    it("returns null when not found", async () => {
      const co = await seedCompany();
      const m = await svc.getMembership(co.id, "user", randomUUID());
      expect(m).toBeNull();
    });
  });

  // ── listMembers ───────────────────────────────────────────────────────

  describe("listMembers", () => {
    it("lists all members for a company", async () => {
      const co = await seedCompany();
      await svc.ensureMembership(co.id, "user", randomUUID());
      await svc.ensureMembership(co.id, "user", randomUUID());
      const members = await svc.listMembers(co.id);
      expect(members.length).toBe(2);
    });
  });

  // ── hasPermission ─────────────────────────────────────────────────────

  describe("hasPermission", () => {
    it("returns granted:true with scope when grant exists", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(co.id, "user", userId, [{ permissionKey: "agents:create" }], null);
      const result = await svc.hasPermission(co.id, "user", userId, "agents:create");
      expect(result.granted).toBe(true);
    });

    it("returns granted:false when no grant exists", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      const result = await svc.hasPermission(co.id, "user", userId, "agents:create");
      expect(result.granted).toBe(false);
      expect(result.scope).toBeNull();
    });

    it("negative: returns granted:false when member is suspended", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(co.id, "user", userId, [{ permissionKey: "agents:create" }], null);
      await svc.suspendMember(co.id, m!.id, randomUUID());
      const result = await svc.hasPermission(co.id, "user", userId, "agents:create");
      expect(result.granted).toBe(false);
    });
  });

  // ── canModifyMember ───────────────────────────────────────────────────

  describe("canModifyMember", () => {
    it("owner can modify admin", () => {
      expect(svc.canModifyMember("owner", "admin")).toBe(true);
    });

    it("admin can modify contributor", () => {
      expect(svc.canModifyMember("admin", "contributor")).toBe(true);
    });

    it("negative: same-rank returns false", () => {
      expect(svc.canModifyMember("admin", "admin")).toBe(false);
    });

    it("negative: lower rank cannot modify higher rank", () => {
      expect(svc.canModifyMember("contributor", "admin")).toBe(false);
    });

    it("negative: null role returns false", () => {
      expect(svc.canModifyMember(null, "admin")).toBe(false);
      expect(svc.canModifyMember("admin", null)).toBe(false);
    });
  });

  // ── setPrincipalGrants ────────────────────────────────────────────────

  describe("setPrincipalGrants", () => {
    it("sets grants for a principal", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(
        co.id,
        "user",
        userId,
        [{ permissionKey: "agents:create" }, { permissionKey: "users:invite" }],
        null,
      );
      const r1 = await svc.hasPermission(co.id, "user", userId, "agents:create");
      const r2 = await svc.hasPermission(co.id, "user", userId, "users:invite");
      expect(r1.granted).toBe(true);
      expect(r2.granted).toBe(true);
    });

    it("overwrites on re-call", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(
        co.id,
        "user",
        userId,
        [{ permissionKey: "agents:create" }, { permissionKey: "users:invite" }],
        null,
      );
      await svc.setPrincipalGrants(
        co.id,
        "user",
        userId,
        [{ permissionKey: "tasks:assign" }],
        null,
      );
      const r1 = await svc.hasPermission(co.id, "user", userId, "agents:create");
      const r2 = await svc.hasPermission(co.id, "user", userId, "tasks:assign");
      expect(r1.granted).toBe(false);
      expect(r2.granted).toBe(true);
    });
  });

  // ── setMemberPermissions ──────────────────────────────────────────────

  describe("setMemberPermissions", () => {
    it("updates permissions via membership id", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId);
      const result = await svc.setMemberPermissions(
        co.id,
        m!.id,
        [{ permissionKey: "agents:create" }],
        null,
      );
      expect(result).not.toBeNull();
      const check = await svc.hasPermission(co.id, "user", userId, "agents:create");
      expect(check.granted).toBe(true);
    });

    it("returns null for nonexistent member", async () => {
      const co = await seedCompany();
      const result = await svc.setMemberPermissions(co.id, randomUUID(), [{ permissionKey: "agents:create" }], null);
      expect(result).toBeNull();
    });

    it("updates membershipRole when provided", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId, "contributor");
      expect(m!.membershipRole).toBe("contributor");

      const result = await svc.setMemberPermissions(
        co.id,
        m!.id,
        [{ permissionKey: "agents:create" }],
        null,
        "admin",
      );
      expect(result).not.toBeNull();
      expect(result!.membershipRole).toBe("admin");

      // Verify persisted in DB
      const rows = await testDb.db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, m!.id));
      expect(rows[0]!.membershipRole).toBe("admin");
    });

    it("does not change membershipRole when omitted", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId, "contributor");

      const result = await svc.setMemberPermissions(
        co.id,
        m!.id,
        [{ permissionKey: "agents:create" }],
        null,
      );
      expect(result).not.toBeNull();
      expect(result!.membershipRole).toBe("contributor");
    });
  });

  // ── removeMember ──────────────────────────────────────────────────────

  describe("removeMember", () => {
    it("deletes membership and grants", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(co.id, "user", userId, [{ permissionKey: "agents:create" }], null);
      const removed = await svc.removeMember(co.id, m!.id, randomUUID());
      expect(removed).not.toBeNull();

      const after = await svc.getMembership(co.id, "user", userId);
      expect(after).toBeNull();

      const grants = await testDb.db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, co.id),
            eq(principalPermissionGrants.principalId, userId),
          ),
        );
      expect(grants.length).toBe(0);
    });

    it("returns null for nonexistent member", async () => {
      const co = await seedCompany();
      const result = await svc.removeMember(co.id, randomUUID(), randomUUID());
      expect(result).toBeNull();
    });
  });

  // ── suspendMember / unsuspendMember ───────────────────────────────────

  describe("suspendMember / unsuspendMember", () => {
    it("toggles member status", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      const m = await svc.ensureMembership(co.id, "user", userId);

      const suspended = await svc.suspendMember(co.id, m!.id, randomUUID());
      expect(suspended!.status).toBe("suspended");

      const unsuspended = await svc.unsuspendMember(co.id, m!.id, randomUUID());
      expect(unsuspended!.status).toBe("active");
    });

    it("returns null for nonexistent member", async () => {
      const co = await seedCompany();
      expect(await svc.suspendMember(co.id, randomUUID(), randomUUID())).toBeNull();
      expect(await svc.unsuspendMember(co.id, randomUUID(), randomUUID())).toBeNull();
    });
  });

  // ── canUser ───────────────────────────────────────────────────────────

  describe("canUser", () => {
    it("instance admin bypasses permission check", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.promoteInstanceAdmin(userId);
      const result = await svc.canUser(co.id, userId, "agents:create");
      expect(result).toBe(true);
    });

    it("normal user checks grants", async () => {
      const co = await seedCompany();
      const userId = randomUUID();
      await svc.ensureMembership(co.id, "user", userId);
      await svc.setPrincipalGrants(co.id, "user", userId, [{ permissionKey: "agents:create" }], null);
      const result = await svc.canUser(co.id, userId, "agents:create");
      expect(result).toBe(true);
    });

    it("negative: returns false for null userId", async () => {
      const co = await seedCompany();
      expect(await svc.canUser(co.id, null, "agents:create")).toBe(false);
    });
  });

  // ── isInstanceAdmin / promoteInstanceAdmin / demoteInstanceAdmin ─────

  describe("instance admin management", () => {
    it("promoteInstanceAdmin creates admin role", async () => {
      const userId = randomUUID();
      const result = await svc.promoteInstanceAdmin(userId);
      expect(result).toBeDefined();
      expect(await svc.isInstanceAdmin(userId)).toBe(true);
    });

    it("promoteInstanceAdmin is idempotent", async () => {
      const userId = randomUUID();
      const first = await svc.promoteInstanceAdmin(userId);
      const second = await svc.promoteInstanceAdmin(userId);
      expect(first!.id).toBe(second!.id);
    });

    it("demoteInstanceAdmin removes role", async () => {
      const userId = randomUUID();
      await svc.promoteInstanceAdmin(userId);
      await svc.demoteInstanceAdmin(userId);
      expect(await svc.isInstanceAdmin(userId)).toBe(false);
    });

    it("negative: isInstanceAdmin returns false for null/undefined", async () => {
      expect(await svc.isInstanceAdmin(null)).toBe(false);
      expect(await svc.isInstanceAdmin(undefined)).toBe(false);
    });
  });
});
