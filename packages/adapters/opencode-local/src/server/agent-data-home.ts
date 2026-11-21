import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OPENCODE_APP_DIR_NAME,
  resolveOpenCodeDataDir,
  resolvePaperclipInstanceRootForAdapter,
} from "@paperclipai/adapter-utils/server-utils";
import { isTruthyEnvFlag } from "./models.js";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Files worth carrying over from a pre-existing shared data dir into a fresh
 * per-agent one. `opencode.db` is deliberately absent: the point of the split is
 * to stop every agent writing one SQLite file, and copying it would re-create
 * the multi-GB-per-agent problem on day one.
 */
const SEED_FILES = ["auth.json"] as const;
const SEED_DIRS = ["repos"] as const;

export type OpenCodePerAgentDataHomeResult = {
  notes: string[];
  dataHome: string | null;
};

function resolveIsolationDisabled(env: Record<string, string>, config: Record<string, unknown>): boolean {
  if (config.sharedDataHome === true) return true;
  if (env.PAPERCLIP_OPENCODE_SHARED_DATA_HOME || process.env.PAPERCLIP_OPENCODE_SHARED_DATA_HOME) {
    return isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_SHARED_DATA_HOME ?? process.env.PAPERCLIP_OPENCODE_SHARED_DATA_HOME,
    );
  }
  return false;
}

/**
 * Point each local `opencode_local` agent at its own data dir so concurrent runs
 * never contend on one `opencode.db`.
 *
 * Why this is safe for session resume: the data home is a stable function of
 * `agentId`, so an agent's own sessions stay reachable across heartbeats. The
 * one-time transition cost is that sessions created before the split live in the
 * old shared DB and are no longer resumable — the adapter already handles that
 * with `isOpenCodeUnknownSessionError`, which retries on a fresh session.
 *
 * Why this does not strand agents without credentials: OpenCode keeps `auth.json`
 * in its data dir, so it is seeded from the previous data dir when present. On
 * this instance auth is env-var only and no `auth.json` exists, so the seed is a
 * no-op; the copy exists for deployments that do persist one.
 */
export async function prepareOpenCodePerAgentDataHome(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  agentId: string;
  targetIsRemote?: boolean;
}): Promise<OpenCodePerAgentDataHomeResult> {
  const notes: string[] = [];
  if (input.targetIsRemote) {
    // Remote targets already get per-run isolated homes in
    // prepareManagedOpenCodeRemoteHomes; overriding them here would leak host
    // paths into the remote env.
    return { notes, dataHome: null };
  }

  const agentId = input.agentId.trim();
  if (!PATH_SEGMENT_RE.test(agentId)) {
    notes.push(
      `Skipped per-agent OpenCode data home: agent id '${input.agentId}' is not a safe path segment.`,
    );
    return { notes, dataHome: null };
  }

  if (resolveIsolationDisabled(input.env, input.config)) {
    return { notes, dataHome: null };
  }

  const baseOverride =
    (typeof input.config.openCodeDataRoot === "string" && input.config.openCodeDataRoot.trim()) ||
    (typeof input.env.PAPERCLIP_OPENCODE_DATA_ROOT === "string" &&
      input.env.PAPERCLIP_OPENCODE_DATA_ROOT.trim()) ||
    (typeof process.env.PAPERCLIP_OPENCODE_DATA_ROOT === "string" &&
      process.env.PAPERCLIP_OPENCODE_DATA_ROOT.trim()) ||
    "";
  const base = baseOverride
    ? path.resolve(baseOverride)
    : path.join(resolvePaperclipInstanceRootForAdapter(), "adapter-data", "opencode");

  // OpenCode appends its own app name to XDG_DATA_HOME, so the directory that
  // actually holds opencode.db / auth.json / storage/ is one level below the
  // value we hand the child process. Both the seed source and the seed target
  // must be expressed in OpenCode's own layout, not in XDG_DATA_HOME terms.
  const dataHome = path.join(base, agentId, OPENCODE_APP_DIR_NAME);
  const previousDataHome = resolveOpenCodeDataDir({ env: input.env });
  if (path.resolve(previousDataHome) === dataHome) {
    return { notes, dataHome };
  }

  await fs.mkdir(dataHome, { recursive: true });

  // Seed only what the agent cannot re-derive. Best-effort: a read-only or
  // partially-populated source dir must not fail the run.
  for (const file of SEED_FILES) {
    const target = path.join(dataHome, file);
    try {
      await fs.access(target);
      continue;
    } catch {
      // Not present yet — fall through to the copy.
    }
    try {
      await fs.copyFile(path.join(previousDataHome, file), target);
    } catch {
      // Absent or unreadable in the previous data dir; not fatal.
    }
  }
  for (const dir of SEED_DIRS) {
    const target = path.join(dataHome, dir);
    try {
      await fs.access(target);
      continue;
    } catch {
      // Not present yet — fall through to the copy.
    }
    try {
      await fs.cp(path.join(previousDataHome, dir), target, {
        recursive: true,
        force: false,
        errorOnExist: false,
        dereference: false,
      });
    } catch {
      // Absent or unreadable in the previous data dir; not fatal.
    }
  }

  input.env.XDG_DATA_HOME = path.join(base, agentId);
  notes.push(`Isolated OpenCode data dir per agent at ${dataHome}.`);
  return { notes, dataHome };
}
