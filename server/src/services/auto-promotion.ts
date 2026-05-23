/**
 * Plan 4 - auto-promotion service.
 *
 * Pure DB layer: eligibility query, transactional promote, revert, review,
 * config CRUD, and scan-history aggregation. No HTTP, no scheduling.
 *
 * Design notes:
 * - patchConfig and revert emit activity_log via direct INSERT (not logActivity)
 *   so we can return the inserted id. Live-event publish is skipped for these
 *   internal events as a deliberate trade-off; Phase 5 routes can add it if
 *   needed.
 * - scanGuild summary emits use logActivity so the notifier channels pick them
 *   up without extra wiring.
 * - promoteOne uses FOR UPDATE to guard against races between eligibility query
 *   and commit. UNIQUE(skill_id) on auto_promotion_audit is the final backstop.
 */
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  autoPromotionAudit,
  autoPromotionConfig,
  autoPromotionReverts,
  autoPromotionReviews,
  skillUses,
  skills,
} from "@paperclipai/db";
import type {
  AutoPromotionConfigPatch,
  AutoPromotionListQuery,
} from "@paperclipai/shared";

import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type AutoPromotionAuditRow = typeof autoPromotionAudit.$inferSelect;
export type AutoPromotionRevertRow = typeof autoPromotionReverts.$inferSelect;
export type AutoPromotionReviewRow = typeof autoPromotionReviews.$inferSelect;
export type AutoPromotionConfigRow = typeof autoPromotionConfig.$inferSelect;

export interface ScanResult {
  scanId: string;
  scannedCount: number;
  eligibleCount: number;
  promotedCount: number;
  failedCount: number;
  dryRun: boolean;
  promotions: Array<{
    auditId: string | null; // null in dry-run mode
    skillId: string;
    skillName: string;
    successCount: number;
    failCount: number;
    successRatio: number;
    distinctRuns: number;
    skillAgeHours: number;
  }>;
}

