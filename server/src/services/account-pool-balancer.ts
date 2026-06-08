import { eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { fetchClaudeQuota, readClaudeToken, readClaudeAuthStatus } from "@paperclipai/adapter-claude-local/server";
import { fetchCodexQuota, readCodexAuthInfo } from "@paperclipai/adapter-codex-local/server";
import { POOL_PROVIDERS } from "@paperclipai/shared";
import type { AccountWithHealth, AutoRotationPreview, PoolAccount, PoolProvider, QuotaWindow } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import {
  DEFAULT_ACCOUNT_ID,
  accountRotationEnabled,
  ensureFreshLocalToken,
  ensureFreshPoolToken,
  getDefaultAccountHealth,
  getPoolState,
  getStopSwitch,
  isSnapshotCappedNow,
  listPoolAccounts,
  listPoolAccountRows,
  markDefaultAccountCapped,
  markPoolAccountCapped,
  readPoolAccountHealth,
  savePoolAccountHealth,
  saveDefaultAccountHealth,
  setActiveAccount,
} from "./account-pool.js";

/**
 * Per-provider hooks for the otherwise provider-agnostic balancer. Claude ignores
 * the ChatGPT account id; Codex needs it on the usage call. Default-account
 * identity/token resolution differs per provider (file/keychain vs auth.json).
 */
interface ProviderStrategy {
  provider: PoolProvider;
  /** probe live quota for a pooled access token (codex also needs its account id) */
  fetchQuota(token: string, accountId: string | null): Promise<QuotaWindow[]>;
  /** resolve the machine's DEFAULT login: identity + a probe token (best-effort) */
  fetchDefaultAccount(): Promise<{ email?: string; subscriptionType?: string; token: string | null; accountId: string | null; error: string | null }>;
  defaultName: string;
  defaultKey: string;
}

const PROVIDER_STRATEGIES: Record<PoolProvider, ProviderStrategy> = {
  claude: {
    provider: "claude",
    fetchQuota: (token) => fetchClaudeQuota(token),
    defaultName: "Default — this machine (Claude)",
    defaultKey: "Machine login (~/.claude)",
    async fetchDefaultAccount() {
      const status = await readClaudeAuthStatus().catch(() => null);
      const fresh = await ensureFreshLocalToken();
      if (fresh.error) {
        logger.warn({ err: fresh.error }, "default claude token refresh failed; probing with existing token");
      }
      const token = fresh.accessToken ?? (await readClaudeToken().catch(() => null));
      return {
        email: status?.email ?? undefined,
        subscriptionType: status?.subscriptionType ?? undefined,
        token: token ?? null,
        accountId: null,
        error: token ? null : "no local Claude login found on this machine",
      };
    },
  },
  codex: {
    provider: "codex",
    fetchQuota: (token, accountId) => fetchCodexQuota(token, accountId),
    defaultName: "Default — this machine (Codex)",
    defaultKey: "Machine login (~/.codex/auth.json)",
    async fetchDefaultAccount() {
      const info = await readCodexAuthInfo().catch(() => null);
      if (!info) {
        return { token: null, accountId: null, error: "no local Codex login found on this machine" };
      }
      return {
        email: info.email ?? undefined,
        subscriptionType: info.planType ?? undefined,
        token: info.accessToken ?? null,
        accountId: info.accountId ?? null,
        error: info.accessToken ? null : "no usable Codex access token on this machine",
      };
    },
  },
};

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
  // rotationEnabled === false → operator excluded this account from rotation; never pick it.
  const usable = accounts.filter((a) => a.rotationEnabled !== false && !a.capped && a.usedPercent !== null && !a.error);
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

/**
 * previewCombinedBest — a side-effect-free preview of which account the shared
 * `auto_rotation` adapter would currently pick across BOTH provider pools + each
 * provider's local default, using CACHED health snapshots (no live probe, no token
 * decrypt/refresh). This is the read-only twin of heartbeat's
 * resolveCombinedBestSeed: same candidate-building + pickBestAccount logic, but it
 * returns just the winner's identity for the UI "Rotation Active" indicator.
 *
 * Honors per-provider STOP switches (a stopped provider contributes only its
 * pinned account) and the per-provider `defaultRotationEnabled` flag (when false
 * the provider's local default is excluded from the combined pick). Returns null
 * when nothing usable is known yet.
 */
export async function previewCombinedBest(db: Db, companyId: string): Promise<AutoRotationPreview | null> {
  type Candidate = AccountWithHealth & { provider: PoolProvider; isDefault: boolean };
  const candidates: Candidate[] = [];

  for (const provider of POOL_PROVIDERS) {
    const stop = await getStopSwitch(db, companyId, provider);
    const state = await getPoolState(db, companyId, provider);
    const pinnedId = stop.stopped ? (state?.activeAccountId ?? DEFAULT_ACCOUNT_ID) : null;

    const toCandidate = (id: string, isDefault: boolean, snapshot: ReturnType<typeof readPoolAccountHealth>): Candidate => ({
      id,
      name: id,
      key: id,
      status: "active",
      provider,
      isDefault,
      windows: snapshot?.windows ?? [],
      usedPercent: snapshot?.usedPercent ?? null,
      resetsAt: snapshot?.resetsAt ?? null,
      capped: isSnapshotCappedNow(snapshot ?? null),
      error: snapshot?.error ?? undefined,
    });

    const rows = await listPoolAccountRows(db, companyId, provider);
    for (const row of rows) {
      if (pinnedId && row.id !== pinnedId) continue;
      if (!accountRotationEnabled(row)) continue; // operator excluded from rotation
      candidates.push(toCandidate(row.id, false, readPoolAccountHealth(row.providerMetadata)));
    }
    // Provider default (sentinel): included unless a non-default account is pinned
    // OR the operator excluded the default via defaultRotationEnabled:false.
    if ((!pinnedId || pinnedId === DEFAULT_ACCOUNT_ID) && (state?.defaultRotationEnabled ?? true)) {
      const defSnap = await getDefaultAccountHealth(db, companyId, provider);
      candidates.push(toCandidate(DEFAULT_ACCOUNT_ID, true, defSnap));
    }
  }

  const best = pickBestAccount(candidates) as Candidate | null;
  if (!best) return null;
  return { provider: best.provider, accountId: best.isDefault ? null : best.id, isDefault: best.isDefault };
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

  /**
   * Fetch live health for one pool account. The account's encrypted secret is
   * its `.credentials.json` blob; we extract the OAuth accessToken and ask the
   * Anthropic usage API for that specific account's windows.
   */
  async function fetchAccountHealth(companyId: string, account: PoolAccount, provider: PoolProvider): Promise<AccountWithHealth> {
    const strategy = PROVIDER_STRATEGIES[provider];
    try {
      // Refresh-on-use: returns a non-expired access token (rotates the stored
      // secret when the old one is near expiry). Codex also surfaces its account id.
      const { accessToken, accountId, error: refreshError } = await ensureFreshPoolToken(db, companyId, account.id, provider);
      if (!accessToken) {
        return { ...account, windows: [], usedPercent: null, resetsAt: null, capped: false, error: refreshError ?? "no access token in credentials" };
      }
      const windows = await strategy.fetchQuota(accessToken, accountId);
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
  async function probeAndPersist(companyId: string, accounts: PoolAccount[], provider: PoolProvider): Promise<AccountWithHealth[]> {
    const health = await Promise.all(accounts.map((a) => fetchAccountHealth(companyId, a, provider)));
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
  async function fetchDefaultAccountHealth(provider: PoolProvider): Promise<AccountWithHealth> {
    const strategy = PROVIDER_STRATEGIES[provider];
    const base: PoolAccount = {
      id: DEFAULT_ACCOUNT_ID,
      name: strategy.defaultName,
      key: strategy.defaultKey,
      status: "active",
    };
    try {
      // Refresh-on-use: for Claude (file login) this refreshes the on-disk token
      // and writes it back so the probe and the running CLI stay in sync; for
      // Codex it reads auth.json. Identity (email/tier) is surfaced even when the
      // quota probe itself fails.
      const def = await strategy.fetchDefaultAccount();
      const subscriptionType = def.subscriptionType;
      const email = def.email;
      if (!def.token) {
        return { ...base, windows: [], usedPercent: null, resetsAt: null, capped: false, subscriptionType, email, error: def.error ?? "no local login found" };
      }
      const windows = await strategy.fetchQuota(def.token, def.accountId);
      return { ...toAccountWithHealth(base, windows), subscriptionType, email };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, windows: [], usedPercent: null, resetsAt: null, capped: false, error: message };
    }
  }

  /** Probe the default account for a provider and persist its snapshot. */
  async function probeAndPersistDefault(companyId: string, provider: PoolProvider): Promise<AccountWithHealth> {
    const health = await fetchDefaultAccountHealth(provider);
    await saveDefaultAccountHealth(db, companyId, provider, {
      usedPercent: health.usedPercent,
      resetsAt: health.resetsAt,
      capped: health.capped,
      windows: health.windows,
      error: health.error ?? null,
      at: new Date().toISOString(),
      email: health.email ?? null,
      subscriptionType: health.subscriptionType ?? null,
    }).catch((err) => logger.warn({ err, companyId, provider }, "failed to persist default account health"));
    return health;
  }

  /** On-demand probe of all of a company's accounts incl. default, across providers (UI "Reload"). */
  async function probeCompany(companyId: string, provider?: PoolProvider): Promise<AccountWithHealth[]> {
    const providers = provider ? [provider] : POOL_PROVIDERS;
    const perProvider = await Promise.all(
      providers.map(async (p) => {
        const accounts = await listPoolAccounts(db, companyId, p);
        const [pooled, def] = await Promise.all([
          probeAndPersist(companyId, accounts, p),
          probeAndPersistDefault(companyId, p),
        ]);
        return [def, ...pooled];
      }),
    );
    return perProvider.flat();
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

  /** Run the balancer for a single company + provider. */
  async function runForCompany(companyId: string, provider: PoolProvider = "claude"): Promise<BalancerCompanyResult> {
    const poolRows = await listPoolAccountRows(db, companyId, provider);
    const rotationById = new Map(poolRows.map((r) => [r.id, accountRotationEnabled(r)]));
    const poolAccounts = poolRows.map((r) => ({ id: r.id, name: r.name, key: r.key, status: r.status }));

    // The local/default account is ALWAYS a candidate (it's what agents fall back
    // to). Probe it + every pooled account, persisting snapshots for the UI.
    const [pooledHealth, defaultHealth] = await Promise.all([
      probeAndPersist(companyId, poolAccounts, provider),
      probeAndPersistDefault(companyId, provider),
    ]);
    // Tag each pooled account's rotation-participation flag; disabled ones are
    // still probed (so the UI shows health) but pickBestAccount never selects them.
    const health = [
      defaultHealth,
      ...pooledHealth.map((h) => ({ ...h, rotationEnabled: rotationById.get(h.id) !== false })),
    ];

    const best = pickBestAccount(health);
    const state = await getPoolState(db, companyId, provider);
    const currentId = state?.activeAccountId ?? null; // null == currently on default/local

    if (!best) {
      logger.warn({ companyId, provider }, "account-pool balancer found no usable account");
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
      const stop = await getStopSwitch(db, companyId, provider);
      if (stop.stopped) {
        await notifyStopBlocked(companyId, stop.reason);
        logger.info({ companyId, provider, wanted: best.id, current: currentId }, "account-pool rotation suppressed by STOP switch");
        return { companyId, activeAccountId: currentId, rotated: false, stopped: true, note: "stop_switch_engaged" };
      }
    }

    // Commit the new assignment (bestActiveId is null when default wins).
    await setActiveAccount(db, {
      companyId,
      provider,
      activeAccountId: bestActiveId,
      prevAccountId: currentId,
      reason: isInitialAssignment ? "initial" : "rotation",
    });

    if (isInitialAssignment) {
      logger.info({ companyId, provider, accountId: bestActiveId }, "account-pool balancer set initial active account");
      return { companyId, activeAccountId: bestActiveId, rotated: false, stopped: false, note: "initial_assignment" };
    }

    const from = health.find((h) => effectiveActiveId(h.id) === currentId) ?? null;
    await notifyRotation(companyId, from, best);
    await wakeAllAgents(companyId, currentId, bestActiveId);
    logger.info({ companyId, provider, from: currentId, to: bestActiveId }, "account-pool balancer rotated active account");
    return { companyId, activeAccountId: bestActiveId, rotated: true, stopped: false };
  }

  /** True when a company has at least one pool account of the given provider. */
  async function companyHasProviderPool(companyId: string, provider: PoolProvider): Promise<boolean> {
    const accounts = await listPoolAccounts(db, companyId, provider);
    return accounts.length > 0;
  }

  /** Run the balancer across every active company × provider that has a pool. */
  async function tick(): Promise<BalancerTickResult> {
    const activeCompanies = await db
      .select({ id: companies.id })
      .from(companies)
      .where(ne(companies.status, "archived"));

    const results: BalancerCompanyResult[] = [];
    for (const company of activeCompanies) {
      for (const provider of POOL_PROVIDERS) {
        try {
          // Skip a provider with no pool accounts for this company — nothing to
          // balance and probing the default would just churn snapshots.
          if (!(await companyHasProviderPool(company.id, provider))) continue;
          results.push(await runForCompany(company.id, provider));
        } catch (error) {
          logger.error({ err: error, companyId: company.id, provider }, "account-pool balancer failed for company");
          results.push({ companyId: company.id, activeAccountId: null, rotated: false, stopped: false, note: "error" });
        }
      }
    }

    return {
      companiesScanned: activeCompanies.length,
      rotations: results.filter((r) => r.rotated).length,
      results,
    };
  }

  /**
   * REACTIVE rotation: an agent run just hit a quota cap on `cappedAccountId`
   * (DEFAULT_ACCOUNT_ID sentinel when the local/default account was active).
   * Marks it capped until `cappedUntil`, then moves the team to the next account
   * that is NOT currently capped. Does NOT call the usage API (no health probe) —
   * selection is "next available" so a run never has to wait on a rate-limited
   * usage endpoint to fail over. Returns the new active account id (string or
   * null=default), or undefined when there is no healthy alternative.
   */
  async function rotateOnCap(
    companyId: string,
    cappedAccountId: string,
    cappedUntil: Date | null,
    provider: PoolProvider = "claude",
  ): Promise<string | null | undefined> {
    const untilIso = cappedUntil ? cappedUntil.toISOString() : null;
    // 1) Mark the capped account so we don't immediately pick it again.
    if (cappedAccountId === DEFAULT_ACCOUNT_ID) {
      await markDefaultAccountCapped(db, companyId, provider, untilIso);
    } else {
      await markPoolAccountCapped(db, cappedAccountId, untilIso);
    }

    const now = new Date();
    // 2) Build the candidate list: default first, then pooled accounts by id.
    //    Exclude the just-capped one and anything still capped (resetsAt in future).
    const candidates: string[] = [];
    if (cappedAccountId !== DEFAULT_ACCOUNT_ID) {
      const defaultSnap = await getDefaultAccountHealth(db, companyId, provider);
      if (!isSnapshotCappedNow(defaultSnap, now)) candidates.push(DEFAULT_ACCOUNT_ID);
    }
    const poolRows = await listPoolAccountRows(db, companyId, provider);
    for (const row of poolRows.sort((a, b) => a.id.localeCompare(b.id))) {
      if (row.id === cappedAccountId) continue;
      if (!accountRotationEnabled(row)) continue; // operator excluded from rotation
      if (isSnapshotCappedNow(readPoolAccountHealth(row.providerMetadata), now)) continue;
      candidates.push(row.id);
    }

    if (candidates.length === 0) {
      logger.warn({ companyId, cappedAccountId }, "account-pool: capped account but no healthy alternative");
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "account-pool-balancer",
        action: "account_pool.rotation_blocked",
        entityType: "account_pool_state",
        entityId: companyId,
        details: { cappedAccountId, reason: "no_healthy_alternative", retryAfter: untilIso },
      });
      return undefined;
    }

    const winner = candidates[0]!;
    const winnerActiveId = effectiveActiveId(winner); // null when default wins
    const fromActiveId = effectiveActiveId(cappedAccountId);

    await setActiveAccount(db, {
      companyId,
      provider,
      activeAccountId: winnerActiveId,
      prevAccountId: fromActiveId,
      reason: "rotation",
    });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "account-pool-balancer",
      action: "account_pool.rotated",
      entityType: "account_pool_state",
      entityId: companyId,
      details: {
        provider,
        fromAccountId: fromActiveId,
        toAccountId: winnerActiveId,
        reason: "quota_exhausted_during_run",
        cappedUntil: untilIso,
      },
    });
    // No explicit wake here: the failed run is retried by the caller
    // (scheduleBoundedRetryForRun) which re-resolves the now-rotated active
    // account, and other agents pick it up on their next run.
    logger.info({ companyId, from: fromActiveId, to: winnerActiveId }, "account-pool: reactive rotation on quota cap");
    return winnerActiveId;
  }

  return { tick, runForCompany, fetchAccountHealth, probeCompany, rotateOnCap };
}
