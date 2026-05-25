/**
 * Lifecycle hook helper: bridges the ccrotate CLI on this pod with the
 * `kkroo.ccrotate` plugin's `plugin_state.snapshot` row.
 *
 * Designed to be wired as the heartbeat instance setting `general.preRunCmd`
 * (subcommand `import`) and `general.postRunCmd` (subcommand `export`):
 *
 *   preRunCmd:  node /app/server/dist/cli/ccrotate-state-hook.js import
 *   postRunCmd: node /app/server/dist/cli/ccrotate-state-hook.js export
 *
 * The hook talks to Postgres directly via the same `createDb()` the server
 * uses (no HTTP, no API token plumbing). DATABASE_URL is inherited from the
 * paperclip-0 process the hook is spawned from.
 *
 * import: pulls the most recent persisted snapshot blob and runs
 *   `ccrotate import <blob> --force` so the Job pod's ccrotate matches the
 *   operator-snapshotted pool.
 *
 * export: runs `ccrotate export`, parses the `mp-gz-b64:…` blob from the
 *   text output, and upserts it back into plugin_state so the next import
 *   sees the latest state (e.g. tier transitions captured by the worker
 *   during this run).
 *
 * Either subcommand exits 0 on success or no-op (e.g. plugin not installed,
 * or no snapshot to import yet) so the heartbeat doesn't fail the run on
 * absent state. Hard failures (DB unreachable, ccrotate missing) exit
 * non-zero — preRun blocks the run and the operator sees a hook-failed
 * activity log entry.
 */

import { spawnSync } from "node:child_process";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDb, plugins, pluginState } from "@paperclipai/db";

const PLUGIN_KEY = "kkroo.ccrotate";
const NAMESPACE = "ccrotate";
const STATE_KEY = "snapshot";
const BLOB_RE = /mp-gz-b64:[A-Za-z0-9:+=/_-]+/;

interface PersistedSnapshot {
  blob: string;
  capturedAt: string;
}

function exitWith(code: number, message: string): never {
  if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
}

async function loadPluginIdOrExit(db: ReturnType<typeof createDb>): Promise<string | null> {
  const rows = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, PLUGIN_KEY))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function readSnapshot(
  db: ReturnType<typeof createDb>,
  pluginId: string,
): Promise<PersistedSnapshot | null> {
  const rows = await db
    .select({ value: pluginState.valueJson })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "instance"),
        isNull(pluginState.scopeId),
        eq(pluginState.namespace, NAMESPACE),
        eq(pluginState.stateKey, STATE_KEY),
      ),
    )
    .limit(1);
  return (rows[0]?.value as PersistedSnapshot | null) ?? null;
}

async function writeSnapshot(
  db: ReturnType<typeof createDb>,
  pluginId: string,
  value: PersistedSnapshot,
): Promise<void> {
  // Upsert via the table's natural unique key. The schema declares
  // `nullsNotDistinct()` on the constraint so the NULL scope_id used by
  // instance-scope rows still collides with itself for ON CONFLICT
  // resolution, matching how the SDK's ctx.state.set persists values.
  await db
    .insert(pluginState)
    .values({
      pluginId,
      scopeKind: "instance",
      scopeId: null,
      namespace: NAMESPACE,
      stateKey: STATE_KEY,
      valueJson: value,
    })
    .onConflictDoUpdate({
      target: [
        pluginState.pluginId,
        pluginState.scopeKind,
        pluginState.scopeId,
        pluginState.namespace,
        pluginState.stateKey,
      ],
      set: { valueJson: value, updatedAt: sql`now()` },
    });
}

function runCcrotate(
  args: string[],
  timeoutMs: number = 25_000,
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("ccrotate", args, { encoding: "utf8", timeout: timeoutMs });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function adapterToTarget(adapterType: string): "claude" | "codex" | null {
  if (/(^|_)(claude)(_|$)/.test(adapterType)) return "claude";
  if (/(^|_)(opencode|codex)(_|$)/.test(adapterType)) return "codex";
  return null;
}

async function doImport(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) exitWith(1, "DATABASE_URL not set");
  const db = createDb(dbUrl);
  const pluginId = await loadPluginIdOrExit(db);
  if (!pluginId) exitWith(0, `[ccrotate-hook] plugin ${PLUGIN_KEY} not installed; nothing to import`);
  const snapshot = await readSnapshot(db, pluginId);
  if (!snapshot?.blob) {
    exitWith(0, `[ccrotate-hook] no snapshot persisted yet; skipping import`);
  }
  const r = runCcrotate(["import", snapshot.blob, "--force"]);
  if (r.status !== 0) {
    exitWith(r.status ?? 1, `[ccrotate-hook] ccrotate import failed (exit=${r.status}): ${r.stderr || r.stdout}`);
  }
  exitWith(0, `[ccrotate-hook] imported snapshot capturedAt=${snapshot.capturedAt}`);
}

