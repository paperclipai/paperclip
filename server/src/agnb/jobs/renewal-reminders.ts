import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * renewal-reminders — scan renewals where today is N days before renewal_date
 * for some N in reminder_days_before. Flip status to 'reminded' + stamp
 * last_reminded_at / updated_at. Surfaces on the /renewals page for operator
 * action. Ported from agnb api/internal/renewal-reminders.
 *
 * Translation notes:
 *   - supabase internal.renewals → ctx.db.execute(sql`... FROM agnb.renewals ...`)
 *   - reminder_days_before is an int[] column → read as a JS number array.
 *   - No CRON_SECRET gate. (Push/email is the dispatcher's job; this just
 *     advances renewal state, matching the source which only set status.)
 *
 * Cadence: daily.
 * requiresEnv: none.
 */
export async function renewalReminders(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const today = new Date().toISOString().slice(0, 10);

  const renewals = rows<{
    id: string;
    name: string;
    renewal_date: string;
    reminder_days_before: number[] | null;
  }>(
    await db.execute(sql`
      SELECT id::text AS id, name, renewal_date::text AS renewal_date, reminder_days_before
      FROM agnb.renewals
      WHERE status IN ('upcoming', 'reminded')
      ORDER BY renewal_date ASC
    `),
  );

  let reminded = 0;
  const matches: Array<Record<string, unknown>> = [];
  const todayMs = new Date(today).getTime();

  for (const r of renewals) {
    if (ctx.signal.aborted) break;
    const daysUntil = Math.floor((new Date(r.renewal_date).getTime() - todayMs) / 86_400_000);
    const windows = r.reminder_days_before ?? [];
    if (windows.includes(daysUntil)) {
      await db.execute(sql`
        UPDATE agnb.renewals
        SET status = 'reminded', last_reminded_at = now(), updated_at = now()
        WHERE id = ${r.id}::uuid
      `);
      reminded++;
      matches.push({ name: r.name, days_until: daysUntil, renewal_date: r.renewal_date });
    }
  }

  ctx.log("renewal reminders", { today, total_active: renewals.length, reminded });

  return {
    ok: true,
    processed: reminded,
    today,
    total_active: renewals.length,
    reminded,
    matches,
    summary: `${reminded}/${renewals.length} reminded`,
  };
}
