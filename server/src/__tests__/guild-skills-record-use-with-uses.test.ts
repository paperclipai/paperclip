import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  skillUses,
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
    `Skipping embedded Postgres recordUse+skill_uses tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("guildSkillService.recordUse - skill_uses event log (Plan 4 Phase 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof guildSkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-guild-skills-record-use-uses-",
    );
    db = createDb(tempDb.connectionString);
    svc = guildSkillService(db);
  }, 20_000);

  afterEach(async () => {
    // skill_uses has ON DELETE CASCADE from skills and heartbeat_runs, so
    // deleting those parent tables is enough; direct DELETE on skill_uses
    // would trip the append-only trigger.
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

  // Seeds a heartbeat_runs row tied to (companyId, agentId). The run is
  // the FK target that skill_uses.run_id must reference.
  async function seedRun(companyId: string, agentId: string): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
    });
    return id;
  }

  async function seedSkill(companyId: string, guildId: string): Promise<string> {
    const created = await svc.create(companyId, guildId, {
      name: `skill-${randomUUID().slice(0, 8)}`,
      body: "placeholder body for test",
    });
    return created.id;
  }

  // Case 1: success=true writes one skill_uses row AND increments success_count.
  it("success=true inserts one skill_uses row and increments success_count", async () => {
    const companyId = await seedCompany();
    const guildId = await seedAgent(companyId, "guild");
    const runId = await seedRun(companyId, guildId);
    const skillId = await seedSkill(companyId, guildId);

    const result = await svc.recordUse(companyId, guildId, skillId, true, runId);

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(0);

    const uses = await db.select().from(skillUses);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.skillId).toBe(skillId);
    expect(uses[0]!.guildId).toBe(guildId);
    expect(uses[0]!.runId).toBe(runId);
    expect(uses[0]!.success).toBe(true);
  });

  // Case 2: success=false writes one skill_uses row AND increments fail_count.
  it("success=false inserts one skill_uses row and increments fail_count", async () => {
    const companyId = await seedCompany();
    const guildId = await seedAgent(companyId, "guild");
    const runId = await seedRun(companyId, guildId);
    const skillId = await seedSkill(companyId, guildId);

    const result = await svc.recordUse(companyId, guildId, skillId, false, runId);

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);

    const uses = await db.select().from(skillUses);
    expect(uses).toHaveLength(1);
    expect(uses[0]!.success).toBe(false);
  });

  // Case 3: unknown skillId rejects via the existing get() notFound guard.
  it("unknown skillId rejects with notFound", async () => {
    const companyId = await seedCompany();
    const guildId = await seedAgent(companyId, "guild");
    const runId = await seedRun(companyId, guildId);
    const fakeSkillId = randomUUID();

    await expect(
      svc.recordUse(companyId, guildId, fakeSkillId, true, runId),
    ).rejects.toThrow(/not found/i);
  });

  // Case 4: cross-guild skill rejects - guild B cannot record use on
  // guild A's skill even though the skill id is valid.
  it("cross-guild call rejects when skill belongs to a different guild", async () => {
    const companyId = await seedCompany();
    const guildA = await seedAgent(companyId, "guild");
    const guildB = await seedAgent(companyId, "guild");
    const runIdForB = await seedRun(companyId, guildB);
    const skillId = await seedSkill(companyId, guildA);

    await expect(
      svc.recordUse(companyId, guildB, skillId, true, runIdForB),
    ).rejects.toThrow(/not found/i);
  });

  // Case 5: multiple uses for the same (skill, run) all persist; the
  // event log is not unique on (skill_id, run_id).
  it("multiple uses for the same (skill, run) pair all persist", async () => {
    const companyId = await seedCompany();
    const guildId = await seedAgent(companyId, "guild");
    const runId = await seedRun(companyId, guildId);
    const skillId = await seedSkill(companyId, guildId);

    await svc.recordUse(companyId, guildId, skillId, true, runId);
    await svc.recordUse(companyId, guildId, skillId, true, runId);
    await svc.recordUse(companyId, guildId, skillId, false, runId);

    const uses = await db.select().from(skillUses);
    expect(uses).toHaveLength(3);

    const finalSkill = await svc.get(companyId, guildId, skillId);
    expect(finalSkill.successCount).toBe(2);
    expect(finalSkill.failCount).toBe(1);
  });

  // Case 6: atomicity. A fake runId that violates the FK constraint
  // causes the entire transaction to roll back: no skill_uses row is
  // inserted AND the counter on the skills row is unchanged.
  it("fake runId causes FK violation, rolling back both insert and counter update", async () => {
    const companyId = await seedCompany();
    const guildId = await seedAgent(companyId, "guild");
    const skillId = await seedSkill(companyId, guildId);
    const fakeRunId = randomUUID(); // not in heartbeat_runs

    await expect(
      svc.recordUse(companyId, guildId, skillId, true, fakeRunId),
    ).rejects.toThrow();

    // No event-log row written.
    const uses = await db.select().from(skillUses);
    expect(uses).toHaveLength(0);

    // Counter unchanged: the update was rolled back too.
    const skill = await svc.get(companyId, guildId, skillId);
    expect(skill.successCount).toBe(0);
    expect(skill.failCount).toBe(0);
  });
});
