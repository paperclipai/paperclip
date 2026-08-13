// synthesize-agent-activity.ts — read-only rollup of agent logs into an improvement backlog.
//
// Aggregates the last N days of a company's issue_comments / activity_log / issues /
// decisions / feedback_votes into WINS / RECURRING-BLOCKS / FEEDBACK / IDEAS, and maps each
// recurring-block bucket to the server tuning knob that addresses it (closing the loop with
// the block-noise fixes). Writes a Markdown report to the vault and prints a summary.
//
//   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
//     tsx scripts/synthesize-agent-activity.ts --company <id> --days 7 [--out <path>]
//
// Purely read-only: SELECTs only, via the pg client the drizzle instance already holds. Each
// query is guarded so a missing table/column degrades that section instead of aborting.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

function flag(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

// Each recurring-block bucket maps 1:1 to a Workstream-1 tuning knob (see the plan).
const KNOB_MAP: Array<{ test: RegExp; knob: string }> = [
  { test: /disposition|next step|retried continuation|could not resolve/i, knob: "successful-run-handoff attempts (raised 1->3)" },
  { test: /liveness|no output|stalled|stopped|stranded|stale active run/i, knob: "recovery liveness thresholds (1h/4h -> 2h/8h)" },
  { test: /deny_default|no allowing profile|permitted_connections_not_installed|tool.*denied/i, knob: "baseline tools:use grant per agent (D1)" },
  { test: /cross[_ -]issue influence|influence cap/i, knob: "CROSS_ISSUE_INFLUENCE_LIMIT (20 -> 100, env)" },
  { test: /review[_ ]policy|invalid_review_participant|in_review_without_action/i, knob: "reviewPolicy -> anyone for internal issues (D6)" },
  { test: /budget|paused|hard[_ -]?stop/i, knob: "company budget hard-stop -> warn-only (D2)" },
  { test: /productivity review|churn|no[_ -]comment streak/i, knob: "productivity-review thresholds (10->20 / 6h->12h)" },
];
const knobFor = (text: string): string => KNOB_MAP.find((k) => k.test.test(text))?.knob ?? "—";
const lead = (body: string): string => String(body || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

type Row = Record<string, unknown>;

async function main() {
  const config = loadConfig() as { databaseUrl?: string; embeddedPostgresPort?: number };
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl) as unknown as { $client?: { unsafe: (t: string, p?: unknown[]) => Promise<Row[]> } };
  const client = db.$client;
  if (typeof client?.unsafe !== "function") throw new Error("could not access postgres-js client (.$client.unsafe)");

  const company = flag("--company", "54f418d2-d1ef-400f-9f09-684246293de1")!;
  const days = Number(flag("--days", "7"));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const q = async (label: string, text: string, params: unknown[]): Promise<Row[]> => {
    try {
      return [...(await client.unsafe(text, params))];
    } catch (e) {
      console.error(`  (skipped ${label}: ${(e as Error).message.slice(0, 100)})`);
      return [];
    }
  };

  const wins = await q("wins",
    `select coalesce(p.name,'unassigned') as project, count(*)::int as n
     from issues i left join projects p on p.id = i.project_id
     where i.company_id = $1 and i.status = 'done' and i.updated_at > $2
     group by 1 order by 2 desc limit 12`, [company, cutoff]);
  const winsTotal = wins.reduce((a, r) => a + Number(r.n), 0);

  const blocks = await q("blocks",
    `select left(regexp_replace(body, E'[\\n\\r]+', ' ', 'g'), 90) as lead,
            presentation->>'tone' as tone, count(*)::int as n
     from issue_comments
     where company_id = $1 and created_at > $2 and presentation->>'tone' in ('warning','danger')
     group by 1,2 order by 3 desc limit 25`, [company, cutoff]);

  const spawned = await q("spawned",
    `select coalesce(origin_kind,'user/manual') as origin, count(*)::int as n
     from issues where company_id = $1 and created_at > $2
     group by 1 order by 2 desc limit 15`, [company, cutoff]);

  const statusDist = await q("status",
    `select status, count(*)::int as n from issues where company_id = $1 group by 1 order by 2 desc`, [company]);

  const feedback = await q("feedback",
    `select vote, count(*)::int as n, min(reason) as sample
     from feedback_votes where company_id = $1 and created_at > $2 group by 1 order by 2 desc`, [company, cutoff]);

  const ideas = await q("ideas",
    `select title from decisions
     where company_id = $1 and status = 'open' order by created_at desc limit 15`, [company]);

  const blockBuckets = blocks.map((b) => ({ lead: lead(String(b.lead)), tone: String(b.tone), n: Number(b.n), knob: knobFor(String(b.lead)) }));
  const byKnob = new Map<string, number>();
  for (const b of blockBuckets) byKnob.set(b.knob, (byKnob.get(b.knob) ?? 0) + b.n);
  const knobRanked = [...byKnob.entries()].sort((a, b) => b[1] - a[1]);

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const md: string[] = [];
  md.push(`---\ntitle: Twenty Four — Agent Activity Synthesis\nsurface: code\ngenerated: ${now}\nwindow_days: ${days}\ncompany: ${company}\n---\n`);
  md.push(`# Twenty Four — Agent Activity Synthesis`);
  md.push(`_Last ${days} days · generated ${now} · read-only rollup of agent logs._\n`);

  md.push(`## TL;DR — recurring blocks → tuning knob`);
  if (knobRanked.length) {
    md.push(`| block family | comments | tuning knob |`, `|---|---:|---|`);
    for (const [knob, n] of knobRanked) md.push(`| ${knob === "—" ? "(uncategorized)" : knob.split(" (")[0]} | ${n} | ${knob} |`);
  } else md.push(`_No warning/danger comments in the window — quiet._`);
  md.push("");

  md.push(`## Wins (${winsTotal} issues reached \`done\`)`);
  if (wins.length) for (const w of wins) md.push(`- **${w.project}** — ${w.n} done`);
  else md.push(`_No done transitions recorded in the window._`);
  md.push("");

  md.push(`## Recurring blocks (warning/danger comments)`);
  if (blockBuckets.length) {
    md.push(`| n | tone | lead | knob |`, `|---:|---|---|---|`);
    for (const b of blockBuckets) md.push(`| ${b.n} | ${b.tone} | ${b.lead.replace(/\|/g, "\\|")} | ${b.knob === "—" ? "" : b.knob.split(" (")[0]} |`);
  } else md.push(`_None._`);
  md.push("");

  md.push(`## Self-spawned issue volume (noise multiplier)`);
  if (spawned.length) for (const s of spawned) md.push(`- \`${s.origin}\` — ${s.n}`);
  md.push("");

  md.push(`## Feedback (thumbs)`);
  if (feedback.length) for (const f of feedback) md.push(`- ${f.vote}: ${f.n}${f.sample ? ` — e.g. "${String(f.sample).slice(0, 80)}"` : ""}`);
  else md.push(`_No feedback votes in the window (agents aren't emitting them yet — worth a "log a win" habit)._`);
  md.push("");

  md.push(`## Ideas / open decisions`);
  if (ideas.length) for (const d of ideas) md.push(`- **${d.title}**${d.summary ? ` — ${String(d.summary).slice(0, 120)}` : ""}`);
  else md.push(`_No open decisions._`);
  md.push("");

  md.push(`## Appendix — current issue status`);
  for (const s of statusDist) md.push(`- ${s.status}: ${s.n}`);
  md.push("");

  const report = md.join("\n");
  const outPath = flag("--out") || join(homedir(), "obsidian", "Areas", "Twenty Four - Agent Activity Synthesis.md");
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, report, "utf8");
    console.log(`\nReport written: ${outPath}`);
  } catch (e) {
    const fallback = join(process.cwd(), "agent-activity-synthesis.md");
    writeFileSync(fallback, report, "utf8");
    console.log(`\n(vault write failed: ${(e as Error).message}) — wrote ${fallback}`);
  }

  // ---- flywheel close (WS2a): bucket -> ONE auto-filed improvement issue ----
  // The report alone required a human to transcribe the worklist; this files it. One idempotent
  // issue per knob bucket at/above --improve-min (default 5) block-comments in the window.
  // Dedup: an OPEN issue with the same "[flywheel] Tune:" marker title — at most one per knob
  // while it remains open; a done/cancelled one no longer blocks re-filing on a later recurrence.
  // Assigned to the human OWNER (user principal): every auto-oracle (orphan/stuck/heal) skips
  // user-owned issues, so this creates zero agent churn — the knob CHANGE stays human-approved
  // (WS2b, deliberately: no auto-tuner).
  const improveMin = Number(flag("--improve-min", "5"));
  if (!process.argv.includes("--no-file-issues")) {
    try {
      const auth = JSON.parse(readFileSync(join(homedir(), ".paperclip/auth.json"), "utf8")) as {
        credentials?: Record<string, Record<string, unknown>>;
      };
      const tok = Object.values(auth.credentials ?? {})
        .map((c) => c && (c.token || c.accessToken || c.sessionToken || c.apiKey))
        .find(Boolean) as string | undefined;
      if (!tok) throw new Error("no API token in ~/.paperclip/auth.json");
      const base = "http://localhost:3100";
      const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
      const openStatuses = new Set(["backlog", "todo", "in_progress", "blocked", "in_review"]);
      const issuesRes = await fetch(`${base}/api/companies/${company}/issues?limit=400`, { headers: H });
      const issuesJson = (await issuesRes.json()) as { issues?: Row[] } | Row[];
      const allIssues = Array.isArray(issuesJson) ? issuesJson : (issuesJson.issues ?? []);
      const membersRes = await fetch(`${base}/api/companies/${company}/members`, { headers: H });
      const membersJson = (await membersRes.json()) as { members?: Array<Record<string, string>> };
      const ownerUserId = (membersJson.members ?? []).find(
        (m) => m.principalType === "user" && m.membershipRole === "owner" && m.status === "active",
      )?.principalId ?? null;
      let filed = 0;
      for (const [knob, n] of knobRanked) {
        if (knob === "—" || n < improveMin) continue;
        const title = `[flywheel] Tune: ${knob.split(" (")[0]}`.slice(0, 80);
        if (allIssues.some((i) => i.title === title && openStatuses.has(String(i.status)))) continue;
        const samples = blockBuckets.filter((b) => b.knob === knob).slice(0, 3)
          .map((b) => `- (${b.n}x, ${b.tone}) ${b.lead}`).join("\n");
        const body: Record<string, unknown> = {
          title,
          status: "todo",
          description:
            `Auto-filed by the weekly agent-activity synthesis (flywheel WS2a): ${n} warning/danger ` +
            `block-comments in the last ${days}d map to this tuning knob.\n\nKnob: ${knob}\n\nSample leads:\n${samples}\n\n` +
            `This is a HUMAN-approved tuning decision (no auto-tuner by design): apply the knob change or close ` +
            `as won't-fix. Deduplicated — at most one open issue per knob; closing it allows a later recurrence to re-file.`,
        };
        if (ownerUserId) body.assigneeUserId = ownerUserId;
        let res = await fetch(`${base}/api/companies/${company}/issues`, { method: "POST", headers: H, body: JSON.stringify(body) });
        if (!res.ok && ownerUserId) {
          delete body.assigneeUserId; // owner-assign rejected by validation -> file unassigned rather than not at all
          res = await fetch(`${base}/api/companies/${company}/issues`, { method: "POST", headers: H, body: JSON.stringify(body) });
        }
        if (res.ok) { filed++; console.log(`  filed improvement issue: ${title} (${n} block-comments)`); }
        else console.log(`  improvement-issue POST failed HTTP ${res.status} for "${title}"`);
      }
      console.log(`flywheel: ${filed} improvement issue(s) filed (threshold ${improveMin}, dedup'd)`);
    } catch (e) {
      console.log(`flywheel: issue filing skipped (${(e as Error).message.slice(0, 100)}) — report still written`);
    }
  }

  console.log(`=== SUMMARY (${days}d, company ${company.slice(0, 8)}) ===`);
  console.log(`wins: ${winsTotal} done · block-comments: ${blockBuckets.reduce((a, b) => a + b.n, 0)} · top knob: ${knobRanked[0]?.[0] ?? "n/a"}`);
  process.exit(0);
}

void main().catch((error) => {
  console.error("synthesize-agent-activity failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
