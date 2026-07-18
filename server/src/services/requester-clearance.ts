import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";

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
