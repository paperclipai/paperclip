/**
 * Contract shared across DB, server, UI, runtime, and the least-privilege
 * Tailscale HTTPS host broker for the opt-in `tailscale_https` exposure mode on
 * managed workspace runtime services.
 *
 * This file is the single source of truth for the exposure config and exposure
 * state shapes so the database column, shared validators, server serializers,
 * UI clients, and the broker wire protocol cannot drift. See PAP-17049 (plan)
 * and PAP-17050 (threat-model verdict).
 */

/** Exposure provider. Only Tailscale HTTPS is defined today. */
export type RuntimeExposureProvider = "tailscale_https";

/**
 * How a configured exposure reports health when provisioning fails.
 * `fail_closed` is the only supported value: a configured HTTPS preview is
 * never reported healthy with a plain-HTTP fallback.
 */
export type RuntimeExposureFailurePolicy = "fail_closed";

/**
 * Opt-in exposure request declared on a managed workspace runtime service.
 * Deliberately narrow: no arbitrary target URL, path, hostname suffix, or port
 * is accepted from the app. `hostname: "auto"` is resolved from the local
 * Tailscale node; `publicPort: "same"` reuses the allocated app port.
 */
export interface RuntimeExposureConfig {
  type: RuntimeExposureProvider;
  /** Only "auto" is supported; the node DNS name is resolved at runtime. */
  hostname: "auto";
  /** Only "same" is supported; the public port equals the loopback app port. */
  publicPort: "same";
  /** Provision the Paperclip Vite HMR companion listener alongside the app. */
  includePaperclipViteHmr: boolean;
  failurePolicy: RuntimeExposureFailurePolicy;
}

/**
 * Exposure lifecycle, modelled independently of the backend process lifecycle.
 * A backend can be `running`/healthy while its HTTPS exposure is still
 * `pending`, `failed`, or `cleanup_pending`.
 */
export type RuntimeExposureState =
  | "pending"
  | "ready"
  | "failed"
  | "cleanup_pending"
  | "removed";

/** Purpose of a single owned HTTPS-to-loopback listener. */
export type RuntimeExposureListenerPurpose = "app" | "vite_hmr";

/**
 * One HTTPS-to-loopback mapping owned by this runtime service. `publicPort`
 * always equals `targetPort` (same-number invariant); the target is loopback.
 */
export interface RuntimeExposureListener {
  purpose: RuntimeExposureListenerPurpose;
  publicPort: number;
  targetPort: number;
}

/**
 * Structured exposure state persisted on the runtime-service record and echoed
 * through server serializers to the UI. Never contains privileged commands,
 * lease handles, host paths, or raw broker/CLI output.
 */
export interface RuntimeExposureStatus {
  provider: RuntimeExposureProvider;
  state: RuntimeExposureState;
  /** Canonical browser URL once `ready`; null while pending/failed/removed. */
  publicUrl: string | null;
  /** Resolved node DNS hostname once known; null otherwise. */
  hostname: string | null;
  listeners: RuntimeExposureListener[];
  /**
   * Opaque broker reference for reconciliation/audit correlation. Not a lease
   * handle and not secret; safe to serialize to the UI.
   */
  brokerRef: string | null;
  /** Last non-sensitive, bounded error string for actionable UI remediation. */
  lastError: string | null;
  updatedAt: string | null;
}
