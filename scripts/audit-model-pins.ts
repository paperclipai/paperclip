#!/usr/bin/env tsx
/**
 * audit-model-pins.ts
 *
 * BLOCKING audit: scans the `agents` table for any row whose `adapter_config.model`
 * is missing, empty, or fuzzy ("latest" / "auto" / wildcard). Such rows let the
 * underlying provider CLI auto-resolve to whatever ships next, which can silently
 * change agent behavior when a new model version comes online.
 *
 * Exit codes:
 *   0 — all agents have fully-versioned model pins
 *   1 — one or more agents are unpinned; details printed; ABORT any rebuild/restart
 *   2 — could not connect to DB (config or postgres state issue)
 *
 * Run before: pnpm build, container rebuild, model upgrade, paperclipctl restart.
 * Run on cron: weekly + on every paperclip server start (wire into launcher).
 *
 * Usage:
 *   tsx scripts/audit-model-pins.ts
 *   tsx scripts/audit-model-pins.ts --json    # machine-readable output
 */

import { Client } from "pg";

const CONN = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? "paperclip",
  password: process.env.PGPASSWORD ?? "paperclip",
  database: process.env.PGDATABASE ?? "paperclip",
};

const FUZZY = /\b(latest|auto|\*)\b/i;
const jsonOut = process.argv.includes("--json");

type AgentRow = {
  id: string;
  name: string;
  role: string;
  adapter_type: string;
  model: string | null;
  status: string;
  company: string;
};

async function main(): Promise<number> {
  const client = new Client(CONN);
  try {
    await client.connect();
  } catch (e) {
    console.error(`[audit-model-pins] cannot connect to postgres: ${(e as Error).message}`);
    return 2;
  }

  let bad: AgentRow[] = [];
  let total = 0;

  try {
    const res = await client.query<AgentRow>(`
      SELECT a.id,
             a.name,
             a.role,
             a.adapter_type,
             a.adapter_config ->> 'model' AS model,
             a.status,
             c.name AS company
        FROM agents a
   LEFT JOIN companies c ON c.id = a.company_id
    ORDER BY c.name NULLS LAST, a.role, a.name
    `);
    total = res.rows.length;
    bad = res.rows.filter((r) => {
      const m = (r.model ?? "").trim();
      return m === "" || FUZZY.test(m);
    });
  } finally {
    await client.end();
  }

  if (jsonOut) {
    console.log(JSON.stringify({ totalAgents: total, badPins: bad }, null, 2));
  } else {
    console.log(`[audit-model-pins] scanned ${total} agents`);
    if (bad.length === 0) {
      console.log(`[audit-model-pins] OK — all agents have fully-versioned model pins`);
    } else {
      console.error(`[audit-model-pins] FAIL — ${bad.length} agents have invalid pins:`);
      for (const r of bad) {
        console.error(
          `  - ${r.company ?? "(no company)"} / ${r.name} (role=${r.role}, status=${r.status}, adapter=${r.adapter_type}) — model="${r.model ?? "<NULL>"}"`,
        );
      }
      console.error(
        `\n[audit-model-pins] DO NOT proceed with rebuild / restart. Pin every agent's adapter_config.model to a fully-versioned id (e.g. "claude-opus-4-7", "claude-sonnet-4-6").`,
      );
    }
  }

  return bad.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[audit-model-pins] unexpected error: ${(e as Error).stack}`);
  process.exit(2);
});
