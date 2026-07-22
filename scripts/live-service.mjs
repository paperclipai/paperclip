#!/usr/bin/env node
/**
 * live-service.mjs
 *
 * Answers one question: **which working tree is production right now?**
 *
 * Before LOOA-382 the answer was a property of the repository layout -- the
 * main worktree, because that is where `pnpm dev` had always been run from.
 * That made it tempting to hard-code, and LOOA-371 correctly resisted that by
 * deriving it structurally (`--git-dir == --git-common-dir`).
 *
 * But the layout was never the real source of truth. Production is wherever the
 * serving process actually has its cwd. LOOA-382 moves the server into a
 * dedicated checkout, at which point "main worktree" and "production" are
 * different directories -- and any guard still equating the two would be
 * protecting the wrong tree while the real one runs unguarded.
 *
 * So ask the process, not the directory. The dev runner already registers the
 * serving process in the local service registry, recording its cwd and port.
 * That record is the honest answer, and it stays correct across the cutover
 * without anyone remembering to update a constant.
 *
 * Falls back to the main worktree when nothing is registered (server down), so
 * the guards keep a conservative answer rather than no answer.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * The dev runner registers the serving process under this profile.
 * Source of truth: scripts/dev-service-profile.ts (`profileKind`).
 */
const DEV_SERVICE_PROFILE_KIND = "paperclip-dev";

/** The ref the serving tree is deployed *from*. `deploy:live` fast-forwards to it. */
const DRIFT_BASE_REF = "origin/master";

/**
 * How long a serving tree may sit behind `master` before drift is "stale".
 *
 * A deploy normally follows a merge within minutes, so a tree that is behind
 * for a moment is not worth announcing -- alarming on every merge is how a
 * check gets ignored (LOOA-371's own lesson: a checker that cries wolf gets
 * switched off). Past this window the merged code is demonstrably not being
 * shipped, which is the silent failure LOOA-389 exists to make loud.
 */
export const DEFAULT_DRIFT_GRACE_MS = (() => {
  // Parse explicitly rather than `Number(env) || default`: a grace of 0 ("alarm
  // on any drift, no grace") is a legitimate setting, and `0 || default` would
  // silently discard it.
  const raw = process.env.PAPERCLIP_LIVE_DRIFT_GRACE_MS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 30 * 60 * 1000;
})();

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Mirrors packages/shared/src/home-paths.ts. Kept dependency-free on purpose: */
/** this module is imported from a git hook, where TS/workspace resolution is  */
/** not available. `scripts/live-service.test.mjs` pins it against the real     */
/** resolver so the duplication cannot silently drift.                          */
export function resolveInstanceRoot(env = process.env) {
  const home = env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.resolve(expandHome(home), "instances", instanceId);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * The serving checkout, as reported by the process that is actually serving.
 *
 * @returns {{ cwd: string, pid: number, port: number|null, url: string|null, serviceKey: string } | null}
 */
export function findServingService(env = process.env) {
  const registryDir = path.join(resolveInstanceRoot(env), "runtime-services");

  let entries;
  try {
    entries = readdirSync(registryDir).filter((name) => name.endsWith(".json"));
  } catch {
    return null; // No registry yet -- nothing has ever served from this instance.
  }

  const candidates = [];
  for (const entry of entries) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(registryDir, entry), "utf8"));
    } catch {
      continue; // A torn or hand-edited record is not a reason to fail the guard.
    }

    if (record?.profileKind !== DEV_SERVICE_PROFILE_KIND) continue;
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    if (!isProcessAlive(record.pid)) continue; // Stale record from a dead server.

    candidates.push({
      cwd: record.cwd,
      pid: record.pid,
      port: typeof record.port === "number" ? record.port : null,
      url: typeof record.url === "string" ? record.url : null,
      serviceKey: record.serviceKey ?? entry,
      startedAt: record.startedAt ?? "",
    });
  }

  if (candidates.length === 0) return null;

  // If two servers are somehow up, the most recently started one owns the port.
  candidates.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return candidates[0];
}

/** The main worktree of the repo containing `cwd`. The conservative fallback. */
export function findMainWorktree(cwd = process.cwd()) {
  const listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const first = listing.split("\n").find((line) => line.startsWith("worktree "));
  if (!first) throw new Error("could not resolve the main worktree");
  return first.slice("worktree ".length);
}

/**
 * The tree whose files are the deployed bytes.
 *
 * `source` says how we know, because the two answers mean different things: a
 * registry hit is the tree a live process is serving; the fallback is only a
 * guess at the tree a process *would* serve.
 *
 * @returns {{ tree: string, source: "service-registry"|"main-worktree-fallback", service: object|null }}
 */
export function resolveLiveTree(cwd = process.cwd(), env = process.env) {
  const service = findServingService(env);
  if (service) {
    return { tree: service.cwd, source: "service-registry", service };
  }
  return { tree: findMainWorktree(cwd), source: "main-worktree-fallback", service: null };
}

/**
 * The commit the serving tree currently has checked out -- the bytes running.
 *
 * This is the identity trace LOOA-382 asked health to leave. A server cannot
 * prove *which instance* it attached to (an empty one answers identically), but
 * it can prove *which commit* its own tree is at, because that is a fact the
 * deploy writes to disk, not a field the server declares about itself.
 *
 * @returns {{ head: string, branch: string } | null} null outside a git checkout.
 */
export function resolveServingCommit(tree) {
  try {
    const head = git(["rev-parse", "HEAD"], tree);
    if (!head) return null;
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], tree);
    return { head, branch: branch || "HEAD" };
  } catch {
    return null;
  }
}

