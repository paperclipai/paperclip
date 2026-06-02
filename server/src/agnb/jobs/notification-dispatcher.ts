import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { notify } from "../lib/notify.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * notification-dispatcher — scan recent rows across domains and fire
 * notifications for high-severity events not yet notified. agnb.notifications
 * (kind + source_id) is the dedupe ledger.
 * Ported from agnb api/internal/notification-dispatcher.
 *
 * Triggers:
 *   crm_critical        — new fail-severity CRM hygiene issue (last 24h)
 *   blog_publish_fail   — blog_drafts.status = 'failed' (last 24h)
 *   rzp_paid            — topup_links flipped to 'paid' (last 24h)
 *   renewal_due         — renewals due in next 7d, not yet notified
 *   backlink_high_rank  — backlink_prospects with domain_rank >= 7 (last 7d)
 *   anomaly             — daily_metrics_snapshots high-severity anomaly today
 *
 * Translation notes:
 *   - supabase internal.* → ctx.db.execute(sql`... FROM agnb.* ...`)
 *   - notify() now takes ctx.db as first arg (writes agnb.notifications).
 *   - uuid ids cast ::text to compare against notifications.source_id (text).
 *   - No CRON_SECRET gate. Slack/email inside notify() no-op if env missing.
 *
 * Cadence: every 5–15 min.
 * requiresEnv: none (SLACK_WEBHOOK_URL / RESEND_API_KEY optional; DB rows
 *   always written so the HQ feed populates even without push channels).
 */
