import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";

export const CLOUD_RUNTIME_IDENTITY_HEADER = "x-paperclip-cloud-runtime-identity";
export const CLOUD_RUNTIME_IDENTITY_AUDIENCE = "paperclip-runtime-identity/v1";
export const CLOUD_RUNTIME_IDENTITY_ISSUER = "paperclip-cloud";
export const CLOUD_RUNTIME_IDENTITY_JWS_TYPE = "paperclip-cloud-runtime-identity+jwt";

const SINGLETON_KEY = "cloud-runtime-identity/v1";
const MAX_ASSERTION_LIFETIME_SECONDS = 10 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;
const STACK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type PersistedRuntimeIdentity = {
  stackId: string;
  claimId: string;
  previousOrigin: string;
  canonicalOrigin: string;
  stackSlug: string;
  appliedAt: Date;
};

type RuntimeIdentityDb = Pick<Db, "select" | "insert">;

export type CloudRuntimeIdentitySnapshot = {
  stackId: string;
  claimId: string;
  previousOrigin: string;
  canonicalOrigin: string;
  stackSlug: string;
  appliedAt: Date;
};

export type RuntimeIdentityClaims = {
  v: 1;
  iss: typeof CLOUD_RUNTIME_IDENTITY_ISSUER;
  aud: typeof CLOUD_RUNTIME_IDENTITY_AUDIENCE;
  sub: string;
  claimId: string;
  previousOrigin: string;
  canonicalOrigin: string;
  stackSlug: string;
  iat: number;
  exp: number;
};

let initialized = false;
let startupOrigin: string | null = null;
let currentIdentity: CloudRuntimeIdentitySnapshot | null = null;

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function exactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.origin !== value
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredStartupOrigin(env: NodeJS.ProcessEnv): string | null {
  const candidate = nonEmpty(env.PAPERCLIP_PUBLIC_URL)
    ?? nonEmpty(env.PAPERCLIP_AUTH_PUBLIC_BASE_URL)
    ?? nonEmpty(env.PAPERCLIP_API_URL);
  return candidate ? exactHttpsOrigin(candidate) : null;
}

function snapshot(row: PersistedRuntimeIdentity): CloudRuntimeIdentitySnapshot {
  return {
    stackId: row.stackId,
    claimId: row.claimId,
    previousOrigin: row.previousOrigin,
    canonicalOrigin: row.canonicalOrigin,
    stackSlug: row.stackSlug,
    appliedAt: row.appliedAt,
  };
}

function parsePersistedIdentity(row: {
  general: Record<string, unknown>;
  createdAt: Date;
}): PersistedRuntimeIdentity {
  const value = row.general;
  if (
    value.v !== 1
    || typeof value.stackId !== "string"
    || typeof value.claimId !== "string"
    || typeof value.previousOrigin !== "string"
    || typeof value.canonicalOrigin !== "string"
    || typeof value.stackSlug !== "string"
  ) {
    throw new Error("Persisted Cloud runtime identity is malformed");
  }
  return {
    stackId: value.stackId,
    claimId: value.claimId,
    previousOrigin: value.previousOrigin,
    canonicalOrigin: value.canonicalOrigin,
    stackSlug: value.stackSlug,
    appliedAt: row.createdAt,
  };
}

