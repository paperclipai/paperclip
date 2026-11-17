import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  companies,
  companyWorkloadIdentityKeys,
  toolAccessAuditEvents,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { runtimePublicOrigin } from "./cloud-runtime-identity.js";
import { generateClientKeyPair, jwkThumbprint } from "./tool-access/oauth/client-credentials.js";

/**
 * Workload identity issuer: each company signs short-lived OIDC tokens that
 * name one of its connections, and publishes the public keys so an outside
 * cloud (AWS, GCP, Azure) can verify them without Paperclip storing that
 * cloud's keys. Only the control plane can sign; agents never see these tokens.
 */

export const WORKLOAD_IDENTITY_ALGORITHM = "ES256";
export const WORKLOAD_IDENTITY_TOKEN_LIFETIME_SECONDS = 300;
/** A `next` key is published this long before it may sign, so cached key sets pick it up. */
export const WORKLOAD_IDENTITY_PUBLISH_BEFORE_USE_MS = 24 * 60 * 60 * 1000;
/** A replaced key stays published this long, so tokens it signed still verify. */
export const WORKLOAD_IDENTITY_RETIRING_GRACE_MS = 24 * 60 * 60 * 1000;

type KeyRow = typeof companyWorkloadIdentityKeys.$inferSelect;

export type WorkloadIdentityIssuerOrigin =
  | { available: true; origin: string }
  | { available: false; reason: "no_public_url" | "not_https" | "has_port" | "loopback" };

/** AWS requires an https issuer with no port that it can reach from the internet. */
export function workloadIdentityIssuerOrigin(origin: string | null = runtimePublicOrigin()): WorkloadIdentityIssuerOrigin {
  if (!origin) return { available: false, reason: "no_public_url" };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { available: false, reason: "no_public_url" };
  }
  if (url.protocol !== "https:") return { available: false, reason: "not_https" };
  if (url.port !== "") return { available: false, reason: "has_port" };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./.test(host)) {
    return { available: false, reason: "loopback" };
  }
  return { available: true, origin: url.origin };
}

export function workloadIdentityIssuer(origin: string, companyId: string): string {
  return `${origin}/oidc/companies/${companyId}`;
}

export function workloadIdentitySubject(connectionId: string): string {
  return `connection:${connectionId}`;
}

/** Only public EC members, so private material can never reach the published key set. */
function publicJwkFor(row: Pick<KeyRow, "publicJwk" | "keyId">) {
  const jwk = row.publicJwk;
  return {
    kty: "EC",
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    kid: row.keyId,
    alg: WORKLOAD_IDENTITY_ALGORITHM,
    use: "sig",
  };
}

function isPublished(row: KeyRow, now: Date): boolean {
  if (row.status === "active" || row.status === "next") return true;
  return row.status === "retiring"
    && now.getTime() - row.statusChangedAt.getTime() < WORKLOAD_IDENTITY_RETIRING_GRACE_MS;
}

const privateKeyCache = new Map<string, KeyObject>();

