import { eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import type { AccountWithHealth, PoolAccount, QuotaWindow } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import {
  getPoolState,
  getStopSwitch,
  listPoolAccounts,
  savePoolAccountHealth,
  setActiveAccount,
} from "./account-pool.js";

/**
 * Balancer Brain — the cron-driven core of the Account Pool & Rotation feature.
 *
 * Every cycle, for each company that has a pool:
 *   1. list pool accounts (company_secrets marked poolType=claude_account)
 *   2. fetch live quota health per account (its OAuth token → Anthropic usage API)
 *   3. pickBestAccount() — lowest usedPercent, not capped
 *   4. if the winner differs from the current active account → rotate:
 *        - write account_pool_state (prev = old, reason = "rotation")
 *        - notify the operator (activity log + live event)
 *        - wake every agent so they pick up the new account on next run
 *   5. respect the STOP switch (D3) — never auto-rotate when engaged
 *
 * Spec: docs/superpowers/specs/2026-06-02-account-pool-rotation-spec.md
 */

/** usedPercent at/over this value means the account window is exhausted */
const CAP_THRESHOLD = 100;

export interface BalancerDeps {
  /** existing wakeup mechanism (heartbeat.wakeup) — never edits heartbeat.ts */
  heartbeat?: IssueAssignmentWakeupDeps;
}

export interface BalancerCompanyResult {
  companyId: string;
  /** account the team is on after this cycle (null when no usable account) */
  activeAccountId: string | null;
  rotated: boolean;
  stopped: boolean;
  /** reason a rotation was skipped or no account chosen, for observability */
  note?: string;
}

export interface BalancerTickResult {
  companiesScanned: number;
  rotations: number;
  results: BalancerCompanyResult[];
}

/**
 * pickBestAccount — the core business rule.
 *
 * "The whole team rides together on the best available account" (D1).
 * Best = the account with the most headroom: lowest usedPercent among the
 * accounts that are NOT capped. Accounts that are capped, or whose health
 * could not be determined (usedPercent === null / fetch error), are never
 * chosen — we will not move the team onto an account we can't trust.
 *
 * Returns null when no account is currently usable.
 */
export function pickBestAccount(accounts: AccountWithHealth[]): AccountWithHealth | null {
  const usable = accounts.filter((a) => !a.capped && a.usedPercent !== null && !a.error);
  if (usable.length === 0) return null;

  return usable.reduce((best, candidate) => {
    // usedPercent is guaranteed non-null by the filter above
    const bestPct = best.usedPercent as number;
    const candPct = candidate.usedPercent as number;
    if (candPct < bestPct) return candidate;
    // tie-break deterministically by id so repeated ticks don't flap
    if (candPct === bestPct && candidate.id < best.id) return candidate;
    return best;
  });
}

/** derive AccountWithHealth from a pool account's quota windows */
function toAccountWithHealth(account: PoolAccount, windows: QuotaWindow[]): AccountWithHealth {
  const reported = windows.filter((w) => w.usedPercent !== null);
  const usedPercent = reported.length > 0 ? Math.max(...reported.map((w) => w.usedPercent as number)) : null;
  const capped = reported.some((w) => (w.usedPercent as number) >= CAP_THRESHOLD);
  // earliest reset among capped windows, for the "when does it free up" display
  const cappedResets = windows
    .filter((w) => w.usedPercent !== null && (w.usedPercent as number) >= CAP_THRESHOLD && w.resetsAt)
    .map((w) => w.resetsAt as string)
    .sort();
  return {
    ...account,
    windows,
    usedPercent,
    resetsAt: cappedResets[0] ?? null,
    capped,
  };
}

export function accountPoolBalancer(db: Db, deps: BalancerDeps = {}) {
  const secrets = secretService(db);

  /**
   * Fetch live health for one pool account. The account's encrypted secret is
   * its `.credentials.json` blob; we extract the OAuth accessToken and ask the
   * Anthropic usage API for that specific account's windows.
   */
  async function fetchAccountHealth(companyId: string, account: PoolAccount): Promise<AccountWithHealth> {
    try {
      const blob = await secrets.resolveSecretValue(companyId, account.id, "latest");
      const token = extractAccessToken(blob);
      if (!token) {
        return { ...account, windows: [], usedPercent: null, resetsAt: null, capped: false, error: "no oauth accessToken in credentials" };
      }
      const windows = await fetchClaudeQuota(token);
      return toAccountWithHealth(account, windows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...account, windows: [], usedPercent: null, resetsAt: null, capped: false, error: message };
    }
  }

  /** Wake every agent in the company so they re-seed on the new account. */
  async function wakeAllAgents(companyId: string, fromAccountId: string | null, toAccountId: string) {
    const wakeup = deps.heartbeat?.wakeup;
    if (!wakeup) {
      logger.warn({ companyId }, "account-pool balancer rotated but no wakeup dep wired; agents will pick up on next natural run");
      return;
    }
    const rows = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const wakeable = rows.filter((a) => a.status !== "archived" && a.status !== "deleted");
    await Promise.allSettled(
      wakeable.map((agent) =>
        wakeup(agent.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "account_pool_rotation",
          payload: { fromAccountId, toAccountId },
          requestedByActorType: "system",
          requestedByActorId: null,
          contextSnapshot: { reason: "account_pool_rotation", fromAccountId, toAccountId },
        }).catch((err) => {
          logger.warn({ err, companyId, agentId: agent.id }, "failed to wake agent for account-pool rotation");
          return null;
        }),
      ),
    );
  }

  /** Notify the operator that a rotation happened (activity log + live event). */
  async function notifyRotation(
    companyId: string,
    from: AccountWithHealth | null,
    to: AccountWithHealth,
  ) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "account-pool-balancer",
      action: "account_pool.rotated",
      entityType: "account_pool_state",
      entityId: companyId,
      details: {
        fromAccountId: from?.id ?? null,
        fromAccountName: from?.name ?? null,
        toAccountId: to.id,
        toAccountName: to.name,
        toUsedPercent: to.usedPercent,
        reason: from?.capped ? "previous_account_capped" : "better_account_available",
      },
    });
  }

  /** Notify the operator that rotation was needed but the STOP switch blocked it. */
  async function notifyStopBlocked(companyId: string, reason: string | null) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "account-pool-balancer",
      action: "account_pool.rotation_suppressed",
      entityType: "account_pool_state",
      entityId: companyId,
      details: { suppressedBy: "stop_switch", stopReason: reason },
    });
  }

  /** Run the balancer for a single company. */
  async function runForCompany(companyId: string): Promise<BalancerCompanyResult> {
    const poolAccounts = await listPoolAccounts(db, companyId);
    if (poolAccounts.length === 0) {
      return { companyId, activeAccountId: null, rotated: false, stopped: false, note: "no_pool_accounts" };
    }

    const health = await Promise.all(poolAccounts.map((a) => fetchAccountHealth(companyId, a)));

    // Persist last-known health per account so the API/UI can show every account's
    // % (not just the active one) without re-probing Anthropic on each poll.
    const checkedAt = new Date().toISOString();
    await Promise.allSettled(
      health.map((h) =>
        savePoolAccountHealth(db, h.id, {
          usedPercent: h.usedPercent,
          resetsAt: h.resetsAt,
          capped: h.capped,
          error: h.error ?? null,
          checkedAt,
        }),
      ),
    );

    const best = pickBestAccount(health);
    const state = await getPoolState(db, companyId);
    const currentId = state?.activeAccountId ?? null;

    if (!best) {
      logger.warn({ companyId }, "account-pool balancer found no usable account");
      return { companyId, activeAccountId: currentId, rotated: false, stopped: false, note: "no_usable_account" };
    }

    // No change needed — already on the best account.
    if (best.id === currentId) {
      return { companyId, activeAccountId: currentId, rotated: false, stopped: false };
    }

    const isInitialAssignment = currentId === null;

    // STOP switch (D3): never auto-rotate when engaged. An initial assignment
    // (no account yet) is allowed so a freshly-armed pool still gets seeded.
    if (!isInitialAssignment) {
      const stop = await getStopSwitch(db, companyId);
      if (stop.stopped) {
        await notifyStopBlocked(companyId, stop.reason);
        logger.info({ companyId, wanted: best.id, current: currentId }, "account-pool rotation suppressed by STOP switch");
        return { companyId, activeAccountId: currentId, rotated: false, stopped: true, note: "stop_switch_engaged" };
      }
    }

    // Commit the new assignment.
    await setActiveAccount(db, {
      companyId,
      activeAccountId: best.id,
      prevAccountId: currentId,
      reason: isInitialAssignment ? "initial" : "rotation",
    });

    if (isInitialAssignment) {
      logger.info({ companyId, accountId: best.id }, "account-pool balancer set initial active account");
      return { companyId, activeAccountId: best.id, rotated: false, stopped: false, note: "initial_assignment" };
    }

    const from = health.find((h) => h.id === currentId) ?? null;
    await notifyRotation(companyId, from, best);
    await wakeAllAgents(companyId, currentId, best.id);
    logger.info({ companyId, from: currentId, to: best.id }, "account-pool balancer rotated active account");
    return { companyId, activeAccountId: best.id, rotated: true, stopped: false };
  }

  /** Run the balancer across every active company that has a pool. */
  async function tick(): Promise<BalancerTickResult> {
    const activeCompanies = await db
      .select({ id: companies.id })
      .from(companies)
      .where(ne(companies.status, "archived"));

    const results: BalancerCompanyResult[] = [];
    for (const company of activeCompanies) {
      try {
        results.push(await runForCompany(company.id));
      } catch (error) {
        logger.error({ err: error, companyId: company.id }, "account-pool balancer failed for company");
        results.push({ companyId: company.id, activeAccountId: null, rotated: false, stopped: false, note: "error" });
      }
    }

    return {
      companiesScanned: activeCompanies.length,
      rotations: results.filter((r) => r.rotated).length,
      results,
    };
  }

  return { tick, runForCompany, fetchAccountHealth };
}

/** Pull the OAuth accessToken out of a stored `.credentials.json` blob. */
function extractAccessToken(blob: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return null;
  const token = (oauth as Record<string, unknown>).accessToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}
