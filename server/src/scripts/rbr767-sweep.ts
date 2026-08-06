/**
 * RBR-767 / RBR-796 sweep: route every issue that lacks a real, wakeable owner.
 *
 * This calls `resolveIssueAssigneeFallback` -- the exact function the create path uses --
 * rather than reimplementing the ladder. A bash replica of the invokability predicate
 * silently drifted (it treated `error` agents as non-invokable when they are in fact
 * invokable), which is precisely the class of bug this issue exists to kill. One ladder,
 * one source of truth.
 *
 * Two populations are swept:
 *
 *   1. **Unassigned** issues (`assignee_agent_id IS NULL AND assignee_user_id IS NULL`) --
 *      legacy invisible work created before the create-path fallback shipped, plus
 *      zero-agent-era work: rows the create path deliberately wrote with no assignee
 *      because the company had no agents at all (`no_agents_in_company`). Zero agents is
 *      the bootstrap state of every company, not an error, so the create path flags rather
 *      than refuses -- and those rows land here.
 *   2. **Degraded** issues (`assignee_fallback_reason IS NOT NULL`) -- issues the create
 *      path deliberately wrote while the roster had no invokable owner. Per RBR-796 the
 *      create path fails *visible*, never *closed*: it assigns the company root even when
 *      that root is paused, and flags the row. Those rows have a non-null assignee, so the
 *      unassigned query alone would never find them. This flag is the sweep input that
 *      closes the loop -- a degraded roster produces a worklist, not an outage.
 *
 * Both `no_invokable_owner` and `no_agents_in_company` drain through the identical path:
 * once a row lands on a genuinely invokable owner the flag is cleared. A zero-agent-era
 * issue is routed by the first sweep after the first hire. No new machinery.
 *
 * Once a degraded issue is re-routed to a genuinely invokable owner the flag is cleared,
 * so the worklist drains as the roster recovers.
 *
 * Non-terminal = status NOT IN (done, cancelled). `backlog` IS included by design: an
 * unowned backlog item is still invisible work.
 *
 *   pnpm --filter @paperclipai/server exec tsx src/scripts/rbr767-sweep.ts --company <uuid> [--apply]
 */
import type { Db } from "@paperclipai/db";
import { issues, agents, createDb } from "@paperclipai/db";
import { and, eq, isNull, isNotNull, notInArray, or } from "drizzle-orm";

import { loadConfig } from "../config.js";
import {
  loadCompanyAgentOrgRows,
  resolveIssueAssigneeFallback,
} from "../services/issue-assignee-fallback.js";
import { evaluateAgentInvokabilityFromDb, type AgentOrgRow } from "../services/agent-invokability.js";

const TERMINAL = ["done", "cancelled"];

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export type Rbr767SweepResult = {
  /** Rows the sweep considered: unassigned or flagged, non-terminal. */
  scanned: number;
  /** Rows that landed on a genuinely invokable owner (written when `apply`). */
  repaired: number;
  /** Rows that still lack an invokable owner and stay flagged for the next run. */
  failed: number;
  lines: string[];
};

/**
 * The sweep body, exported so it can be exercised against a real database rather than
 * only via the CLI. `log` is injected so tests can assert on the worklist without
 * capturing stdout.
 */
