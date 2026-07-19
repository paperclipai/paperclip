import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { MAX_DELEGATION_DEPTH } from "./delegation-origin.js";

/**
 * NEO-447 Phase 2 — requester identity for MCP tool authorization.
 *
 * A heartbeat/channel run may act on behalf of a human requester. The
 * requester's identity is persisted onto the run row at dispatch time
 * (`heartbeatRuns.contextSnapshot.requester`) by the trusted dispatcher
 * (heartbeat wake or the channel-run registrar) — never supplied by the
 * agent itself. The requester's AUTHORITY (clearance) is re-derived fresh
 * from company_memberships at execute time so a revoked membership takes
 * effect immediately, not at next dispatch.
 */

/** The shape persisted at `heartbeatRuns.contextSnapshot.requester`. */
export interface RunRequesterSnapshot {
  /** Paperclip user id the run acts on behalf of; null = unresolved. */
  userId: string | null;
  /** Channel-native sender id (e.g. Cliq user id), for audit trail only. */
  channelUserId?: string | null;
  /** Channel/conversation id the request originated from. */
  channelId?: string | null;
  /** Originating surface, e.g. "cliq". */
  source?: string | null;
}

/** Read + validate the requester snapshot off a run's contextSnapshot. */
export function readRunRequester(
  contextSnapshot: unknown,
): RunRequesterSnapshot | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = (contextSnapshot as Record<string, unknown>).requester;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  return {
    userId: str(r.userId),
    channelUserId: str(r.channelUserId),
    channelId: str(r.channelId),
    source: str(r.source),
  };
}

/**
 * Map a human company-membership role to an MCP clearance level
 * (guest < member < board — see agent-mcp-tools CLEARANCE_RANK).
 * Unknown/absent roles resolve to null (UNRESOLVED ⇒ caller floors).
 */
export function clearanceForMembershipRole(
  membershipRole: string | null | undefined,
): "guest" | "member" | "board" | null {
  switch (membershipRole) {
    case "owner":
    case "admin":
      return "board";
    case "operator":
      return "member";
    case "viewer":
      return "guest";
    default:
      return null;
  }
}

/**
 * Re-derive a requester's clearance from their ACTIVE membership in the
 * run's company. Missing, inactive, or unmapped membership ⇒ null
 * (UNRESOLVED — the PEP floors it to guest, never agent authority).
 */
export async function resolveRequesterClearance(
  db: Db,
  companyId: string,
  userId: string,
): Promise<"guest" | "member" | "board" | null> {
  const [row] = await db
    .select({
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ),
    )
    .limit(1);
  if (!row || row.status !== "active") return null;
  return clearanceForMembershipRole(row.membershipRole);
}

/* ---------------------------------------------------------------------------
 * NEO-568 (563a) — effective-clearance MIN engine ported onto upstream.
 *
 * The identity helpers above answer "who is the requester and what is their
 * role". This section answers "given the agent, the requester, and the trusted
 * delegation origin, what is the EFFECTIVE clearance, and does it clear a given
 * tool?". It is a faithful port of the fork's `effectiveClearance` in
 * `agent-mcp-tools.ts` (NEO-446/447/448):
 *
 *   effective clearance = MIN(agentAuthority, requestingUserRole, originClearance)
 *
 * with a hard guest floor, fail-closed origin handling, and the autonomous
 * (no-user heartbeat) → guest-unless-allowed rule. Upstream `selectorMatches()`
 * keys on actor/agent/project/routine/issue/gateway/application — NOT on the
 * invoking human's role — so this supplies that missing dimension and the two
 * enforcement points it feeds: the catalog clamp (NEO-447) and the invocation
 * gate (NEO-448). The gateway wiring that calls these helpers lands in 563c
 * (NEO-570); the broad parity suite lands in 563f (NEO-572).
 * ------------------------------------------------------------------------- */

export type ToolClearanceRole = "guest" | "member" | "board";

// guest < member < board. An unknown/unmapped role ranks -1 so it can never
// satisfy any required clearance (fail closed).
export const CLEARANCE_RANK: Record<string, number> = { guest: 0, member: 1, board: 2 };

export function clearanceRank(role: string | null | undefined): number {
  return CLEARANCE_RANK[role ?? ""] ?? -1;
}

/** Map a numeric rank (clamped to guest..board) back to a role. */
export function rankToRole(rank: number): ToolClearanceRole {
  if (rank <= 0) return "guest";
  if (rank === 1) return "member";
  return "board";
}

/** Normalize an arbitrary value to a known clearance role, or null. */
export function normalizeClearanceRole(value: unknown): ToolClearanceRole | null {
  if (value === "guest" || value === "member" || value === "board") return value;
  return null;
}

/**
 * NEO-448 Phase 3: the transitive origin principal of the delegation chain,
 * derived by the route/gateway layer from the TRUSTED run row (never
 * agent-supplied). `role` is already MIN(stamped-at-seed, fresh-from-membership).
 */
export interface OriginAuthzContext {
  kind: "user" | "autonomous" | "unresolved";
  userId: string | null;
  role: string | null;
  depth: number;
}

