import type { Environment, SandboxEnvironmentConfig } from "@paperclipai/shared";
import { fingerprintEnvironmentSandboxProviderConfig, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "./environment-custom-image-runtime.js";

export type SandboxTemplateIdentity = { id: string; capturedAt: string | null; templateKind: string; bindingField: string } | null;
export type SandboxSnapshotIdentity = {
  provider: "daytona";
  requestedRef: string;
  id: string;
  name: string;
  organizationId: string;
  createdAt: string;
};

export function readSnapshotIdentity(value: unknown, reference: unknown): SandboxSnapshotIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (identity.provider !== "daytona" || identity.requestedRef !== reference
    || typeof identity.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity.id)
    || typeof identity.name !== "string" || !identity.name.trim()
    || (reference !== identity.id && reference !== identity.name)
    || typeof identity.organizationId !== "string" || !identity.organizationId.trim()
    || typeof identity.createdAt !== "string" || !Number.isFinite(Date.parse(identity.createdAt))) return null;
  return identity as SandboxSnapshotIdentity;
}

export function isQualifiableDaytonaSnapshot(
  input: SandboxEnvironmentConfig, template: SandboxTemplateIdentity,
): input is SandboxEnvironmentConfig & Record<string, unknown> & { snapshot: string } {
  const config = input as unknown as Record<string, unknown>;
  return config.provider === "daytona" && typeof config.snapshot === "string" && !!config.snapshot.trim()
    && !config.image && !config.template && !config.templateRef
    && (!template || (template.templateKind === "snapshot" && template.bindingField === "snapshot"));
}

/** Keep an invalidated snapshot binding distinct from an environment that has
 * never required an immutable qualification. A failed probe cannot unpin a run.
 */
export function hasSandboxSnapshotQualification(environment: Environment, companyId: string): boolean {
  const proofs = environment.metadata?.[SANDBOX_PLATFORM_PROBE_METADATA_KEY];
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) return false;
  const proof = (proofs as Record<string, unknown>)[companyId];
  return !!proof && typeof proof === "object" && !Array.isArray(proof)
    && (proof as Record<string, unknown>).v === 2;
}

/** Discovery reads only saved, company-scoped proof. Execution pins the same
 * provider ID rather than resolving the mutable name again. A new config or
 * captured template needs a new probe; deleting the pinned snapshot fails at
 * the provider instead of silently selecting its replacement. */
export function qualifiedSandboxSnapshotId(
  environment: Environment, companyId: string, config: SandboxEnvironmentConfig, template: SandboxTemplateIdentity,
): string | null {
  if (!isQualifiableDaytonaSnapshot(config, template)) return null;
  const proofs = environment.metadata?.[SANDBOX_PLATFORM_PROBE_METADATA_KEY];
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) return null;
  const proof = (proofs as Record<string, unknown>)[companyId];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const value = proof as Record<string, unknown>;
  if (value.v !== 2 || value.invalidated === true || value.companyId !== companyId
    || value.baseConfigFingerprint !== fingerprintEnvironmentSandboxProviderConfig(environment.config as SandboxEnvironmentConfig)
    || value.runtimeConfigFingerprint !== fingerprintEnvironmentSandboxProviderConfig(config)
    || value.snapshot !== config.snapshot || JSON.stringify(value.template) !== JSON.stringify(template)) return null;
  return readSnapshotIdentity(value.snapshotIdentity, config.snapshot)?.id ?? null;
}
