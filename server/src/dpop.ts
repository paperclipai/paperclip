/**
 * DPoP (Demonstration of Proof-of-Possession) verification module.
 * Implements RFC 9449 patterns adapted from strongdm/agentic-auth.
 *
 * Each agent has its own ES256 keypair. The public key is stored in the
 * agent registry. On every request, the agent sends a DPoP proof header
 * that cryptographically proves it holds the private key matching the
 * token's cnf.jkt (confirmation JWK thumbprint) claim.
 *
 * This prevents token theft: even if someone intercepts an access token,
 * they cannot use it without the agent's private key.
 */

import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

export interface DpopProofPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  ath?: string;
}

export interface JwkPublicKey {
  kty: string;
  crv: string;
  x: string;
  y: string;
  [key: string]: unknown;
}

export interface DpopVerifyResult {
  valid: boolean;
  jkt: string | null;
  error: string | null;
}

const DPOP_MAX_AGE_SECONDS = 300; // 5 minutes
const DPOP_HEADER_NAME = "dpop";

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/**
 * Compute JWK Thumbprint per RFC 7638.
 * For EC keys: canonical JSON of {crv, kty, x, y} then SHA-256.
 */
export function computeJwkThumbprint(jwk: JwkPublicKey): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return base64UrlEncode(createHash("sha256").update(canonical).digest());
}

/**
 * Convert a JWK public key to PEM format for Node.js crypto verification.
 */
function jwkToPem(jwk: JwkPublicKey): string {
  const keyObject = require("node:crypto").createPublicKey({
    key: {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    },
    format: "jwk",
  });
  return keyObject.export({ type: "spki", format: "pem" }) as string;
}

/**
 * Verify a DPoP proof header against the expected JWK thumbprint.
 *
 * @param dpopHeader - The raw DPoP header value from the request
 * @param httpMethod - The HTTP method of the request (e.g., "POST")
 * @param httpUri - The full request URI
 * @param expectedJkt - The expected JWK thumbprint from the access token's cnf.jkt claim
 * @param accessTokenHash - Optional SHA-256 hash of the access token (for ath claim)
 */
export function verifyDpopProof(
  dpopHeader: string,
  httpMethod: string,
  httpUri: string,
  expectedJkt: string | null,
  accessTokenHash?: string,
): DpopVerifyResult {
  const fail = (error: string): DpopVerifyResult => ({ valid: false, jkt: null, error });

  if (!dpopHeader) return fail("Missing DPoP header");

  // Parse the DPoP proof JWT (header.payload.signature)
  const parts = dpopHeader.split(".");
  if (parts.length !== 3) return fail("Invalid DPoP proof format");

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: DpopProofPayload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as DpopProofPayload;
  } catch {
    return fail("Failed to parse DPoP proof");
  }

  // Verify header
  if (header.typ !== "dpop+jwt") return fail("Invalid DPoP typ header");
  if (header.alg !== "ES256") return fail("Unsupported DPoP algorithm, expected ES256");
  if (!header.jwk || typeof header.jwk !== "object") return fail("Missing JWK in DPoP header");

  const jwk = header.jwk as JwkPublicKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return fail("Invalid JWK key type, expected EC P-256");

  // Compute thumbprint and compare to expected
  const jkt = computeJwkThumbprint(jwk);
  if (expectedJkt && jkt !== expectedJkt) return fail("JWK thumbprint mismatch");

  // Verify payload claims
  if (!payload.jti) return fail("Missing jti claim");
  if (payload.htm?.toUpperCase() !== httpMethod.toUpperCase()) return fail("HTTP method mismatch");
  if (payload.htu !== httpUri) return fail("HTTP URI mismatch");

  const now = Math.floor(Date.now() / 1000);
  if (!payload.iat || Math.abs(now - payload.iat) > DPOP_MAX_AGE_SECONDS) {
    return fail("DPoP proof expired or clock skew too large");
  }

  // Verify access token hash if provided
  if (accessTokenHash && payload.ath !== accessTokenHash) {
    return fail("Access token hash mismatch");
  }

  // Verify signature
  try {
    const pem = jwkToPem(jwk);
    const verifier = createVerify("SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    const signatureBuffer = base64UrlDecode(signatureB64);
    if (!verifier.verify(pem, signatureBuffer)) {
      return fail("Invalid DPoP signature");
    }
  } catch {
    return fail("DPoP signature verification failed");
  }

  return { valid: true, jkt, error: null };
}

/**
 * Generate a new ES256 keypair for an agent.
 * Returns the public key as JWK (stored in agent registry)
 * and the private key as JWK (given to the agent, never stored server-side).
 */
export function generateAgentKeypair(): {
  publicKeyJwk: JwkPublicKey;
  privateKeyJwk: Record<string, unknown>;
  jkt: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

  const publicKeyJwk = publicKey.export({ format: "jwk" }) as JwkPublicKey;
  const privateKeyJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  const jkt = computeJwkThumbprint(publicKeyJwk);

  return { publicKeyJwk, privateKeyJwk, jkt };
}

/**
 * Compute the SHA-256 hash of an access token for the DPoP ath claim.
 */
export function computeAccessTokenHash(accessToken: string): string {
  return base64UrlEncode(createHash("sha256").update(accessToken).digest());
}

/**
 * Extract the DPoP header from an Express request.
 */
export function extractDpopHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers[DPOP_HEADER_NAME] || headers["DPoP"];
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}
