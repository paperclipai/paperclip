/**
 * BootstrapTokenMinter — narrow port the driver depends on for short-TTL,
 * single-use bootstrap tokens that the agent shim exchanges for a run JWT
 * via POST /api/agent-auth/exchange.
 *
 * The concrete implementation lives in `server/` (calls bootstrapTokensService);
 * this package can never import it directly because the driver intentionally
 * has no server dependency. The server-side registry wiring injects an
 * adapter that fulfils this interface.
 */

export interface BootstrapTokenMintRequest {
  agentId: string;
  companyId: string;
  runId: string;
  /**
   * The Kubernetes Job UID this token is bound to. Empty string is allowed
   * for the V1 minter shape — the M2 driver mints tokens BEFORE the Job is
   * created (so the Secret can carry an OwnerReference to the Job from the
   * start), at which point the Job UID is not yet known. Job-UID enforcement
   * at exchange time is tracked as a deferred V2 hardening (Risk #5).
   */
  jobUid: string;
  /** Defaults to 600s (10 minutes) when omitted. */
  ttlSeconds?: number;
}

export interface BootstrapTokenMintResult {
  token: string;
  expiresAt: Date;
}

export interface BootstrapTokenMinter {
  mint(req: BootstrapTokenMintRequest): Promise<BootstrapTokenMintResult>;
}
