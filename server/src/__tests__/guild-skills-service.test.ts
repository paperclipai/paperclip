import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  skills,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { guildSkillService } from "../services/guild-skills.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres guild skill service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("guildSkillService (Plan 3 Phase B3)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof guildSkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-guild-skills-service-",
    );
    db = createDb(tempDb.connectionString);
    svc = guildSkillService(db);
  }, 20_000);

  afterEach(async () => {
    // skill_uses rows cascade-delete when skills or heartbeat_runs are
    // removed; direct DELETE trips the append-only trigger.
    await db.delete(skills);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    // `issuePrefix` has a unique index so each seeded company must have
    // a distinct prefix. Use the first 6 chars of the UUID upper-cased
    // so the prefix slot remains a short identifier (matches the
    // production "PAP" / "ROC" shape).
    const prefix = id.replace(/-/g, "").slice(0, 6).toUpperCase();
    await db.insert(companies).values({
      id,
      name: `test-co-${id.slice(0, 8)}`,
      issuePrefix: prefix,
    });
    return id;
  }

  async function seedAgent(
    companyId: string,
    kind: "agent" | "guild" | "orchestrator" | "worker" = "agent",
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `${kind}-${id.slice(0, 8)}`,
      kind,
    });
    return id;
  }

  describe("assertGuild + create", () => {
    it("creates a provisional skill on a guild agent", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");

      const created = await svc.create(companyId, guildId, {
        name: "drain-in-flight-runs",
        body: "Before triggering a heartbeat invoke, drain queued or running runs first.",
      });

      expect(created.guildId).toBe(guildId);
      expect(created.companyId).toBe(companyId);
      expect(created.name).toBe("drain-in-flight-runs");
      expect(created.provenance).toBe("provisional");
      expect(created.successCount).toBe(0);
      expect(created.failCount).toBe(0);
      expect(created.retiredAt).toBeNull();
    });

    it("rejects create on a non-guild agent (kind=agent) with conflict", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, "agent");

      await expect(
        svc.create(companyId, agentId, {
          name: "test-skill",
          body: "doesn't matter",
        }),
      ).rejects.toThrow(/not 'guild'/);
    });

    it("rejects create when the guild belongs to a different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const guildInA = await seedAgent(companyA, "guild");

      // The guild exists, but we're calling with companyB's id; the
      // service should refuse cross-company access.
      await expect(
        svc.create(companyB, guildInA, {
          name: "test-skill",
          body: "doesn't matter",
        }),
      ).rejects.toThrow(/not found in company/);
    });

    it("rejects duplicate non-retired skill name in same guild", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");

      await svc.create(companyId, guildId, { name: "twin", body: "first" });
      await expect(
        svc.create(companyId, guildId, { name: "twin", body: "second" }),
      ).rejects.toThrow(/already exists/);
    });

    it("allows reusing a name after retiring the old skill", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");

      const first = await svc.create(companyId, guildId, {
        name: "rolled-up",
        body: "first version",
      });
      await svc.retire(companyId, guildId, first.id);

      // Retired -> name is free again. Second create succeeds.
      const second = await svc.create(companyId, guildId, {
        name: "rolled-up",
        body: "second version",
      });
      expect(second.id).not.toBe(first.id);
      expect(second.body).toBe("second version");
      expect(second.provenance).toBe("provisional");
    });
  });

  describe("promote", () => {
    it("promotes provisional -> canonical and is idempotent", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");
      const created = await svc.create(companyId, guildId, {
        name: "p1",
        body: "x",
      });

      const promoted = await svc.promote(companyId, guildId, created.id);
      expect(promoted.provenance).toBe("canonical");

      // Idempotent — promoting again is a no-op that returns the row.
      const again = await svc.promote(companyId, guildId, created.id);
      expect(again.provenance).toBe("canonical");
    });

    it("refuses to promote a retired skill", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");
      const created = await svc.create(companyId, guildId, {
        name: "stale",
        body: "obsolete",
      });
      await svc.retire(companyId, guildId, created.id);

      await expect(
        svc.promote(companyId, guildId, created.id),
      ).rejects.toThrow(/retired/);
    });

    it("refuses to promote a skill in a different guild than its actual owner", async () => {
      const companyId = await seedCompany();
      const guildA = await seedAgent(companyId, "guild");
      const guildB = await seedAgent(companyId, "guild");
      const created = await svc.create(companyId, guildA, {
        name: "shared",
        body: "x",
      });

      await expect(
        svc.promote(companyId, guildB, created.id),
      ).rejects.toThrow(/not found in guild/);
    });
  });

  describe("recordUse", () => {
    it("increments successCount on success=true and failCount on success=false", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");
      // heartbeat_runs.id is now a required FK on skill_uses, so each
      // recordUse call needs a real run row.
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: guildId,
        invocationSource: "manual",
        status: "running",
      });
      const created = await svc.create(companyId, guildId, {
        name: "counts",
        body: "x",
      });

      const after1 = await svc.recordUse(companyId, guildId, created.id, true, runId);
      expect(after1.successCount).toBe(1);
      expect(after1.failCount).toBe(0);

      const after2 = await svc.recordUse(companyId, guildId, created.id, false, runId);
      expect(after2.successCount).toBe(1);
      expect(after2.failCount).toBe(1);

      const after3 = await svc.recordUse(companyId, guildId, created.id, true, runId);
      expect(after3.successCount).toBe(2);
      expect(after3.failCount).toBe(1);
    });
  });

  describe("list", () => {
    it("filters by provenance and excludes retired by default", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");

      const a = await svc.create(companyId, guildId, { name: "a", body: "x" });
      const b = await svc.create(companyId, guildId, { name: "b", body: "x" });
      const c = await svc.create(companyId, guildId, { name: "c", body: "x" });

      await svc.promote(companyId, guildId, b.id);
      await svc.retire(companyId, guildId, c.id);

      const allLive = await svc.list(companyId, guildId, {
        includeRetired: false,
        limit: 50,
      });
      expect(allLive.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());

      const provisionalOnly = await svc.list(companyId, guildId, {
        provenance: "provisional",
        includeRetired: false,
        limit: 50,
      });
      expect(provisionalOnly.map((s) => s.id)).toEqual([a.id]);

      const canonicalOnly = await svc.list(companyId, guildId, {
        provenance: "canonical",
        includeRetired: false,
        limit: 50,
      });
      expect(canonicalOnly.map((s) => s.id)).toEqual([b.id]);

      const allIncludingRetired = await svc.list(companyId, guildId, {
        includeRetired: true,
        limit: 50,
      });
      expect(allIncludingRetired.map((s) => s.id).sort()).toEqual(
        [a.id, b.id, c.id].sort(),
      );
    });

    it("returns empty for a guild with no skills", async () => {
      const companyId = await seedCompany();
      const guildId = await seedAgent(companyId, "guild");
      const rows = await svc.list(companyId, guildId, {
        includeRetired: false,
        limit: 50,
      });
      expect(rows).toEqual([]);
    });
  });
});
