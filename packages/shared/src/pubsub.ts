import { z } from "zod";

export const PUBSUB_MAX_PAYLOAD_BYTES = 64 * 1024;
export const PUBSUB_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const PUBSUB_VISIBILITY_TIMEOUT_MS = 30 * 1000;
/**
 * Ingress admission policy: bounds what a trusted peer can durably enqueue.
 * Quotas are checked before the nonce/message insert, so an over-quota
 * envelope consumes neither replay state nor storage; the peer's outbox
 * redelivers it once the window drains.
 */
export const PUBSUB_RATE_WINDOW_MS = 60_000;
export const PUBSUB_PEER_MAX_RATE_MESSAGES = 30;
export const PUBSUB_MAX_PENDING_INBOX = 200;
export const PUBSUB_MAX_PENDING_INBOX_BYTES = 4 * 1024 * 1024;
export const PUBSUB_MAX_PENDING_WAKES = 8;
/** Company-wide PubSub wake cooldown: after a PubSub wake settles, the next one for the same company waits this long, bounding sustained CEO execution to one run per window per company. */
export const PUBSUB_WAKE_COOLDOWN_MS = 60_000;
/** Stale window for live PubSub wake receipts: a live row (queued/claimed/coalesced/running) whose owner crashed mid-flight can stay non-terminal (its run may sit behind the 60s legacy controller lease before the orphan reaper settles it). After this window the receipt no longer holds the company wake slot; the run queue still serializes any wake admitted past an in-flight run. Same 60s convention as LEGACY_CONTROLLER_LEASE_MS. */
export const PUBSUB_WAKE_STALE_MS = 60_000;
/** Egress delivery budget: an outbox row that has failed this many consecutive times stops retrying and is cancelled with a visible lastError, so a permanently non-deliverable message (e.g., a peer that never granted the topic, 403) cannot retry unboundedly. The message remains in the sender's history. Generous enough for legitimate peer-outage / crash redelivery (W1 acceptance: peer offline -> restart -> redelivered) while bounding sustained failure. */
export const PUBSUB_DELIVERY_MAX_ATTEMPTS = 40;
/** Bounded retention: nonces older than this, and acked inbound history older than this, are swept. */
export const PUBSUB_NONCE_RETENTION_MS = 7 * 24 * 3_600_000;
export const PUBSUB_INBOUND_RETENTION_MS = 30 * 24 * 3_600_000;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const pubsubIdSchema = z.string().uuid().regex(new RegExp(`^${uuidPattern}$`));
const topicPattern = new RegExp(`^fleet\\.(?:(?:chat|task)\\.[a-zA-Z0-9_-]{1,64}|p2p\\.${uuidPattern}\\.${uuidPattern})$`);
export const pubsubTopicSchema = z.string().max(160).regex(topicPattern, "Invalid fleet topic");
export const pubsubTopicPatternSchema = z.string().max(160).refine(
  (value) => topicPattern.test(value) || /^fleet\.(chat|task|p2p)\.\*$/.test(value)
    || new RegExp(`^fleet\\.p2p\\.${uuidPattern}\\.\\*$`).test(value),
  "Use an exact fleet topic or a trailing segment wildcard",
);

export const PUBSUB_NODE_LIMIT = 10000;
export const PUBSUB_DEPTH_LIMIT = 32;
/** A signed envelope canonicalizes as one root object holding twelve fixed fields plus the payload. */
export const PUBSUB_ENVELOPE_WRAPPER_NODES = 12;

