/**
 * Legacy-agent enrollment for the default MCP spec (TECH-7339).
 *
 * Applies the same durable snapshot + setup path used for new-agent creation
 * (`snapshotDefaultMcpForNewAgent` / `scheduleDefaultMcpSetup`, `default-mcp-setup.ts`) to agents
 * created before the feature existed. No client metadata PATCH, direct SQL edit or one-off token
 * script: this is the same server-managed `agents.metadata.defaultMcp` write, through the same
 * code path, so an enrolled agent is indistinguishable from one created after the feature shipped.
 *
 * Idempotent: only an agent whose `defaultMcp` key is absent or explicitly null (the same
 * "legacy/unmanaged" definition used everywhere else in this feature, see
 * doc/connections/DEFAULT-MCP-SPEC.md) is touched. An agent that already has a snapshot -- however
 * it got there -- is left alone, so a repeated batch never duplicates an identity, connection,
 * binding or credential. An agent whose `defaultMcp` key is present but fails validation is reported
 * as `corrupted_existing_state` rather than silently overwritten; that state fails closed at runtime
 * (see `readDefaultMcpState`) and this path does not second-guess that.
 *
 * Respects the same gates as new-agent creation: the feature flag
 * (`PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED`) and the frozen company rollout scope
 * (`PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS`). An archived company is skipped and reported, never
 * enrolled. `dryRun` performs the same scan and classification with no writes (a census).
 */
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { readDefaultMcpTemplateScope, isCompanyInDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import {
  DEFAULT_MCP_METADATA_KEY,
  DEFAULT_MCP_SPEC,
  isDefaultMcpSpecEnabled,
  isValidDefaultMcpTemplate,
  readDefaultMcpState,
} from "./default-mcp-spec.js";
import { scheduleDefaultMcpSetup, snapshotDefaultMcpForNewAgent } from "./default-mcp-setup.js";

export const DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT = 25;
const COMMS_BOARD_ENTRY_KEY = "comms-board";

export type LegacyEnrollmentSkipReason =
  | "company_archived"
  | "company_out_of_scope"
  | "owner_required"
  | "corrupted_existing_state"
  | "agent_terminated"
  | "already_enrolled"
  | "legacy_access_conflict";

export type LegacyEnrollmentOutcome =
  | { agentId: string; companyId: string; result: "enrolled"; ownerAssignmentRequired?: true }
  | { agentId: string; companyId: string; result: "would_enroll"; ownerAssignmentRequired?: true }
  | { agentId: string; companyId: string; result: "skipped"; reason: LegacyEnrollmentSkipReason };

export interface LegacyEnrollmentReport {
  /** Rows actually scanned in this batch (bounded by `limit`), not a total count across all pages. */
  scanned: number;
  outcomes: LegacyEnrollmentOutcome[];
  /** Pass as `afterId` to resume; null once a batch returns fewer rows than `limit`. */
  nextCursor: string | null;
}

/** Same "legacy/unmanaged" definition as `readDefaultMcpState`, split from "corrupted". */
function classifyDefaultMcpMetadata(metadata: unknown): "absent" | "corrupted" | "present" {
  // A non-null, non-plain-object metadata value (array, string, number) is malformed agent metadata,
  // not "no defaultMcp key" -- treating it as absent would let the enrollment write attempt a
  // `jsonb_set` against a non-object root and throw inside the transaction. Report it instead.
  if (metadata !== null && metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
    return "corrupted";
  }
  if (!metadata || typeof metadata !== "object") return "absent";
  const raw = (metadata as Record<string, unknown>)[DEFAULT_MCP_METADATA_KEY];
  if (raw === undefined || raw === null) return "absent";
  return readDefaultMcpState(metadata) !== null ? "present" : "corrupted";
}

export interface LegacyResponsibleUser {
  userId: string;
  emailNorm: string;
}

const AGENT_CREATION_ACTIONS = ["agent.created", "agent.hire_created"] as const;
const AGENT_APPROVAL_ACTIONS = ["agent.approved"] as const;

async function earliestUserActorFor(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
  actions: readonly string[],
): Promise<string | null> {
  const [row] = await db
    .select({ actorId: activityLog.actorId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, agentId),
        eq(activityLog.actorType, "user"),
        inArray(activityLog.action, actions),
      ),
    )
    .orderBy(asc(activityLog.createdAt))
    .limit(1);
  return row?.actorId ?? null;
}