export function autoPromotionService(db: Db) {
  async function getConfig(
    companyId: string,
    guildId: string,
  ): Promise<AutoPromotionConfigRow> {
    const rows = await db
      .select()
      .from(autoPromotionConfig)
      .where(
        and(
          eq(autoPromotionConfig.guildId, guildId),
          eq(autoPromotionConfig.companyId, companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw notFound(
        `auto-promotion config not found for guild ${guildId} in company ${companyId}`,
      );
    }
    return rows[0];
  }

  async function patchConfig(
    companyId: string,
    guildId: string,
    patch: AutoPromotionConfigPatch,
    actor: { id: string; type: "user" | "agent" | "system" },
  ): Promise<{ row: AutoPromotionConfigRow; activityId: string }> {
    const keys = Object.keys(patch) as Array<keyof AutoPromotionConfigPatch>;
    if (keys.length === 0) {
      throw conflict("empty patch - provide at least one field");
    }
    // Server-side floor guard (CHECK constraints also catch, but we want a clean error)
    if (patch.minUses !== undefined && patch.minUses < 3) {
      throw conflict("min_uses must be >= 3");
    }
    if (
      patch.minSuccessRatio !== undefined &&
      (patch.minSuccessRatio < 0.6 || patch.minSuccessRatio > 1.0)
    ) {
      throw conflict("min_success_ratio must be in [0.6, 1.0]");
    }
    if (patch.minAgeHours !== undefined && patch.minAgeHours < 6) {
      throw conflict("min_age_hours must be >= 6");
    }
    if (
      patch.minBodyStableHours !== undefined &&
      patch.minBodyStableHours < 6
    ) {
      throw conflict("min_body_stable_hours must be >= 6");
    }
    if (patch.minDistinctRuns !== undefined && patch.minDistinctRuns < 2) {
      throw conflict("min_distinct_runs must be >= 2");
    }
    if (
      patch.maxPromotionsPerTick !== undefined &&
      (patch.maxPromotionsPerTick < 1 || patch.maxPromotionsPerTick > 20)
    ) {
      throw conflict("max_promotions_per_tick must be in [1, 20]");
    }
    if (
      patch.scanHourUtc !== undefined &&
      (patch.scanHourUtc < 0 || patch.scanHourUtc > 23)
    ) {
      throw conflict("scan_hour_utc must be in [0, 23]");
    }

    const before = await getConfig(companyId, guildId);

    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of keys) {
      updateValues[k] = patch[k];
    }

    return db.transaction(async (tx) => {
      const updated = await tx
        .update(autoPromotionConfig)
        .set(updateValues)
        .where(
          and(
            eq(autoPromotionConfig.guildId, guildId),
            eq(autoPromotionConfig.companyId, companyId),
          ),
        )
        .returning();
      if (!updated[0]) {
        throw notFound(`No config for guild ${guildId}`);
      }
      const guild = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, guildId))
        .limit(1);
      // Direct insert so we can return the id; logActivity doesn't expose the id
      // Bypasses logActivity's sanitizeRecord; payload must be pre-sanitized if extended.
      const inserted = await tx
        .insert(activityLog)
        .values({
          companyId,
          actorType: actor.type,
          actorId: actor.id,
          action: "guild.skill.auto_promotion_config_changed",
          entityType: "guild",
          entityId: guildId,
          agentId: null,
          runId: null,
          details: {
            guildId,
            guildSlug: guild[0]?.name ?? null,
            changedBy: actor.id,
            before,
            after: updated[0],
            fieldsChanged: keys,
          } as Record<string, unknown>,
        })
        .returning({ id: activityLog.id });
      return { row: updated[0], activityId: inserted[0]!.id };
    });
  }

  async function recordReview(
    companyId: string,
    auditId: string,
    reviewerId: string,
    context?: string,
  ): Promise<AutoPromotionReviewRow> {
    // Confirm audit exists in this company before writing
    const audit = await db
      .select()
      .from(autoPromotionAudit)
      .where(
        and(
          eq(autoPromotionAudit.id, auditId),
          eq(autoPromotionAudit.companyId, companyId),
        ),
      )
      .limit(1);
    if (!audit[0]) {
      throw notFound(`Audit ${auditId} not found in company ${companyId}`);
    }
    const inserted = await db
      .insert(autoPromotionReviews)
      .values({ auditId, reviewerId, context: context ?? null })
      .returning();
    return inserted[0]!;
  }

  async function revert(
    companyId: string,
    auditId: string,
    reason: string,
    revertedBy: string,
  ): Promise<{
    revert: AutoPromotionRevertRow;
    skill: typeof skills.$inferSelect;
    activityId: string;
  }> {
    if (!reason || reason.length < 1 || reason.length > 2000) {
      throw conflict("reason must be 1-2000 chars");
    }
    return db.transaction(async (tx) => {
      const auditRow = await tx
        .select()
        .from(autoPromotionAudit)
        .where(
          and(
            eq(autoPromotionAudit.id, auditId),
            eq(autoPromotionAudit.companyId, companyId),
          ),
        )
        .limit(1);
      if (!auditRow[0]) {
        throw notFound(`Audit ${auditId} not found in company ${companyId}`);
      }
      // Pre-check before UNIQUE constraint fires for a cleaner error message
      const existingRevert = await tx
        .select()
        .from(autoPromotionReverts)
        .where(eq(autoPromotionReverts.auditId, auditId))
        .limit(1);
      if (existingRevert[0]) {
        throw conflict(
          `Audit ${auditId} already reverted at ${existingRevert[0].revertedAt.toISOString()}`,
        );
      }
      const skillRow = await tx
        .select()
        .from(skills)
        .where(eq(skills.id, auditRow[0].skillId))
        .limit(1);
      if (!skillRow[0]) {
        throw notFound(`Skill ${auditRow[0].skillId} not found`);
      }
      const insertedRevert = await tx
        .insert(autoPromotionReverts)
        .values({ auditId, revertedBy, reason })
        .returning();
      const updatedSkill = await tx
        .update(skills)
        .set({ provenance: "provisional", updatedAt: new Date() })
        .where(eq(skills.id, auditRow[0].skillId))
        .returning();
      const guild = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, auditRow[0].guildId))
        .limit(1);
      // Bypasses logActivity's sanitizeRecord; payload must be pre-sanitized if extended.
      const insertedActivity = await tx
        .insert(activityLog)
        .values({
          companyId,
          actorType: "user",
          actorId: revertedBy,
          action: "guild.skill.auto_promotion_reverted",
          entityType: "auto_promotion_audit",
          entityId: auditId,
          agentId: null,
          runId: null,
          details: {
            guildId: auditRow[0].guildId,
            guildSlug: guild[0]?.name ?? null,
            auditId,
            skillId: auditRow[0].skillId,
            skillName: skillRow[0].name,
            revertedBy,
            reason: reason.slice(0, 500),
          } as Record<string, unknown>,
        })
        .returning({ id: activityLog.id });
      return {
        revert: insertedRevert[0]!,
        skill: updatedSkill[0]!,
        activityId: insertedActivity[0]!.id,
      };
    });
  }

  async function listAudits(
    companyId: string,
    guildId: string,
    query: AutoPromotionListQuery,
  ): Promise<{
    rows: Array<
      AutoPromotionAuditRow & {
        revert: AutoPromotionRevertRow | null;
        reviewCount: number;
      }
    >;
    total: number;
  }> {
    const filters = [
      eq(autoPromotionAudit.guildId, guildId),
      eq(autoPromotionAudit.companyId, companyId),
    ];
    if (query.since) {
      filters.push(gte(autoPromotionAudit.decidedAt, new Date(query.since)));
    }
    if (query.until) {
      filters.push(lte(autoPromotionAudit.decidedAt, new Date(query.until)));
    }
    // SQL-level filters so LIMIT and total COUNT both reflect the filtered universe
    if (query.revertedOnly) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM auto_promotion_reverts r WHERE r.audit_id = ${autoPromotionAudit.id})`,
      );
    }
    if (query.neverReviewed) {
      filters.push(
        sql`NOT EXISTS (SELECT 1 FROM auto_promotion_reviews rev WHERE rev.audit_id = ${autoPromotionAudit.id})`,
      );
    }

    const audits = await db
      .select()
      .from(autoPromotionAudit)
      .where(and(...filters))
      .orderBy(desc(autoPromotionAudit.decidedAt))
      .limit(query.limit);

    const revertRows =
      audits.length === 0
        ? []
        : await db
            .select()
            .from(autoPromotionReverts)
            .where(
              inArray(
                autoPromotionReverts.auditId,
                audits.map((a) => a.id),
              ),
            );
    const revertByAudit = new Map(revertRows.map((r) => [r.auditId, r]));

    const reviewCounts =
      audits.length === 0
        ? []
        : await db
            .select({
              auditId: autoPromotionReviews.auditId,
              n: sql<number>`COUNT(*)::int`,
            })
            .from(autoPromotionReviews)
            .where(
              inArray(
                autoPromotionReviews.auditId,
                audits.map((a) => a.id),
              ),
            )
            .groupBy(autoPromotionReviews.auditId);
    const reviewCountByAudit = new Map(reviewCounts.map((r) => [r.auditId, r.n]));

    const rows = audits.map((a) => ({
      ...a,
      revert: revertByAudit.get(a.id) ?? null,
      reviewCount: reviewCountByAudit.get(a.id) ?? 0,
    }));

    const [totalRow] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(autoPromotionAudit)
      .where(and(...filters));

    return { rows, total: totalRow?.n ?? 0 };
  }

  async function getAuditEnvelope(companyId: string, auditId: string) {
    const [audit] = await db
      .select()
      .from(autoPromotionAudit)
      .where(
        and(
          eq(autoPromotionAudit.id, auditId),
          eq(autoPromotionAudit.companyId, companyId),
        ),
      )
      .limit(1);
    if (!audit) {
      throw notFound(`Audit ${auditId} not found in company ${companyId}`);
    }
    const [skillRow] = await db
      .select()
      .from(skills)
      .where(eq(skills.id, audit.skillId))
      .limit(1);
    const recentUses = await db
      .select()
      .from(skillUses)
      .where(eq(skillUses.skillId, audit.skillId))
      .orderBy(desc(skillUses.recordedAt))
      .limit(10);
    const [revertRow] = await db
      .select()
      .from(autoPromotionReverts)
      .where(eq(autoPromotionReverts.auditId, auditId))
      .limit(1);
    const [reviewCountRow] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(autoPromotionReviews)
      .where(eq(autoPromotionReviews.auditId, auditId));
    return {
      audit,
      skill: skillRow ?? null,
      recentUses,
      reverted: revertRow ?? null,
      reviewCount: reviewCountRow?.n ?? 0,
    };
  }

  async function listScanTicks(
    companyId: string,
    guildId: string,
    limit: number,
  ) {
    // db.execute() with postgres.js returns a RowList which IS the array
    const rows = await db.execute<{
      scan_id: string;
      decided_at: string;
      scanned_count: number | null;
      eligible_count: number | null;
      promoted_count: number | null;
      dry_run: boolean;
      failed: boolean;
    }>(sql`
      WITH ranked AS (
        SELECT
          details->>'scanId' AS scan_id,
          MAX(created_at)    AS decided_at,
          MAX(CASE WHEN action IN (
            'guild.skill.auto_promotion_scan',
            'guild.skill.auto_promotion_scan_dryrun',
            'guild.skill.auto_promoted'
          ) THEN (details->>'scannedCount')::int END) AS scanned_count,
          MAX(CASE WHEN action IN (
            'guild.skill.auto_promotion_scan',
            'guild.skill.auto_promotion_scan_dryrun',
            'guild.skill.auto_promoted'
          ) THEN (details->>'eligibleCount')::int END) AS eligible_count,
          MAX(CASE WHEN action IN (
            'guild.skill.auto_promotion_scan',
            'guild.skill.auto_promotion_scan_dryrun',
            'guild.skill.auto_promoted'
          ) THEN (details->>'promotedCount')::int END) AS promoted_count,
          BOOL_OR(action = 'guild.skill.auto_promotion_scan_dryrun') AS dry_run,
          BOOL_OR(action = 'guild.skill.auto_promotion_scan_failed') AS failed
        FROM activity_log
        WHERE company_id = ${companyId}
          AND details->>'guildId' = ${guildId}
          AND action LIKE 'guild.skill.auto_promot%'
          AND details->>'scanId' IS NOT NULL
        GROUP BY details->>'scanId'
      )
      SELECT * FROM ranked ORDER BY decided_at DESC LIMIT ${limit}
    `);
    // RowList from postgres.js is the array itself; spread to a plain array
    return Array.from(rows);
  }

  // Transactional promote for one candidate: re-reads the skill FOR UPDATE
  // to guard against races, then inserts the audit row and flips provenance.
  // Returns { auditId: null, skipped: true } if the skill is no longer eligible.
  // Returns { auditId: null, skipped: false } in dry-run mode (no writes).
  async function promoteOne(
    candidate: {
      id: string;
      distinctRuns: number;
      ageHours: number;
      bodyStableHours: number;
    },
    config: AutoPromotionConfigRow,
    scanId: string,
  ): Promise<{ auditId: string | null; skipped: boolean }> {
    return db.transaction(async (tx) => {
      // FOR UPDATE prevents concurrent flips from racing through the window
      const [skillRow] = await tx
        .select()
        .from(skills)
        .where(eq(skills.id, candidate.id))
        .for("update");
      if (
        !skillRow ||
        skillRow.provenance !== "provisional" ||
        skillRow.retiredAt !== null
      ) {
        return { auditId: null, skipped: true };
      }
      // Re-validate counts in case recordUse ran between eligibility query and lock
      const totalUses = skillRow.successCount + skillRow.failCount;
      if (totalUses < config.minUses) {
        return { auditId: null, skipped: true };
      }
      const ratio = skillRow.successCount / Math.max(1, totalUses);
      if (ratio < Number(config.minSuccessRatio)) {
        return { auditId: null, skipped: true };
      }
      // Dry-run: no DB writes, no audit row
      if (config.dryRun) {
        return { auditId: null, skipped: false };
      }
      const inserted = await tx
        .insert(autoPromotionAudit)
        .values({
          skillId: skillRow.id,
          guildId: skillRow.guildId,
          companyId: skillRow.companyId,
          successCountAtDecision: skillRow.successCount,
          failCountAtDecision: skillRow.failCount,
          totalUsesAtDecision: totalUses,
          distinctRunsAtDecision: candidate.distinctRuns,
          successRatioAtDecision: ratio.toFixed(3),
          skillAgeHoursAtDecision: Math.floor(candidate.ageHours),
          bodyStableHoursAtDecision: Math.floor(candidate.bodyStableHours),
          minUsesThreshold: config.minUses,
          minSuccessRatioThreshold: String(config.minSuccessRatio),
          minAgeHoursThreshold: config.minAgeHours,
          minBodyStableHoursThreshold: config.minBodyStableHours,
          minDistinctRunsThreshold: config.minDistinctRuns,
          scanId,
        })
        .returning({ id: autoPromotionAudit.id });
      await tx
        .update(skills)
        .set({ provenance: "canonical", updatedAt: new Date() })
        .where(eq(skills.id, skillRow.id));
      return { auditId: inserted[0]!.id, skipped: false };
    });
  }

  async function scanGuild(
    scanId: string,
    config: AutoPromotionConfigRow,
  ): Promise<ScanResult> {
    const [guild] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, config.guildId))
      .limit(1);
    const guildSlug = guild?.name ?? null;

    // Eligibility query - fetch up to 2x maxPerTick to have room for diversity filter
    // RowList from postgres.js is iterable as an array directly
    const rawCandidates = await db.execute<{
      id: string;
      name: string;
      success_count: number;
      fail_count: number;
      distinct_runs: number;
      age_hours: number;
      body_stable_hours: number;
    }>(sql`
      SELECT s.id, s.name, s.success_count, s.fail_count,
             (SELECT COUNT(DISTINCT run_id) FROM skill_uses WHERE skill_id = s.id)::int AS distinct_runs,
             EXTRACT(EPOCH FROM (now() - s.created_at))/3600 AS age_hours,
             EXTRACT(EPOCH FROM (now() - s.body_updated_at))/3600 AS body_stable_hours
        FROM skills s
        LEFT JOIN auto_promotion_audit a ON a.skill_id = s.id
       WHERE s.guild_id = ${config.guildId}
         AND s.provenance = 'provisional'
         AND s.retired_at IS NULL
         AND a.skill_id IS NULL
         AND (s.success_count + s.fail_count) >= ${config.minUses}
         AND s.success_count::numeric / NULLIF(s.success_count + s.fail_count, 0) >= ${config.minSuccessRatio}
         AND EXTRACT(EPOCH FROM (now() - s.created_at))/3600 >= ${config.minAgeHours}
         AND EXTRACT(EPOCH FROM (now() - s.body_updated_at))/3600 >= ${config.minBodyStableHours}
       ORDER BY s.success_count DESC, s.created_at ASC
       LIMIT ${config.maxPromotionsPerTick * 2}
    `);

    const candidateRows = Array.from(rawCandidates);
    const scannedCount = candidateRows.length;

    // Diversity gate applied in code (distinct_runs from the subquery)
    const eligible = candidateRows
      .filter((c) => c.distinct_runs >= config.minDistinctRuns)
      .slice(0, config.maxPromotionsPerTick);
    const eligibleCount = eligible.length;

    const promotions: ScanResult["promotions"] = [];
    let failedCount = 0;

    for (const c of eligible) {
      try {
        const ratio = c.success_count / Math.max(1, c.success_count + c.fail_count);
        const result = await promoteOne(
          {
            id: c.id,
            distinctRuns: c.distinct_runs,
            ageHours: c.age_hours,
            bodyStableHours: c.body_stable_hours,
          },
          config,
          scanId,
        );
        if (!result.skipped) {
          promotions.push({
            auditId: result.auditId,
            skillId: c.id,
            skillName: c.name,
            successCount: c.success_count,
            failCount: c.fail_count,
            successRatio: Number(ratio.toFixed(3)),
            distinctRuns: c.distinct_runs,
            skillAgeHours: Math.floor(c.age_hours),
          });
        }
      } catch {
        failedCount += 1;
      }
    }

    const promotedCount = promotions.length;

    // Update health metrics
    await db
      .update(autoPromotionConfig)
      .set({
        lastSuccessfulScanAt: new Date(),
        lastScanId: scanId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(autoPromotionConfig.guildId, config.guildId),
          eq(autoPromotionConfig.companyId, config.companyId),
        ),
      );

    // Summary action selection per spec §5.2 step 8
    let summaryAction: string;
    if (promotedCount > 0 && !config.dryRun) {
      summaryAction = "guild.skill.auto_promoted";
    } else if (promotedCount > 0 && config.dryRun) {
      summaryAction = "guild.skill.auto_promotion_scan_dryrun";
    } else {
      summaryAction = "guild.skill.auto_promotion_scan";
    }

    await logActivity(db, {
      companyId: config.companyId,
      actorType: "system",
      actorId: "auto-promotion-scanner",
      action: summaryAction,
      entityType: "guild",
      entityId: config.guildId,
      details: {
        guildId: config.guildId,
        guildSlug,
        scanId,
        scannedCount,
        eligibleCount,
        promotedCount,
        dryRun: config.dryRun,
        thresholds: {
          minUses: config.minUses,
          minSuccessRatio: Number(config.minSuccessRatio),
          minAgeHours: config.minAgeHours,
          minBodyStableHours: config.minBodyStableHours,
          minDistinctRuns: config.minDistinctRuns,
          maxPerTick: config.maxPromotionsPerTick,
        },
        promotions,
      },
    });

    return {
      scanId,
      scannedCount,
      eligibleCount,
      promotedCount,
      failedCount,
      dryRun: config.dryRun,
      promotions,
    };
  }

  return {
    getConfig,
    patchConfig,
    recordReview,
    revert,
    listAudits,
    getAuditEnvelope,
    listScanTicks,
    scanGuild,
    // Exported for testing races directly
    promoteOne,
  };
}