export type InvocationSource = "heartbeat" | "channel" | null;

/**
 * The requester dimension of a tool-access decision. `agentAuthority` is the
 * agent principal's own clearance ceiling (the upstream analog of the fork's
 * per-binding `bindingAuthority`); `requestingUserRole` is the human behind the
 * request (null when none is resolved); `origin` is the trusted delegation
 * origin.
 */
export interface RequesterClearanceInput {
  agentAuthority: string;
  requestingUserRole: string | null | undefined;
  autonomousAllowed: boolean;
  invocationSource: InvocationSource;
  origin?: OriginAuthzContext | null;
}

/**
 * Effective clearance = MIN(agentAuthority, requestingUserRole, originClearance).
 *
 * Ported from the fork's `effectiveClearance` so the requester-clearance
 * dimension behaves identically on the upstream stack:
 *  - unresolved origin → guest (fail closed)
 *  - delegation depth over the cap → guest (defeats depth-laundering)
 *  - autonomous (no user, non-user origin): channel source → guest; otherwise
 *    the agent's authority iff `autonomousAllowed`, else guest
 *  - otherwise MIN over {agentAuthority, requestingUserRole?, originRole?} with a
 *    guest floor (rank <= 0 → guest).
 */
export function effectiveClearance(input: RequesterClearanceInput): ToolClearanceRole {
  const { agentAuthority, requestingUserRole, autonomousAllowed, invocationSource, origin } = input;

  // NEO-448 Phase 3: delegation-origin clamps come first, fail-closed. An
  // agent-caused run whose origin could not be established must never pass as
  // autonomous, and a chain deeper than the cap is refused wholesale.
  if (origin) {
    if (origin.kind === "unresolved") return "guest";
    if (origin.depth > MAX_DELEGATION_DEPTH) return "guest";
  }
  const originIsUser = origin?.kind === "user";
  const isAutonomous = requestingUserRole == null && !originIsUser;
  if (isAutonomous) {
    // NEO-447 Phase 2: a channel run is BY DEFINITION on behalf of someone — an
    // unresolved/unmapped requester must never inherit autonomous authority.
    if (invocationSource === "channel") return "guest";
    // Autonomous (heartbeat/no user): full agent authority iff allowed, else guest.
    return autonomousAllowed ? rankToRole(clearanceRank(agentAuthority)) : "guest";
  }
  // MIN(agentAuthority, requesterClearance, originClearance) — the origin
  // dimension defeats MAX-over-chain laundering: no hop can widen the chain past
  // the human who seeded it.
  const ranks = [clearanceRank(agentAuthority)];
  if (requestingUserRole != null) ranks.push(clearanceRank(requestingUserRole));
  if (originIsUser) ranks.push(clearanceRank(origin!.role));
  return rankToRole(Math.min(...ranks));
}

/**
 * Does an effective clearance meet a required minimum role? An unmapped required
 * role (rank -1) is satisfied by any real clearance; an unmapped effective
 * clearance never satisfies a real requirement (fail closed).
 */
export function meetsMinRequesterRole(
  effective: string | null | undefined,
  requiredMinRole: string | null | undefined,
): boolean {
  return clearanceRank(effective) >= clearanceRank(requiredMinRole);
}

/**
 * NEO-447 catalog clamp: keep only the tools whose required clearance is within
 * the requester's effective clearance. An agent must not even SEE (enumerate,
 * volunteer) a tool it cannot invoke. `requiredRoleFor` returns the per-tool
 * min-role (falling back to a binding/connection default).
 */
export function clampToolsByClearance<T>(
  tools: readonly T[],
  effective: string | null | undefined,
  requiredRoleFor: (tool: T) => string | null | undefined,
): T[] {
  const effectiveRank = clearanceRank(effective);
  return tools.filter((tool) => effectiveRank >= clearanceRank(requiredRoleFor(tool)));
}

export interface InvocationClearanceDecision {
  allowed: boolean;
  effective: ToolClearanceRole;
  requiredRole: ToolClearanceRole;
  /**
   * Taint ceiling for the result (NEO-448): re-surfacing sensitive tool output
   * must re-check the reader against this. An unmapped required role labels as
   * board (fail closed).
   */
  clearanceCeiling: ToolClearanceRole;
}

/**
 * NEO-448 invocation gate: decide whether a call is permitted, given the
 * requester dimension and the tool's required clearance. Mirrors the fork's
 * execute-path gate so the audited PEP behaves identically upstream.
 */
export function decideInvocationClearance(
  requester: RequesterClearanceInput,
  requiredToolRole: string | null | undefined,
): InvocationClearanceDecision {
  const effective = effectiveClearance(requester);
  const requiredRole = normalizeClearanceRole(requiredToolRole) ?? "board";
  return {
    allowed: clearanceRank(effective) >= clearanceRank(requiredToolRole),
    effective,
    requiredRole,
    clearanceCeiling:
      requiredToolRole === "guest" || requiredToolRole === "member" ? requiredToolRole : "board",
  };
}
