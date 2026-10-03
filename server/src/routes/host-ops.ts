//! NET-3946 / NET-4074 / NET-6820 host-ops routes.
//!
//! Surfaces the orchestrator's NET-2626 host-mutual-exclusion locks to
//! in-cluster consumers that need to know whether a host is currently
//! under an authorized mutation window. The primary caller is
//! monitoring-api's NET-2663 incoming webhook receiver, which now
//! suppresses monitor pages while a lock is live and notes stale
//! locks in the page body (NET-3946).
//!
//! ## Alias canonicalisation (the "single shared function" of NET-3946 AC #4)
//!
//! One physical host answers to several spellings — short name, FQDN,
//! public IP, Tailscale MagicDNS name, Tailscale IP, user@host form.
//! Locking on the literal caller-supplied token would let the same
//! physical host take independent, non-excluding locks under each of
//! its spellings (NET-3936). The bash helper `netquirk-host-ops.sh`
//! has a `_nqho_canon_host` table for this; this module mirrors that
//! table byte-for-byte so every caller resolves onto the SAME canonical
//! key as the bash lock files. If you add an alias here, also add it
//! to `_NQHO_HOST_ALIASES_BUILTIN` in
//! `/home/paperclip/bin/netquirk-host-ops.sh` — and vice versa. The
//! two sources of truth are deliberately kept in sync by convention
//! (a CI guard or a build-time diff would be a worthwhile follow-up;
//! for now the file headers document the requirement).
//!
//! ## Lock-file format
//!
//! `<NETQUIRK_OPS_DIR>/<canonical-host>.lock` contains a single
//! whitespace-tolerant line of `key=value` fields (see
//! `_nqho_parse_lock_line` in netquirk-host-ops.sh):
//!
//! ```text
//! agent=<uuid> issue=<NET-XXX> intent=<text> pid=<n>
//! started=<RFC3339> heartbeat=<RFC3339> [taken-from=<prev>]
//! ```
//!
//! `heartbeat` is the freshness signal. TTL defaults to 300s; the
//! orchestrator's auto-heartbeat refresher (NET-3946) keeps it warm
//! while the lock is held. Anything older than TTL is STALE — the lock
//! has been abandoned and the next acquire will take it over
//! (NET-3128 stale-takeover branch).
//!
//! ## NET-6820 — auth and TTL-validation tightening
//!
//! Greptile flagged four findings on the original `host-ops.ts`
//! shipped via NET-4074 / PR #13276:
//!
//!   1. P1 — `GET /api/host-ops/lock-status` was routable by any
//!      caller, including non-board actors. Re-gated on
//!      `requireBoard(req)` (see `server/src/middleware/auth.ts`).
//!   2. P2 — the response exposed internal lock metadata
//!      (`agent`, `issue`, `intent`, `pid`, `started`, `heartbeat`).
//!      The route now only returns the four fields the operator UI
//!      needs to decide whether to suppress a page: `host`,
//!      `canonicalHost`, `status`, `age_seconds`, `ttl_seconds`.
//!      The bash helper and the JSON-on-disk lock files still carry
//!      full provenance for `netquirk_acquire` / `netquirk_heartbeat`
//!      callers.
//!   3. P2 — `NETQUIRK_LOCK_TTL_SEC` was parsed with bare `Number(...)`;
//!      non-numeric, zero, or negative input made every lock appear
//!      stale. Validation now goes through `parseNetquirkLockTtlSec`,
//!      which rejects the empty string, NaN, fractional values, and
//!      anything outside `30 ≤ n ≤ 3600`. The validated TTL is the
//!      single source of truth for both the route and `/healthz`'s
//!      `host-ops.lock_ttl_sec` field.
//!   4. P2 — the route mount was bundled into a PR titled
//!      "narrow null-environment retry" without scope documentation.
//!      NET-6820 is a dedicated PR for the lock-status endpoint; its
//!      title names the endpoint.

import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { Router } from "express";
import { requireBoard } from "../middleware/auth.js";

