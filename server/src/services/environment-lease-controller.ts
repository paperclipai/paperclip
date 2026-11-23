import { currentControllerProcessStamp, readControllerProcess, type ControllerProcess } from "./controller-process-identity.js";

/**
 * The server process that holds an environment lease (plan section A).
 *
 * A run lease is owned by its run while the run is active. Once the run is
 * terminal, the release is still owed by the process that executes the run:
 * it releases the lease from its own `finally`, with the run's resource
 * disposition. This stamp names that process, so the shared ownership prover
 * can tell a lease whose holder is releasing it from one whose holder died
 * between the terminal run write and the release.
 *
 * The stamp is written in the same write that makes the lease active and does
 * no I/O (`currentControllerProcessStamp`).
 */
export const ENVIRONMENT_LEASE_CONTROLLER_KEY = "leaseController";

export function withEnvironmentLeaseController(metadata: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(metadata ?? {}), [ENVIRONMENT_LEASE_CONTROLLER_KEY]: currentControllerProcessStamp() };
}

export function readEnvironmentLeaseController(metadata: unknown): ControllerProcess | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return readControllerProcess((metadata as Record<string, unknown>)[ENVIRONMENT_LEASE_CONTROLLER_KEY]);
}