/**
 * The human responsible for a specific legacy agent: the earliest verified-human actor on its own
 * `agent.created`/`agent.hire_created` activity, or (if it was created by an agent or built-in) its
 * earliest `agent.approved` activity. Deliberately NOT `activityLog.responsibleUserId` (falls back to
 * the company default) and NOT the company's owner/admin: a company-wide fallback here would
 * attribute a specific agent's credential to a human who may have had nothing to do with it. A known
 * candidate who isn't an active, verified-email company member is treated the same as no candidate --
 * `owner_required` -- never silently substituted.
 */
export async function resolveLegacyResponsibleUser(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<LegacyResponsibleUser | null> {
  const candidateId =
    (await earliestUserActorFor(db, companyId, agentId, AGENT_CREATION_ACTIONS)) ??
    (await earliestUserActorFor(db, companyId, agentId, AGENT_APPROVAL_ACTIONS));
  if (!candidateId) return null;
  return verifyResponsibleUserCandidate(db, companyId, candidateId);
}

/**
 * The membership gate shared by the audit-log resolver and the operator override: the user must be an ACTIVE `user`
 * member of the company with a verified email. Null when any part fails.
 */
export async function verifyResponsibleUserCandidate(
  db: Pick<Db, "select">,
  companyId: string,
  candidateId: string,
): Promise<LegacyResponsibleUser | null> {
  const [membership] = await db
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, candidateId),
        eq(companyMemberships.status, "active"),
        eq(authUsers.emailVerified, true),
      ),
    )
    .limit(1);
  const emailNorm = (membership?.email ?? "").trim().toLowerCase();
  if (!emailNorm) return null;
  return { userId: candidateId, emailNorm };
}

interface LegacyAccessAssessment {
  /** Ordinary (non-dedicated) entry keys this agent already has effective access to; preserve as ON. */
  preserveKeys: ReadonlySet<string>;
  /** An existing install exists but can't be safely mapped to a valid, unambiguous template. */
  conflict: boolean;
}

/**
 * Before a legacy agent is snapshotted, a company-wide install on one of the ordinary (non-dedicated)
 * spec entries (e.g. Google) grants it effective access today (see `installAppliesToAgent`: a
 * company install applies whenever the agent has no `defaultMcp` state at all). The instant the
 * agent becomes snapshot-managed, that same function stops honoring a company-wide install for a
 * managed connection -- only an explicit per-agent install counts. Left alone, enrollment would
 * silently revoke access with no DB row ever changing. This inspects each ordinary entry's existing
 * agent-or-company install (if any) and reports which entry keys to carry forward as an explicit
 * install (`preserveKeys`, passed to `snapshotDefaultMcpForNewAgent`'s `preserveEnabledKeys`), or
 * flags `conflict` when an install exists but can't be safely attributed to one valid template --
 * the caller skips the whole agent (`legacy_access_conflict`) rather than guess.
 */
