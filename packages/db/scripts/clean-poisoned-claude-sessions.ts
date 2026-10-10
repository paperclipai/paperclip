#!/usr/bin/env tsx
/**
 * One-shot cleaner for `agent_task_sessions` rows whose persisted `claude_local`
 * session is poisoned by a non-`msg_*` `previous_message_id`.
 *
 * The poison shape: the Claude CLI keeps an on-disk JSONL transcript keyed by
 * sessionId at `<claude-config-dir>/projects/<encoded-cwd>/<sessionId>.jsonl`.
 * If the last `assistant` entry has a `message.id` that does NOT start with
 * `msg_`, every subsequent `--resume` against /v1/messages 400s with
 * `diagnostics.previous_message_id` and the issue is permanently stranded
 * until the persisted session is dropped. See RED-877 / RED-978 / RED-991 for
 * the upstream adapter fix; this script retroactively heals rows that were
 * stranded BEFORE that adapter shipped.
 *
 * Usage:
 *   tsx packages/db/scripts/clean-poisoned-claude-sessions.ts \
 *     --config /path/to/paperclip/config.json \
 *     [--claude-config-dir ~/.claude] \
 *     [--dry-run] [--json]
 *
 * Or in a Paperclip checkout shell:
 *   pnpm --filter @paperclipai/db exec tsx scripts/clean-poisoned-claude-sessions.ts --dry-run
 *
 * Exits 0 on success even when nothing was healed. Idempotent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../src/client.js";
import { agentTaskSessions } from "../src/schema/index.js";

const CLAUDE_ADAPTER_TYPE = "claude_local";

export type SessionClassification =
  | { kind: "healthy"; lastAssistantId: string }
  | { kind: "poisoned"; lastAssistantId: string }
  | { kind: "missing_jsonl"; jsonlPath: string }
  | { kind: "no_assistant_entries" }
  | { kind: "skipped_remote" }
  | { kind: "skipped_no_session_id" }
  | { kind: "unreadable_jsonl"; error: string };

export interface ClaudeSessionRowInput {
  sessionId: string | null;
  cwd: string | null;
  isRemote: boolean;
}

/**
 * Pure classifier — given JSONL text, returns whether the session is poisoned.
 * A session is "poisoned" iff its last `assistant` entry has a `message.id`
 * that does not start with `msg_`. Sessions with zero assistant entries are
 * left alone (they can be resumed safely from scratch).
 */
export function classifyJsonlText(text: string): SessionClassification {
  let lastAssistantId: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const entry = obj as Record<string, unknown>;
    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    const id = (msg as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) {
      lastAssistantId = id;
    }
  }
  if (lastAssistantId === null) {
    return { kind: "no_assistant_entries" };
  }
  if (lastAssistantId.startsWith("msg_")) {
    return { kind: "healthy", lastAssistantId };
  }
  return { kind: "poisoned", lastAssistantId };
}

export function encodeClaudeCwd(cwd: string): string {
  // Mirrors `effectiveExecutionCwd.replace(/[^a-zA-Z0-9-]/g, "-")` from the
  // claude-local adapter (`packages/adapters/claude-local/src/server/execute.ts`).
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  if (override && override.trim().length > 0) return path.resolve(override);
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".claude");
}

export function jsonlPathFor(input: { claudeConfigDir: string; cwd: string; sessionId: string }): string {
  return path.join(
    input.claudeConfigDir,
    "projects",
    encodeClaudeCwd(input.cwd),
    `${input.sessionId}.jsonl`,
  );
}

export function classifyRow(
  row: ClaudeSessionRowInput,
  opts: { claudeConfigDir: string; readJsonl: (filePath: string) => string | null },
): SessionClassification & { jsonlPath?: string } {
  if (!row.sessionId) return { kind: "skipped_no_session_id" };
  if (row.isRemote) return { kind: "skipped_remote" };
  if (!row.cwd) return { kind: "skipped_no_session_id" };
  const jsonlPath = jsonlPathFor({
    claudeConfigDir: opts.claudeConfigDir,
    cwd: row.cwd,
    sessionId: row.sessionId,
  });
  let text: string | null;
  try {
    text = opts.readJsonl(jsonlPath);
  } catch (error) {
    return {
      kind: "unreadable_jsonl",
      error: error instanceof Error ? error.message : String(error),
      jsonlPath,
    };
  }
  if (text === null) {
    return { kind: "missing_jsonl", jsonlPath };
  }
  const classification = classifyJsonlText(text);
  return { ...classification, jsonlPath };
}