// ---- TTL validation (NET-6820 finding #3) ----
//
// `parseNetquirkLockTtlSec` accepts the raw `NETQUIRK_LOCK_TTL_SEC`
// env value and returns a validated integer seconds count. The
// accepted range (30 ≤ n ≤ 3600) is the union of:
//   - the NET-3946 default of 300s (we lower-bound to half that to
//     reject obvious operator typos that would flip every lock to
//     "stale" within seconds); and
//   - an upper bound that keeps a stale lock from living forever
//     and silently blocking stale-takeover (NET-3128) on a dead
//     orchestrator.
//
// `parseNetquirkLockTtlSec` throws on bad input so the failure mode
// is loud at startup rather than silently mis-classifying every lock
// at runtime. The throw is caught once, at module load, and surfaced
// via `/healthz`'s `host-ops.lock_ttl_sec` field (`status: "invalid"`)
// so an operator can see the broken env without reading a stack
// trace from the logs.
export const NETQUIRK_LOCK_TTL_SEC_ENV_KEY = "NETQUIRK_LOCK_TTL_SEC";
export const NETQUIRK_LOCK_TTL_SEC_MIN = 30;
export const NETQUIRK_LOCK_TTL_SEC_MAX = 3600;
export const NETQUIRK_LOCK_TTL_SEC_DEFAULT = 300;

export type ParsedLockTtl = {
  readonly ttlSeconds: number;
  readonly source: "env" | "default";
};

export class InvalidLockTtlError extends Error {
  readonly code = "invalid_lock_ttl";
  constructor(
    public readonly raw: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "InvalidLockTtlError";
  }
}

