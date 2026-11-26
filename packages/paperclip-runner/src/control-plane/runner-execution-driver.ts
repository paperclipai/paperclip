import type { DurablePrpControlPlane, RunnerProcessConnection, RunnerProcessHandle, RunnerProcessLaunchSpec } from "./durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";

/** Environment ownership shared by local, SSH, and sandbox Runner execution.
 * Preparation belongs to connection registration, before launch; activation
 * happens after dispatch. PRP authority and session semantics stay with Core.
 * Filesystem paths and process specifications are private to the built-in driver,
 * not a serializable plugin API.
 */
export interface RunnerExecutionDriver {
  /** Prepare resources and register or acquire the connection before launch. */
  controlPlaneRegistration?: (
    authority: DurablePrpControlPlane,
    identity?: DurableRecoveryIdentity,
    signal?: AbortSignal,
  ) => Promise<{
    connectUrl?: string;
    connection?: RunnerProcessConnection;
    activate?: () => Promise<void> | void;
    ready?: () => Promise<void>;
    failure?: Promise<never>;
    startupFailureCode?:
      | "runner_local_connect_failed"
      | "runner_direct_wss_failed"
      | "runner_ingress_unavailable";
    /** Persists only exact, independently verified suspended remote state. */
    checkpoint?: (settlement: "settled" | "unsettled") => Promise<void> | void;
    release: () => Promise<void> | void;
  }>;
  /** Override process ownership; omission uses the SDK's local process owner. */
  runnerProcessLauncher?: (
    spec: RunnerProcessLaunchSpec,
  ) => RunnerProcessHandle;
  /** Durable runner state path in the process owner's filesystem. */
  runnerStateDirectory?: string;
  /** Read the live durable runner state when runnerd owns a remote filesystem. */
  readRunnerState?: () => Promise<Record<string, unknown>>;
  /** Materializes a verified external checkpoint before authority rotation. */
  prepareExternalRunnerState?: () => Promise<void>;
  /** Idempotently archives and returns the verified suspended runner binding. */
  archiveExternalRunnerState?: (input: {
    archiveKey: string;
    priorIdentity: DurableRecoveryIdentity;
  }) => Promise<Record<string, unknown>>;
  /** Active-connection recovery budget. Omitted for the existing local mode. */
  runnerReconnectGraceMs?: number;
  /**
   * A verified Runner that outlived its controller. Adoption registers
   * the durable authority and waits for this exact process to reconnect; it
   * never calls the process launcher while the process remains alive.
   */
  adoptExistingRunner?: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
    isAlive: () => Promise<boolean> | boolean;
    signal?: (signal: NodeJS.Signals) => Promise<boolean> | boolean;
  };
}