export function resetWorkloadIdentityKeyCacheForTests() {
  privateKeyCache.clear();
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function workloadIdentityService(db: Db, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  async function newKeyValues(companyId: string, status: "next" | "active") {
    const generated = await generateClientKeyPair(WORKLOAD_IDENTITY_ALGORITHM, now());
    const encrypted = await localEncryptedProvider.createSecret({ value: generated.privateKeyPem });
    const at = now();
    return {
      companyId,
      keyId: generated.publicKey.keyId,
      algorithm: WORKLOAD_IDENTITY_ALGORITHM as "ES256",
      publicJwk: generated.publicKey.publicJwk as unknown as Record<string, unknown>,
      privateKeyMaterial: encrypted.material,
      status,
      createdAt: at,
      statusChangedAt: at,
    };
  }

  async function assertCompany(companyId: string) {
    const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    if (!company) throw notFound("Company not found");
  }

  async function activeKey(companyId: string): Promise<KeyRow | undefined> {
    const [row] = await db.select().from(companyWorkloadIdentityKeys).where(and(
      eq(companyWorkloadIdentityKeys.companyId, companyId),
      eq(companyWorkloadIdentityKeys.status, "active"),
    ));
    return row;
  }

  /** The company's signing key, created on first use. Concurrent callers converge on one key. */
  async function ensureActiveKey(companyId: string): Promise<KeyRow> {
    const existing = await activeKey(companyId);
    if (existing) return existing;
    await assertCompany(companyId);
    await db.insert(companyWorkloadIdentityKeys).values(await newKeyValues(companyId, "active")).onConflictDoNothing();
    const created = await activeKey(companyId);
    if (!created) throw new Error("Workload identity key could not be created");
    return created;
  }

  async function privateKeyFor(row: KeyRow): Promise<KeyObject> {
    const cacheKey = `${row.companyId}:${row.keyId}`;
    const cached = privateKeyCache.get(cacheKey);
    if (cached) return cached;
    const pem = await localEncryptedProvider.resolveVersion({ material: row.privateKeyMaterial, externalRef: null });
    const privateKey = createPrivateKey(pem);
    // Fail closed on corruption or a wrong master key; never sign with a key that isn't the published one.
    if (row.algorithm !== WORKLOAD_IDENTITY_ALGORITHM || privateKey.asymmetricKeyType !== "ec"
      || jwkThumbprint(createPublicKey(privateKey).export({ format: "jwk" })) !== row.keyId) {
      throw new Error("Workload identity private key does not match its published key");
    }
    privateKeyCache.set(cacheKey, privateKey);
    return privateKey;
  }

  async function keysFor(companyId: string): Promise<KeyRow[]> {
    return db.select().from(companyWorkloadIdentityKeys).where(and(
      eq(companyWorkloadIdentityKeys.companyId, companyId),
      inArray(companyWorkloadIdentityKeys.status, ["next", "active", "retiring"]),
    ));
  }

  async function lockCompany(tx: Db, companyId: string) {
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).for("update");
    if (!company) throw notFound("Company not found");
  }

  return {
    ensureActiveKey,

    /** Public key set, or null when the company has never created a key (callers answer 404). */
    async publicKeySet(companyId: string): Promise<{ keys: ReturnType<typeof publicJwkFor>[] } | null> {
      const at = now();
      const keys = (await keysFor(companyId)).filter((row) => isPublished(row, at)).map(publicJwkFor);
      return keys.length > 0 ? { keys } : null;
    },

    /** OIDC discovery document, or null when the issuer isn't usable here or the company has no key. */
    async discoveryDocument(companyId: string, origin = workloadIdentityIssuerOrigin()) {
      if (!origin.available) return null;
      const at = now();
      if (!(await keysFor(companyId)).some((row) => isPublished(row, at))) return null;
      const issuer = workloadIdentityIssuer(origin.origin, companyId);
      return {
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: [WORKLOAD_IDENTITY_ALGORITHM],
        claims_supported: ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"],
      };
    },

    /**
     * A 5-minute token that names one connection. `sub` and `aud` come from the
     * connection and its method, never from agent input. The token itself is
     * never stored or logged.
     */
    async signConnectionToken(input: {
      companyId: string;
      connectionId: string;
      audience: string;
      /** The issuer recorded when the connection was set up; signing stops if the instance address changed. */
      expectedIssuer?: string | null;
      origin?: WorkloadIdentityIssuerOrigin;
    }) {
      if (!/^[\x21-\x7e]{1,256}$/.test(input.audience)) {
        throw unprocessable("Invalid workload identity audience", { code: "workload_identity_audience_invalid" });
      }
      const origin = input.origin ?? workloadIdentityIssuerOrigin();
      if (!origin.available) {
        throw unprocessable("This Paperclip instance needs a public HTTPS address to sign identity tokens.", {
          code: "workload_identity_unavailable", reason: origin.reason,
        });
      }
      const issuer = workloadIdentityIssuer(origin.origin, input.companyId);
      if (input.expectedIssuer && input.expectedIssuer !== issuer) {
        throw conflict("This Paperclip instance's address changed. Update the identity provider in your cloud account.", {
          code: "workload_identity_issuer_changed",
        });
      }
      const [connection] = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
        eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId),
      ));
      if (!connection) throw notFound("Connection not found");

      const key = await ensureActiveKey(input.companyId);
      const privateKey = await privateKeyFor(key);
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issuedAt + WORKLOAD_IDENTITY_TOKEN_LIFETIME_SECONDS;
      const subject = workloadIdentitySubject(input.connectionId);
      const header = { alg: WORKLOAD_IDENTITY_ALGORITHM, typ: "JWT", kid: key.keyId };
      const claims = {
        iss: issuer, sub: subject, aud: input.audience,
        iat: issuedAt, nbf: issuedAt, exp: expiresAt, jti: randomUUID(),
      };
      const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
      const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
      await db.insert(toolAccessAuditEvents).values({
        companyId: input.companyId,
        connectionId: input.connectionId,
        actorType: "system",
        actorId: "workload-identity",
        action: "workload_identity.token_issued",
        outcome: "success",
        details: { keyId: key.keyId, audience: input.audience, expiresAt: new Date(expiresAt * 1000).toISOString() },
      });
      return {
        token: `${signingInput}.${base64Url(signature)}`,
        issuer,
        subject,
        keyId: key.keyId,
        expiresAt: new Date(expiresAt * 1000),
      };
    },

    /** Board view: issuer and key states, with no private material. */
    async describe(companyId: string, origin = workloadIdentityIssuerOrigin()) {
      await assertCompany(companyId);
      const at = now();
      const rows = await keysFor(companyId);
      return {
        issuer: origin.available ? workloadIdentityIssuer(origin.origin, companyId) : null,
        unavailableReason: origin.available ? null : origin.reason,
        keys: rows
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({
            keyId: row.keyId,
            status: row.status,
            published: isPublished(row, at),
            createdAt: row.createdAt.toISOString(),
            statusChangedAt: row.statusChangedAt.toISOString(),
          })),
      };
    },

    /** Step 1 of a planned rotation: publish a `next` key alongside the active one. */
    async beginRotation(companyId: string) {
      return db.transaction(async (tx) => {
        await lockCompany(tx as unknown as Db, companyId);
        const rows = await tx.select().from(companyWorkloadIdentityKeys).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          inArray(companyWorkloadIdentityKeys.status, ["next", "active"]),
        ));
        if (!rows.some((row) => row.status === "active")) {
          throw conflict("This company has no signing key to rotate yet.", { code: "workload_identity_no_key" });
        }
        const pending = rows.find((row) => row.status === "next");
        if (pending) return { keyId: pending.keyId, created: false };
        const [created] = await tx.insert(companyWorkloadIdentityKeys)
          .values(await newKeyValues(companyId, "next")).returning();
        return { keyId: created.keyId, created: true };
      });
    },

    /** Step 2: once the `next` key has been published long enough, it signs; the old key stays published for a grace period. */
    async completeRotation(companyId: string) {
      return db.transaction(async (tx) => {
        await lockCompany(tx as unknown as Db, companyId);
        const [next] = await tx.select().from(companyWorkloadIdentityKeys).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          eq(companyWorkloadIdentityKeys.status, "next"),
        ));
        if (!next) throw conflict("Start a rotation first.", { code: "workload_identity_no_rotation" });
        const at = now();
        const readyAt = new Date(next.createdAt.getTime() + WORKLOAD_IDENTITY_PUBLISH_BEFORE_USE_MS);
        if (readyAt > at) {
          throw conflict("The new key must be published for 24 hours before it can sign.", {
            code: "workload_identity_rotation_not_ready", readyAt: readyAt.toISOString(),
          });
        }
        await tx.update(companyWorkloadIdentityKeys).set({ status: "retiring", statusChangedAt: at }).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          eq(companyWorkloadIdentityKeys.status, "active"),
        ));
        await tx.update(companyWorkloadIdentityKeys).set({ status: "active", statusChangedAt: at })
          .where(eq(companyWorkloadIdentityKeys.id, next.id));
        return { keyId: next.keyId };
      });
    },

    /** For a key believed exposed: stop publishing every current key and sign with a fresh one immediately. */
    async emergencyRotation(companyId: string) {
      return db.transaction(async (tx) => {
        await lockCompany(tx as unknown as Db, companyId);
        const at = now();
        await tx.update(companyWorkloadIdentityKeys).set({ status: "retired", statusChangedAt: at }).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          inArray(companyWorkloadIdentityKeys.status, ["next", "active", "retiring"]),
        ));
        const [created] = await tx.insert(companyWorkloadIdentityKeys)
          .values(await newKeyValues(companyId, "active")).returning();
        return { keyId: created.keyId };
      });
    },
  };
}

export type WorkloadIdentityService = ReturnType<typeof workloadIdentityService>;
