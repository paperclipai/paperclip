import { z } from "zod";

/**
 * Validators for the opt-in `tailscale_https` runtime exposure contract.
 * Strict-by-default: unknown fields are rejected so a malformed or injected
 * config cannot smuggle an arbitrary target, path, or hostname suffix through
 * the runtime configuration into the broker (PAP-17050 verdict).
 */

export const runtimeExposureProviderSchema = z.literal("tailscale_https");

export const runtimeExposureFailurePolicySchema = z.literal("fail_closed");

export const runtimeExposureConfigSchema = z
  .object({
    type: runtimeExposureProviderSchema,
    hostname: z.literal("auto"),
    publicPort: z.literal("same"),
    includePaperclipViteHmr: z.boolean(),
    failurePolicy: runtimeExposureFailurePolicySchema,
  })
  .strict();

export const runtimeExposureStateSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "cleanup_pending",
  "removed",
]);

export const runtimeExposureListenerPurposeSchema = z.enum(["app", "vite_hmr"]);

export const runtimeExposureListenerSchema = z
  .object({
    purpose: runtimeExposureListenerPurposeSchema,
    publicPort: z.number().int().positive(),
    targetPort: z.number().int().positive(),
  })
  .strict()
  // Same-number invariant: the public HTTPS port must equal the loopback
  // target port. The broker enforces this too, but rejecting here keeps
  // persisted/serialized state honest.
  .refine((listener) => listener.publicPort === listener.targetPort, {
    message: "publicPort must equal targetPort (same-number exposure)",
    path: ["publicPort"],
  });

export const runtimeExposureStatusSchema = z
  .object({
    provider: runtimeExposureProviderSchema,
    state: runtimeExposureStateSchema,
    publicUrl: z.string().url().nullable(),
    hostname: z.string().min(1).nullable(),
    listeners: z.array(runtimeExposureListenerSchema),
    brokerRef: z.string().min(1).nullable(),
    lastError: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .strict();

export type RuntimeExposureConfigInput = z.infer<typeof runtimeExposureConfigSchema>;
export type RuntimeExposureStatusInput = z.infer<typeof runtimeExposureStatusSchema>;

/**
 * Default exposure config used when a project/workspace enables HTTPS exposure
 * without overriding sub-fields. Fail-closed and HMR-inclusive by default so
 * dev-mode hot reload works over the exposed HTTPS origin.
 */
export const DEFAULT_TAILSCALE_HTTPS_EXPOSURE: RuntimeExposureConfigInput = {
  type: "tailscale_https",
  hostname: "auto",
  publicPort: "same",
  includePaperclipViteHmr: true,
  failurePolicy: "fail_closed",
};

/**
 * Parse an untrusted `expose` block off a workspace runtime service config.
 * Returns null when exposure is absent; throws (via zod) on a malformed block
 * so misconfiguration fails closed rather than silently exposing nothing.
 */
export function parseRuntimeExposureConfig(
  value: unknown,
): RuntimeExposureConfigInput | null {
  if (value === undefined || value === null) return null;
  return runtimeExposureConfigSchema.parse(value);
}

/**
 * What an `expose` block says about HTTPS exposure, independent of whether the
 * runtime is eligible for it.
 *
 * `unset` is the common case: legacy templates only declare
 * `{ type: "url", urlTemplate }` for the backend readiness URL and say nothing
 * about exposure. Those runtimes are defaulted to `tailscale_https` by the
 * server start path when they are eligible (PAP-17158), so no project template
 * or UI caller has to supply an exposure block.
 */
export type RuntimeExposureIntent = "enabled" | "disabled" | "unset";

/**
 * Keys of the exposure contract itself. Anything a declared `tailscale_https`
 * block sets outside this list (and {@link RUNTIME_EXPOSURE_TRANSPORT_KEYS}) is
 * rejected, so a malformed or injected config still cannot smuggle an arbitrary
 * target, path, or hostname suffix through to the broker (PAP-17050 verdict).
 */
const RUNTIME_EXPOSURE_CONFIG_KEYS = [
  "type",
  "hostname",
  "publicPort",
  "includePaperclipViteHmr",
  "failurePolicy",
] as const;

/**
 * Pre-existing `expose` keys that describe the *backend* URL rather than the
 * exposure, and may legitimately sit next to a `tailscale_https` declaration.
 */
const RUNTIME_EXPOSURE_TRANSPORT_KEYS = ["urlTemplate", "tailscaleHttps"] as const;

/**
 * Read the declared intent off an `expose` block.
 *
 * An explicit negative always wins over an explicit positive so a deliberate
 * opt-out can never be re-enabled by a stale `type` left in the same block.
 */
export function readRuntimeExposureIntent(value: unknown): RuntimeExposureIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unset";
  const expose = value as Record<string, unknown>;
  // Deliberate opt-outs, checked first.
  if (expose.tailscaleHttps === false) return "disabled";
  if (expose.type === "none") return "disabled";
  if (expose.type === "tailscale_https" || expose.tailscaleHttps === true) return "enabled";
  return "unset";
}

/**
 * Resolve the exposure config a service *declared* (as opposed to the one it
 * inherits by default). Returns null unless the block explicitly opts in.
 *
 * Recognized sub-fields fall back to {@link DEFAULT_TAILSCALE_HTTPS_EXPOSURE},
 * so `{ type: "tailscale_https" }` is a complete declaration; unknown keys still
 * throw rather than being silently dropped.
 */
export function resolveDeclaredRuntimeExposureConfig(
  value: unknown,
): RuntimeExposureConfigInput | null {
  if (readRuntimeExposureIntent(value) !== "enabled") return null;
  const expose = value as Record<string, unknown>;
  const known = new Set<string>([...RUNTIME_EXPOSURE_CONFIG_KEYS, ...RUNTIME_EXPOSURE_TRANSPORT_KEYS]);
  const unknownKeys = Object.keys(expose).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported expose field(s): ${unknownKeys.sort().join(", ")}`);
  }
  const merged: Record<string, unknown> = { ...DEFAULT_TAILSCALE_HTTPS_EXPOSURE };
  for (const key of RUNTIME_EXPOSURE_CONFIG_KEYS) {
    if (expose[key] !== undefined) merged[key] = expose[key];
  }
  // `tailscaleHttps: true` is shorthand for the provider; normalize it away.
  merged.type = "tailscale_https";
  return runtimeExposureConfigSchema.parse(merged);
}
