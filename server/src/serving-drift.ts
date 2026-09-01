import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Server-side serving-tree drift — the async, event-loop-safe sibling of the
 * drift logic in `scripts/live-service.mjs`.
 *
 * `live-service.mjs` is deliberately dependency-free (a git hook runs it) and
 * uses synchronous `execFileSync`, which is fine for a one-shot CLI. Inside the
 * long-lived server process a synchronous `git fetch` would block the event
 * loop for the whole company, so this module mirrors the *verdict* logic
 * (`evaluateDrift`, kept behaviourally identical and pinned by test against the
 * mjs) while running the git plumbing through async `execFile`.
 *
 * The sweep runs inside the serving process, so the tree it measures is
 * `process.cwd()` — the exact bytes running, the same tree `serving-commit.ts`
 * reads. That is by construction the registry-resolved live tree, because the
 * sweep *is* the live process.
 *
 * LOOA-412: the sweep computes drift on a throttled cadence and writes the
 * result to the module cache below; `/api/health` reads that cache so
 * `servingTree.behindBy` is readable without the request path ever fetching
 * (LOOA-389 exposed `head`; this adds "is it behind, and by how much?").
 */

/** The ref the serving tree is deployed from; `deploy:live` fast-forwards to it. Mirrors live-service.mjs. */
const DRIFT_BASE_REF = "origin/master";

/**
 * How long a serving tree may sit behind `master` before drift is "stale".
 * Mirrors `DEFAULT_DRIFT_GRACE_MS` in `scripts/live-service.mjs` — parsed
 * explicitly so a grace of `0` ("alarm on any drift") is honoured rather than
 * discarded by `Number(env) || default`.
 */
export const DEFAULT_DRIFT_GRACE_MS = (() => {
  const raw = process.env.PAPERCLIP_LIVE_DRIFT_GRACE_MS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 30 * 60 * 1000;
})();

/**
 * How often the in-process sweep actually recomputes drift (and fetches). The
 * periodic heartbeat timer ticks every ~30s, but a `git fetch` per tick would
 * be wasteful; the sweep throttles itself to this cadence. Default 10 minutes.
 */