export async function runRbr767Sweep(
  db: Db,
  options: { companyId: string; apply?: boolean; log?: (line: string) => void | Promise<void> },
): Promise<Rbr767SweepResult> {
  const { companyId } = options;
  const apply = options.apply ?? false;
  const lines: string[] = [];
  // Awaited, so a caller may hand in an async sink (a file, the activity log, an API)
  // and have the sweep stay in step with it rather than racing ahead of its own
  // narration. That ordering guarantee is also what makes the per-row log line a
  // deterministic seam for exercising the between-snapshot-and-write window the
  // compare-and-swap below defends.
  const log = async (line: string) => {
    lines.push(line);
    await options.log?.(line);
  };

  const companyAgents = await loadCompanyAgentOrgRows(db, companyId);
  const agentName = new Map(companyAgents.map((a) => [a.id, a.name]));

  const orphans = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      priority: issues.priority,
      parentId: issues.parentId,
      createdByAgentId: issues.createdByAgentId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeFallbackReason: issues.assigneeFallbackReason,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      notInArray(issues.status, TERMINAL),
      or(
        // (1) Legacy invisible work, plus zero-agent-era work: no owner at all.
        and(isNull(issues.assigneeAgentId), isNull(issues.assigneeUserId)),
        // (2) Degraded work: an owner was written, but off a degraded roster. These rows
        //     have a non-null assignee and would be missed by the unassigned query alone.
        isNotNull(issues.assigneeFallbackReason),
      ),
    ));

  if (orphans.length === 0) {
    await log(`SWEEP CLEAN: 0 unassigned or degraded non-terminal issues in ${companyId}`);
    return { scanned: 0, repaired: 0, failed: 0, lines };
  }

  const unassignedCount = orphans.filter((issue) => !issue.assigneeAgentId).length;
  const degradedCount = orphans.length - unassignedCount;
  await log(
    `${orphans.length} issue(s) needing an owner `
    + `(${unassignedCount} unassigned, ${degradedCount} degraded)${apply ? "" : " (dry run)"}`,
  );
  let failed = 0;
  let repaired = 0;
  // Subset of `failed` that lost the compare-and-swap rather than failing to route.
  let racedOut = 0;

  for (const issue of orphans) {
    const parent = issue.parentId
      ? (await db.select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues).where(eq(issues.id, issue.parentId)).limit(1))[0]
      : null;

    const result = resolveIssueAssigneeFallback({
      companyId,
      parentAssigneeAgentId: parent?.assigneeAgentId ?? null,
      createdByAgentId: issue.createdByAgentId,
      companyAgents,
    });

    // `applied: false` here means only `no_agents_in_company` -- the company still has no
    // agents, so the row keeps its flag and is re-routed by the first sweep after the
    // first hire. A still-degraded result means the roster has not recovered yet, same
    // outcome. Neither is an error in the row; both are "the roster is not ready."
    if (!result.applied) {
      failed += 1;
      await log(`${issue.identifier} [${issue.status}/${issue.priority}] -> NO OWNER POSSIBLE (${result.reason})`);
      continue;
    }
    if (result.degraded) {
      failed += 1;
      await log(
        `${issue.identifier} [${issue.status}/${issue.priority}] -> STILL DEGRADED `
        + `(${result.degradedReason}); leaving flagged for the next sweep`,
      );
      continue;
    }

    const owner = `${result.reason} = ${agentName.get(result.assigneeAgentId) ?? "?"} (${result.assigneeAgentId})`;
    await log(`${issue.identifier} [${issue.status}/${issue.priority}] -> ${owner}`);
    repaired += 1;

    if (apply) {
      // Guard the write in two ways against drift since the initial snapshots:
      //  1. Re-validate invokability of the chosen owner against a fresh roster read,
      //     right before writing. `companyAgents` was loaded once at the top of the
      //     sweep; an agent could have been paused/terminated/reparented into an invalid
      //     chain since then, and Greptile correctly flagged that a stale invokability
      //     verdict could land a non-wakeable owner on the repaired issue.
      //  2. The UPDATE is a compare-and-swap: its WHERE pins the write to the assignee
      //     this sweep snapshotted, and re-checks non-terminal status, so a concurrent
      //     reassignment, claim, completion or cancellation landing between the SELECT
      //     and this UPDATE loses the race by design and is reported rather than
      //     silently overwritten.
      const [freshOwner] = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          reportsTo: agents.reportsTo,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, result.assigneeAgentId))
        .limit(1);
      const freshInvokability = await evaluateAgentInvokabilityFromDb(
        db,
        (freshOwner as AgentOrgRow | undefined) ?? null,
      );
      if (!freshInvokability.invokable) {
        failed += 1;
        repaired -= 1;
        await log(
          `${issue.identifier} [${issue.status}/${issue.priority}] -> SKIPPED: chosen owner `
          + `${result.assigneeAgentId} is no longer invokable (${freshInvokability.reason}); rerun the sweep`,
        );
        continue;
      }
      const written = await db.update(issues)
        .set({
          assigneeAgentId: result.assigneeAgentId,
          // The row now has a genuinely invokable owner, so it is no longer degraded.
          // Clearing the flag is what drains the worklist as the roster recovers.
          assigneeFallbackReason: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(issues.id, issue.id),
          notInArray(issues.status, TERMINAL),
          // RBR-813 AC2: compare-and-swap against the assignee this sweep snapshotted at
          // the top-of-run SELECT. The flag-clearing above is the root-cause fix and on
          // its own is enough for every writer that goes through `issueService`; this is
          // the backstop for the window that fix cannot close -- a reassignment that
          // lands *after* the SELECT and *before* this UPDATE, where the row was still
          // legitimately flagged when it was scanned. Pinning the write to its own
          // snapshot makes the repair atomic with respect to the plan it was computed
          // from, rather than merely "still degraded at write time." Skipping is always
          // the right call on a mismatch: whatever moved the row is newer information
          // than anything this sweep computed.
          issue.assigneeAgentId === null
            ? isNull(issues.assigneeAgentId)
            : eq(issues.assigneeAgentId, issue.assigneeAgentId),
          or(
            // Unchanged guard for the legacy unassigned population: do not clobber a
            // concurrent explicit assignment landed since the SELECT.
            and(isNull(issues.assigneeAgentId), isNull(issues.assigneeUserId)),
            // Degraded rows already have an assignee, so the unassigned guard would reject
            // every one of them. Gate on the flag instead: still-degraded means nobody has
            // claimed it since the SELECT, so re-routing is safe.
            //
            // RBR-813: that premise used to be false, and this branch was silently
            // stealing explicit assignments. Nothing on the update/reassign path cleared
            // the flag, so a row a human deliberately took stayed flagged forever and
            // every subsequent sweep overwrote their owner with the ladder's pick. The
            // fix is to make the premise true rather than to weaken this predicate:
            // `issueService.update` and `issueService.checkout` now clear
            // `assigneeFallbackReason` whenever an explicit assignee lands, so a claimed
            // row is out of the worklist entirely and a row that reaches here really is
            // one nobody has accepted. Keep this branch -- deleting it would strand every
            // genuinely-degraded row, which all carry an assignee by construction.
            isNotNull(issues.assigneeFallbackReason),
          ),
        ))
        .returning({ id: issues.id });

      // Zero rows means the compare-and-swap lost: the row changed underneath this sweep
      // between the scan and the write. Report it as skipped rather than repaired so the
      // counts stay honest and the operator knows to rerun rather than believing a repair
      // landed that did not.
      if (written.length === 0) {
        repaired -= 1;
        failed += 1;
        racedOut += 1;
        await log(
          `${issue.identifier} [${issue.status}/${issue.priority}] -> SKIPPED: the row changed `
          + `under the sweep (reassigned, claimed, or closed since the scan); rerun the sweep`,
        );
      }
    }
  }

  // Split the tail summary by cause. A row that raced out did *not* fail to find an
  // invokable owner and is not necessarily still flagged -- whatever moved it may well
  // have given it a better owner than the ladder would have -- so folding it into the
  // roster-has-not-recovered line would tell the operator something false about their
  // data at exactly the moment they are deciding whether to rerun.
  const unrouted = failed - racedOut;
  if (unrouted > 0) {
    await log(
      `\n${unrouted} issue(s) still lack an invokable owner -- the roster has not recovered. `
      + `They remain flagged and will be re-routed by the next sweep.`,
    );
  }
  if (racedOut > 0) {
    await log(
      `\n${racedOut} issue(s) changed under the sweep and were left untouched. `
      + `Their current state is newer than this run's plan; rerun the sweep to re-evaluate them.`,
    );
  }

  return { scanned: orphans.length, repaired, failed, lines };
}

async function main() {
  const companyId = parseFlag("--company");
  if (!companyId) throw new Error("--company <uuid> is required");
  const apply = process.argv.includes("--apply");

  const config = loadConfig();
  const db = createDb(
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`,
  );

  const result = await runRbr767Sweep(db, {
    companyId,
    apply,
    log: (line) => console.log(line),
  });
  if (result.failed > 0) process.exitCode = 1;
}

// Only run the CLI when this module is the process entrypoint. Importing it from a test
// must not start a sweep or call process.exit.
const invokedAsScript = process.argv[1]?.includes("rbr767-sweep") ?? false;
if (invokedAsScript) {
  // The pg pool keeps the event loop alive; exit explicitly once the sweep is done.
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
