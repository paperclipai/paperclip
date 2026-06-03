import type { QuotaWindow } from "./quota.js";

/**
 * Shared contract for the Account Pool & Rotation feature.
 * Spec: docs/superpowers/specs/2026-06-02-account-pool-rotation-spec.md
 *
 * Pool accounts are company_secrets rows marked with
 * providerMetadata.poolType === POOL_ACCOUNT_TYPE.
 */
export const POOL_ACCOUNT_TYPE = "claude_account" as const;

/** why the team is currently on a given account */
export type RotationReason = "initial" | "rotation" | "manual";

/** a pooled subscription account (projection of a company_secrets row) */
export interface PoolAccount {
  /** company_secrets.id */
  id: string;
  /** human label, e.g. "Claude Max #1" */
  name: string;
  /** company_secrets.key */
  key: string;
  /** company_secrets.status */
  status: string;
}

/** a pool account enriched with live quota health */
export interface AccountWithHealth extends PoolAccount {
  /** quota windows from getQuotaWindows(); empty when fetch failed */
  windows: QuotaWindow[];
  /** highest usedPercent across windows (0-100), null when unknown */
  usedPercent: number | null;
  /** earliest resetsAt across capped windows, null when unknown */
  resetsAt: string | null;
  /** true when any window is at/over the cap and the account is unusable now */
  capped: boolean;
  /** set when the health fetch failed */
  error?: string;
}

/** current load-balancer state for a company (one row in account_pool_state) */
export interface PoolState {
  companyId: string;
  activeAccountId: string | null;
  prevAccountId: string | null;
  reason: RotationReason;
  assignedAt: string;
  rotationStopped: boolean;
  stopReason: string | null;
}

/** GET /api/account-pool response */
export interface AccountPoolListResponse {
  accounts: AccountWithHealth[];
  state: PoolState | null;
}

/** POST /api/account-pool request — add an account to the pool */
export interface AddPoolAccountRequest {
  name: string;
  /** raw .credentials.json blob content */
  credentialsJson: string;
}
