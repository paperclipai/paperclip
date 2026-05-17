/**
 * Phase 4A-1 (LET-310): sandbox quota parser.
 *
 * Rejects unbounded / "default-dangerous" inputs (zero, negative, missing).
 * Accepts only explicit positive ceilings. The defaults below are policy
 * metadata only — Phase 4A-1 does not enforce them on a live container.
 */

export interface SandboxQuotaInput {
  cpuMillis?: number;
  memoryBytes?: number;
  pidsLimit?: number;
  ephemeralStorageBytes?: number;
  walltimeSeconds?: number;
}

export interface SandboxQuotaCeilings {
  cpuMillis: number;
  memoryBytes: number;
  pidsLimit: number;
  ephemeralStorageBytes: number;
  walltimeSeconds: number;
}

export const DEFAULT_SANDBOX_QUOTA_CEILINGS: SandboxQuotaCeilings = Object.freeze({
  cpuMillis: 2_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pidsLimit: 256,
  ephemeralStorageBytes: 5 * 1024 * 1024 * 1024,
  walltimeSeconds: 30 * 60,
});

export const MAX_SANDBOX_QUOTA_CEILINGS: SandboxQuotaCeilings = Object.freeze({
  cpuMillis: 16_000,
  memoryBytes: 32 * 1024 * 1024 * 1024,
  pidsLimit: 4_096,
  ephemeralStorageBytes: 64 * 1024 * 1024 * 1024,
  walltimeSeconds: 4 * 60 * 60,
});

export class InvalidSandboxQuotaError extends Error {
  readonly code = "INVALID_SANDBOX_QUOTA";
  constructor(
    readonly field: keyof SandboxQuotaCeilings,
    readonly reason: "unbounded" | "non_positive" | "non_finite" | "exceeds_max",
  ) {
    super(`Invalid sandbox quota for ${field}: ${reason}`);
  }
}

function readPositiveInteger(
  field: keyof SandboxQuotaCeilings,
  value: unknown,
  max: number,
): number {
  if (value === undefined || value === null) {
    throw new InvalidSandboxQuotaError(field, "unbounded");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidSandboxQuotaError(field, "non_finite");
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidSandboxQuotaError(field, "non_positive");
  }
  if (value > max) {
    throw new InvalidSandboxQuotaError(field, "exceeds_max");
  }
  return value;
}

export function parseSandboxQuotas(input: SandboxQuotaInput | undefined | null): SandboxQuotaCeilings {
  if (!input || typeof input !== "object") {
    throw new InvalidSandboxQuotaError("cpuMillis", "unbounded");
  }
  return {
    cpuMillis: readPositiveInteger("cpuMillis", input.cpuMillis, MAX_SANDBOX_QUOTA_CEILINGS.cpuMillis),
    memoryBytes: readPositiveInteger("memoryBytes", input.memoryBytes, MAX_SANDBOX_QUOTA_CEILINGS.memoryBytes),
    pidsLimit: readPositiveInteger("pidsLimit", input.pidsLimit, MAX_SANDBOX_QUOTA_CEILINGS.pidsLimit),
    ephemeralStorageBytes: readPositiveInteger(
      "ephemeralStorageBytes",
      input.ephemeralStorageBytes,
      MAX_SANDBOX_QUOTA_CEILINGS.ephemeralStorageBytes,
    ),
    walltimeSeconds: readPositiveInteger(
      "walltimeSeconds",
      input.walltimeSeconds,
      MAX_SANDBOX_QUOTA_CEILINGS.walltimeSeconds,
    ),
  };
}

export function sandboxQuotasToMetadata(quotas: SandboxQuotaCeilings): Record<string, number> {
  return { ...quotas };
}
