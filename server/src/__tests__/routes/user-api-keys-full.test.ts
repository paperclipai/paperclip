import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanDb, closeCleanupConnection } from "../helpers/test-db.js";
import type { TestDb } from "../helpers/test-db.js";
import { createTestApp, setMockActor, resetMockActor } from "../helpers/test-app.js";
import { userApiKeys, authUsers, companies, companyMemberships } from "@paperclipai/db";

const TEST_USER_ID = "user-api-key-test-user";
const TEST_COMPANY_ID = "00000000-0000-4000-a000-000000000099";

describe("user-api-key routes", () => {
  let testDb: TestDb;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    testDb = getTestDb();
  });

  afterAll(async () => {
    await closeCleanupConnection();
    await testDb.close();
  });

  beforeEach(async () => {
    await cleanDb();
    resetMockActor();

    // Seed user
    await testDb.db.insert(authUsers).values({
      id: TEST_USER_ID,
      name: "PAT Route Test User",
      email: "pat-route-test@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Seed company
    await testDb.db.insert(companies).values({
      id: TEST_COMPANY_ID,
      name: "PAT Test Company",
    });

    // Seed membership
    await testDb.db.insert(companyMemberships).values({
      principalType: "user",
      principalId: TEST_USER_ID,
      companyId: TEST_COMPANY_ID,
      membershipRole: "owner",
      status: "active",
    });

    setMockActor({
      type: "board",
      userId: TEST_USER_ID,
      companyIds: [TEST_COMPANY_ID],
      source: "session",
    });

    app = createTestApp(testDb.db);
  });

  describe("POST /api/users/me/api-keys", () => {
    it("creates a PAT and returns the full key exactly once", async () => {
      const res = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "my-cli-key" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: "my-cli-key",
      });
      expect(res.body.id).toBeDefined();
      expect(res.body.key).toMatch(/^pclip_[a-f0-9]{32}$/);
      expect(res.body.keyPrefix).toBe(res.body.key.slice(0, 14));
      expect(res.body.createdAt).toBeDefined();

      // Verify stored in DB with hash
      const rows = await testDb.db
        .select()
        .from(userApiKeys)
        .where(eq(userApiKeys.id, res.body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].keyHash).toBe(
        createHash("sha256").update(res.body.key).digest("hex"),
      );
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(app)
        .post("/api/users/me/api-keys")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 400 when name is empty string", async () => {
      const res = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "  " });

      expect(res.status).toBe(400);
    });

    it("returns 403 for non-board actors", async () => {
      setMockActor({
        type: "agent",
        agentId: "agent-1",
        companyId: TEST_COMPANY_ID,
      });
      app = createTestApp(testDb.db);

      const res = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "my-key" });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/users/me/api-keys", () => {
    it("lists all keys for the current user without exposing full key", async () => {
      // Create two keys first
      await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "key-1" });
      await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "key-2" });

      const res = await request(app).get("/api/users/me/api-keys");

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      for (const key of res.body) {
        expect(key.name).toBeDefined();
        expect(key.keyPrefix).toBeDefined();
        expect(key.createdAt).toBeDefined();
        // Must NOT contain the full key
        expect(key.key).toBeUndefined();
        expect(key.keyHash).toBeUndefined();
      }
    });

    it("returns empty array when user has no keys", async () => {
      const res = await request(app).get("/api/users/me/api-keys");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("only lists keys for the authenticated user", async () => {
      // Create a key as TEST_USER_ID
      await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "my-key" });

      // Switch to a different user
      const OTHER_USER_ID = "other-user-id";
      await testDb.db.insert(authUsers).values({
        id: OTHER_USER_ID,
        name: "Other User",
        email: "other@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setMockActor({
        type: "board",
        userId: OTHER_USER_ID,
        companyIds: [],
        source: "session",
      });
      app = createTestApp(testDb.db);

      const res = await request(app).get("/api/users/me/api-keys");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("DELETE /api/users/me/api-keys/:keyId", () => {
    it("revokes a key by setting revokedAt", async () => {
      const createRes = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "to-revoke" });
      const keyId = createRes.body.id;

      const res = await request(app).delete(`/api/users/me/api-keys/${keyId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: true });

      // Verify revokedAt is set
      const rows = await testDb.db
        .select()
        .from(userApiKeys)
        .where(eq(userApiKeys.id, keyId));
      expect(rows[0].revokedAt).not.toBeNull();
    });

    it("returns 404 for nonexistent key", async () => {
      const res = await request(app).delete(
        "/api/users/me/api-keys/00000000-0000-4000-a000-000000000000",
      );

      expect(res.status).toBe(404);
    });

    it("prevents revoking another user's key", async () => {
      // Create key as TEST_USER_ID
      const createRes = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "other-key" });
      const keyId = createRes.body.id;

      // Switch to a different user
      const OTHER_USER_ID = "other-user-id-2";
      await testDb.db.insert(authUsers).values({
        id: OTHER_USER_ID,
        name: "Other User 2",
        email: "other2@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setMockActor({
        type: "board",
        userId: OTHER_USER_ID,
        companyIds: [],
        source: "session",
      });
      app = createTestApp(testDb.db);

      const res = await request(app).delete(`/api/users/me/api-keys/${keyId}`);

      expect(res.status).toBe(404);

      // Verify key is NOT revoked
      const rows = await testDb.db
        .select()
        .from(userApiKeys)
        .where(eq(userApiKeys.id, keyId));
      expect(rows[0].revokedAt).toBeNull();
    });

    it("is idempotent on already-revoked keys", async () => {
      const createRes = await request(app)
        .post("/api/users/me/api-keys")
        .send({ name: "already-revoked" });
      const keyId = createRes.body.id;

      // Revoke once
      await request(app).delete(`/api/users/me/api-keys/${keyId}`);
      // Revoke again
      const res = await request(app).delete(`/api/users/me/api-keys/${keyId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: true });
    });

    it("returns 403 for non-board actors", async () => {
      setMockActor({
        type: "agent",
        agentId: "agent-1",
        companyId: TEST_COMPANY_ID,
      });
      app = createTestApp(testDb.db);

      const res = await request(app).delete(
        "/api/users/me/api-keys/00000000-0000-4000-a000-000000000000",
      );

      expect(res.status).toBe(403);
    });
  });
});
