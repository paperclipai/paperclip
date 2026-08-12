import { conflict } from "../errors.js";

export function readCustomImageSetupSessionCompanyId(session: {
  metadata?: Record<string, unknown> | null;
}): string | null {
  const value = session.metadata?.setupRpcCompanyId;
  if (typeof value !== "string") return null;
  const companyId = value.trim();
  return companyId && companyId !== "instance" ? companyId : null;
}

export function readNullableDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

export function readFutureDate(value: Date | string | null | undefined, now: Date): Date | null {
  const date = readNullableDate(value);
  return date && date.getTime() > now.getTime() ? date : null;
}

export function requireFutureCustomImageSetupExpiry(
  session: { expiresAt: Date | string | null },
  now: Date,
): Date {
  const expiresAt = readFutureDate(session.expiresAt, now);
  if (!expiresAt) {
    throw conflict("Environment customImage setup session has expired.");
  }
  return expiresAt;
}
