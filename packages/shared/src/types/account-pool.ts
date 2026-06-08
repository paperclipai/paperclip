import type { QuotaWindow } from "./quota.js";

/**
 * Shared contract for the Account Pool & Rotation feature.
 * Spec: docs/superpowers/specs/2026-06-02-account-pool-rotation-spec.md
 *
 * Pool accounts are company_secrets rows marked with
 * providerMetadata.poolType === POOL_ACCOUNT_TYPES[provider].
 */

/** which CLI provider a pool / account belongs to */
export type PoolProvider = "claude" | "codex";

/** all supported pool providers, in default rotation/listing order */
export const POOL_PROVIDERS: readonly PoolProvider[] = ["claude", "codex"] as const;

/** company_secrets.providerMetadata.poolType marker per provider */
export const POOL_ACCOUNT_TYPES = {
  claude: "claude_account",
  codex: "codex_account",
} as const satisfies Record<PoolProvider, string>;

/** back-compat alias — the original Claude-only marker */
export const POOL_ACCOUNT_TYPE = POOL_ACCOUNT_TYPES.claude;

/** map a poolType marker back to its provider, or null when not a pool account */
export function poolProviderFromType(poolType: unknown): PoolProvider | null {
  if (poolType === POOL_ACCOUNT_TYPES.claude) return "claude";
  if (poolType === POOL_ACCOUNT_TYPES.codex) return "codex";
  return null;
}

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
  /** which provider pool this account belongs to */
  provider?: PoolProvider;
  /**
   * whether this account participates in auto-rotation. Default true. When false
   * the balancer never selects it (the operator excluded it via the pool UI tick).
   * The implicit default/machine account is always enabled.
   */
  rotationEnabled?: boolean;
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

/** current load-balancer state for a company+provider (one row in account_pool_state) */
export interface PoolState {
  companyId: string;
  /** which provider's pool this state tracks */
  provider: PoolProvider;
  activeAccountId: string | null;
  prevAccountId: string | null;
  reason: RotationReason;
  assignedAt: string;
  rotationStopped: boolean;
  stopReason: string | null;
  /**
   * Whether `auto_rotation` agents may fall back to this machine's local/default
   * login for this provider. Default true. Toggled via the default account card's
   * "Include in auto-rotation" checkbox. Does NOT affect the per-provider
   * claude_local/codex_local balancer (which always keeps the local default).
   */
  defaultRotationEnabled: boolean;
}

/**
 * GET /api/account-pool/auto-rotation-state response — a side-effect-free preview
 * of which account the shared `auto_rotation` adapter would currently pick across
 * all provider pools + their local defaults. Null when nothing usable is known yet.
 */
export interface AutoRotationPreview {
  /** the provider pool the combined-best pick currently lands on */
  provider: PoolProvider;
  /** the winning pooled account id, or null when the provider's local default wins */
  accountId: string | null;
  /** true when the winner is the provider's local/default login (accountId === null) */
  isDefault: boolean;
}

/** GET /api/account-pool response */
export interface AccountPoolListResponse {
  accounts: AccountWithHealth[];
  state: PoolState | null;
}

/** POST /api/account-pool request — add an account to the pool */
export interface AddPoolAccountRequest {
  name: string;
  /** which provider this account belongs to; defaults to "claude" for back-compat */
  provider?: PoolProvider;
  /**
   * raw credential blob content — a Claude `.credentials.json` for provider
   * "claude", or a Codex `~/.codex/auth.json` for provider "codex".
   */
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
