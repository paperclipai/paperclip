import { Command } from "commander";
import pc from "picocolors";
import { eq, desc } from "drizzle-orm";
import { createDb, routineCheckRuns } from "@paperclipai/db";
import { buildRegistry } from "@paperclipai/server/routine-checks";
import { runOne } from "@paperclipai/server/routine-checks/runner";
import { readConfig, resolveConfigPath } from "../config/store.js";

interface CheckLogger {
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
}

interface CommonOpts {
  config?: string;
  dataDir?: string;
}

interface RunOpts extends CommonOpts {
  json?: boolean;
}

interface HistoryOpts extends CommonOpts {
  limit?: string;
  json?: boolean;
}

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

const noopLogger: CheckLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function getDbConnectionString(configPath?: string): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;

  const resolvedPath = resolveConfigPath(configPath);
  const config = readConfig(resolvedPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return config.database.connectionString.trim();
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

async function listCmd(_opts: CommonOpts): Promise<void> {
  const r = buildRegistry();
  const rows = r.list();
  console.log(`${rows.length} routine checks registered:`);
  for (const def of rows) {
    console.log(`  ${pc.bold(def.name.padEnd(28))}  ${def.schedule.padEnd(20)}  ${def.notify}`);
  }
}

async function runCmd(name: string, opts: RunOpts): Promise<void> {
  const r = buildRegistry();
  const def = r.get(name);
  if (!def) {
    console.error(pc.red(`unknown check: ${name}`));
    process.exit(2);
  }
  const db = createDb(getDbConnectionString(opts.config)) as ClosableDb;
  try {
    const result = await runOne({
      db,
      def,
      scheduledFor: new Date(),
      logger: noopLogger,
      now: () => new Date(),
      webhook: undefined, // CLI runs do not dispatch notifications
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `${def.name}: ${
          result.skipped
            ? "skipped (slot taken)"
            : `status=${result.status} notified=${result.notified}`
        }`,
      );
    }
  } finally {
    await closeDb(db);
  }
}

async function historyCmd(name: string, opts: HistoryOpts): Promise<void> {
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : 20;
  const db = createDb(getDbConnectionString(opts.config)) as ClosableDb;
  try {
    const rows = await db
      .select()
      .from(routineCheckRuns)
      .where(eq(routineCheckRuns.checkName, name))
      .orderBy(desc(routineCheckRuns.runAt))
      .limit(limit);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim(`No runs recorded for ${name}.`));
      return;
    }
    for (const row of rows) {
      const status =
        row.status === "ok"
          ? pc.green(row.status)
          : row.status === "warn"
            ? pc.yellow(row.status)
            : pc.red(row.status);
      console.log(
        `${row.runAt.toISOString()}  ${status.padEnd(8)}  findings=${row.findings}  ${row.errorText ?? ""}`,
      );
    }
  } finally {
    await closeDb(db);
  }
}

export function registerChecksCommands(program: Command): void {
  const checksCmd = program.command("checks").description("Routine checks for paperclip");

  checksCmd
    .command("list")
    .description("List registered routine checks")
    .action(async () => {
      try {
        await listCmd({});
      } catch (e) {
        console.error(pc.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  checksCmd
    .command("run <name>")
    .description("Manually run a single routine check (no notification dispatch)")
    .option("--json", "Output raw JSON")
    .action(async (name: string, opts: RunOpts) => {
      try {
        await runCmd(name, opts);
      } catch (e) {
        console.error(pc.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  checksCmd
    .command("history <name>")
    .description("Show recent runs for a routine check")
    .option("--limit <n>", "Number of rows to display", "20")
    .option("--json", "Output raw JSON")
    .action(async (name: string, opts: HistoryOpts) => {
      try {
        await historyCmd(name, opts);
      } catch (e) {
        console.error(pc.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });
}
