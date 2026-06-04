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
  /** account email, when known (OAuth-added accounts; best-effort for default) */
  email?: string;
  /** subscription tier label, e.g. "Claude Team" / "Claude Max" */
  subscriptionType?: string;
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

/** POST /api/account-pool/oauth/start response — begin "Login with Claude" */
export interface OauthStartResponse {
  /** open this in any browser, log in, copy the shown CODE#STATE back */
  authorizeUrl: string;
  /** echoed back on complete to bind the request (CSRF) */
  state: string;
  /** PKCE verifier held by the client and sent back on complete */
  codeVerifier: string;
}

/** POST /api/account-pool/oauth/complete request — finish "Login with Claude" */
export interface OauthCompleteRequest {
  /** the authorization code (the part before '#' in the pasted CODE#STATE) */
  code: string;
  /** the state (the part after '#'), must match the start response */
  state: string;
  /** the PKCE verifier returned by start */
  codeVerifier: string;
}
