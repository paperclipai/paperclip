/**
 * Runtime exposure lifecycle orchestrator for the `tailscale_https` mode.
 *
 * Owns the exposure state machine independently of the backend process
 * lifecycle (PAP-17049 plan, PAP-17050 verdict). A backend can be running and
 * healthy while its HTTPS exposure is still `pending`, `failed`, or
 * `cleanup_pending`. This module never touches Tailscale directly — it drives
 * the least-privilege broker through an injected {@link BrokerClient} and an
 * injected external HTTPS health probe, so every branch is unit-testable
 * against a fake broker with no sockets, no CLI, and no certificates.
 *
 * Invariants enforced here (in addition to the broker's own controls):
 *  - fail-closed: a configured HTTPS preview is never reported `ready` unless an
 *    external, normally-validating HTTPS probe succeeds.
 *  - same-number: only the app port and its derived HMR companion are exposed.
 *  - idempotent stop/cleanup: a missing/already-removed lease is success, not an
 *    error; genuine cleanup failures quarantine the ports and never reuse them.
 *  - reconcile touches only Paperclip-owned mappings the broker reports; it can
 *    never mutate an unknown/manual mapping or the primary `:443` route (the
 *    broker's `list` never returns those, and remove requires an owned handle).
 */
import type { RuntimeExposureConfigInput, RuntimeExposureStatus } from "@paperclipai/shared";
import {
  buildRuntimeExposureHealthUrl,
  buildRuntimeExposureUrl,
  deriveViteHmrPort,
  isRuntimeExposureAppPort,
} from "@paperclipai/shared";

import {
  BrokerClientError,
  type BrokerClient,
  type BrokerListenerRequest,
} from "./broker-client.js";

/** Injected seams — all side effects live behind these for testability. */
export interface ExposureManagerDeps {
  broker: BrokerClient;
  /** External HTTPS probe; must reject/return false on cert or connection error. */
  probeHealth: (healthUrl: string) => Promise<boolean>;
  /** ISO timestamp source. Injected so tests are deterministic. */
  now: () => string;
  /**
   * Optional operator-facing diagnosis of the about-to-be-exposed listeners,
   * returning null when nothing is provably wrong (PAP-17256).
   *
   * This does not replace the broker's own loopback gate and cannot loosen it —
   * it runs first only so a wildcard bind fails with the port and address named
   * instead of a bare `listener_ownership_mismatch`.
   */
  diagnoseListenerBinds?: (ports: number[]) => Promise<string | null>;
}

export interface ProvisionInput {
  runtimeId: string;
  config: RuntimeExposureConfigInput;
  /** Broker-issued reservation handle persisted before the backend starts. */
  handle: string;
  /** Resolved Tailscale node DNS hostname (the manager does not resolve it). */
  hostname: string;
  /** Loopback app port already allocated in the dedicated range. */
  appPort: number;
}

export interface ProvisionResult {
  status: RuntimeExposureStatus;
  /**
   * Server-only lease handle required to later remove the mapping. NEVER
   * serialized to the UI or embedded in {@link RuntimeExposureStatus}; persist
   * it in a server-private store. Null when nothing was exposed.
   */
  handle: string | null;
  /**
   * Human-readable elaboration of {@link RuntimeExposureStatus.lastError}, when
   * one is available (PAP-17256).
   *
   * Deliberately NOT folded into the persisted status: `lastError` stays the
   * broker's stable machine code so the retry/cleanup vocabularies keep matching
   * on it. This rides alongside so the caller can put the reason in the failure
   * the operator actually reads.
   */
  errorDetail?: string | null;
}

export interface ReserveInput {
  runtimeId: string;
  config: RuntimeExposureConfigInput;
  appPort: number;
}

/** Reserve the app/HMR pair before the backend binds either listener. */
export async function reserveExposure(
  deps: ExposureManagerDeps,
  input: ReserveInput,
): Promise<ProvisionResult> {
  const status = baseStatus(deps.now());
  if (!isRuntimeExposureAppPort(input.appPort)) {
    status.state = "failed";
    status.lastError = "app port outside dedicated runtime exposure range";
    return { status, handle: null };
  }
  const requested = buildListenerRequests(input.config, input.appPort);
  status.listeners = requested.map((listener) => ({
    purpose: listener.purpose,
    publicPort: listener.port,
    targetPort: listener.port,
  }));
  status.brokerRef = input.runtimeId;
  try {
    const result = await deps.broker.reserve(input.runtimeId, requested);
    const requestedPorts = new Set(requested.map((listener) => listener.port));
    const returnedPorts = new Set(result.reservedPorts);
    if (requestedPorts.size !== returnedPorts.size || ![...requestedPorts].every((port) => returnedPorts.has(port))) {
      await safeRemove(deps.broker, input.runtimeId, result.handle);
      status.state = "failed";
      status.lastError = "broker returned unexpected reserved ports";
      return { status, handle: null };
    }
    return { status, handle: result.handle };
  } catch (error) {
    status.state = "failed";
    status.lastError = brokerErrorCode(error);
    return { status, handle: null };
  }
}

