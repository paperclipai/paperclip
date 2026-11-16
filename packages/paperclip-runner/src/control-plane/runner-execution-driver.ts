import type { RunnerLaunchPreparer } from "../live/runner-provider-launch.js";
import type { DurablePrpControlPlane, RunnerProcessConnection, RunnerProcessHandle, RunnerProcessLaunchSpec } from "./durable-prp-control-plane.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";

/** Environment ownership shared by local, SSH, and sandbox Runner execution.
 * Preparation belongs to connection registration, before launch; activation
 * happens after dispatch. PRP authority and session semantics stay with Core.
 * Provider preparation can be owned by the execution environment. Process
 * specifications stay private to the driver; plugins receive versioned requirements.
 */
export interface RunnerExecutionDriver {
  /** The driver verifies a stopped, idle Codex App Server source before launch. */
  codexSourceRecoveryVersion?: 1;
  /** The driver verifies a stopped, idle source for the selected ACPX provider before launch. */
  acpxSourceRecoveryVersion?: 1;
  /** An explicitly supported host release/resume pair; absence keeps ordinary warm ownership.
   * Release and released-source adoption require the registration checkpoint cleanup hook. */
  releaseResume?: {
    release(identity: DurableRecoveryIdentity): Promise<void>;
    resume(identity: DurableRecoveryIdentity, bootstrapTicket: string): Promise<"resumed" | "unavailable">;
    /** Confirmed Core-owned completed-session proof, used only for cache adoption. */
    releasedSource?: DurableRecoveryIdentity;
  };
  /** Current authenticated lease/checkpoint-writer owner; may change during warm reuse. */
  authorityRunId?: string;
  /** Own provider configuration and file preparation in the execution environment. */
  prepareLaunch?: RunnerLaunchPreparer;
  /** Reauthorize retained resources before adoption without preparing them again.
   * The ID is bound to the exact execution in the durable controller checkpoint.
   * Omission preserves prepareLaunch's existing recovery/authorization path.
   * Adoption with this hook requires prepareLaunch and its retained configuration binding.
   */
  authorizeRunnerAdoption?: (configurationId: string, identity: DurableRecoveryIdentity) => Promise<void>;
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
    /** Core committed the Runner's exit (its close suspend completed). Stop
     * treating a dropped connection as transport loss, so a Core-dialed route
     * neither redials nor fails; keep the established receive/ACK path. */
    quiesce?: () => void;
    release: (reason?: "detach") => Promise<void> | void;
  }>;
  /** Register source and target checkpoint ownership before staging changes the stored run. */
  onStagedRunAttachment?: (authority: DurablePrpControlPlane, proof: {
    sourceIdentity: DurableRecoveryIdentity; targetIdentity: DurableRecoveryIdentity; templateDigest: string;
  }) => Promise<void>;
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
  /** Process lifetime while disconnected. Defaults to the active-connection
   * recovery budget for compatibility. Null uses the authenticated connection
   * lease as the lifetime bound, so controller downtime cannot kill its owner. */
  runnerProcessReconnectGraceMs?: number | null;
  /**
   * A verified Runner that outlived its controller. Adoption registers
   * the durable authority and waits for this exact process to reconnect; it
   * never calls the process launcher while the process remains alive.
   */
  adoptExistingRunner?: {
    pid: number | null;
    processGroupId: number | null;
    startedAt: string | null;
    isAlive: () => Promise<boolean> | boolean;
    signal?: (signal: NodeJS.Signals) => Promise<boolean> | boolean;
  };
}
