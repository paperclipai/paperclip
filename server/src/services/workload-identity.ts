import { createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { and, eq, gt, inArray, lte, or } from "drizzle-orm";
import {
  companies,
  companyWorkloadIdentityKeys,
  toolAccessAuditEvents,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { persistActivity, publishActivity, type LogActivityInput } from "./activity-log.js";
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

let configuredPublicOrigin: string | null = null;

/**
 * The instance's configured public address (auth.publicBaseUrl, BETTER_AUTH_URL,
 * BETTER_AUTH_BASE_URL), set once by createApp. Used after the live Cloud
 * address and the PAPERCLIP_PUBLIC_URL family, which `runtimePublicOrigin` reads.
 */
export function setWorkloadIdentityConfiguredPublicOrigin(origin: string | null | undefined) {
  configuredPublicOrigin = origin?.trim() || null;
}

export function workloadIdentityPublicOrigin(): string | null {
  return runtimePublicOrigin() ?? configuredPublicOrigin;
}

/** AWS requires an https issuer with no port that it can reach from the internet. */
export function workloadIdentityIssuerOrigin(origin: string | null = workloadIdentityPublicOrigin()): WorkloadIdentityIssuerOrigin {
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

/** Only each company's current signing key is held decrypted; a rotated-out key is dropped. */
const signingKeyCache = new Map<string, { keyId: string; privateKey: KeyObject }>();

export function resetWorkloadIdentityKeyCacheForTests() {
  signingKeyCache.clear();
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
    const cached = signingKeyCache.get(row.companyId);
    if (cached?.keyId === row.keyId) return cached.privateKey;
    const pem = await localEncryptedProvider.resolveVersion({ material: row.privateKeyMaterial, externalRef: null });
    const privateKey = createPrivateKey(pem);
    // Fail closed on corruption or a wrong master key; never sign with a key that isn't the published one.
    if (row.algorithm !== WORKLOAD_IDENTITY_ALGORITHM || privateKey.asymmetricKeyType !== "ec"
      || jwkThumbprint(createPublicKey(privateKey).export({ format: "jwk" })) !== row.keyId) {
      throw new Error("Workload identity private key does not match its published key");
    }
    signingKeyCache.set(row.companyId, { keyId: row.keyId, privateKey });
    return privateKey;
  }

  /** Published keys only, filtered in SQL so reads stay bounded however many rotations happened. */
  async function publishedKeyRows(companyId: string): Promise<KeyRow[]> {
    const graceStart = new Date(now().getTime() - WORKLOAD_IDENTITY_RETIRING_GRACE_MS);
    return db.select().from(companyWorkloadIdentityKeys).where(and(
      eq(companyWorkloadIdentityKeys.companyId, companyId),
      or(
        inArray(companyWorkloadIdentityKeys.status, ["next", "active"]),
        and(eq(companyWorkloadIdentityKeys.status, "retiring"),
          gt(companyWorkloadIdentityKeys.statusChangedAt, graceStart)),
      ),
    ));
  }

  /** Retiring keys past their grace period become retired, so they leave every view. */
  async function settleRetiring(tx: Db, companyId: string, at: Date) {
    await tx.update(companyWorkloadIdentityKeys).set({ status: "retired", statusChangedAt: at }).where(and(
      eq(companyWorkloadIdentityKeys.companyId, companyId),
      eq(companyWorkloadIdentityKeys.status, "retiring"),
      lte(companyWorkloadIdentityKeys.statusChangedAt, new Date(at.getTime() - WORKLOAD_IDENTITY_RETIRING_GRACE_MS)),
    ));
  }

  type RotationActor = Pick<LogActivityInput, "actorType" | "actorId">;

  /** Runs one rotation step and its activity entry in one transaction; publishes the entry after commit. */
  async function rotate(
    companyId: string,
    actor: RotationActor,
    step: "begin" | "complete" | "emergency",
    work: (tx: Db, at: Date) => Promise<{ keyId: string; created?: boolean }>,
  ) {
    const { result, publication } = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockCompany(tx, companyId);
      const at = now();
      await settleRetiring(tx, companyId, at);
      const result = await work(tx, at);
      // A repeated "begin" while a rotation is pending changes nothing, so it is not logged.
      if (result.created === false) return { result, publication: null };
      const { publication } = await persistActivity(tx, {
        companyId, ...actor,
        action: `workload_identity.rotation_${step}`,
        entityType: "company", entityId: companyId,
        details: { keyId: result.keyId },
      });
      return { result, publication };
    });
    if (publication) publishActivity(publication);
    if (step !== "begin") signingKeyCache.delete(companyId);
    return result;
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
      const keys = (await publishedKeyRows(companyId)).map(publicJwkFor);
      return keys.length > 0 ? { keys } : null;
    },

    /** OIDC discovery document, or null when the issuer isn't usable here or the company has no key. */
    async discoveryDocument(companyId: string, origin = workloadIdentityIssuerOrigin()) {
      if (!origin.available) return null;
      if ((await publishedKeyRows(companyId)).length === 0) return null;
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
      const [connection] = await db.select({ status: toolConnections.status, enabled: toolConnections.enabled })
        .from(toolConnections).where(and(
          eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId),
        ));
      if (!connection) throw notFound("Connection not found");
      // Disabling a connection must stop new cloud credentials at once.
      if (!connection.enabled || connection.status !== "active") {
        throw unprocessable("This connection is not active.", { code: "workload_identity_connection_inactive" });
      }

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

    /** Board view: issuer and the published keys with their states, with no private material. */
    async describe(companyId: string, origin = workloadIdentityIssuerOrigin()) {
      await assertCompany(companyId);
      const rows = await publishedKeyRows(companyId);
      return {
        issuer: origin.available ? workloadIdentityIssuer(origin.origin, companyId) : null,
        unavailableReason: origin.available ? null : origin.reason,
        keys: rows
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({
            keyId: row.keyId,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            statusChangedAt: row.statusChangedAt.toISOString(),
          })),
      };
    },

    /** Step 1 of a planned rotation: publish a `next` key alongside the active one. */
    async beginRotation(companyId: string, actor: RotationActor) {
      return rotate(companyId, actor, "begin", async (tx) => {
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
        return { keyId: created!.keyId, created: true };
      });
    },

    /** Step 2: once the `next` key has been published long enough, it signs; the old key stays published for a grace period. */
    async completeRotation(companyId: string, actor: RotationActor) {
      return rotate(companyId, actor, "complete", async (tx, at) => {
        const [next] = await tx.select().from(companyWorkloadIdentityKeys).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          eq(companyWorkloadIdentityKeys.status, "next"),
        ));
        if (!next) throw conflict("Start a rotation first.", { code: "workload_identity_no_rotation" });
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
    async emergencyRotation(companyId: string, actor: RotationActor) {
      return rotate(companyId, actor, "emergency", async (tx, at) => {
        await tx.update(companyWorkloadIdentityKeys).set({ status: "retired", statusChangedAt: at }).where(and(
          eq(companyWorkloadIdentityKeys.companyId, companyId),
          inArray(companyWorkloadIdentityKeys.status, ["next", "active", "retiring"]),
        ));
        const [created] = await tx.insert(companyWorkloadIdentityKeys)
          .values(await newKeyValues(companyId, "active")).returning();
        return { keyId: created!.keyId };
      });
    },
  };
}

export type WorkloadIdentityService = ReturnType<typeof workloadIdentityService>;
