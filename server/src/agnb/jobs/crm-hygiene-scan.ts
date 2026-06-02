import { sql } from "drizzle-orm";
import { hsFetch, hubspotConfigured, type HsDeal, type HsContact } from "../lib/hubspot.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * crm-hygiene-scan — daily HubSpot scanner. Ported from agnb
 * api/internal/crm-hygiene-scan. Pulls deals + contacts and flags:
 *   stale, missing_close_date, missing_owner, stuck_in_stage (deals)
 *   missing_email, missing_phone, duplicate (contacts)
 * Upserts into agnb.crm_hygiene_issues and auto-resolves issues that no
 * longer match on this scan. Requires HUBSPOT_TOKEN (or HUBSPOT_API_KEY).
 */
const STALE_DAYS = 30;
const STUCK_DAYS = 14;

type Issue = {
  object_type: "deal" | "contact";
  object_id: string;
  object_name: string;
  issue_type: string;
  severity: string;
  details: string;
};

async function scanDeals(signal: AbortSignal): Promise<Issue[]> {
  const issues: Issue[] = [];
  const now = Date.now();
  let after: string | undefined;
  let pages = 0;
  do {
    if (signal.aborted) break;
    const params = new URLSearchParams({
      properties: "dealname,dealstage,closedate,hubspot_owner_id,hs_lastmodifieddate,createdate",
      limit: "100",
    });
    if (after) params.set("after", after);
    const r = await hsFetch<HsDeal>(`/crm/v3/objects/deals?${params}`);
    for (const d of r.results) {
      const name = d.properties.dealname ?? `Deal ${d.id}`;
      const stage = d.properties.dealstage ?? "";
      const isOpen = stage !== "closedwon" && stage !== "closedlost";
      const lastMod = d.properties.hs_lastmodifieddate ? new Date(d.properties.hs_lastmodifieddate).getTime() : 0;
      const created = d.properties.createdate ? new Date(d.properties.createdate).getTime() : 0;
      const daysSinceMod = lastMod ? Math.floor((now - lastMod) / 86_400_000) : 999;
      const daysSinceCreate = created ? Math.floor((now - created) / 86_400_000) : 0;

      if (isOpen && daysSinceMod > STALE_DAYS) issues.push({ object_type: "deal", object_id: d.id, object_name: name, issue_type: "stale", severity: "warn", details: `no activity in ${daysSinceMod}d` });
      if (isOpen && !d.properties.closedate) issues.push({ object_type: "deal", object_id: d.id, object_name: name, issue_type: "missing_close_date", severity: "warn", details: "no expected close date" });
      if (isOpen && !d.properties.hubspot_owner_id) issues.push({ object_type: "deal", object_id: d.id, object_name: name, issue_type: "missing_owner", severity: "fail", details: "no owner assigned" });
      if (isOpen && daysSinceCreate > STUCK_DAYS && daysSinceMod > STUCK_DAYS) {
        issues.push({ object_type: "deal", object_id: d.id, object_name: name, issue_type: "stuck_in_stage", severity: "warn", details: `${daysSinceMod}d in '${stage}'` });
      }
    }
    after = r.paging?.next?.after;
    pages++;
    if (pages >= 5) break; // cap to avoid runaway
  } while (after);
  return issues;
}

