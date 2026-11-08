/**
 * The static per-driver traits for the four environment drivers.
 *
 * This module is a dependency leaf: it imports no other service module. It
 * imports one type from `environment-runtime.ts` (`SandboxCapabilityKey`), but
 * a type-only import compiles to nothing, so it adds no runtime dependency
 * edge. `environment-runtime.ts` imports `workspace-realization.ts` at value
 * level, so `workspace-realization.ts` cannot import `environment-runtime.ts`
 * back. It imports this leaf module instead, and this module stays a leaf so
 * the import graph has no cycle.
 *
 * Each trait below is a fixed fact about a driver family. It is a code fact,
 * not a fact about one lease, so a consumer reads it as a plain table lookup
 * instead of a driver-name condition.
 */

import type { EnvironmentDriver } from "@paperclipai/shared";
import type { SandboxCapabilityKey } from "./environment-runtime.js";

/**
 * The static capability support definition for one environment driver. It names
 * the eight capabilities the driver family can support at all. A capability the
 * definition does not name resolves `false` for the driver, whatever a
 * declaration, a verified verb, or a narrowing says. The general classifier
 * reads this static definition for a built-in driver in place of a live worker
 * method list.
 *
 * The definition is the code-level ground truth for a driver. It replaces a
 * driver-identity condition: a consumer asks the classifier for a capability
 * instead of matching the driver name.
 */
export interface EnvironmentDriverCapabilitySupport {
  readonly driver: EnvironmentDriver;
  /** The capability keys the driver family can support. */
  readonly supportedCapabilities: ReadonlySet<SandboxCapabilityKey>;
}

const NO_CAPABILITY_SUPPORT: ReadonlySet<SandboxCapabilityKey> = new Set<SandboxCapabilityKey>();

// The nine capability keys, written out here as literal strings. This module
// does not import `environment-runtime.ts` as a value (see the module comment
// above), so it cannot read `SANDBOX_CAPABILITY_KEYS` from there. Keep this
// list equal to that list.
const ALL_CAPABILITY_SUPPORT: ReadonlySet<SandboxCapabilityKey> = new Set<SandboxCapabilityKey>([
  "reusableLeases",
  "nativeSyncIn",
  "nativeSyncOut",
  "persistentProcessSessions",
  "independentControlCommands",
  "incrementalSessionOutput",
  "concurrentSyncOperations",
  "duplexCommandStream",
  "runnerWebSocketIngress",
]);

/**
 * The static capability support for the four environment drivers.
 *
 * - `local` runs commands on the host file system with no provider capability
 *   model, so it supports none of the eight capabilities. Every capability
 *   resolves `false`.
 * - `ssh` runs commands on a remote host through the SSH transport with no
 *   provider capability model, so it supports none of the eight capabilities
 *   either.
 * - `sandbox` runs the full provider capability model. A built-in provider maps
 *   its own methods through `builtinSandboxProviderVerifiedMethods`, and a
 *   plugin-backed provider reports live worker methods, so the driver can support
 *   every capability. The classifier still intersects the per-provider
 *   declaration, the verified methods, and the per-lease narrowing.
 * - `plugin` resolves its capabilities from the live plugin worker method list,
 *   so it can support every capability. The classifier intersects the live
 *   verified methods and the declaration.
 */
export const ENVIRONMENT_DRIVER_CAPABILITY_SUPPORT: Record<
  EnvironmentDriver,
  EnvironmentDriverCapabilitySupport
> = {
  local: { driver: "local", supportedCapabilities: NO_CAPABILITY_SUPPORT },
  ssh: { driver: "ssh", supportedCapabilities: NO_CAPABILITY_SUPPORT },
  sandbox: { driver: "sandbox", supportedCapabilities: ALL_CAPABILITY_SUPPORT },
  plugin: { driver: "plugin", supportedCapabilities: ALL_CAPABILITY_SUPPORT },
};

/**
 * The static per-driver traits every runtime consumer reads instead of a
 * driver-identity condition. Each field is a fixed code fact about the driver
 * family; it never varies per lease.
 */
export interface EnvironmentDriverTraits {
  readonly driver: EnvironmentDriver;
  /**
   * True when the driver realizes a workspace through the runtime driver's
   * `realizeWorkspace` method. Read by the run orchestrator
   * (`environment-run-orchestrator.ts`, `realizeForRun`) to decide whether to
   * call the driver before it resolves the execution target. The `plugin`
   * driver skips this step: its execution target resolves the workspace
   * itself, so the orchestrator never calls `realizeWorkspace` for it.
   */
  readonly realizesWorkspace: boolean;
  /**
   * True when the driver runs the workspace on a target other than the host
   * file system. Read by `isRemoteExecutionEnvironmentDriver`
   * (`heartbeat.ts`) to decide whether a host-local directory path is present
   * on the run target.
   */
  readonly runsWorkspaceOffHost: boolean;
  /**
   * True when the driver stages a multi-source remote workspace through a
   * confined per-project runtime. Read by `isConfinedRemoteStagingDriver`
   * (`heartbeat.ts`) to decide whether a referenced (mentioned) project
   * stages under that confinement guard.
   */
  readonly confinesStagedProjects: boolean;
  /**
   * True when the driver resolves a per-lease capability snapshot that a
   * consumer reads today. Read by `resolveEnvironmentExecutionTarget`
   * (`environment-execution-target.ts`) to decide whether to call the
   * general capability resolver for a lease on this driver.
   *
   * Only the `sandbox` driver has a consumer today. The `plugin` driver
   * implements `resolveCapabilities`, but no consumer reads a plugin
   * snapshot yet, so this stays `false` for `plugin` here. A change to
   * `true` changes runtime behavior, so the board owns that decision.
   */
  readonly hasLeaseCapabilityModel: boolean;
}

/**
 * The static traits for the four environment drivers. See {@link
 * EnvironmentDriverTraits} for what each field means and which consumer reads
 * it.
 */
export const ENVIRONMENT_DRIVER_TRAITS: Record<EnvironmentDriver, EnvironmentDriverTraits> = {
  local: {
    driver: "local",
    realizesWorkspace: true,
    runsWorkspaceOffHost: false,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
  ssh: {
    driver: "ssh",
    realizesWorkspace: true,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
  sandbox: {
    driver: "sandbox",
    realizesWorkspace: true,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: true,
    hasLeaseCapabilityModel: true,
  },
  plugin: {
    driver: "plugin",
    realizesWorkspace: false,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
};

/**
 * Read the static traits for a driver key. Returns `null` for an unknown or
 * absent driver, so a caller applies its own fallback default (the four
 * drivers above are the only registered drivers today).
 */
export function getEnvironmentDriverTraits(
  driver: string | null | undefined,
): EnvironmentDriverTraits | null {
  if (!driver) return null;
  return Object.prototype.hasOwnProperty.call(ENVIRONMENT_DRIVER_TRAITS, driver)
    ? ENVIRONMENT_DRIVER_TRAITS[driver as EnvironmentDriver]
    : null;
}
