import { createHash, createPublicKey, generateKeyPair, randomUUID, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import type { toolConnections } from "@paperclipai/db";
import { asRecord, normalizeOauthScopes, oauthConfig } from "./metadata.js";

/**
 * MCP OAuth Client Credentials extension (2026-07-28): machine-to-machine sign-in
 * for organization-owned connections. No person signs in; Paperclip presents a
 * client it was registered as, either with a signed assertion (RFC 7523,
 * `private_key_jwt`, recommended) or a client secret.
 *
 * This module is the protocol half: key material, assertions, and how the
 * connection records its pinned authorization server. Secret values never live
 * here; they are read from the company vault by the caller just before a token
 * request and never stored in config.
 */
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Vault paths. The private key and client secret are only ever sent to the pinned token endpoint. */
export const CLIENT_PRIVATE_KEY_PATH = "oauth.client_private_key";
export const CLIENT_PRIVATE_KEY_NEXT_PATH = "oauth.client_private_key_next";
export const CLIENT_SECRET_PATH = "oauth.client_secret";

export type ClientCredentialsAuthMethod = "private_key_jwt" | "client_secret_basic" | "client_secret_post";
export type ClientAssertionAlgorithm = "RS256" | "ES256";

/** Public half of a Paperclip-held key, safe to show and to store in config. */
export type ClientPublicKey = {
  keyId: string;
  algorithm: ClientAssertionAlgorithm;
  publicKeyPem: string;
  publicJwk: JsonWebKey;
  createdAt: string;
};

export type ClientCredentialsSettings = {
  clientId: string | null;
  tokenUrl: string;
  /** Pinned authorization-server issuer. Null when the admin entered a token URL directly. */
  issuer: string | null;
  scopes: string[];
  resource: string | null;
  authMethod: ClientCredentialsAuthMethod;
  key: ClientPublicKey | null;
  pendingKey: ClientPublicKey | null;
};

function isAuthMethod(value: unknown): value is ClientCredentialsAuthMethod {
  return value === "private_key_jwt" || value === "client_secret_basic" || value === "client_secret_post";
}

function publicKeyFrom(value: unknown): ClientPublicKey | null {
  const record = asRecord(value);
  if (typeof record.keyId !== "string" || typeof record.publicKeyPem !== "string") return null;
  if (record.algorithm !== "RS256" && record.algorithm !== "ES256") return null;
  return {
    keyId: record.keyId,
    algorithm: record.algorithm,
    publicKeyPem: record.publicKeyPem,
    publicJwk: asRecord(record.publicJwk) as JsonWebKey,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
  };
}

/**
 * The machine sign-in settings a connection was set up with, or null when the
 * connection does not use them. Older env-configured client-credentials rows
 * (no `clientAuth`) keep their original path.
 */
export function clientCredentialsSettings(
  connection: Pick<typeof toolConnections.$inferSelect, "config">,
): ClientCredentialsSettings | null {
  const oauth = oauthConfig(connection);
  if (oauth.grantType !== "client_credentials") return null;
  const clientAuth = asRecord(oauth.clientAuth);
  if (!isAuthMethod(clientAuth.method) || typeof oauth.tokenUrl !== "string") return null;
  return {
    clientId: typeof oauth.clientId === "string" && oauth.clientId.trim() ? oauth.clientId.trim() : null,
    tokenUrl: oauth.tokenUrl,
    issuer: typeof oauth.issuer === "string" && oauth.issuer.trim() ? oauth.issuer.trim() : null,
    scopes: normalizeOauthScopes(oauth.scopes),
    resource: typeof oauth.resource === "string" && oauth.resource ? oauth.resource : null,
    authMethod: clientAuth.method,
    key: publicKeyFrom(clientAuth.key),
    pendingKey: publicKeyFrom(clientAuth.pendingKey),
  };
}

export function usesClientCredentials(connection: Pick<typeof toolConnections.$inferSelect, "config">): boolean {
  return clientCredentialsSettings(connection) !== null;
}

/** Prefer RS256 (the most widely accepted); use ES256 only when the server asks for it. */
export function chooseAssertionAlgorithm(supported: string[] | undefined): ClientAssertionAlgorithm {
  if (!supported?.length || supported.includes("RS256")) return "RS256";
  if (supported.includes("ES256")) return "ES256";
  return "RS256";
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** RFC 7638 JWK thumbprint, used as the key ID so it is stable and verifiable. */
export function jwkThumbprint(jwk: JsonWebKey): string {
  const canonical = jwk.kty === "EC"
    ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
    : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return base64Url(createHash("sha256").update(JSON.stringify(canonical)).digest());
}

export function publicKeyForPrivateKey(privateKeyPem: string, algorithm: ClientAssertionAlgorithm, createdAt: Date): ClientPublicKey {
  const publicKey = createPublicKey(privateKeyPem);
  const exported = publicKey.export({ format: "jwk" });
  const keyId = jwkThumbprint(exported);
  return {
    keyId,
    algorithm,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    publicJwk: { ...exported, kid: keyId, alg: algorithm, use: "sig" },
    createdAt: createdAt.toISOString(),
  };
}

function generatePrivateKey(algorithm: ClientAssertionAlgorithm): Promise<KeyObject> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, _publicKey: KeyObject, privateKey: KeyObject) =>
      error ? reject(error) : resolve(privateKey);
    if (algorithm === "ES256") generateKeyPair("ec", { namedCurve: "P-256" }, done);
    else generateKeyPair("rsa", { modulusLength: 2048 }, done);
  });
}

/**
 * A fresh signing key. The private half goes straight to the vault; only the
 * public half is kept in config. Generated off the event loop: RSA key
 * generation takes long enough to stall unrelated requests if done inline.
 */
export async function generateClientKeyPair(algorithm: ClientAssertionAlgorithm, now = new Date()): Promise<{
  privateKeyPem: string;
  publicKey: ClientPublicKey;
}> {
  const privateKey = await generatePrivateKey(algorithm);
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKeyPem, publicKey: publicKeyForPrivateKey(privateKeyPem, algorithm, now) };
}

/** Assertions are single-use and short-lived: a captured one is useless a minute later. */
export const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

/**
 * RFC 7523 §3 client assertion: `iss` = `sub` = client ID, `aud` = the token
 * endpoint it is presented to, a short `exp`, and a unique `jti`.
 */
export function signClientAssertion(input: {
  privateKeyPem: string;
  algorithm: ClientAssertionAlgorithm;
  keyId: string;
  clientId: string;
  audience: string;
  now?: Date;
}): string {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = { alg: input.algorithm, typ: "JWT", kid: input.keyId };
  const claims = {
    iss: input.clientId,
    sub: input.clientId,
    aud: input.audience,
    iat: issuedAt,
    exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
    jti: randomUUID(),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    input.algorithm === "ES256"
      ? { key: input.privateKeyPem, dsaEncoding: "ieee-p1363" }
      : input.privateKeyPem,
  );
  return `${signingInput}.${base64Url(signature)}`;
}

/** Secret authentication method the server accepts, preferring Basic as the spec requires servers to support it. */
export function chooseSecretAuthMethod(supported: string[] | undefined): "client_secret_basic" | "client_secret_post" {
  if (!supported?.length || supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}
