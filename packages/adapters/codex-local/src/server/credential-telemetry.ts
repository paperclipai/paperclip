import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY = "codexCredentialTelemetry";

export type CodexAuthRefreshFailureClass =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated";

export type CodexCredentialSeedSource =
  | "configured_key"
  | "host_file"
  | "snapshot_file";

export type CodexLastRefreshAgeBucket =
  | "lt_1h"
  | "lt_8d"
  | "gte_8d"
  | "missing";

export interface CodexCredentialTelemetryDimensions {
  seedSource: CodexCredentialSeedSource;
  lastRefreshAgeBucket: CodexLastRefreshAgeBucket;
  rotationsDetected: boolean;
  failureClass?: CodexAuthRefreshFailureClass;
}

export interface CodexCredentialTelemetrySnapshot {
  refreshTokenFingerprint: string | null;
  lastRefreshAgeBucket: CodexLastRefreshAgeBucket;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const EIGHT_DAYS_MS = 8 * 24 * ONE_HOUR_MS;

const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has )?already been used|token reuse detected)/i;
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i;
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?invalidated|refresh token (?:has been )?(?:invalidated|revoked|invalid)|invalid refresh token|invalid[_\s-]?grant|unauthorized|missing bearer|\b401\b)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readNestedString(record: Record<string, unknown>, pathSegments: string[]): string | null {
  let current: unknown = record;
  for (const segment of pathSegments) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current.trim() : null;
}

function fingerprintSensitiveValue(value: string | null): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex");
}

export function bucketCodexLastRefreshAge(
  lastRefresh: string | null | undefined,
  now = new Date(),
): CodexLastRefreshAgeBucket {
  if (!lastRefresh) return "missing";
  const parsed = new Date(lastRefresh);
  if (Number.isNaN(parsed.getTime())) return "missing";

  const ageMs = Math.max(0, now.getTime() - parsed.getTime());
  if (ageMs < ONE_HOUR_MS) return "lt_1h";
  if (ageMs < EIGHT_DAYS_MS) return "lt_8d";
  return "gte_8d";
}

export async function readCodexCredentialTelemetrySnapshot(
  codexHome: string,
  now = new Date(),
): Promise<CodexCredentialTelemetrySnapshot> {
  const authPath = path.join(codexHome, "auth.json");
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch {
    return {
      refreshTokenFingerprint: null,
      lastRefreshAgeBucket: "missing",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      refreshTokenFingerprint: null,
      lastRefreshAgeBucket: "missing",
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      refreshTokenFingerprint: null,
      lastRefreshAgeBucket: "missing",
    };
  }

  return {
    refreshTokenFingerprint: fingerprintSensitiveValue(readNestedString(parsed, ["tokens", "refresh_token"])),
    lastRefreshAgeBucket: bucketCodexLastRefreshAge(
      typeof parsed.last_refresh === "string" ? parsed.last_refresh : null,
      now,
    ),
  };
}

export function classifyCodexAuthRefreshFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): CodexAuthRefreshFailureClass | null {
  const haystack = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return "refresh_token_reused";
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return "refresh_token_expired";
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  return null;
}

export function buildCodexCredentialTelemetryDimensions(input: {
  seedSource: CodexCredentialSeedSource;
  seedSnapshot: CodexCredentialTelemetrySnapshot;
  postRunSnapshot: CodexCredentialTelemetrySnapshot;
  failureClass?: CodexAuthRefreshFailureClass | null;
}): CodexCredentialTelemetryDimensions {
  return {
    seedSource: input.seedSource,
    lastRefreshAgeBucket: input.seedSnapshot.lastRefreshAgeBucket,
    rotationsDetected: Boolean(
      input.seedSnapshot.refreshTokenFingerprint &&
        input.postRunSnapshot.refreshTokenFingerprint &&
        input.seedSnapshot.refreshTokenFingerprint !== input.postRunSnapshot.refreshTokenFingerprint,
    ),
    ...(input.failureClass ? { failureClass: input.failureClass } : {}),
  };
}
