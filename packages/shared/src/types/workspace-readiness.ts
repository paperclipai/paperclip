/**
 * Workspace readiness contract (PAP-17572).
 *
 * Transport health ("the port answered") is not user readiness. A cloned
 * workspace is only usable when its own database is reachable, the seed
 * manifest reached a verified terminal state, representative cloned rows are
 * readable, the password-independent login handoff is configured, and the
 * instance/workspace/company identity matches the one the control plane expects.
 *
 * These fields ride on the *protected* health response only. Public health
 * stays redacted: an anonymous caller learns liveness, never which instance or
 * execution workspace answered.
 */

export const WORKSPACE_READINESS_STATES = [
  /** The isolated database is still being restored. */
  "provisioning",
  /** Restore finished; the clone is being validated. */
  "validating",
  /** Every readiness signal agrees; the workspace can be opened. */
  "ready",
  /** Serving, but at least one readiness signal regressed after being ready. */
  "degraded",
  /** A managed repair is running right now. */
  "repairing",
  /** A terminal provisioning or repair failure needs an operator action. */
  "failed",
] as const;

export type WorkspaceReadinessState = (typeof WORKSPACE_READINESS_STATES)[number];

/** Terminal state of the versioned seed manifest, or `unknown` for a legacy marker. */
export type WorkspaceSeedReadinessState =
  | "pending"
  | "running"
  | "verified"
  | "failed"
  | "unknown"
  | "absent";

export interface WorkspaceReadiness {
  state: WorkspaceReadinessState;
  /** `SELECT 1` plus a readable migration journal on this instance's own database. */
  databaseReady: boolean;
  /** A representative cloned company/issue pair is readable. */
  cloneDataReady: boolean;
  /** A signing key and a resolvable cloned admin identity are both present. */
  authHandoffReady: boolean;
  /** Exact cloned user checked for a caller-scoped handoff probe, or null. */
  authHandoffUserId: string | null;
  seedState: WorkspaceSeedReadinessState;
  /** Last recorded seed phase, e.g. `restore` or `post_restore_validation`. */
  seedPhase: string | null;
  seedMode: "minimal" | "full" | null;
  /** Resolved instance identity of the process that answered, never a branch heuristic. */
  instanceId: string | null;
  /** Execution workspace this instance was provisioned for, when known. */
  executionWorkspaceId: string | null;
  /** Company whose cloned board this workspace serves, when known. */
  companyId: string | null;
  /** Phase that failed, so operators do not need host-shell archaeology. */
  failurePhase: string | null;
}

/**
 * Result of the control plane's protected readiness probe against a managed
 * workspace runtime. `reason` is a stable machine code so the runtime gate and
 * the UI can branch without parsing prose.
 */
export type WorkspaceReadinessProbeResult =
  | { ok: true; readiness: WorkspaceReadiness }
  | {
      ok: false;
      reason:
        | "unreachable"
        | "http_error"
        | "unhealthy_payload"
        | "readiness_missing"
        | "not_ready"
        | "identity_mismatch";
      readiness: WorkspaceReadiness | null;
      detail: string | null;
    };

export interface WorkspaceLoginHandoffTicketResponse {
  /** Absolute URL that exchanges the ticket and redirects to the cloned board. */
  url: string;
  expiresAt: string;
  /** `handoff` for the signed path, `credentials` when only the fallback is available. */
  mode: "handoff" | "credentials";
}