interface CliArgs {
  configPath: string | null;
  claudeConfigDir: string | null;
  dryRun: boolean;
  json: boolean;
  databaseUrl: string | null;
  deleteMissing: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: null,
    claudeConfigDir: null,
    dryRun: false,
    json: false,
    databaseUrl: null,
    deleteMissing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--config":
        args.configPath = argv[++i] ?? null;
        break;
      case "--claude-config-dir":
        args.claudeConfigDir = argv[++i] ?? null;
        break;
      case "--database-url":
        args.databaseUrl = argv[++i] ?? null;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--delete-missing-jsonl":
        args.deleteMissing = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`Unknown flag: ${token}`);
        }
    }
  }
  return args;
}

const USAGE = `Usage:
  tsx packages/db/scripts/clean-poisoned-claude-sessions.ts [flags]

Flags:
  --config <path>            Path to paperclip config.json (defaults to
                             $PAPERCLIP_HOME/instances/default/config.json or
                             the standard locations).
  --database-url <url>       Override DB connection string entirely.
  --claude-config-dir <path> Override Claude CLI config dir (default:
                             $CLAUDE_CONFIG_DIR or ~/.claude).
  --dry-run                  Report poisoned rows but do not delete.
  --delete-missing-jsonl     Also delete rows whose sessionId references a
                             JSONL that no longer exists on disk.
  --json                     Emit a single JSON summary on stdout instead of
                             human-readable lines.
  -h, --help                 Print this usage.
`;