async function doExport(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) exitWith(1, "DATABASE_URL not set");
  const db = createDb(dbUrl);
  const pluginId = await loadPluginIdOrExit(db);
  if (!pluginId) exitWith(0, `[ccrotate-hook] plugin ${PLUGIN_KEY} not installed; nothing to export`);

  // Snap the active account's freshly-rotated tokens for the target that just
  // ran back into ccrotate's profiles.* JSON before export. Without this,
  // codex CLI's
  // automatic refresh_token rotation (writes new tokens to
  // /paperclip/.codex/auth.json on first refresh) is invisible to ccrotate's
  // pool snapshot — `ccrotate refresh` is claude-only ("refresh-one is only
  // available in Claude Code mode" for codex), so the codex pool's stashed
  // refresh_token in profiles.codex.json never tracks the rotated value. Next
  // time ccrotate switches to that account, it loads the OLD refresh_token,
  // which has been invalidated by OpenAI when the new one was issued, codex
  // CLI silently fails auth, opencode exits 0 with empty stdout, and the run
  // is mis-classified as adapter_failed. We saw this live: 5/5 codex pool
  // accounts had id_tokens 16h–9d expired, snap-after-rotation never ran.
  //
  // `--force` overwrites without confirmation. The snap is best-effort: if the
  // target CLI hasn't been used in this pod (no ~/.<target>/auth.json), the
  // snap errors harmlessly. In Paperclip's served ccrotate pool, snapping the
  // unrelated target is actively noisy: opencode runs do not own a stable
  // Claude CLI session, and a best-effort Claude snap can report false active
  // config mismatches while the cluster auth-bot is rotating accounts.
  const adapterType = (process.env.PAPERCLIP_ADAPTER_TYPE ?? "").trim();
  const target = adapterType ? adapterToTarget(adapterType) : null;
  const targets: readonly ("claude" | "codex")[] = target
    ? [target]
    : adapterType
      ? []
      : ["claude", "codex"];
  if (adapterType && !target) {
    console.error(`[ccrotate-hook] adapterType=${adapterType} has no ccrotate target; skipping snap`);
  }
  for (const target of targets) {
    const snap = runCcrotate(["--target", target, "snap", "--force"], 30_000);
    if (snap.status !== 0) {
      console.error(
        `[ccrotate-hook] ccrotate --target ${target} snap exit=${snap.status} (continuing): ${snap.stderr || snap.stdout}`.trim(),
      );
    }
  }

  // Refresh-one (not full pool refresh) so the captured tier-cache reflects
  // current API state for the account that just finished a run, without
  // hammering Anthropic's per-org Usage API. The full-pool `ccrotate refresh`
  // we used to call here was probing every account in the pool on EVERY
  // postRun — at peak, ~30 sweeps/hour into an API that throttles per-org
  // and was the actual source of the "Usage API on cooldown" entries that
  // poisoned tier-cache for hours during the 2026-05-09 storm.
  //
  // `refresh-one` (lib/commands/refresh-one.js) prioritizes the active
  // account first (score=-1 in its candidate ranking) and skips
  // cooldown'd tokens — so this stays an efficient ~1 Usage API call
  // per postRun. The auth-bot's separate */5 cron handles whole-pool
  // sweeps; postRun's job is just to keep the active account fresh.
  // ccrotate import on the next run-start is a per-account timestamp
  // merge so partial freshness still wins over stale-pod state.
  // (refresh-one is claude-only; for codex active it errors and we
  // proceed — the codex snap above already saved tokens.)
  const refresh = runCcrotate(["refresh-one"], 30_000);
  if (refresh.status !== 0) {
    console.error(
      `[ccrotate-hook] ccrotate refresh-one exit=${refresh.status} (continuing with stale tier-cache): ${refresh.stderr || refresh.stdout}`,
    );
  }

  const r = runCcrotate(["export"]);
  if (r.status !== 0) {
    exitWith(r.status ?? 1, `[ccrotate-hook] ccrotate export failed (exit=${r.status}): ${r.stderr || r.stdout}`);
  }
  const match = (r.stdout + r.stderr).match(BLOB_RE);
  if (!match) {
    exitWith(1, `[ccrotate-hook] ccrotate export produced no mp-gz-b64 blob:\n${r.stdout}`);
  }
  const value: PersistedSnapshot = { blob: match[0], capturedAt: new Date().toISOString() };
  await writeSnapshot(db, pluginId, value);
  exitWith(0, `[ccrotate-hook] persisted ${value.blob.length}-char snapshot`);
}

const subcommand = process.argv[2];
if (subcommand === "import") {
  doImport().catch((err) => exitWith(1, `[ccrotate-hook] import threw: ${err}`));
} else if (subcommand === "export") {
  doExport().catch((err) => exitWith(1, `[ccrotate-hook] export threw: ${err}`));
} else {
  exitWith(2, "usage: ccrotate-state-hook (import|export)");
}
