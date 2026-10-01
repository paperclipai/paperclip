import { createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Sealed GitHub broker exchange, used when the launcher can only reach the
 * broker through a proxy it did not choose (e.g. an agent sandbox's HTTP proxy,
 * which the agent environment can override).
 *
 * The runtime capability is `header.claims.signature` (HS256). The launcher
 * never sends the signature, the bearer, or any API key. It sends the unsigned
 * token, proves possession of the signature with an HMAC over a fresh
 * transcript that binds an ephemeral X25519 key, and the broker returns the
 * credentials encrypted with AES-256-GCM under a key derived from X25519 and
 * the signature. A proxy (or anything listening where the proxy points) sees
 * no reusable secret, cannot read the response, and cannot forge one.
 *
 * The launcher side lives in `githubLauncherSource()` and must stay in sync.
 */
export const GITHUB_BROKER_SEALED_HEADER = "x-paperclip-github-sealed";
export const GITHUB_BROKER_SEALED_VERSION = 1;
const LABEL = "paperclip-github-sealed-v1";
const MAX_SKEW_MS = 120_000;

export type OpenedGitHubBrokerRequest = {
  /** `header.claims.signature`, recomputed by the broker. Verify its claims before use. */
  token: string;
  signature: string;
  clientKey: string;
  transcript: string;
};

export function githubBrokerSealedTranscript(input: { path: string; token: string; ts: number; nonce: string; key: string }) {
  return [LABEL, "POST", input.path, input.token, String(input.ts), input.nonce, input.key].join("\n");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a sealed request header. `signatureFor` recomputes the capability
 * signature for an unsigned token (or returns null). Returns null on any
 * malformed, stale, or unauthenticated request.
 */
export function openSealedGitHubBrokerRequest(
  header: unknown,
  path: string,
  signatureFor: (unsignedToken: string) => string | null,
  now = Date.now(),
): OpenedGitHubBrokerRequest | null {
  if (typeof header !== "string" || header.length > 8192) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const { v, token, ts, nonce, key, proof } = parsed ?? {};
  if (v !== GITHUB_BROKER_SEALED_VERSION || typeof token !== "string" || typeof ts !== "number" ||
    typeof nonce !== "string" || typeof key !== "string" || typeof proof !== "string") return null;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return null;
  if (token.split(".").length !== 2 || Buffer.from(nonce, "base64url").length < 16) return null;
  try {
    const clientKey = createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" });
    if (clientKey.asymmetricKeyType !== "x25519") return null;
  } catch {
    return null;
  }
  const signature = signatureFor(token);
  if (!signature) return null;
  const transcript = githubBrokerSealedTranscript({ path, token, ts, nonce, key });
  const expected = createHmac("sha256", signature).update(transcript).digest("base64url");
  if (!safeEqual(proof, expected)) return null;
  return { token: `${token}.${signature}`, signature, clientKey: key, transcript };
}

/** Encrypt a JSON body to the launcher that sent `opened`. */
export function sealGitHubBrokerResponse(opened: OpenedGitHubBrokerRequest, body: unknown) {
  const pair = generateKeyPairSync("x25519");
  const serverKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const shared = diffieHellman({
    privateKey: pair.privateKey,
    publicKey: createPublicKey({ key: Buffer.from(opened.clientKey, "base64url"), format: "der", type: "spki" }),
  });
  const aad = `${opened.transcript}\n${serverKey}`;
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(opened.signature), Buffer.from(aad), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return {
    v: GITHUB_BROKER_SEALED_VERSION,
    key: serverKey,
    iv: iv.toString("base64url"),
    data: data.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}
