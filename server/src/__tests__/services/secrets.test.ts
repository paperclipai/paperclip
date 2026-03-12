import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { secretService } from "../../services/secrets.js";
import { companies } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

// Mock the provider registry to avoid needing real secret providers
vi.mock("../../secrets/provider-registry.js", () => {
  const createHash = require("node:crypto").createHash;
  const mockProvider = {
    createVersion: async (input: { value: string; externalRef: string | null }) => ({
      material: { encrypted: input.value },
      valueSha256: createHash("sha256").update(input.value).digest("hex"),
      externalRef: input.externalRef,
    }),
    resolveVersion: async (input: { material: Record<string, unknown>; externalRef: string | null }) =>
      String((input.material as { encrypted: string }).encrypted),
  };
  return {
    getSecretProvider: () => mockProvider,
    listSecretProviders: () => [{ id: "builtin", name: "Built-in" }],
  };
});

describe("secretService", () => {
  let testDb: TestDb;
  let companyId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({ name: "Secret Co", issuePrefix: `S${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return secretService(testDb.db);
  }

  // ── create ────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a secret", async () => {
      const secret = await svc().create(companyId, {
        name: "API_KEY",
        provider: "builtin" as any,
        value: "sk-test-123",
      });
      expect(secret).toBeDefined();
      expect(secret.name).toBe("API_KEY");
      expect(secret.companyId).toBe(companyId);
      expect(secret.latestVersion).toBe(1);
    });

    it("negative: duplicate name throws conflict", async () => {
      await svc().create(companyId, {
        name: "DUPLICATE",
        provider: "builtin" as any,
        value: "val1",
      });
      await expect(
        svc().create(companyId, {
          name: "DUPLICATE",
          provider: "builtin" as any,
          value: "val2",
        }),
      ).rejects.toThrow(/already exists/i);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists secrets for company", async () => {
      await svc().create(companyId, { name: "S1", provider: "builtin" as any, value: "v1" });
      await svc().create(companyId, { name: "S2", provider: "builtin" as any, value: "v2" });
      const all = await svc().list(companyId);
      expect(all.length).toBe(2);
    });
  });

  // ── getById / getByName ───────────────────────────────────────────────

  describe("getById / getByName", () => {
    it("finds by id and name", async () => {
      const secret = await svc().create(companyId, {
        name: "FIND_ME",
        provider: "builtin" as any,
        value: "val",
      });
      const byId = await svc().getById(secret.id);
      expect(byId).not.toBeNull();
      expect(byId!.name).toBe("FIND_ME");

      const byName = await svc().getByName(companyId, "FIND_ME");
      expect(byName).not.toBeNull();
      expect(byName!.id).toBe(secret.id);
    });

    it("negative: returns null for nonexistent", async () => {
      expect(await svc().getById(randomUUID())).toBeNull();
      expect(await svc().getByName(companyId, "NOPE")).toBeNull();
    });
  });

  // ── rotate ────────────────────────────────────────────────────────────

  describe("rotate", () => {
    it("creates a new version", async () => {
      const secret = await svc().create(companyId, {
        name: "ROTATE_ME",
        provider: "builtin" as any,
        value: "old",
      });
      const rotated = await svc().rotate(secret.id, { value: "new" });
      expect(rotated).not.toBeNull();
      expect(rotated!.latestVersion).toBe(2);
    });

    it("negative: throws for nonexistent secret", async () => {
      await expect(svc().rotate(randomUUID(), { value: "x" })).rejects.toThrow(/not found/i);
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates secret metadata", async () => {
      const secret = await svc().create(companyId, {
        name: "UPD",
        provider: "builtin" as any,
        value: "val",
      });
      const updated = await svc().update(secret.id, { description: "Updated desc" });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe("Updated desc");
    });
  });

  // ── remove ────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("deletes secret", async () => {
      const secret = await svc().create(companyId, {
        name: "DEL",
        provider: "builtin" as any,
        value: "val",
      });
      const removed = await svc().remove(secret.id);
      expect(removed).not.toBeNull();
      const after = await svc().getById(secret.id);
      expect(after).toBeNull();
    });

    it("negative: returns null for nonexistent", async () => {
      const removed = await svc().remove(randomUUID());
      expect(removed).toBeNull();
    });
  });
});
