import { resolveLoginCommandKey } from "./login-command.js";
import type { Environment } from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

/**
 * The argument object that the runtime `acquireRunLease` seam accepts. The type
 * derives from the service method, so a change to the acquire input stays in
 * sync with this helper.
 */
export type AcquireLoginLeaseArgs = Parameters<EnvironmentRuntimeService["acquireRunLease"]>[0];

/** A requested deadline is safe only when the provider attests an expiry at or before it. */
export function loginLeaseBoundsDeadline(expiresAt: Date | null | undefined, deadline: number): boolean {
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
  return Number.isFinite(expiresAtMs) && Number.isFinite(deadline) && expiresAtMs <= deadline;
}

/**
 * The company, environment, and provider adapter selected for this allocation.
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
  /** The environment and adapter selected by the caller. */
  metadata: LoginLeaseMetadata;
  /**
   * The saved computer that executes the command, independently of account
   * ownership. Temporary sandbox logins omit this target.
   */
  targetAgentId?: string | null;
  /** Explicit browser login; ordinary probes keep their execution allocation. */
  browserLogin?: boolean;
  /**
   * Re-check the environment company binding inside the lease insert
   * transaction. The setup-token flow sets this to true.
   */
  assertCompanyBinding?: boolean;
  /**
   * The latest time the allocation may stay active. Both browser-login flows
   * pass their absolute session deadline.
   */
  requestedExpiresAt?: Date | null;
}

/**
 * Build a one-off allocation without a task run or execution workspace. Browser
 * login callers opt into the login purpose; verification probes retain their
 * ordinary execution allocation. Sandbox callers keep the image-template path.
 */
export function buildLoginLeaseAcquireArgs(
  options: BuildLoginLeaseAcquireArgsOptions,
): AcquireLoginLeaseArgs {
  const pluginLogin = options.browserLogin === true && options.metadata.environment.driver === "plugin";
  return {
    ...(pluginLogin ? { purpose: "login" as const, loginCommandKey: resolveLoginCommandKey(options.metadata.adapterType ?? "") } : {}),
    companyId: options.metadata.companyId,
    environment: options.metadata.environment,
    adapterType: pluginLogin ? "paperclip_runner" : options.metadata.adapterType ?? null,
    agentId: options.targetAgentId ?? null,
    // A null issue, a null heartbeat run, and a null execution workspace disable
    // lease reuse, so this allocation has its own cleanup ownership.
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
