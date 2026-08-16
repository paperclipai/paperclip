import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  COMPANY_WORK_PROJECTION_API_VERSION,
  COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { HttpError } from "../errors.js";

const cursorPayloadSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_PROJECTION_API_VERSION),
  schemaVersion: z.literal(COMPANY_WORK_PROJECTION_SCHEMA_VERSION),
  companyId: z.string().uuid(),
  snapshotRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  afterRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  afterIssueId: z.string().uuid().nullable(),
  pageSize: z.number().int().min(1).max(500),
}).strict();
const MAX_CURSOR_LIFETIME_MS = 5 * 60 * 1000;

export type CompanyWorkProjectionCursor = z.infer<typeof cursorPayloadSchema>;

function cursorError(message: string, code = "WORK_PROJECTION_MALFORMED", status = 400): never {
  throw new HttpError(status, message, { code });
}

function masterSecret(): string | null {
  return process.env.PAPERCLIP_WORK_PROJECTION_CURSOR_SECRET?.trim()
    || process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || null;
}

function previousMasterSecret(): string | null {
  return process.env.PAPERCLIP_WORK_PROJECTION_CURSOR_PREVIOUS_SECRET?.trim() || null;
}

function signingKey(companyId: string, secret: string | null): Buffer {
  if (!secret) {
    throw new HttpError(503, "Work projection signing key is unavailable", {
      code: "WORK_PROJECTION_UNAVAILABLE",
    });
  }
  return createHmac("sha256", secret)
    .update(`company-work-projection-cursor:v1:${resolvePaperclipInstanceId()}:${companyId}`)
    .digest();
}

function signature(payload: string, companyId: string, secret: string | null): string {
  return createHmac("sha256", signingKey(companyId, secret)).update(payload).digest("base64url");
}

function signaturesMatch(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertCompanyWorkProjectionCursorSigningReady(
  companyId: string,
  secretOverride?: string,
): void {
  signingKey(companyId, secretOverride ?? masterSecret());
}

export function encodeCompanyWorkProjectionCursor(
  value: CompanyWorkProjectionCursor,
  secretOverride?: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursorPayloadSchema.parse(value)), "utf8").toString("base64url");
  return `${payload}.${signature(payload, value.companyId, secretOverride ?? masterSecret())}`;
}

export function decodeCompanyWorkProjectionCursor(
  token: string,
  expectedCompanyId: string,
  now: Date,
  secretOverride?: string,
  previousSecretOverride?: string,
): CompanyWorkProjectionCursor {
  const parts = token.split(".");
  if (parts.length !== 2) cursorError("Malformed work projection cursor");
  const [payload, suppliedSignature] = parts;

  let unknownValue: unknown;
  try {
    unknownValue = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    cursorError("Malformed work projection cursor");
  }
  const currentSignature = signature(payload, expectedCompanyId, secretOverride ?? masterSecret());
  const previousSecret = previousSecretOverride ?? previousMasterSecret();
  const matchesCurrent = signaturesMatch(suppliedSignature, currentSignature);
  const matchesPrevious = !matchesCurrent && previousSecret
    ? signaturesMatch(suppliedSignature, signature(payload, expectedCompanyId, previousSecret))
    : false;
  if (!matchesCurrent && !matchesPrevious) {
    cursorError("Malformed work projection cursor");
  }

  const parsed = cursorPayloadSchema.safeParse(unknownValue);
  if (!parsed.success) {
    const raw = unknownValue as Record<string, unknown> | null;
    if (
      raw &&
      (raw.apiVersion !== COMPANY_WORK_PROJECTION_API_VERSION ||
        raw.schemaVersion !== COMPANY_WORK_PROJECTION_SCHEMA_VERSION)
    ) {
      cursorError("Incompatible work projection cursor version", "WORK_PROJECTION_INCOMPATIBLE", 409);
    }
    cursorError("Malformed work projection cursor");
  }

  if (parsed.data.companyId !== expectedCompanyId) {
    // Do not disclose whether the signed cursor belongs to another company.
    cursorError("Malformed work projection cursor");
  }

  const issuedAt = new Date(parsed.data.issuedAt).getTime();
  const expiresAt = new Date(parsed.data.expiresAt).getTime();
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_CURSOR_LIFETIME_MS) {
    cursorError("Malformed work projection cursor lifetime");
  }
  if (expiresAt <= now.getTime()) {
    cursorError("Work projection snapshot expired", "WORK_PROJECTION_SNAPSHOT_EXPIRED", 410);
  }
  return parsed.data;
}