/**
 * Pure drift verdict, separated from the git plumbing so it can be tested
 * against synthetic states.
 *
 * A serving tree only ever fast-forwards, so it is never *ahead* of master --
 * `behindBy` is the number of reviewed, merged commits it has not deployed.
 * Being behind is not *broken*: the server is up and serving reviewed code,
 * just an older cut of it. It is a stall, not an outage, and must never page
 * like one. It becomes "stale" (worth announcing) only once it has been behind
 * longer than the grace window.
 *
 * @param {{ behindBy?: number, oldestUndeployedAtMs?: number|null, now?: number, graceMs?: number }} state
 */
export function evaluateDrift(state = {}) {
  const {
    behindBy = 0,
    oldestUndeployedAtMs = null,
    now = Date.now(),
    graceMs = DEFAULT_DRIFT_GRACE_MS,
  } = state;
  const behind = Number.isFinite(behindBy) ? Math.max(0, Math.trunc(behindBy)) : 0;
  // Age is only meaningful when there is undeployed work; a tree level with
  // master has no oldest-undeployed commit to age.
  const driftAgeMs =
    behind > 0 && oldestUndeployedAtMs != null && Number.isFinite(oldestUndeployedAtMs)
      ? Math.max(0, now - oldestUndeployedAtMs)
      : null;
  // Require a *known* age past the window. If we cannot age the drift we report
  // it as behind-but-not-yet-stale rather than paging on a commit that may have
  // merged seconds ago -- behind is still surfaced via `behindBy`.
  const stale = behind > 0 && driftAgeMs != null && driftAgeMs >= graceMs;
  return { behindBy: behind, driftAgeMs, stale, graceMs };
}

/**
 * How far the serving tree has fallen behind `master`, measured against the
 * integration repo's master rather than the serving tree's cached ref.
 *
 * The serving tree's `origin/master` only advances when someone fetches, so
 * without a fetch a stalled tree looks up to date -- which is exactly the
 * silent failure this detects. Fetch is therefore on by default; a caller that
 * only wants a cached read can pass `{ fetch: false }` and accept staleness.
 *
 * @returns {{ available: boolean, base: string, head: string|null, branch: string|null,
 *             behindBy: number, driftAgeMs: number|null, stale: boolean, graceMs: number,
 *             oldestUndeployedAtMs: number|null }}
 */
export function computeServingDrift(tree, opts = {}) {
  const { fetch = true, graceMs = DEFAULT_DRIFT_GRACE_MS, now = Date.now() } = opts;

  let base = DRIFT_BASE_REF;
  if (fetch) {
    try {
      git(["fetch", "--quiet", "origin", "master"], tree);
      base = "FETCH_HEAD";
    } catch {
      // No reachable origin (e.g. a detached fixture). Fall back to whatever
      // origin/master we already have; if that is missing too, the rev-list
      // below throws and we report the drift as unavailable rather than clean.
    }
  }

  let head = null;
  let branch = null;
  try {
    head = git(["rev-parse", "HEAD"], tree);
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], tree);
    const behindBy = Number(git(["rev-list", "--count", `HEAD..${base}`], tree));
    let oldestUndeployedAtMs = null;
    if (behindBy > 0) {
      // The oldest commit master has that we do not -- how long reviewed code
      // has been waiting to ship. Committer date is a proxy for "merged at".
      const oldest = git(["log", "--reverse", "--format=%ct", `HEAD..${base}`], tree)
        .split("\n")
        .filter(Boolean)[0];
      if (oldest) oldestUndeployedAtMs = Number(oldest) * 1000;
    }
    const verdict = evaluateDrift({ behindBy, oldestUndeployedAtMs, now, graceMs });
    return { available: true, base, head, branch, oldestUndeployedAtMs, ...verdict };
  } catch {
    return {
      available: false,
      base,
      head,
      branch,
      behindBy: 0,
      driftAgeMs: null,
      stale: false,
      graceMs,
      oldestUndeployedAtMs: null,
    };
  }
}

function formatDriftDuration(ms) {
  if (ms == null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resolved = resolveLiveTree();
  const wantsFetch = !process.argv.includes("--no-fetch");
  const serving = resolveServingCommit(resolved.tree);
  const drift = computeServingDrift(resolved.tree, { fetch: wantsFetch });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...resolved, serving, drift }, null, 2));
  } else {
    console.log(`live tree: ${resolved.tree}  (via ${resolved.source})`);
    if (resolved.service) {
      console.log(`  served by pid ${resolved.service.pid} on ${resolved.service.url ?? "?"}`);
    }
    if (serving) {
      console.log(`  serving ${serving.head.slice(0, 9)} on ${serving.branch}`);
    }
    if (!drift.available) {
      console.log(`  drift: unknown (could not compare against ${DRIFT_BASE_REF})`);
    } else if (drift.behindBy === 0) {
      console.log(`  drift: up to date with master`);
    } else {
      const staleTag = drift.stale ? "STALE" : "behind (within grace)";
      console.log(
        `  drift: ${staleTag} -- ${drift.behindBy} commit(s) behind master, ` +
          `oldest undeployed ${formatDriftDuration(drift.driftAgeMs)} ago`,
      );
      if (drift.stale) {
        console.log(`  -> reviewed code is merged but not serving. Deploy it:  pnpm deploy:live`);
      }
    }
  }
  // `live:where` is a status read, not a gate: even STALE drift exits 0 so it
  // can be composed into other reads. Callers that want to *fail* on drift read
  // `drift.stale` from --json.
}