export async function notificationDispatcher(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const fired: Array<{ kind: string; source_id: string; pushed: string[] }> = [];

  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const next7dDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const alreadyNotified = async (kind: string, sourceId: string): Promise<boolean> => {
    const res = await db.execute(sql`
      SELECT id FROM agnb.notifications
      WHERE kind = ${kind} AND source_id = ${sourceId} LIMIT 1
    `);
    return rows(res).length > 0;
  };

  // 1. CRM critical issues
  if (!ctx.signal.aborted) {
    const crm = rows<{
      id: string;
      hubspot_object_name: string;
      issue_type: string;
      details: string | null;
    }>(
      await db.execute(sql`
        SELECT id::text AS id, hubspot_object_name, issue_type, details
        FROM agnb.crm_hygiene_issues
        WHERE severity = 'fail' AND resolved_at IS NULL AND detected_at >= ${since24h}
        LIMIT 20
      `),
    );
    for (const i of crm) {
      if (ctx.signal.aborted) break;
      if (await alreadyNotified("crm_critical", i.id)) continue;
      const r = await notify(db, {
        kind: "crm_critical",
        severity: "critical",
        source_kind: "crm_hygiene_issue",
        source_id: i.id,
        title: `CRM critical: ${i.issue_type} on ${i.hubspot_object_name}`,
        body: i.details ?? undefined,
        link: "/all-gas-no-brakes/crm-hygiene",
      });
      fired.push({ kind: "crm_critical", source_id: i.id, pushed: r.pushed });
    }
  }

  // 2. Blog publish failures
  if (!ctx.signal.aborted) {
    const blogs = rows<{ id: string; title: string; error_message: string | null }>(
      await db.execute(sql`
        SELECT id::text AS id, title, error_message
        FROM agnb.blog_drafts
        WHERE status = 'failed' AND updated_at >= ${since24h}
        LIMIT 10
      `),
    );
    for (const b of blogs) {
      if (ctx.signal.aborted) break;
      if (await alreadyNotified("blog_publish_fail", b.id)) continue;
      const r = await notify(db, {
        kind: "blog_publish_fail",
        severity: "critical",
        source_kind: "blog_draft",
        source_id: b.id,
        title: `Blog publish failed: ${b.title}`,
        body: b.error_message ?? "Check editor for details.",
        link: "/all-gas-no-brakes/blog-automation",
      });
      fired.push({ kind: "blog_publish_fail", source_id: b.id, pushed: r.pushed });
    }
  }

  // 3. Razorpay paid
  if (!ctx.signal.aborted) {
    const paid = rows<{
      id: string;
      customer_name: string;
      total_paise: number | null;
      amount_paise: number | null;
    }>(
      await db.execute(sql`
        SELECT id::text AS id, customer_name, total_paise, amount_paise
        FROM agnb.topup_links
        WHERE status = 'paid' AND paid_at >= ${since24h}
        LIMIT 20
      `),
    );
    for (const p of paid) {
      if (ctx.signal.aborted) break;
      if (await alreadyNotified("rzp_paid", p.id)) continue;
      const total = (p.total_paise ?? p.amount_paise ?? 0) / 100;
      const r = await notify(db, {
        kind: "rzp_paid",
        severity: "info",
        source_kind: "topup_link",
        source_id: p.id,
        title: `💸 ${p.customer_name} paid ₹${total.toLocaleString("en-IN")}`,
        link: "/all-gas-no-brakes/invoices",
        push: true, // paid events worth pushing despite info severity
      });
      fired.push({ kind: "rzp_paid", source_id: p.id, pushed: r.pushed });
    }
  }

  // 4. Renewals due in next 7d
  if (!ctx.signal.aborted) {
    const due = rows<{
      id: string;
      name: string;
      kind: string;
      vendor: string | null;
      renewal_date: string;
      amount_paise: number | null;
      currency: string | null;
    }>(
      await db.execute(sql`
        SELECT id::text AS id, name, kind, vendor, renewal_date::text AS renewal_date,
               amount_paise, currency
        FROM agnb.renewals
        WHERE renewal_date <= ${next7dDate} AND renewal_date >= ${today}
          AND status IN ('upcoming', 'reminded')
        LIMIT 20
      `),
    );
    for (const r0 of due) {
      if (ctx.signal.aborted) break;
      if (await alreadyNotified("renewal_due", r0.id)) continue;
      const daysLeft = Math.floor(
        (new Date(r0.renewal_date).getTime() - new Date(today).getTime()) / 86_400_000,
      );
      const amt = r0.amount_paise
        ? ` · ${r0.currency === "USD" ? "$" : "₹"}${(r0.amount_paise / 100).toLocaleString("en-IN")}`
        : "";
      const r = await notify(db, {
        kind: "renewal_due",
        severity: daysLeft <= 2 ? "critical" : "warn",
        source_kind: "renewal",
        source_id: r0.id,
        title: `Renewal in ${daysLeft}d: ${r0.name}`,
        body: `${r0.kind}${r0.vendor ? ` · ${r0.vendor}` : ""}${amt} · due ${r0.renewal_date}`,
        link: "/all-gas-no-brakes/renewals",
      });
      fired.push({ kind: "renewal_due", source_id: r0.id, pushed: r.pushed });
    }
  }

  // 5. High-rank backlink prospects (rank >= 7)
  if (!ctx.signal.aborted) {
    const prospects = rows<{
      id: string;
      source_domain: string;
      domain_rank: number | null;
      competitor_name: string | null;
      notes: string | null;
    }>(
      await db.execute(sql`
        SELECT id::text AS id, source_domain, domain_rank, competitor_name, notes
        FROM agnb.backlink_prospects
        WHERE domain_rank >= 7 AND status = 'new' AND discovered_at >= ${since7d}
        LIMIT 20
      `),
    );
    for (const p of prospects) {
      if (ctx.signal.aborted) break;
      if (await alreadyNotified("backlink_high_rank", p.id)) continue;
      const r = await notify(db, {
        kind: "backlink_high_rank",
        severity: "warn",
        source_kind: "backlink_prospect",
        source_id: p.id,
        title: `High-DA prospect: ${p.source_domain} (rank ${p.domain_rank})`,
        body: `${p.notes ?? ""} · from competitor: ${p.competitor_name ?? "—"}`,
        link: "/all-gas-no-brakes/backlink-prospects",
      });
      fired.push({ kind: "backlink_high_rank", source_id: p.id, pushed: r.pushed });
    }
  }

  // 6. Anomalies (today's snapshot, high-severity only)
  if (!ctx.signal.aborted) {
    const snap = rows<{ anomalies: unknown }>(
      await db.execute(sql`
        SELECT anomalies FROM agnb.daily_metrics_snapshots
        WHERE snapshot_date = ${today} LIMIT 1
      `),
    )[0];
    const anomalies = Array.isArray(snap?.anomalies)
      ? (snap!.anomalies as Array<{ metric: string; today: number; wow_pct: number; severity: string }>)
      : [];
    for (const a of anomalies) {
      if (ctx.signal.aborted) break;
      if (a.severity !== "high") continue;
      const sourceId = `${today}:${a.metric}`;
      if (await alreadyNotified("anomaly", sourceId)) continue;
      const r = await notify(db, {
        kind: "anomaly",
        severity: "warn",
        source_kind: "anomaly",
        source_id: sourceId,
        title: `Anomaly: ${a.metric} ${a.wow_pct > 0 ? "+" : ""}${a.wow_pct.toFixed(0)}% vs 7d avg`,
        body: `today: ${a.today}`,
        link: "/all-gas-no-brakes/dashboard",
      });
      fired.push({ kind: "anomaly", source_id: sourceId, pushed: r.pushed });
    }
  }

  ctx.log("notification dispatch done", {
    fired: fired.length,
    slack: fired.filter((f) => f.pushed.includes("slack")).length,
    email: fired.filter((f) => f.pushed.includes("email")).length,
  });

  return {
    ok: true,
    processed: fired.length,
    fired,
    summary: `${fired.length} notifications fired`,
  };
}