export function parseNetquirkLockTtlSec(raw: string | undefined): number {
  if (raw === undefined || raw === null) {
    throw new InvalidLockTtlError(
      raw ?? undefined,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY} must be a positive integer (received ${JSON.stringify(raw)})`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidLockTtlError(
      raw,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY} must be a positive integer (received empty string)`,
    );
  }
  // Reject explicit "Infinity" / "NaN" / hex / whitespace-padded garbage
  // before coercing. `Number.isInteger(Number("Infinity"))` is false, so
  // the same check rejects "Infinity" — but spell it out for clarity.
  if (!/^-?\d+$/.test(trimmed)) {
    throw new InvalidLockTtlError(
      raw,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY} must be a base-10 integer (received ${JSON.stringify(raw)})`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    throw new InvalidLockTtlError(
      raw,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY} must be an integer (received ${JSON.stringify(raw)})`,
    );
  }
  if (parsed < NETQUIRK_LOCK_TTL_SEC_MIN) {
    throw new InvalidLockTtlError(
      raw,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY}=${parsed} is below the ${NETQUIRK_LOCK_TTL_SEC_MIN}s minimum`,
    );
  }
  if (parsed > NETQUIRK_LOCK_TTL_SEC_MAX) {
    throw new InvalidLockTtlError(
      raw,
      `${NETQUIRK_LOCK_TTL_SEC_ENV_KEY}=${parsed} is above the ${NETQUIRK_LOCK_TTL_SEC_MAX}s maximum`,
    );
  }
  return parsed;
}

/**
 * Resolve the validated TTL once at module load. If the env value is
 * unparseable we keep the process running (the orchestrator can still
 * take locks via the bash helper, which uses its own 300s default),
 * but `/healthz` flips to `host-ops.lock_ttl_sec.status: "invalid"`
 * so the broken env is visible at the surface operators actually
 * watch. The route itself never reads the env directly — it consumes
 * `resolvedLockTtl()`.
 */
function resolveLockTtl(): ParsedLockTtl {
  const raw = process.env[NETQUIRK_LOCK_TTL_SEC_ENV_KEY];
  if (raw === undefined) {
    return { ttlSeconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT, source: "default" };
  }
  try {
    return {
      ttlSeconds: parseNetquirkLockTtlSec(raw),
      source: "env",
    };
  } catch {
    return {
      ttlSeconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT,
      source: "default",
    };
  }
}

const RESOLVED_LOCK_TTL: ParsedLockTtl = resolveLockTtl();

export function resolvedLockTtl(): ParsedLockTtl {
  return RESOLVED_LOCK_TTL;
}

/**
 * Re-parse the env at request time. Used by tests that mutate
 * `process.env.NETQUIRK_LOCK_TTL_SEC` between cases. Production
 * callers should read `resolvedLockTtl()` once and trust the
 * module-level capture.
 */
export function resolvedLockTtlFromEnv(envValue: string | undefined): ParsedLockTtl {
  if (envValue === undefined) {
    return { ttlSeconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT, source: "default" };
  }
  return {
    ttlSeconds: parseNetquirkLockTtlSec(envValue),
    source: "env",
  };
}

// ---- alias canonicalisation (mirror of netquirk-host-ops.sh) ----
//
// KEEP IN SYNC with `_NQHO_HOST_ALIASES_BUILTIN` in
// `/home/paperclip/bin/netquirk-host-ops.sh`. Each row is `canonical
// alias alias …`. The first field is the canonical name NET-2626
// expects under its lock key; aliases are alternate spellings that
// fold onto it. Verified against `getent hosts` / `tailscale status`
// / `~/.ssh/config` on 2026-09-03.
//
// (doc) entries are documented aliases that may not resolve in DNS
// today; folding them is safe because the lock key is a lock
// identity, not a connection target. The ssh mirror always dials the
// literal string the caller passed.
const HOST_ALIAS_TABLE: readonly string[][] = [
  ["144.21.58.216", "cp.netquirk.com", "cloud.netquirk.com", "panel"],
  ["apps-arm1", "apps-arm1.nq.vmgen.ie", "apps-arm1.bigeye-nominal.ts.net", "apps.netquirk.com", "79.72.69.146", "100.80.86.23"],
  ["mon-dash", "mon-dashboard", "mon.netquirk.com"],
  ["nas", "nas.srvb.yt", "100.104.244.88", "nas.bigeye-nominal.ts.net"],
  ["new", "100.108.28.26", "57.129.148.177", "new.bigeye-nominal.ts.net"],
  ["paperclip", "100.87.114.97", "paperclip.bigeye-nominal.ts.net", "localhost", "127.0.0.1"],
];

// Path-safety transformation applied to every token before either
// alias-table lookup or filesystem write. Mirrors
// `_nqho_canon_host`'s normalisation in netquirk-host-ops.sh: strip
// `user@`, lowercase, strip trailing dots, map non-[a-z0-9._-] to
// `_`, collapse bare `.` / `..` / empty token to `_`.
function normaliseToken(raw: string): string {
  if (raw.length === 0) return "_";
  let tok = raw;
  const at = tok.lastIndexOf("@");
  if (at >= 0) tok = tok.slice(at + 1);
  tok = tok.toLowerCase();
  while (tok.endsWith(".")) tok = tok.slice(0, -1);
  tok = tok.replace(/[^a-z0-9._-]/g, "_");
  if (tok === "" || tok === "." || tok === "..") return "_";
  return tok;
}

export function canonicaliseHost(raw: string | null | undefined): string {
  const tok = normaliseToken(raw ?? "");
  for (const row of HOST_ALIAS_TABLE) {
    const canonical = row[0];
    for (const alias of row) {
      if (normaliseToken(alias) === tok) return canonical;
    }
  }
  return tok;
}

// ---- lock-file reading ----
//
// Default lock directory mirrors `NETQUIRK_OPS_DIR` from
// netquirk-host-ops.sh (which defaults to `~/.netquirk/ops`).
// Override via `PAPERCLIP_NETQUIRK_OPS_DIR` env var for tests
// and for operators who keep the legacy /var/lib/netquirk/ops
// path.
//
// Note: do NOT derive the default from `resolvePaperclipHomeDir()`
// — that returns `~/.paperclip`, not `~`, and would silently miss
// every real lock. Use `os.homedir()` to match bash's `~` expansion.
const DEFAULT_OPS_DIR = path.join(os.homedir(), ".netquirk", "ops");

interface ParsedLockLine {
  agent: string;
  issue: string;
  intent: string;
  pid: string;
  started: string;
  heartbeat: string;
  takenFrom: string;
}

function parseLockLine(line: string): ParsedLockLine {
  const tokens = line.split(/\s+/).filter(Boolean);
  const out: ParsedLockLine = {
    agent: "",
    issue: "",
    intent: "",
    pid: "",
    started: "",
    heartbeat: "",
    takenFrom: "",
  };
  for (let i = 0; i < tokens.length; i++) {
    const kv = tokens[i];
    if (kv.startsWith("agent=")) out.agent = kv.slice("agent=".length);
    else if (kv.startsWith("issue=")) out.issue = kv.slice("issue=".length);
    else if (kv.startsWith("intent=")) {
      // intent may contain spaces — collect everything up to the next
      // known key. Mirrors `_nqho_parse_lock_line`.
      let v = kv.slice("intent=".length);
      let j = i + 1;
      while (
        j < tokens.length &&
        !tokens[j].startsWith("agent=") &&
        !tokens[j].startsWith("issue=") &&
        !tokens[j].startsWith("pid=") &&
        !tokens[j].startsWith("started=") &&
        !tokens[j].startsWith("heartbeat=") &&
        !tokens[j].startsWith("taken-from=")
      ) {
        v = `${v} ${tokens[j]}`;
        j++;
      }
      out.intent = v;
      i = j - 1;
    } else if (kv.startsWith("pid=")) out.pid = kv.slice("pid=".length);
    else if (kv.startsWith("started=")) out.started = kv.slice("started=".length);
    else if (kv.startsWith("heartbeat=")) out.heartbeat = kv.slice("heartbeat=".length);
    else if (kv.startsWith("taken-from=")) out.takenFrom = kv.slice("taken-from=".length);
  }
  return out;
}

function parseRfc3339Utc(s: string): number {
  // Accept "YYYY-MM-DDTHH:MM:SSZ" with optional fractional seconds.
  // Returns ms since epoch, or NaN on unparseable input.
  if (!s) return NaN;
  const m = Date.parse(s);
  return Number.isFinite(m) ? m : NaN;
}

export type LockStatus =
  | { status: "absent" }
  | {
      status: "live";
      canonicalHost: string;
      agent: string;
      issue: string;
      intent: string;
      pid: string;
      started: string;
      heartbeat: string;
      ageSeconds: number;
      ttlSeconds: number;
    }
  | {
      status: "stale";
      canonicalHost: string;
      agent: string;
      issue: string;
      intent: string;
      pid: string;
      started: string;
      heartbeat: string;
      ageSeconds: number;
      ttlSeconds: number;
    };

export interface ReadLockStatusOpts {
  opsDir?: string;
  ttlSeconds?: number;
  now?: number;
}

export function readLockStatus(
  rawHost: string,
  opts?: ReadLockStatusOpts,
): LockStatus {
  const opsDir =
    opts?.opsDir ??
    process.env.PAPERCLIP_NETQUIRK_OPS_DIR ??
    DEFAULT_OPS_DIR;
  // TTL precedence: caller-supplied opts > validated module-level
  // capture > default 300s. Anything invalid is silently dropped to
  // the default — the validator surfaces bad env via `/healthz`,
  // not by throwing out of `readLockStatus`.
  let ttlSeconds: number;
  if (typeof opts?.ttlSeconds === "number") {
    try {
      ttlSeconds = parseNetquirkLockTtlSec(String(opts.ttlSeconds));
    } catch {
      ttlSeconds = NETQUIRK_LOCK_TTL_SEC_DEFAULT;
    }
  } else {
    ttlSeconds = RESOLVED_LOCK_TTL.ttlSeconds;
  }
  const now = opts?.now ?? Date.now();
  const canonical = canonicaliseHost(rawHost);
  const lockPath = path.join(opsDir, `${canonical}.lock`);
  if (!existsSync(lockPath)) {
    return { status: "absent" };
  }
  // Touching statSync validates readability and lets us return a clean
  // error rather than a noisy stack trace if the path is a directory,
  // a broken symlink, etc.
  try {
    statSync(lockPath);
  } catch {
    return { status: "absent" };
  }
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { status: "absent" };
  }
  const line = raw.trim();
  if (line.length === 0) return { status: "absent" };
  const parsed = parseLockLine(line);
  const hbMs = parseRfc3339Utc(parsed.heartbeat);
  // Fallback: heartbeat is unparseable — treat as stale (safer than
  // live because stale pages trigger an operator-visible "mutation
  // may be unattended" notice per NET-3946 AC #1).
  const ageSeconds = Number.isFinite(hbMs)
    ? Math.max(0, Math.floor((now - hbMs) / 1000))
    : Number.POSITIVE_INFINITY;
  const status = ageSeconds < ttlSeconds ? "live" : "stale";
  return {
    status,
    canonicalHost: canonical,
    agent: parsed.agent,
    issue: parsed.issue,
    intent: parsed.intent,
    pid: parsed.pid,
    started: parsed.started,
    heartbeat: parsed.heartbeat,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : ttlSeconds,
    ttlSeconds,
  };
}