export async function assessLegacyOrdinaryAccess(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<LegacyAccessAssessment> {
  const ordinaryEntries = DEFAULT_MCP_SPEC.filter((entry) => !entry.setupHook);
  if (ordinaryEntries.length === 0) return { preserveKeys: new Set(), conflict: false };
  const installs = await db
    .select({ connectionId: toolConnectionInstalls.connectionId, targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
    .from(toolConnectionInstalls)
    .where(
      and(
        eq(toolConnectionInstalls.companyId, companyId),
        inArray(toolConnectionInstalls.targetType, ["agent", "company"]),
      ),
    );
  const installedConnectionIds = new Set(
    installs
      .filter((install) => (install.targetType === "agent" && install.targetId === agentId) || (install.targetType === "company" && install.targetId === companyId))
      .map((install) => install.connectionId),
  );
  if (installedConnectionIds.size === 0) return { preserveKeys: new Set(), conflict: false };

  const preserveKeys = new Set<string>();
  for (const entry of ordinaryEntries) {
    const candidates = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, entry.connectionName), ne(toolConnections.status, "archived")));
    const relevantInstalled = candidates.filter((candidate) => installedConnectionIds.has(candidate.id));
    if (relevantInstalled.length === 0) continue; // no install touches this entry's connection name
    const candidate = candidates.length === 1 ? candidates[0]! : null;
    const valid = candidate && isValidDefaultMcpTemplate(entry, candidate) ? candidate : null;
    if (valid && relevantInstalled.length === 1 && relevantInstalled[0]!.id === valid.id) {
      preserveKeys.add(entry.key);
    } else {
      // An install exists but points at an ambiguous name collision or a connection that fails the
      // entry's template requirements -- there is no safe way to know this install still means what
      // it used to, so this agent is not enrolled at all rather than guessing.
      return { preserveKeys: new Set(), conflict: true };
    }
  }
  return { preserveKeys, conflict: false };
}

/**
 * Scans agents in id order (stable, resumable pagination), classifies each one, and -- unless
 * `dryRun` -- enrolls eligible legacy agents through the existing new-agent snapshot/setup hooks.
 * Bounded to `limit` rows per call; callers needing full coverage page with `nextCursor` until it
 * is null. Returns an empty report (no scan) when the feature flag is off.
 */
