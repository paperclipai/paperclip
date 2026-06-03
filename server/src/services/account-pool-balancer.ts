import { eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { fetchClaudeQuota, readClaudeToken } from "@paperclipai/adapter-claude-local/server";
import type { AccountWithHealth, PoolAccount, QuotaWindow } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import {
  DEFAULT_ACCOUNT_ID,
  getPoolState,
  getStopSwitch,
  listPoolAccounts,
  savePoolAccountHealth,
  saveDefaultAccountHealth,
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

  /**
   * Probe every given account's live health and persist a snapshot for each.
   * Snapshots let the API serve health cheaply (no live Anthropic call per poll);
   * a failed probe (e.g. 429) preserves the last-good metrics — see
   * savePoolAccountHealth. Returns the freshly-probed health.
   */
  async function probeAndPersist(companyId: string, accounts: PoolAccount[]): Promise<AccountWithHealth[]> {
    const health = await Promise.all(accounts.map((a) => fetchAccountHealth(companyId, a)));
    const at = new Date().toISOString();
    await Promise.allSettled(
      health.map((h) =>
        savePoolAccountHealth(db, h.id, {
          usedPercent: h.usedPercent,
          resetsAt: h.resetsAt,
          capped: h.capped,
          windows: h.windows,
          error: h.error ?? null,
          at,
        }),
      ),
    );
    return health;
  }

  /**
   * Probe the machine's DEFAULT (local) account — the login agents fall back to
   * when no pool account is active. Reads the local token (file or macOS
   * Keychain via readClaudeToken) and asks the Anthropic usage API. Returned as
   * an implicit candidate with the DEFAULT_ACCOUNT_ID sentinel. Best-effort: on
   * non-macOS / Docker / missing login the token is null → returns an error
   * shape (does not throw, does not block rotation).
   */
  async function fetchDefaultAccountHealth(): Promise<AccountWithHealth> {
    const base: PoolAccount = {
      id: DEFAULT_ACCOUNT_ID,
      name: "Default — this machine",
      key: "Machine login (~/.claude)",
      status: "active",
    };
    try {
      const token = await readClaudeToken();
      if (!token) {
        return { ...base, windows: [], usedPercent: null, resetsAt: null, capped: false, error: "no local Claude login found on this machine" };
      }
      const windows = await fetchClaudeQuota(token);
      return toAccountWithHealth(base, windows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, windows: [], usedPercent: null, resetsAt: null, capped: false, error: message };
    }
  }

  /** Probe the default account and persist its snapshot to account_pool_state. */
  async function probeAndPersistDefault(companyId: string): Promise<AccountWithHealth> {
    const health = await fetchDefaultAccountHealth();
    await saveDefaultAccountHealth(db, companyId, {
      usedPercent: health.usedPercent,
      resetsAt: health.resetsAt,
      capped: health.capped,
      windows: health.windows,
      error: health.error ?? null,
      at: new Date().toISOString(),
    }).catch((err) => logger.warn({ err, companyId }, "failed to persist default account health"));
    return health;
  }

  /** On-demand probe of all of a company's accounts incl. default (UI "Reload"). */
  async function probeCompany(companyId: string): Promise<AccountWithHealth[]> {
    const accounts = await listPoolAccounts(db, companyId);
    const [pooled, def] = await Promise.all([
      probeAndPersist(companyId, accounts),
      probeAndPersistDefault(companyId),
    ]);
    return [def, ...pooled];
  }

  /** Wake every agent in the company so they re-seed on the new account.
   *  toAccountId is null when rotating TO the default/local account. */
  async function wakeAllAgents(companyId: string, fromAccountId: string | null, toAccountId: string | null) {
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

  /**
   * Map a candidate's id to the value stored in account_pool_state.activeAccountId.
   * The default candidate ("__default__") maps to null — "use the local login,
   * inject nothing" — which is exactly the Slice-3 fallback (heartbeat.ts).
   */
  function effectiveActiveId(candidateId: string): string | null {
    return candidateId === DEFAULT_ACCOUNT_ID ? null : candidateId;
  }

  /** Run the balancer for a single company. */
  async function runForCompany(companyId: string): Promise<BalancerCompanyResult> {
    const poolAccounts = await listPoolAccounts(db, companyId);

    // The local/default account is ALWAYS a candidate (it's what agents fall back
    // to). Probe it + every pooled account, persisting snapshots for the UI.
    const [pooledHealth, defaultHealth] = await Promise.all([
      probeAndPersist(companyId, poolAccounts),
      probeAndPersistDefault(companyId),
    ]);
    const health = [defaultHealth, ...pooledHealth];

    const best = pickBestAccount(health);
    const state = await getPoolState(db, companyId);
    const currentId = state?.activeAccountId ?? null; // null == currently on default/local

    if (!best) {
      logger.warn({ companyId }, "account-pool balancer found no usable account");
      return { companyId, activeAccountId: currentId, rotated: false, stopped: false, note: "no_usable_account" };
    }

    const bestActiveId = effectiveActiveId(best.id); // null when default wins

    // No change needed — already on the best account (default↔null compares too).
    if (bestActiveId === currentId) {
      return { companyId, activeAccountId: currentId, rotated: false, stopped: false };
    }

    // "Initial" only when there is no pool-state row at all yet. Being on the
    // default (currentId === null with an existing row) is a real state we may
    // rotate AWAY from, so we can't treat null as always-initial here.
    const isInitialAssignment = state === null;

    // STOP switch (D3): never auto-rotate when engaged (except first-ever seed).
    if (!isInitialAssignment) {
      const stop = await getStopSwitch(db, companyId);
      if (stop.stopped) {
        await notifyStopBlocked(companyId, stop.reason);
        logger.info({ companyId, wanted: best.id, current: currentId }, "account-pool rotation suppressed by STOP switch");
        return { companyId, activeAccountId: currentId, rotated: false, stopped: true, note: "stop_switch_engaged" };
      }
    }

    // Commit the new assignment (bestActiveId is null when default wins).
    await setActiveAccount(db, {
      companyId,
      activeAccountId: bestActiveId,
      prevAccountId: currentId,
      reason: isInitialAssignment ? "initial" : "rotation",
    });

    if (isInitialAssignment) {
      logger.info({ companyId, accountId: bestActiveId }, "account-pool balancer set initial active account");
      return { companyId, activeAccountId: bestActiveId, rotated: false, stopped: false, note: "initial_assignment" };
    }

    const from = health.find((h) => effectiveActiveId(h.id) === currentId) ?? null;
    await notifyRotation(companyId, from, best);
    await wakeAllAgents(companyId, currentId, bestActiveId);
    logger.info({ companyId, from: currentId, to: bestActiveId }, "account-pool balancer rotated active account");
    return { companyId, activeAccountId: bestActiveId, rotated: true, stopped: false };
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

  return { tick, runForCompany, fetchAccountHealth, probeCompany };
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