// ---- HTTP route ----
//
// Auth: require a board actor (any board user can poll lock status;
// agents cannot, by NET-2626 convention — the lock holder is the only
// party that should ever need this view, and they hold the lock in
// their own bash session, not via this endpoint).
//
// Response shape is intentionally narrow: only the four fields the
// operator UI needs to decide whether to suppress a page. Internal
// lock metadata (agent / issue / intent / pid / started / heartbeat)
// stays on disk and in the bash helper — this endpoint is a probe,
// not an admin surface.
function readHostQuery(req: Pick<Request, "query">): string | null {
  const raw = req.query.host;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    typeof raw[0] === "string"
  ) {
    return raw[0].trim();
  }
  return null;
}

export interface HostOpsRouteDeps {
  opsDir?: string;
  ttlSeconds?: number;
  /**
   * Inject a fixed `now` (epoch ms) so the route can be exercised
   * deterministically from a supertest harness. Defaults to
   * `Date.now()`. Production callers pass nothing.
   */
  now?: () => number;
}

export function hostOpsRoutes(deps: HostOpsRouteDeps = {}): import("express-serve-static-core").Router {
  const router = Router();
  // GET /api/host-ops/lock-status?host=<host>
  //
  // Note: the `api` router is mounted at `/api/host-ops` (see app.ts),
  // so this route's full URL is `/api/host-ops/lock-status`. The route
  // path below MUST therefore be `/lock-status`, NOT
  // `/host-ops/lock-status` — using the latter would yield the broken
  // double-prefix `/api/host-ops/host-ops/lock-status`.
  //
  // Returns the live / stale / absent lock state for the supplied
  // host after alias canonicalisation. Used by monitoring-api's
  // NET-2663 receiver to decide whether a monitor page should be
  // suppressed or annotated.
  router.get("/lock-status", (req, res) => {
    // NET-6820 finding #1: gate on requireBoard BEFORE any disk I/O
    // so a non-board caller cannot probe hosts at all. Default-deny.
    if (!requireBoard(req)) {
      res.status(403).json({ error: "board_only" });
      return;
    }
    const host = readHostQuery(req);
    if (!host) {
      res.status(400).json({
        error: "missing_host",
        message: "query param `host` is required",
      });
      return;
    }
    let status: LockStatus;
    try {
      status = readLockStatus(host, {
        ...(deps.opsDir !== undefined ? { opsDir: deps.opsDir } : {}),
        ...(deps.ttlSeconds !== undefined ? { ttlSeconds: deps.ttlSeconds } : {}),
        ...(deps.now ? { now: deps.now() } : {}),
      });
    } catch (err) {
      res.status(500).json({
        error: "lock_read_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (status.status === "absent") {
      res.json({
        host,
        canonicalHost: canonicaliseHost(host),
        status: "absent",
        age_seconds: 0,
        ttl_seconds: RESOLVED_LOCK_TTL.ttlSeconds,
      });
      return;
    }
    // Trimmed response shape — no agent / issue / intent / pid /
    // started / heartbeat fields. The bash helper retains full
    // provenance for `netquirk_acquire` callers.
    res.json({
      host,
      canonicalHost: status.canonicalHost,
      status: status.status,
      age_seconds: status.ageSeconds,
      ttl_seconds: status.ttlSeconds,
    });
  });
  return router;
}