async function readPersistedIdentity(db: RuntimeIdentityDb): Promise<PersistedRuntimeIdentity | null> {
  const row = await db
    .select({
      general: instanceSettings.general,
      createdAt: instanceSettings.createdAt,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? parsePersistedIdentity(row) : null;
}

function applyCompatibilityEnvironment(identity: CloudRuntimeIdentitySnapshot, env: NodeJS.ProcessEnv) {
  const hostname = new URL(identity.canonicalOrigin).hostname;
  env.PAPERCLIP_PUBLIC_URL = identity.canonicalOrigin;
  env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = identity.canonicalOrigin;
  env.PAPERCLIP_API_URL = identity.canonicalOrigin;
  env.PAPERCLIP_PRIMARY_HOST = hostname;
  env.PAPERCLIP_STACK_SLUG = identity.stackSlug;

  const existingCandidates = (() => {
    try {
      const parsed = JSON.parse(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  })();
  env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([
    identity.canonicalOrigin,
    ...existingCandidates.filter((candidate) => candidate !== identity.canonicalOrigin),
  ]);
}

function assertPersistedIdentityMatchesStack(row: PersistedRuntimeIdentity, env: NodeJS.ProcessEnv) {
  const configuredStackId = nonEmpty(env.PAPERCLIP_CLOUD_STACK_ID);
  if (!configuredStackId || configuredStackId !== row.stackId) {
    throw new Error("Persisted Cloud runtime identity does not match PAPERCLIP_CLOUD_STACK_ID");
  }
  if (!exactHttpsOrigin(row.previousOrigin) || !exactHttpsOrigin(row.canonicalOrigin)) {
    throw new Error("Persisted Cloud runtime identity contains an invalid origin");
  }
  if (!STACK_SLUG_PATTERN.test(row.stackSlug) || new URL(row.canonicalOrigin).hostname.split(".")[0] !== row.stackSlug) {
    throw new Error("Persisted Cloud runtime identity contains an invalid stack slug");
  }
}

/** Load the durable claim before auth, routes, and child-runtime configuration. */
export async function initializeCloudRuntimeIdentity(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CloudRuntimeIdentitySnapshot | null> {
  startupOrigin = configuredStartupOrigin(env);
  // Self-hosted servers have no Cloud stack identity to restore. Avoid touching
  // the singleton table on that path; besides keeping the feature inert, this
  // preserves lightweight startup/test database seams that intentionally do
  // not construct a database client.
  if (!nonEmpty(env.PAPERCLIP_CLOUD_STACK_ID)) {
    initialized = true;
    currentIdentity = null;
    return null;
  }
  const row = await readPersistedIdentity(db);
  initialized = true;
  if (!row) {
    currentIdentity = null;
    return null;
  }
  assertPersistedIdentityMatchesStack(row, env);
  currentIdentity = snapshot(row);
  applyCompatibilityEnvironment(currentIdentity, env);
  return currentIdentity;
}

export function getCloudRuntimeIdentity(): CloudRuntimeIdentitySnapshot | null {
  return currentIdentity ? { ...currentIdentity } : null;
}

/** The live canonical origin, falling back to startup configuration off Cloud. */
export function runtimePublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env === process.env && currentIdentity) return currentIdentity.canonicalOrigin;
  const candidate = nonEmpty(env.PAPERCLIP_PUBLIC_URL)
    ?? nonEmpty(env.PAPERCLIP_AUTH_PUBLIC_BASE_URL)
    ?? nonEmpty(env.PAPERCLIP_API_URL);
  if (!candidate) return null;
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

/** The asserted Cloud origin only. Callers retain their non-Cloud precedence. */
export function runtimeCanonicalOrigin(): string | null {
  return currentIdentity?.canonicalOrigin ?? null;
}

function decodeJsonPart(part: string, label: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error(`Cloud runtime identity has an invalid ${label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error(`Cloud runtime identity has an invalid ${label}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cloud runtime identity has an invalid ${label}`);
  }
  return parsed as Record<string, unknown>;
}

function publicKeyForKid(env: NodeJS.ProcessEnv, kid: string) {
  const raw = nonEmpty(env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS);
  if (!raw) throw new Error("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is not configured");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is invalid");
  }
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { keys?: unknown }).keys
    : undefined;
  if (!Array.isArray(keys)) throw new Error("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS is invalid");
  const matches = keys.filter((candidate): candidate is JsonWebKey & { kid: string } => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const key = candidate as JsonWebKey & { kid?: unknown };
    return key.kid === kid;
  });
  if (matches.length !== 1) throw new Error("Cloud runtime identity uses an unknown signing key");
  const jwk = matches[0];
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || jwk.use !== "sig" || jwk.alg !== "EdDSA" || !jwk.x || jwk.d) {
    throw new Error("Cloud runtime identity signing key is invalid");
  }
  return createPublicKey({ key: jwk, format: "jwk" });
}

function verifyClaims(input: {
  compactJws: string;
  env: NodeJS.ProcessEnv;
  now: Date;
}): RuntimeIdentityClaims {
  const parts = input.compactJws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("Cloud runtime identity assertion is not a compact JWS");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader, "protected header");
  if (
    header.alg !== "EdDSA"
    || header.typ !== CLOUD_RUNTIME_IDENTITY_JWS_TYPE
    || typeof header.kid !== "string"
    || !header.kid
  ) {
    throw new Error("Cloud runtime identity protected header is invalid");
  }
  const key = publicKeyForKid(input.env, header.kid);
  const signature = Buffer.from(encodedSignature, "base64url");
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
  if (!verify(null, signingInput, key, signature)) {
    throw new Error("Cloud runtime identity signature is invalid");
  }

  const payload = decodeJsonPart(encodedPayload, "payload");
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (
    payload.v !== 1
    || payload.iss !== CLOUD_RUNTIME_IDENTITY_ISSUER
    || payload.aud !== CLOUD_RUNTIME_IDENTITY_AUDIENCE
    || typeof payload.sub !== "string"
    || typeof payload.claimId !== "string"
    || typeof payload.previousOrigin !== "string"
    || typeof payload.canonicalOrigin !== "string"
    || typeof payload.stackSlug !== "string"
    || typeof payload.iat !== "number"
    || !Number.isInteger(payload.iat)
    || typeof payload.exp !== "number"
    || !Number.isInteger(payload.exp)
  ) {
    throw new Error("Cloud runtime identity claims are incomplete");
  }
  if (
    payload.exp <= nowSeconds
    || payload.iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS
    || payload.exp <= payload.iat
    || payload.exp - payload.iat > MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    throw new Error("Cloud runtime identity assertion is expired or has an invalid lifetime");
  }
  return payload as RuntimeIdentityClaims;
}

/** Verify that an assertion is signed for this exact, still-unclaimed instance. */
export function verifyCloudRuntimeIdentityAssertion(input: {
  compactJws: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  expectedPreviousOrigin: string | null;
}): RuntimeIdentityClaims {
  const env = input.env ?? process.env;
  const claims = verifyClaims({ compactJws: input.compactJws, env, now: input.now ?? new Date() });
  const configuredStackId = nonEmpty(env.PAPERCLIP_CLOUD_STACK_ID);
  if (!configuredStackId || claims.sub !== configuredStackId) {
    throw new Error("Cloud runtime identity stack does not match this instance");
  }
  const previousOrigin = exactHttpsOrigin(claims.previousOrigin);
  const canonicalOrigin = exactHttpsOrigin(claims.canonicalOrigin);
  if (!previousOrigin || !canonicalOrigin || previousOrigin !== input.expectedPreviousOrigin) {
    throw new Error("Cloud runtime identity previous or canonical origin is invalid");
  }
  if (
    !STACK_SLUG_PATTERN.test(claims.stackSlug)
    || new URL(canonicalOrigin).hostname.split(".")[0] !== claims.stackSlug
    || claims.claimId.length > 256
    || claims.claimId.trim() !== claims.claimId
    || !claims.claimId
  ) {
    throw new Error("Cloud runtime identity destination is invalid");
  }
  return claims;
}

function assertionsEqual(row: PersistedRuntimeIdentity, claims: RuntimeIdentityClaims): boolean {
  const left = Buffer.from(JSON.stringify([
    row.stackId,
    row.claimId,
    row.previousOrigin,
    row.canonicalOrigin,
    row.stackSlug,
  ]));
  const right = Buffer.from(JSON.stringify([
    claims.sub,
    claims.claimId,
    claims.previousOrigin,
    claims.canonicalOrigin,
    claims.stackSlug,
  ]));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verify and durably apply the one-time Cloud claim assertion. */
export async function applyCloudRuntimeIdentityAssertion(input: {
  db: Db;
  compactJws: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<CloudRuntimeIdentitySnapshot> {
  const env = input.env ?? process.env;
  if (!initialized) throw new Error("Cloud runtime identity provider is not initialized");
  const claims = verifyCloudRuntimeIdentityAssertion({
    compactJws: input.compactJws,
    env,
    now: input.now,
    // After a natural restart the provider env may already be canonical, but
    // an identical retry of the original claim is still safe and idempotent.
    // The durable row preserves the pool origin that assertion had to match
    // on first application.
    expectedPreviousOrigin: currentIdentity?.previousOrigin ?? startupOrigin,
  });
  const previousOrigin = claims.previousOrigin;
  const canonicalOrigin = claims.canonicalOrigin;

  const row = await input.db.transaction(async (tx) => {
    const existing = await readPersistedIdentity(tx);
    if (existing) {
      if (!assertionsEqual(existing, claims)) {
        throw new Error("Cloud runtime identity is already claimed by another assertion");
      }
      return existing;
    }

    const now = input.now ?? new Date();
    await tx
      .insert(instanceSettings)
      .values({
        singletonKey: SINGLETON_KEY,
        general: {
          v: 1,
          stackId: claims.sub,
          claimId: claims.claimId,
          previousOrigin,
          canonicalOrigin,
          stackSlug: claims.stackSlug,
        },
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: instanceSettings.singletonKey });
    const durable = await readPersistedIdentity(tx);
    if (!durable || !assertionsEqual(durable, claims)) {
      throw new Error("Cloud runtime identity is already claimed by another assertion");
    }
    return durable;
  });

  currentIdentity = snapshot(row);
  applyCompatibilityEnvironment(currentIdentity, env);
  return { ...currentIdentity };
}

/** Test seam for modules that intentionally share a process. */
export function resetCloudRuntimeIdentityForTests() {
  initialized = false;
  startupOrigin = null;
  currentIdentity = null;
}
