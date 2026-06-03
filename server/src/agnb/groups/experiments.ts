import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: experiments (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/experiments.
 *
 * PHASE 5: experiments/[id]/next-variant — Thompson-sampling bandit pick (pickVariant compute).
 * PHASE 5: experiments/recompute-verdicts — Bayesian Beta-Binomial stats + event emission (worker/cron).
 * Those stay cross-origin; only the pure DB read is ported here.
 */
export function registerExperiments(router: Router, db: Db) {
  /** GET /api/agnb/experiments — A/B experiments list. */
  router.get("/agnb/experiments", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, title, hypothesis, metric, outcome, started_at, ended_at,
             created_by, verdict, p_b_beats_a,
             variant_a_sent, variant_b_sent, variant_a_replies, variant_b_replies
      FROM agnb.experiments
      ORDER BY started_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, experiments: rows(result) });
  });

  /** GET /api/agnb/csv — CSV upload history. */
  router.get("/agnb/csv", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, filename, rows_total, rows_kept, rows_dedup, rows_suppressed,
             status, rocket_file_id, uploaded_at
      FROM agnb.csv_uploads
      ORDER BY uploaded_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, uploads: rows(result) });
  });

  /** GET /api/agnb/subjects — subject-line performance, best reply rate first. */
  router.get("/agnb/subjects", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, subject, first_word, length_chars, campaign_name,
             sends, opens, replies, open_rate, reply_rate, pattern_tags, created_at
      FROM agnb.subject_lines
      ORDER BY reply_rate DESC
      LIMIT 200
    `);
    res.json({ ok: true, subjects: rows(result) });
  });

  /** GET /api/agnb/cohorts — ICP×week positive-rate heatmap source (last 12w). */
  router.get("/agnb/cohorts", async (req, res) => {
    assertBoardOrgAccess(req);
    const since = new Date(Date.now() - 84 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [snapshots, buckets, icps] = await Promise.all([
      db.execute(sql`
        SELECT bucket_id, snapshot_date, total_sent, total_positive
        FROM agnb.bucket_snapshots
        WHERE snapshot_date >= ${since}
      `),
      db.execute(sql`SELECT id, icp_id FROM agnb.experiment_buckets`),
      db.execute(sql`SELECT id, name, tier FROM agnb.icps`),
    ]);
    res.json({ ok: true, snapshots: rows(snapshots), buckets: rows(buckets), icps: rows(icps) });
  });
}