export interface DeprovisionInput {
  runtimeId: string;
  /** Server-persisted lease handle, or null if none was ever recorded. */
  handle: string | null;
  /** Ports previously exposed for this runtime (for quarantine on failure). */
  ports: number[];
}

export interface DeprovisionResult {
  status: RuntimeExposureStatus;
  /** Ports that must be quarantined (never reused) after an ambiguous cleanup. */
  quarantinedPorts: number[];
}

/** Broker error codes that mean "the mapping is already gone" — cleanup is a no-op. */
const ALREADY_GONE_CODES: ReadonlySet<string> = new Set([
  "invalid_handle",
  "listener_not_owned",
  "listener_ownership_mismatch",
]);

function baseStatus(now: string): RuntimeExposureStatus {
  return {
    provider: "tailscale_https",
    state: "pending",
    publicUrl: null,
    hostname: null,
    listeners: [],
    brokerRef: null,
    lastError: null,
    updatedAt: now,
  };
}

/** Build the broker listener request list from a validated exposure config. */
export function buildListenerRequests(
  config: RuntimeExposureConfigInput,
  appPort: number,
): BrokerListenerRequest[] {
  const listeners: BrokerListenerRequest[] = [{ purpose: "app", port: appPort }];
  if (config.includePaperclipViteHmr) {
    listeners.push({ purpose: "vite_hmr", port: deriveViteHmrPort(appPort) });
  }
  return listeners;
}

/**
 * Provision (or re-provision) the HTTPS exposure for one runtime service.
 * Idempotent at the broker level: a repeated call for a still-valid mapping
 * simply re-exposes and re-probes. Always returns a fully-formed status; the
 * caller persists both the status and the returned server-only handle.
 */
export async function provisionExposure(
  deps: ExposureManagerDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const now = deps.now();
  const status = baseStatus(now);
  status.hostname = input.hostname;

  if (!isRuntimeExposureAppPort(input.appPort)) {
    status.state = "failed";
    status.lastError = "app port outside dedicated runtime exposure range";
    return { status, handle: input.handle };
  }

  const requested = buildListenerRequests(input.config, input.appPort);
  status.listeners = requested.map((listener) => ({
    purpose: listener.purpose,
    publicPort: listener.port,
    targetPort: listener.port,
  }));
  status.brokerRef = input.runtimeId;

  // Explain a provable off-loopback bind before the broker denies it, so the
  // failure names the port and the address instead of only the code.
  if (deps.diagnoseListenerBinds) {
    const violation = await deps.diagnoseListenerBinds(requested.map((listener) => listener.port));
    if (violation) {
      status.state = "failed";
      status.lastError = "listener_ownership_mismatch";
      return { status, handle: input.handle, errorDetail: violation };
    }
  }

  let handle: string;
  let publicPorts: number[];
  try {
    const result = await deps.broker.expose(input.runtimeId, input.handle);
    handle = result.handle;
    publicPorts = result.publicPorts;
  } catch (error) {
    status.state = "failed";
    status.lastError = brokerErrorCode(error);
    return { status, handle: input.handle, errorDetail: brokerErrorDetail(error) };
  }

  // The broker must return exactly the ports we asked for (same-number). A
  // mismatch is a contract violation: tear the mapping back down and fail.
  const requestedPorts = new Set(requested.map((l) => l.port));
  const returnedPorts = new Set(publicPorts);
  if (requestedPorts.size !== returnedPorts.size || ![...requestedPorts].every((p) => returnedPorts.has(p))) {
    await safeRemove(deps.broker, input.runtimeId, handle);
    status.state = "failed";
    status.lastError = "broker returned unexpected public ports";
    return { status, handle };
  }

  // Reflect the attempted mapping regardless of health so the UI can show what
  // was provisioned even while probing.
  // fail-closed: never report ready until an external, cert-validating probe
  // succeeds. Keep the handle so the caller can retry or clean up.
  const healthUrl = buildRuntimeExposureHealthUrl(input.hostname, input.appPort);
  let healthy = false;
  try {
    healthy = await deps.probeHealth(healthUrl);
  } catch {
    healthy = false;
  }
  if (!healthy) {
    status.state = "failed";
    status.publicUrl = null;
    status.lastError = "external HTTPS health probe did not validate";
    return { status, handle };
  }

  status.state = "ready";
  status.publicUrl = buildRuntimeExposureUrl(input.hostname, input.appPort);
  status.lastError = null;
  return { status, handle };
}

