import { readRunRequester } from "./requester-clearance.js";

/**
 * NEO-448 Phase 3 — transitive origin principal for delegation chains.
 *
 * A run may be caused (directly or transitively) by a human request. The
 * ORIGIN principal is stamped once on the seed run by trusted server code and
 * then copied VERBATIM across every wake/handoff/retry hop — never re-derived
 * from the acting agent — so a chain A→B→T cannot launder a low-cleared
 * requester into an agent's autonomous binding authority. The PEP enforces
 * MIN(origin, requester, agent-binding) and fails closed on unresolved or
 * over-depth origins.
 *
 * Origin kinds:
 * - "user":       the chain was seeded by an identified human requester.
 * - "autonomous": the chain was seeded by the system (timer/automation) with
 *                 no human principal — existing autonomousAllowed rules apply.
 * - "unresolved": the chain is agent-caused but the origin could not be
 *                 established (missing acting-run context, unmapped channel
 *                 sender, malformed snapshot). The PEP floors this to guest.
 */

/** Maximum agent→agent hops a user-origin chain may traverse before the PEP floors it. */
export const MAX_DELEGATION_DEPTH = 8;

export type OriginKind = "user" | "autonomous" | "unresolved";
export type OriginClearance = "guest" | "member" | "board";

/** The shape persisted at `heartbeatRuns.contextSnapshot.origin`. */
export interface RunOriginSnapshot {
  kind: OriginKind;
  /** Origin human principal; set only when kind === "user". */
  userId: string | null;
  /**
   * Clearance stamped at seed time (immutable across hops). Advisory: the PEP
   * re-derives fresh clearance from company_memberships and takes
   * MIN(stamped, fresh) so a post-seed promotion never widens a chain while a
   * revocation takes effect immediately.
   */
  clearance: OriginClearance | null;
  /** Number of agent→agent hops since the seed run. */
  depth: number;
}

const CLEARANCE_RANK: Record<string, number> = { guest: 0, member: 1, board: 2 };

function isClearance(v: unknown): v is OriginClearance {
  return v === "guest" || v === "member" || v === "board";
}

function normalizeDepth(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  // Cap the stored value just past the enforcement limit so a runaway loop
  // cannot grow the snapshot unboundedly while "over cap" stays observable.
  return Math.min(Math.floor(v), MAX_DELEGATION_DEPTH + 1);
}

/**
 * Read + validate the origin snapshot off a run's contextSnapshot.
 * Absent ⇒ null (pre-Phase-3 run or autonomous seed with no stamp).
 * Present but malformed ⇒ "unresolved" (fail closed, never fail open).
 */
export function readRunOrigin(contextSnapshot: unknown): RunOriginSnapshot | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = (contextSnapshot as Record<string, unknown>).origin;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return unresolvedOrigin(0);
  const r = raw as Record<string, unknown>;
  const depth = normalizeDepth(r.depth);
  if (depth === null) return unresolvedOrigin(MAX_DELEGATION_DEPTH + 1);
  const kind = r.kind;
  if (kind === "autonomous") {
    return { kind: "autonomous", userId: null, clearance: null, depth };
  }
  if (kind === "user") {
    const userId = typeof r.userId === "string" && r.userId.trim().length > 0 ? r.userId : null;
    if (!userId) return unresolvedOrigin(depth);
    return {
      kind: "user",
      userId,
      clearance: isClearance(r.clearance) ? r.clearance : null,
      depth,
    };
  }
  return unresolvedOrigin(depth);
}

/** Seed an origin from the run's requester identity (channel/heartbeat dispatch). */
export function seedOriginFromRequester(input: {
  userId: string | null;
  clearance: OriginClearance | null;
}): RunOriginSnapshot {
  if (input.userId) {
    return { kind: "user", userId: input.userId, clearance: input.clearance, depth: 0 };
  }
  // A dispatch that is BY DEFINITION on behalf of someone (channel message)
  // but whose sender could not be mapped to a Paperclip user: fail closed.
  return unresolvedOrigin(0);
}

export function autonomousOrigin(depth = 0): RunOriginSnapshot {
  return { kind: "autonomous", userId: null, clearance: null, depth };
}

export function unresolvedOrigin(depth: number): RunOriginSnapshot {
  return {
    kind: "unresolved",
    userId: null,
    clearance: null,
    depth: Math.min(Math.max(0, Math.floor(depth)), MAX_DELEGATION_DEPTH + 1),
  };
}

/**
 * Copy an origin VERBATIM onto the next run in the chain. `hop: true` when the
 * wake crosses agents (delegation); same-agent continuations/retries keep the
 * depth unchanged. Identity and stamped clearance are never re-derived here.
 */
export function propagateOrigin(
  prior: RunOriginSnapshot,
  opts: { hop: boolean },
): RunOriginSnapshot {
  const depth = normalizeDepth(opts.hop ? prior.depth + 1 : prior.depth) ?? MAX_DELEGATION_DEPTH + 1;
  return { kind: prior.kind, userId: prior.userId, clearance: prior.clearance, depth };
}

/**
 * Derive the origin to propagate from a prior (acting/source) run:
 * an explicit origin stamp wins; else a requester on the run seeds a
 * user-origin (pre-Phase-3 rows); else the run was autonomous.
 */
export function originFromPriorRun(priorRun: { contextSnapshot: unknown }): RunOriginSnapshot {
  const existing = readRunOrigin(priorRun.contextSnapshot);
  if (existing) return existing;
  const requester = readRunRequester(priorRun.contextSnapshot);
  if (requester) {
    return seedOriginFromRequester({ userId: requester.userId, clearance: null });
  }
  return autonomousOrigin();
}

/**
 * Effective clearance of a user-origin at execute time:
 * MIN(stamped-at-seed, fresh-from-membership). A now-revoked/unmapped
 * membership (fresh null) dominates to null — the PEP floors that to guest —
 * while a missing seed stamp simply defers to the fresh derivation.
 */
export function effectiveOriginClearance(
  stamped: OriginClearance | null,
  fresh: OriginClearance | null,
): OriginClearance | null {
  if (fresh === null) return null;
  if (stamped === null) return fresh;
  return CLEARANCE_RANK[stamped] <= CLEARANCE_RANK[fresh] ? stamped : fresh;
}
