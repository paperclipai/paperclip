// WS2 seed — one `active` prompt_versions row per (agent, task_class='general').
//
// Idempotent: skips any (agent, 'general') that already has an `active` row, so
// re-running never violates the partial-unique one-active-per-class index and
// never duplicates. Authors a v1 baseline so the learning engine
// (services/oracle-dispatcher/learning.py) always has an active base version to
// refine from. NPI-safe: writes only agent identifiers + a placeholder body.
//
// NOTE: prompt_versions.agent is TEXT (an opaque agent identifier — learning.py
// compares it as a string, never joins it as an FK). This script seeds it with
// the board's `agents.name`. If the consumer expects `agents.id` instead, change
// SEED_AGENT_COLUMN below.
//
// Run (NOT at build time — requires a live DB):
//   tsx packages/db/scripts/seed-prompt-versions.ts --config <path> --base-url <url>
//   (or set DATABASE_URL and run without --config)

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/client.js";
import { agents, promptVersions } from "../src/schema/index.js";

const TASK_CLASS = "general";
const SEED_BODY = "[seed v1 baseline prompt — replace via the gated learning flow]";

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveDbUrl(): string {
  const configPath = readArg("--config");
  if (configPath) {
    const config = JSON.parse(readFileSync(path.resolve(configPath), "utf8")) as {
      database?: { mode?: string; embeddedPostgresPort?: number; connectionString?: string };
    };
    if (config.database?.mode === "postgres" && config.database.connectionString) {
      return config.database.connectionString;
    }
    return `postgres://paperclip:paperclip@127.0.0.1:${config.database?.embeddedPostgresPort ?? 54329}/paperclip`;
  }
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;
  throw new Error("Usage: tsx seed-prompt-versions.ts --config <path> | set DATABASE_URL");
}

async function main() {
  const db = createDb(resolveDbUrl());
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  try {
    // Distinct agent identifiers from the board.
    const rows = await db.select({ name: agents.name }).from(agents);
    const seedAgents = Array.from(new Set(rows.map((r) => r.name))).filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );

    let created = 0;
    let skipped = 0;

    for (const agent of seedAgents) {
      const existing = await db
        .select({ id: promptVersions.id })
        .from(promptVersions)
        .where(
          and(
            eq(promptVersions.agent, agent),
            eq(promptVersions.taskClass, TASK_CLASS),
            eq(promptVersions.status, "active"),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped += 1;
        continue;
      }

      await db.insert(promptVersions).values({
        agent,
        taskClass: TASK_CLASS,
        version: 1,
        body: SEED_BODY,
        status: "active",
        createdBy: "seed-prompt-versions",
      });
      created += 1;
    }

    process.stdout.write(
      `seed-prompt-versions: ${created} created, ${skipped} already-active, ${seedAgents.length} agents total\n`,
    );
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