/** Canonical JSON: UTF-16 sorted object keys, JSON primitive spelling, no coercions. */
export function canonicalPubsubJson(value: unknown, limits: { nodeLimit?: number; depthLimit?: number } = {}): string {
  const nodeLimit = limits.nodeLimit ?? PUBSUB_NODE_LIMIT;
  const depthLimit = limits.depthLimit ?? PUBSUB_DEPTH_LIMIT;
  let nodes = 0;
  function encode(current: unknown, depth: number): string {
    if (++nodes > nodeLimit || depth > depthLimit) throw new Error("PubSub JSON is too complex");
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number" && Number.isFinite(current)) return JSON.stringify(current);
    if (Array.isArray(current)) {
      const values: string[] = [];
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) throw new Error("PubSub JSON cannot contain sparse arrays");
        values.push(encode(current[index], depth + 1));
      }
      return `[${values.join(",")}]`;
    }
    if (typeof current === "object" && current !== null
      && (Object.getPrototypeOf(current) === Object.prototype || Object.getPrototypeOf(current) === null)) {
      if (Object.getOwnPropertySymbols(current).length) throw new Error("PubSub JSON cannot contain symbol keys");
      return `{${Object.keys(current).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!Object.hasOwn(descriptor, "value")) throw new Error("PubSub JSON cannot contain accessors");
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    throw new Error("PubSub payload must be finite JSON data");
  }
  return encode(value, 0);
}

export const pubsubPayloadSchema = z.unknown().superRefine((value, context) => {
  try {
    // The payload is always re-canonicalized inside a fixed wrapper before it
    // is signed, digested, or stored (the unsigned envelope adds the most), so
    // reserve that wrapper overhead up front. Otherwise a payload that passes
    // validation alone would exceed the limits once the envelope fields are
    // added, and its committed outbox row would retry signing forever.
    const json = canonicalPubsubJson(value, {
      nodeLimit: PUBSUB_NODE_LIMIT - PUBSUB_ENVELOPE_WRAPPER_NODES,
      depthLimit: PUBSUB_DEPTH_LIMIT - 1,
    });
    if (new TextEncoder().encode(json).byteLength > PUBSUB_MAX_PAYLOAD_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "PubSub payload exceeds 64 KiB" });
    }
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid JSON" });
  }
});
export const pubsubRoleSchema = z.enum(["ceo", "board", "system"]);
export const pubsubEnvelopeSchema = z.object({
  version: z.literal(1),
  id: pubsubIdSchema,
  from_instance: pubsubIdSchema,
  from_company: pubsubIdSchema,
  from_agent: pubsubIdSchema.nullable(),
  from_role: pubsubRoleSchema,
  to_instance: pubsubIdSchema,
  to_company: pubsubIdSchema,
  to_topic: pubsubTopicSchema,
  payload: pubsubPayloadSchema,
  timestamp: z.string().datetime().refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Use canonical UTC milliseconds"),
  nonce: pubsubIdSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "Invalid Ed25519 signature encoding"),
}).strict().refine((value) => value.from_role === "ceo" ? value.from_agent !== null : value.from_agent === null,
  "Only CEO envelopes carry an agent identity");
export type PubsubEnvelope = z.infer<typeof pubsubEnvelopeSchema>;
export type PubsubUnsignedEnvelope = Omit<PubsubEnvelope, "signature">;
export interface PubsubIdentity { instanceId: string; publicKey: string }
export interface PubsubItem {
  id: string;
  topic: string;
  payload: unknown;
  fromInstance: string;
  fromCompany: string;
  fromAgent: string | null;
  fromRole: "ceo" | "board" | "system";
  createdAt: string;
  ackedAt: string | null;
  deliveryCount: number;
}
export interface PubsubPage { items: PubsubItem[]; nextCursor: string | null }
export const pubsubPublishSchema = z.object({ topic: pubsubTopicSchema, payload: pubsubPayloadSchema }).strict();
export const pubsubTrustSchema = z.object({
  peerInstanceId: pubsubIdSchema,
  peerCompanyId: pubsubIdSchema,
  publicKey: z.string().min(40).max(4096),
  url: z.string().url().max(2048),
  topics: z.array(pubsubTopicPatternSchema).min(1).max(64),
}).strict();
export const pubsubSubscribeSchema = z.object({ peerInstanceId: pubsubIdSchema, topic: pubsubTopicPatternSchema }).strict();
export const pubsubObserverSchema = z.object({ agentId: pubsubIdSchema }).strict();

export function pubsubTopicMatches(pattern: string, topic: string): boolean {
  return pattern.endsWith(".*") ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic;
}
export function pubsubTopicBindsEndpoints(topic: string, fromInstance: string, toInstance: string): boolean {
  if (!topic.startsWith("fleet.p2p.")) return true;
  const [, , first, second] = topic.split(".");
  return fromInstance !== toInstance && ((first === fromInstance && second === toInstance)
    || (first === toInstance && second === fromInstance));
}
