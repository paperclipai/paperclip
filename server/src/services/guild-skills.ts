/**
 * Plan 3 v2 organisation — guild skill service.
 *
 * Provides CRUD + promotion + use-tracking for a guild's knowledge
 * library. The dispatch layer's worker-exit hook (Phase E2) calls
 * `create` to persist learnings the worker wrote to /tmp/learnings.json.
 * The operator (or a future PM/COO) calls `promote` once a provisional
 * skill has been reviewed.
 *
 * All public methods enforce the invariant: the target guild row exists
 * in `agents` AND has `kind = 'guild'`. The route layer is expected to
 * have already checked company access; this service does not re-do
 * `assertCompanyAccess`.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import { agents, skillUses, skills } from "@paperclipai/db";
import type {
  GuildSkillCreate,
  GuildSkillListQuery,
  GuildSkillProvenance,
} from "@paperclipai/shared";

import { conflict, notFound } from "../errors.js";

export type GuildSkillRow = typeof skills.$inferSelect;

export function guildSkillService(db: Db) {
  /** Throws notFound if the guild does not exist within the company,
   * or conflict if the target row exists but isn't a guild. Returns
   * the verified guild row so callers (e.g. the route layer) can read
   * the guild's slug for activity_log emissions without a second
   * round-trip. */
  async function assertGuild(
    companyId: string,
    guildId: string,
  ): Promise<{ id: string; name: string }> {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        kind: agents.kind,
        companyId: agents.companyId,
      })
      .from(agents)
      .where(eq(agents.id, guildId))
      .limit(1);
    const row = rows[0];
    if (!row || row.companyId !== companyId) {
      throw notFound(`Guild ${guildId} not found in company ${companyId}`);
    }
    if (row.kind !== "guild") {
      throw conflict(
        `Agent ${guildId} has kind=${row.kind}, not 'guild'. Promote ` +
          `the agent first or address a different agent.`,
      );
    }
    return { id: row.id, name: row.name };
  }

  async function list(
    companyId: string,
    guildId: string,
    query: GuildSkillListQuery,
  ): Promise<GuildSkillRow[]> {
    await assertGuild(companyId, guildId);
    const filters = [eq(skills.guildId, guildId)];
    if (query.provenance) filters.push(eq(skills.provenance, query.provenance));
    if (!query.includeRetired) filters.push(isNull(skills.retiredAt));
    return db
      .select()
      .from(skills)
      .where(and(...filters))
      .orderBy(desc(skills.createdAt))
      .limit(query.limit);
  }

  async function get(
    companyId: string,
    guildId: string,
    skillId: string,
  ): Promise<GuildSkillRow> {
    await assertGuild(companyId, guildId);
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.id, skillId), eq(skills.guildId, guildId)))
      .limit(1);
    if (!rows[0]) throw notFound(`Skill ${skillId} not found in guild ${guildId}`);
    return rows[0];
  }

  async function create(
    companyId: string,
    guildId: string,
    input: GuildSkillCreate,
  ): Promise<GuildSkillRow> {
    await assertGuild(companyId, guildId);
    // Workers SHOULD NOT clobber an existing non-retired skill with the
    // same name. The schema's `skills_guild_name_idx` is non-unique
    // because retired duplicates are allowed, so we enforce uniqueness
    // here at the service layer: if a non-retired skill with this name
    // exists in the guild we return conflict.
    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.guildId, guildId),
          eq(skills.name, input.name),
          isNull(skills.retiredAt),
        ),
      )
      .limit(1);
    if (existing[0]) {
      throw conflict(
        `Skill name '${input.name}' already exists (non-retired) in guild ${guildId}.`,
      );
    }
    const inserted = await db
      .insert(skills)
      .values({
        guildId,
        companyId,
        name: input.name,
        body: input.body,
        createdByRunId: input.createdByRunId ?? null,
        // Provenance is always 'provisional' on worker-write; the
        // create route ignores any client-supplied provenance to
        // prevent a worker from minting canonical skills.
        provenance: "provisional",
      })
      .returning();
    return inserted[0]!;
  }

  async function promote(
    companyId: string,
    guildId: string,
    skillId: string,
  ): Promise<GuildSkillRow> {
    const row = await get(companyId, guildId, skillId);
    if (row.provenance === "canonical") {
      // Promote is idempotent — re-promoting a canonical skill is a
      // no-op. Returning the row keeps the API symmetric.
      return row;
    }
    if (row.retiredAt) {
      throw conflict(
        `Skill ${skillId} is retired; cannot promote a retired skill.`,
      );
    }
    const updated = await db
      .update(skills)
      .set({ provenance: "canonical", updatedAt: new Date() })
      .where(and(eq(skills.id, skillId), eq(skills.guildId, guildId)))
      .returning();
    return updated[0]!;
  }

  async function recordUse(
    companyId: string,
    guildId: string,
    skillId: string,
    success: boolean,
    runId: string,
  ): Promise<GuildSkillRow> {
    // Verify the skill exists in this guild + company first; otherwise
    // a worker in guild A could increment a skill in guild B.
    await get(companyId, guildId, skillId);
    return db.transaction(async (tx) => {
      // Insert the event-log row before the counter update so that a FK
      // violation on run_id rolls back both writes atomically.
      await tx.insert(skillUses).values({ skillId, guildId, runId, success });
      const counterUpdate = success
        ? { successCount: sql`${skills.successCount} + 1` }
        : { failCount: sql`${skills.failCount} + 1` };
      const updated = await tx
        .update(skills)
        .set({ ...counterUpdate, updatedAt: new Date() })
        .where(and(eq(skills.id, skillId), eq(skills.guildId, guildId)))
        .returning();
      return updated[0]!;
    });
  }

  async function retire(
    companyId: string,
    guildId: string,
    skillId: string,
  ): Promise<GuildSkillRow> {
    const row = await get(companyId, guildId, skillId);
    if (row.retiredAt) return row; // idempotent
    const updated = await db
      .update(skills)
      .set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(skills.id, skillId), eq(skills.guildId, guildId)))
      .returning();
    return updated[0]!;
  }

  return { list, get, create, promote, recordUse, retire, assertGuild };
}