export async function enrollLegacyAgentsWithDefaultMcp(
  db: Db,
  options: {
    companyId?: string;
    agentId?: string;
    /** Enroll the board identity without creating a private brain. Preserve ordinary access. */
    commsOnly?: boolean;
    /** Comms-only: leave private-brain setup absent instead of recording an exclusion. */
    arcanaBrainPolicy?: "exclude" | "preserve";
    limit?: number;
    afterId?: string;
    dryRun?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LegacyEnrollmentReport> {
  if (options.arcanaBrainPolicy !== undefined && !options.commsOnly) {
    throw new Error("arcanaBrainPolicy requires comms-only enrollment");
  }
  const env = options.env ?? process.env;
  if (!isDefaultMcpSpecEnabled(env)) {
    return { scanned: 0, outcomes: [], nextCursor: null };
  }
  const limit = options.agentId ? 1 : Math.max(1, Math.min(options.limit ?? DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT, DEFAULT_MCP_LEGACY_ENROLLMENT_BATCH_LIMIT));
  const scope = readDefaultMcpTemplateScope();
  const spec = options.commsOnly && options.arcanaBrainPolicy === "preserve"
    ? DEFAULT_MCP_SPEC.filter((entry) => entry.key !== "arcana-brain")
    : DEFAULT_MCP_SPEC;
  const excludedSetupKeys = options.commsOnly
    ? new Set(spec.filter((entry) => entry.setupHook && entry.key !== COMMS_BOARD_ENTRY_KEY).map((entry) => entry.key))
    : undefined;

  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      metadata: agents.metadata,
      status: agents.status,
      companyStatus: companies.status,
    })
    .from(agents)
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(
      and(
        options.companyId ? eq(agents.companyId, options.companyId) : undefined,
        options.agentId ? eq(agents.id, options.agentId) : undefined,
        !options.agentId && options.afterId ? gt(agents.id, options.afterId) : undefined,
      ),
    )
    .orderBy(asc(agents.id))
    .limit(limit);

  const outcomes: LegacyEnrollmentOutcome[] = [];
  for (const row of rows) {
    const classification = classifyDefaultMcpMetadata(row.metadata);
    if (classification === "present") {
      if (options.agentId) outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "already_enrolled" });
      continue;
    }
    if (classification === "corrupted") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "corrupted_existing_state" });
      continue;
    }
    // A terminated agent is the agent-level equivalent of an archived company: excluded from the
    // normal agent listing everywhere else in this service (see `agentService(db).list`), and
    // enrolling it would leave a pending defaultMcp snapshot with no running agent to ever finish
    // setup for it.
    if (row.status === "terminated") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "agent_terminated" });
      continue;
    }
    if (row.companyStatus === "archived") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "company_archived" });
      continue;
    }
    if (!isCompanyInDefaultMcpTemplateScope(scope, row.companyId)) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "company_out_of_scope" });
      continue;
    }
    // Full enrollment still requires a verified historical owner. Comms-only
    // initialization may leave it unset for the existing explicit caller-owner
    // assignment flow; it never substitutes an arbitrary company owner.
    const owner = await resolveLegacyResponsibleUser(db, row.companyId, row.id);
    if (!owner && !options.commsOnly) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "owner_required" });
      continue;
    }
    const access = await assessLegacyOrdinaryAccess(db, row.companyId, row.id);
    if (access.conflict) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "legacy_access_conflict" });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "would_enroll", ...(!owner ? { ownerAssignmentRequired: true as const } : {}) });
      continue;
    }
    // Row-locked re-check before writing: the pre-scan above is not a snapshot isolation guarantee,
    // so two overlapping batches (or a batch racing the agent's own first heartbeat, a termination,
    // or an approval) could otherwise act on stale metadata or a stale status. Locking here (same
    // `for("update")` pattern as the company template claim in default-mcp-template.ts) re-reads
    // both metadata and status at lock time: a second caller sees the first caller's write and skips
    // instead of re-snapshotting, and an agent terminated in that same window is skipped rather than
    // enrolled with a stale `status`.
    const txResult = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ metadata: agents.metadata, status: agents.status })
        .from(agents)
        .where(eq(agents.id, row.id))
        .limit(1)
        .for("update");
      if (!locked || classifyDefaultMcpMetadata(locked.metadata) !== "absent") return "lost_race" as const;
      if (locked.status === "terminated") return "terminated" as const;
      await snapshotDefaultMcpForNewAgent(tx, {
        companyId: row.companyId,
        agentId: row.id,
        existingMetadata: locked.metadata,
        ownerUserId: owner?.userId ?? null,
        status: locked.status,
        preserveEnabledKeys: access.preserveKeys,
        spec,
        excludedSetupKeys,
      });
      return "enrolled" as const;
    });
    if (txResult === "lost_race") continue; // lost the race or the agent was deleted mid-batch; not an error, not reported
    if (txResult === "terminated") {
      outcomes.push({ agentId: row.id, companyId: row.companyId, result: "skipped", reason: "agent_terminated" });
      continue;
    }
    // After the snapshot write commits; setup makes external calls, and the durable 60s sweep
    // (`sweepDefaultMcpSetups`) is the backstop if this process dies before it runs.
    scheduleDefaultMcpSetup(db, { companyId: row.companyId, agentId: row.id }, { env, spec });
    outcomes.push({ agentId: row.id, companyId: row.companyId, result: "enrolled", ...(!owner ? { ownerAssignmentRequired: true as const } : {}) });
  }

  return {
    scanned: rows.length,
    outcomes,
    nextCursor: !options.agentId && rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

/** Convenience dry-run wrapper: a census with no writes, same classification/skip reasons. */
export async function censusLegacyAgentsPendingDefaultMcp(
  db: Db,
  options: { companyId?: string; limit?: number; afterId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LegacyEnrollmentReport> {
  return enrollLegacyAgentsWithDefaultMcp(db, { ...options, dryRun: true });
}
