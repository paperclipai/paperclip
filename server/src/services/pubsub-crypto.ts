import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  canonicalPubsubJson,
  PUBSUB_TIMESTAMP_WINDOW_MS,
  pubsubEnvelopeSchema,
  pubsubTopicBindsEndpoints,
  type PubsubEnvelope,
  type PubsubUnsignedEnvelope,
} from "@paperclipai/shared";
import { badRequest, unauthorized } from "../errors.js";

export function normalizePubsubPublicKey(pem: string): string {
  let key: KeyObject;
  try {
    // Trust accepts public SPKI only; never accidentally retain a private key in the database.
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)) throw new Error("Not SPKI");
    key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Not Ed25519");
  } catch {
    throw badRequest("PubSub requires an Ed25519 SPKI public key");
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function pubsubDeliveryUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw badRequest("Invalid PubSub peer URL"); }
  if (url.username || url.password || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "/api/pubsub/deliver")) {
    throw badRequest("PubSub peer URL must be an origin or its /api/pubsub/deliver endpoint without credentials, query, or fragment");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const loopback = /^127(?:\.(?:\d{1,3})){3}$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw badRequest("PubSub requires HTTPS except for loopback HTTP");
  }
  url.pathname = "/api/pubsub/deliver";
  return url.toString();
}

export function signPubsubEnvelope(envelope: PubsubUnsignedEnvelope, privateKey: string | KeyObject): PubsubEnvelope {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "private") throw badRequest("PubSub signing requires an Ed25519 private key");
  const signature = sign(null, Buffer.from(canonicalPubsubJson(envelope)), key).toString("base64url");
  const signed = pubsubEnvelopeSchema.parse({ ...envelope, signature });
  if (!pubsubTopicBindsEndpoints(signed.to_topic, signed.from_instance, signed.to_instance)) {
    throw badRequest("P2P topic must bind the signed sender and receiver");
  }
  return signed;
}

export function verifyPubsubEnvelope(input: unknown, publicKey: string, nowMs = Date.now()): PubsubEnvelope {
  const parsed = pubsubEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw badRequest("Invalid PubSub envelope", parsed.error.flatten());
  const envelope = parsed.data;
  if (Math.abs(nowMs - Date.parse(envelope.timestamp)) > PUBSUB_TIMESTAMP_WINDOW_MS) {
    throw unauthorized("PubSub timestamp is outside the five-minute window");
  }
  if (!pubsubTopicBindsEndpoints(envelope.to_topic, envelope.from_instance, envelope.to_instance)) {
    throw unauthorized("P2P topic does not bind the signed endpoints");
  }
  const { signature, ...unsigned } = envelope;
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature
    || !verify(null, Buffer.from(canonicalPubsubJson(unsigned)), normalizePubsubPublicKey(publicKey), bytes)) {
    throw unauthorized("Invalid PubSub signature");
  }
  return envelope;
}

/** Retry timestamp, nonce and signature are excluded; every routing and content field is retained. */
export function pubsubMessageDigest(envelope: PubsubEnvelope | PubsubUnsignedEnvelope): string {
  return createHash("sha256").update(canonicalPubsubJson({
    version: envelope.version,
    id: envelope.id,
    from_instance: envelope.from_instance,
    from_company: envelope.from_company,
    from_agent: envelope.from_agent,
    from_role: envelope.from_role,
    to_instance: envelope.to_instance,
    to_company: envelope.to_company,
    to_topic: envelope.to_topic,
    payload: envelope.payload,
  })).digest("hex");
}