/**
 * Tear down the HTTPS exposure for one runtime service. Idempotent: a null or
 * already-gone handle resolves to `removed` with no quarantine. A genuine
 * cleanup failure resolves to `cleanup_pending` and quarantines the ports.
 */
export async function deprovisionExposure(
  deps: ExposureManagerDeps,
  input: DeprovisionInput,
): Promise<DeprovisionResult> {
  const now = deps.now();
  const status = baseStatus(now);
  status.state = "removed";

  if (input.handle === null) {
    // Nothing the server knows to remove — treat as already cleaned up.
    return { status, quarantinedPorts: [] };
  }

  try {
    await deps.broker.remove(input.runtimeId, input.handle);
    return { status, quarantinedPorts: [] };
  } catch (error) {
    const code = brokerErrorCode(error);
    if (ALREADY_GONE_CODES.has(code)) {
      // The mapping is already gone; cleanup is complete and safe.
      return { status, quarantinedPorts: [] };
    }
    // Ambiguous failure: we cannot prove the mapping is gone. Quarantine the
    // ports so they are never reused, and surface cleanup_pending.
    status.state = "cleanup_pending";
    status.lastError = code;
    return { status, quarantinedPorts: [...new Set(input.ports)] };
  }
}

export interface ReconcileInput {
  /** Runtimes whose exposure SHOULD remain. Everything else owned is an orphan. */
  desiredRuntimeIds: ReadonlySet<string>;
  /** Every server-persisted lease handle, keyed by runtimeId (desired + orphaned). */
  handlesByRuntimeId: ReadonlyMap<string, string>;
}

export interface ReconcileResult {
  /** Owned+desired runtimes confirmed present in the broker's mapping. */
  adopted: string[];
  /** Ports removed because their runtime is no longer desired. */
  removedOrphanPorts: number[];
  /**
   * Orphaned owned runtimes we could NOT remove because no handle was persisted.
   * Reported for operator/broker-side quarantine; the manager never fabricates a
   * handle and never touches a mapping it cannot prove ownership of.
   */
  unremovableOrphans: string[];
  /** Non-fatal per-runtime removal errors during reconciliation. */
  errors: Array<{ runtimeId: string; code: string }>;
}

/**
 * Startup / periodic reconciliation. Adopts owned mappings that are still
 * desired and removes owned mappings that are not. The broker's `list` only
 * ever returns Paperclip-owned listeners, so unknown/manual mappings and the
 * primary `:443` route are structurally out of scope here — they can never be
 * enumerated, adopted, or removed by this routine.
 */
export async function reconcileExposures(
  deps: ExposureManagerDeps,
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    adopted: [],
    removedOrphanPorts: [],
    unremovableOrphans: [],
    errors: [],
  };

  const owned = await deps.broker.list();

  // Group owned ports by runtimeId.
  const portsByRuntime = new Map<string, number[]>();
  for (const listener of owned) {
    const ports = portsByRuntime.get(listener.runtimeId) ?? [];
    ports.push(listener.port);
    portsByRuntime.set(listener.runtimeId, ports);
  }

  for (const [runtimeId, ports] of portsByRuntime) {
    if (input.desiredRuntimeIds.has(runtimeId)) {
      result.adopted.push(runtimeId);
      continue;
    }
    // Orphan: owned by us but no longer desired.
    const handle = input.handlesByRuntimeId.get(runtimeId);
    if (!handle) {
      result.unremovableOrphans.push(runtimeId);
      continue;
    }
    try {
      const removed = await deps.broker.remove(runtimeId, handle);
      result.removedOrphanPorts.push(...removed.removedPorts);
    } catch (error) {
      const code = brokerErrorCode(error);
      if (ALREADY_GONE_CODES.has(code)) {
        // Already gone — reconciled, count its ports as removed for reporting.
        result.removedOrphanPorts.push(...ports);
      } else {
        result.errors.push({ runtimeId, code });
      }
    }
  }

  return result;
}

/** Best-effort remove used on rollback paths; swallows broker errors. */
async function safeRemove(broker: BrokerClient, runtimeId: string, handle: string): Promise<void> {
  try {
    await broker.remove(runtimeId, handle);
  } catch {
    /* best effort — the outer flow has already decided to fail */
  }
}

function brokerErrorCode(error: unknown): string {
  if (error instanceof BrokerClientError) return error.code;
  return "internal_error";
}

/**
 * The broker's own explanation of a denial, when it adds anything to the code.
 *
 * The wire protocol already carries it (`BrokerClientError.message`, e.g.
 * "listener on 42003 is not loopback-only"); dropping it is what made
 * `listener_ownership_mismatch` unactionable in PAP-17254.
 */
function brokerErrorDetail(error: unknown): string | null {
  if (!(error instanceof BrokerClientError)) {
    return error instanceof Error ? error.message : null;
  }
  const message = error.message.trim();
  return message && message !== error.code ? message : null;
}
