import type { Environment } from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

/**
 * The argument object that the runtime `acquireRunLease` seam accepts. The type
 * derives from the service method, so a change to the acquire input stays in
 * sync with this helper.
 */
export type AcquireLoginLeaseArgs = Parameters<EnvironmentRuntimeService["acquireRunLease"]>[0];

/**
 * The lease metadata that identifies the login sandbox. The helper copies these
 * fields to the acquire arguments without a change.
 */
export interface LoginLeaseMetadata {
  companyId: string;
  environment: Environment;
  /** The agent adapter type for this login (mixed-harness environments). */
  adapterType?: string | null;
}

/**
 * The options for one login lease acquire. The helper sets the fixed arguments
 * and passes each option through to the acquire arguments.
 */
export interface BuildLoginLeaseAcquireArgsOptions {
  /** The lease metadata that identifies the login sandbox. */
  metadata: LoginLeaseMetadata;
  /**
   * The agent that owns the login. The codex flow passes null. The setup-token
   * flow passes the target agent.
   */
  targetAgentId?: string | null;
  /**
   * Re-check the environment company binding inside the lease insert
   * transaction. The setup-token flow sets this to true.
   */
  assertCompanyBinding?: boolean;
  /**
   * The latest time the acquired lease may stay active. The setup-token flow
   * passes the session deadline. The codex flow passes nothing.
   */
  requestedExpiresAt?: Date | null;
}

/**
 * Build the fixed sandbox lease arguments for a login service. Both login
 * services acquire a lease with a null issue, a null heartbeat run, and a null
 * execution workspace, and both apply the active custom-image template. This
 * helper sets those fixed arguments in one place and passes the caller options
 * through without a change to the lease behavior.
 */
export function buildLoginLeaseAcquireArgs(
  options: BuildLoginLeaseAcquireArgsOptions,
): AcquireLoginLeaseArgs {
  return {
    companyId: options.metadata.companyId,
    environment: options.metadata.environment,
    adapterType: options.metadata.adapterType ?? null,
    agentId: options.targetAgentId ?? null,
    // A null issue, a null heartbeat run, and a null execution workspace disable
    // lease reuse, so the login session always runs in a fresh sandbox.
    issueId: null,
    heartbeatRunId: null,
    persistedExecutionWorkspace: null,
    // Apply the active custom-image template, so the sandbox binds to the
    // trusted image and runtime identity.
    applyCustomImageTemplate: true,
    assertCompanyBinding: options.assertCompanyBinding,
    requestedExpiresAt: options.requestedExpiresAt ?? null,
  };
}
