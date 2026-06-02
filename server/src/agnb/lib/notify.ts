import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * Centralized notification helper. Ported from agnb lib/agnb/notify.ts.
 *
 * Channels (each fires independently):
 *   1. DB row in agnb.notifications (always — backs the HQ feed + dedupe)
 *   2. Slack webhook if SLACK_WEBHOOK_URL set
 *   3. Email via Resend if RESEND_API_KEY + NOTIFY_TO_EMAILS set
 *
 * Differences from the agnb route version:
 *   - Takes an explicit `db` handle instead of building a supabase client.
 *   - Writes to `agnb.notifications` (was `internal.notifications`).
 *   - No CRON gate (caller is a trusted scheduler).
 * Missing env keys → that channel no-ops gracefully.
 */

export interface NotifyInput {
  kind: string;
  severity: "info" | "warn" | "critical";
  title: string;
  body?: string;
  link?: string;
  source_kind?: string;
  source_id?: string;
  /** Override default: critical+warn pushed, info DB-only. */
  push?: boolean;
}

const SEV_EMOJI: Record<string, string> = { critical: "🚨", warn: "⚠️", info: "ℹ️" };

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_AGNB_BASE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000"
  );
}

async function pushSlack(input: NotifyInput): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const emoji = SEV_EMOJI[input.severity] ?? "•";
  const link = input.link ? `<${baseUrl()}${input.link}|Open in AGNB>` : "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `${emoji} *${input.title}*${input.body ? `\n${input.body}` : ""}${link ? `\n${link}` : ""}`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function pushEmail(input: NotifyInput): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_TO_EMAILS;
  const from = process.env.NOTIFY_FROM_EMAIL ?? "ops@hirefinn.ai";
  if (!apiKey || !to) return false;
  const emoji = SEV_EMOJI[input.severity] ?? "•";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map((e) => e.trim()),
        subject: `${emoji} ${input.title}`,
        html: `
          <p><strong>${input.title}</strong></p>
          ${input.body ? `<p>${input.body}</p>` : ""}
          ${input.link ? `<p><a href="${baseUrl()}${input.link}">Open in AGNB</a></p>` : ""}
          <p style="font-size:11px;color:#888;">severity: ${input.severity} · kind: ${input.kind}</p>`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function notify(
  db: Db,
  input: NotifyInput,
): Promise<{ stored: boolean; pushed: string[] }> {
  const shouldPush = input.push ?? (input.severity === "critical" || input.severity === "warn");

  const channels: string[] = [];
  if (shouldPush) {
    if (await pushSlack(input)) channels.push("slack");
    if (await pushEmail(input)) channels.push("email");
  }

  let stored = false;
  try {
    await db.execute(sql`
      INSERT INTO agnb.notifications
        (kind, severity, title, body, link, source_kind, source_id, pushed_at, pushed_channels)
      VALUES (
        ${input.kind},
        ${input.severity},
        ${input.title.slice(0, 200)},
        ${input.body?.slice(0, 1500) ?? null},
        ${input.link ?? null},
        ${input.source_kind ?? null},
        ${input.source_id ?? null},
        ${channels.length > 0 ? new Date().toISOString() : null},
        ${channels}::text[]
      )
    `);
    stored = true;
  } catch {
    stored = false;
  }

  return { stored, pushed: channels };
}