async function scanContacts(signal: AbortSignal): Promise<Issue[]> {
  const issues: Issue[] = [];
  const seenEmails = new Map<string, string[]>();
  let after: string | undefined;
  let pages = 0;
  do {
    if (signal.aborted) break;
    const params = new URLSearchParams({ properties: "firstname,lastname,email,phone", limit: "100" });
    if (after) params.set("after", after);
    const r = await hsFetch<HsContact>(`/crm/v3/objects/contacts?${params}`);
    for (const c of r.results) {
      const name = `${c.properties.firstname ?? ""} ${c.properties.lastname ?? ""}`.trim() || `Contact ${c.id}`;
      if (!c.properties.email) {
        issues.push({ object_type: "contact", object_id: c.id, object_name: name, issue_type: "missing_email", severity: "warn", details: "no email on record" });
      } else {
        const e = c.properties.email.toLowerCase().trim();
        const cur = seenEmails.get(e) ?? [];
        cur.push(c.id);
        seenEmails.set(e, cur);
      }
      if (!c.properties.phone) {
        issues.push({ object_type: "contact", object_id: c.id, object_name: name, issue_type: "missing_phone", severity: "info", details: "no phone (outbound blocked)" });
      }
    }
    after = r.paging?.next?.after;
    pages++;
    if (pages >= 5) break;
  } while (after);
  for (const [email, ids] of seenEmails.entries()) {
    if (ids.length > 1) {
      for (const id of ids) issues.push({ object_type: "contact", object_id: id, object_name: email, issue_type: "duplicate", severity: "fail", details: `${ids.length} contacts share email '${email}'` });
    }
  }
  return issues;
}

export async function crmHygieneScan(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!hubspotConfigured()) {
    return { ok: true, summary: "skipped: HUBSPOT_TOKEN / HUBSPOT_API_KEY not set" };
  }

  let dealIssues: Issue[] = [];
  let contactIssues: Issue[] = [];
  const errors: string[] = [];
  try { dealIssues = await scanDeals(ctx.signal); } catch (e) { errors.push(`deals: ${e instanceof Error ? e.message : String(e)}`); }
  try { contactIssues = await scanContacts(ctx.signal); } catch (e) { errors.push(`contacts: ${e instanceof Error ? e.message : String(e)}`); }
  const all = [...dealIssues, ...contactIssues];

  let upserts = 0;
  for (const i of all) {
    if (ctx.signal.aborted) break;
    const r = await db.execute(sql`
      INSERT INTO agnb.crm_hygiene_issues
        (hubspot_object_type, hubspot_object_id, hubspot_object_name, issue_type, severity, details, detected_at, resolved_at)
      VALUES (${i.object_type}, ${i.object_id}, ${i.object_name}, ${i.issue_type}, ${i.severity}, ${i.details}, now(), NULL)
      ON CONFLICT (hubspot_object_type, hubspot_object_id, issue_type) DO UPDATE SET
        hubspot_object_name = EXCLUDED.hubspot_object_name,
        severity = EXCLUDED.severity,
        details = EXCLUDED.details,
        detected_at = now(),
        resolved_at = NULL
    `);
    upserts += (r as { rowCount?: number })?.rowCount ?? 0;
  }

  // Auto-resolve: any unresolved issue NOT in this scan → mark resolved.
  const stillExisting = new Set(all.map((i) => `${i.object_type}:${i.object_id}:${i.issue_type}`));
  const unresolved = rows<{ id: string; hubspot_object_type: string; hubspot_object_id: string; issue_type: string }>(
    await db.execute(sql`
      SELECT id, hubspot_object_type, hubspot_object_id, issue_type
      FROM agnb.crm_hygiene_issues WHERE resolved_at IS NULL
    `)
  );
  let resolved = 0;
  for (const u of unresolved) {
    if (ctx.signal.aborted) break;
    const key = `${u.hubspot_object_type}:${u.hubspot_object_id}:${u.issue_type}`;
    if (!stillExisting.has(key)) {
      await db.execute(sql`UPDATE agnb.crm_hygiene_issues SET resolved_at = now() WHERE id = ${u.id}`);
      resolved++;
    }
  }

  ctx.log("crm hygiene scan done", { deals: dealIssues.length, contacts: contactIssues.length, upserts, resolved, errors });
  return {
    ok: errors.length === 0,
    deal_issues: dealIssues.length,
    contact_issues: contactIssues.length,
    upserts,
    auto_resolved: resolved,
    errors,
    summary: `${all.length} issues, ${resolved} auto-resolved`,
  };
}