export const SERVING_TREE_DRIFT_SWEEP_INTERVAL_MS = (() => {
  const raw = process.env.PAPERCLIP_DRIFT_SWEEP_INTERVAL_MS;
  if (raw != null && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 10 * 60 * 1000;
})();

/** Master kill switch for the sweep. Defaults on; set `false` to disable entirely. */
export const SERVING_TREE_DRIFT_SWEEP_ENABLED =
  process.env.PAPERCLIP_DRIFT_SWEEP_ENABLED !== "false";

export type DriftVerdict = {
  behindBy: number;
  driftAgeMs: number | null;
  stale: boolean;
  graceMs: number;
};

/**
 * Pure drift verdict, separated from the git plumbing so it can be tested
 * against synthetic states. Behaviourally identical to `evaluateDrift` in
 * `scripts/live-service.mjs`.
 *
 * A serving tree only ever fast-forwards, so it is never *ahead* of master --
 * `behindBy` is the number of reviewed, merged commits it has not deployed.
 * Being behind is not *broken*; it becomes "stale" (worth acting on) only once
 * it has been behind longer than the grace window, and only when the age is
 * *known* (an unknowable age is reported behind-but-not-stale, never paged).
 */
export function evaluateDrift(
  state: {
    behindBy?: number;
    oldestUndeployedAtMs?: number | null;
    now?: number;
    graceMs?: number;
  } = {},
): DriftVerdict {
  const {
    behindBy = 0,
    oldestUndeployedAtMs = null,
    now = Date.now(),
    graceMs = DEFAULT_DRIFT_GRACE_MS,
  } = state;
  const behind = Number.isFinite(behindBy) ? Math.max(0, Math.trunc(behindBy)) : 0;
  const driftAgeMs =
    behind > 0 && oldestUndeployedAtMs != null && Number.isFinite(oldestUndeployedAtMs)
      ? Math.max(0, now - oldestUndeployedAtMs)
      : null;
  const stale = behind > 0 && driftAgeMs != null && driftAgeMs >= graceMs;
  return { behindBy: behind, driftAgeMs, stale, graceMs };
}

export type ServingDrift = {
  available: boolean;
  base: string;
  /** Resolved SHA of `base` (the master head we compared against), or null when unavailable. */
  baseHead: string | null;
  head: string | null;
  branch: string | null;
  behindBy: number;
  driftAgeMs: number | null;
  stale: boolean;
  graceMs: number;
  oldestUndeployedAtMs: number | null;
};

/**
 * Cap every git subprocess so a hung `fetch` (network stall with no tty to fail
 * fast) can't outlive the sweep interval and accumulate. On timeout execFile
 * kills the process and rejects, so `computeServingDrift` reports the drift
 * unavailable rather than leaking a subprocess.
 */
const GIT_TIMEOUT_MS = 20_000;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * How far the serving `tree` has fallen behind `master`, measured against the
 * integration repo's master (via a fetch) rather than the tree's cached ref --
 * a stalled tree's cached `origin/master` looks up to date otherwise, which is
 * exactly the silent failure this detects. Callers on the request path must
 * pass `{ fetch: false }` (or read the cache) and never invoke this directly.
 */
export async function computeServingDrift(
  tree: string,
  opts: { fetch?: boolean; graceMs?: number; now?: number } = {},
): Promise<ServingDrift> {
  const { fetch = true, graceMs = DEFAULT_DRIFT_GRACE_MS, now = Date.now() } = opts;

  let base = DRIFT_BASE_REF;
  if (fetch) {
    try {
      await git(["fetch", "--quiet", "origin", "master"], tree);
      base = "FETCH_HEAD";
    } catch {
      // No reachable origin (e.g. a detached fixture). Fall back to whatever
      // origin/master we already have; if that is missing too, the rev-list
      // below throws and we report the drift as unavailable rather than clean.
    }
  }

  try {
    const head = await git(["rev-parse", "HEAD"], tree);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], tree);
    const baseHead = await git(["rev-parse", base], tree);
    const behindBy = Number(await git(["rev-list", "--count", `HEAD..${base}`], tree));
    let oldestUndeployedAtMs: number | null = null;
    if (behindBy > 0) {
      // The oldest commit master has that we do not -- how long reviewed code
      // has been waiting to ship. Committer date is a proxy for "merged at".
      const oldest = (await git(["log", "--reverse", "--format=%ct", `HEAD..${base}`], tree))
        .split("\n")
        .filter(Boolean)[0];
      if (oldest) oldestUndeployedAtMs = Number(oldest) * 1000;
    }
    const verdict = evaluateDrift({ behindBy, oldestUndeployedAtMs, now, graceMs });
    return { available: true, base, baseHead, head, branch, oldestUndeployedAtMs, ...verdict };
  } catch {
    return {
      available: false,
      base,
      baseHead: null,
      head: null,
      branch: null,
      behindBy: 0,
      driftAgeMs: null,
      stale: false,
      graceMs,
      oldestUndeployedAtMs: null,
    };
  }
}

/**
 * The last drift result the background sweep computed. `/api/health` reads this
 * so `servingTree.behindBy` is available without the request path fetching.
 * `null` until the first sweep completes (health then reports head/branch only).
 */
export type CachedServingDrift = {
  head: string | null;
  branch: string | null;
  behindBy: number;
  stale: boolean;
  driftAgeMs: number | null;
  checkedAtMs: number;
};

let driftCache: CachedServingDrift | null = null;

export function setCachedServingDrift(value: CachedServingDrift | null): void {
  driftCache = value;
}

export function getCachedServingDrift(): CachedServingDrift | null {
  return driftCache;
}

/** Test-only: drop the cache so a test starts from a known cold state. */
export function __resetServingDriftCacheForTests(): void {
  driftCache = null;
}