function readDatabaseUrlFromConfig(configPath: string): string {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    database?: {
      mode?: string;
      embeddedPostgresPort?: number;
      connectionString?: string;
    };
  };
  if (parsed.database?.mode === "postgres" && parsed.database.connectionString) {
    return parsed.database.connectionString;
  }
  const port = parsed.database?.embeddedPostgresPort ?? 54329;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function defaultConfigPath(): string | null {
  const candidates: string[] = [];
  const home = os.homedir();
  if (process.env.PAPERCLIP_HOME) {
    candidates.push(path.join(process.env.PAPERCLIP_HOME, "config.json"));
  }
  candidates.push(path.join(home, ".paperclip", "instances", "default", "config.json"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonlSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

interface Row {
  id: string;
  agentId: string;
  taskKey: string;
  sessionDisplayId: string | null;
  sessionParamsJson: Record<string, unknown> | null;
}

function extractSessionParams(row: Row): ClaudeSessionRowInput {
  const params = row.sessionParamsJson ?? {};
  const sessionId =
    typeof params.sessionId === "string" && params.sessionId.length > 0
      ? (params.sessionId as string)
      : null;
  const cwd =
    typeof params.cwd === "string" && params.cwd.length > 0 ? (params.cwd as string) : null;
  const isRemote =
    "remoteExecution" in params &&
    params.remoteExecution !== null &&
    typeof params.remoteExecution === "object";
  return { sessionId, cwd, isRemote };
}

interface HealedPair {
  rowId: string;
  agentId: string;
  taskKey: string;
  sessionId: string | null;
  lastAssistantId: string | null;
  jsonlPath: string | null;
  reason: "poisoned" | "missing_jsonl";
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const configPath = args.configPath ?? defaultConfigPath();
  const databaseUrl =
    args.databaseUrl ??
    process.env.DATABASE_URL ??
    (configPath ? readDatabaseUrlFromConfig(configPath) : null);
  if (!databaseUrl) {
    throw new Error(
      "Unable to resolve database URL. Pass --database-url or --config <paperclip config.json>.",
    );
  }
  const claudeConfigDir = resolveClaudeConfigDir(process.env, args.claudeConfigDir ?? undefined);

  const db = createDb(databaseUrl);
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };
  const summary = {
    scanned: 0,
    poisoned: 0,
    missingJsonl: 0,
    noAssistantEntries: 0,
    healthy: 0,
    skippedRemote: 0,
    skippedNoSession: 0,
    unreadable: 0,
    deleted: 0,
    dryRun: args.dryRun,
    healedPairs: [] as HealedPair[],
    skippedRemotePairs: [] as Array<{ rowId: string; agentId: string; taskKey: string }>,
  };

  const log = (line: string) => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  try {
    const rows: Row[] = await db
      .select({
        id: agentTaskSessions.id,
        agentId: agentTaskSessions.agentId,
        taskKey: agentTaskSessions.taskKey,
        sessionDisplayId: agentTaskSessions.sessionDisplayId,
        sessionParamsJson: agentTaskSessions.sessionParamsJson,
      })
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.adapterType, CLAUDE_ADAPTER_TYPE),
          isNotNull(agentTaskSessions.sessionParamsJson),
        ),
      );

    log(
      `Scanning ${rows.length} claude_local rows; claudeConfigDir=${claudeConfigDir}; dryRun=${args.dryRun}`,
    );

    const toDelete: HealedPair[] = [];
    for (const row of rows) {
      summary.scanned += 1;
      const input = extractSessionParams(row);
      const classification = classifyRow(input, {
        claudeConfigDir,
        readJsonl: readJsonlSafe,
      });
      switch (classification.kind) {
        case "healthy":
          summary.healthy += 1;
          break;
        case "no_assistant_entries":
          summary.noAssistantEntries += 1;
          break;
        case "skipped_remote":
          summary.skippedRemote += 1;
          summary.skippedRemotePairs.push({
            rowId: row.id,
            agentId: row.agentId,
            taskKey: row.taskKey,
          });
          break;
        case "skipped_no_session_id":
          summary.skippedNoSession += 1;
          break;
        case "unreadable_jsonl":
          summary.unreadable += 1;
          log(
            `[warn] unreadable jsonl for row=${row.id} agent=${row.agentId} task=${row.taskKey} error=${classification.error}`,
          );
          break;
        case "missing_jsonl": {
          summary.missingJsonl += 1;
          if (args.deleteMissing) {
            toDelete.push({
              rowId: row.id,
              agentId: row.agentId,
              taskKey: row.taskKey,
              sessionId: input.sessionId,
              lastAssistantId: null,
              jsonlPath: classification.jsonlPath ?? null,
              reason: "missing_jsonl",
            });
          } else {
            log(
              `[skip] missing jsonl (use --delete-missing-jsonl to clear) row=${row.id} agent=${row.agentId} task=${row.taskKey} jsonl=${classification.jsonlPath}`,
            );
          }
          break;
        }
        case "poisoned":
          summary.poisoned += 1;
          toDelete.push({
            rowId: row.id,
            agentId: row.agentId,
            taskKey: row.taskKey,
            sessionId: input.sessionId,
            lastAssistantId: classification.lastAssistantId,
            jsonlPath: classification.jsonlPath ?? null,
            reason: "poisoned",
          });
          break;
      }
    }

    if (toDelete.length === 0) {
      log("No poisoned rows found.");
    } else {
      log(`Found ${toDelete.length} rows to clear:`);
      for (const pair of toDelete) {
        log(
          `  - row=${pair.rowId} agent=${pair.agentId} task=${pair.taskKey} sessionId=${pair.sessionId} reason=${pair.reason} lastAssistantId=${pair.lastAssistantId ?? "n/a"}`,
        );
      }
    }

    if (!args.dryRun && toDelete.length > 0) {
      // Single-statement delete with ids list; safer than a per-row loop and
      // avoids races against concurrent heartbeat writes that might re-touch
      // the same (agentId, taskKey).
      const ids = toDelete.map((pair) => pair.rowId);
      const result = await db
        .delete(agentTaskSessions)
        .where(sql`${agentTaskSessions.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
        .returning({ id: agentTaskSessions.id });
      summary.deleted = result.length;
      log(`Deleted ${result.length} rows.`);
    }

    summary.healedPairs = toDelete;

    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      log("--- Summary ---");
      log(
        `scanned=${summary.scanned} healthy=${summary.healthy} poisoned=${summary.poisoned} missingJsonl=${summary.missingJsonl} noAssistantEntries=${summary.noAssistantEntries} skippedRemote=${summary.skippedRemote} skippedNoSession=${summary.skippedNoSession} unreadable=${summary.unreadable} deleted=${summary.deleted} dryRun=${summary.dryRun}`,
      );
    }
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

// Allow `import { ... } from "./clean-poisoned-claude-sessions.js"` from tests
// without triggering the CLI side-effect. Node sets `import.meta.main` on
// direct invocation; fall back to argv[1] comparison for older runtimes.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
