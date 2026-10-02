import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalPubsubJson, PUBSUB_ENVELOPE_WRAPPER_NODES, PUBSUB_MAX_PAYLOAD_BYTES, PUBSUB_NODE_LIMIT,
  PUBSUB_TIMESTAMP_WINDOW_MS, pubsubEnvelopeSchema, pubsubPayloadSchema, pubsubPublishSchema,
  pubsubTopicBindsEndpoints, pubsubTopicMatches, pubsubTopicPatternSchema, pubsubTopicSchema,
  type PubsubUnsignedEnvelope,
} from "@paperclipai/shared";
import { normalizePubsubPublicKey, pubsubDeliveryUrl, pubsubMessageDigest, signPubsubEnvelope, verifyPubsubEnvelope } from "../services/pubsub-crypto.js";

const alice = generateKeyPairSync("ed25519");
const bob = generateKeyPairSync("ed25519");
const alicePublic = alice.publicKey.export({ format: "pem", type: "spki" }).toString();
const bobPublic = bob.publicKey.export({ format: "pem", type: "spki" }).toString();
const timestamp = "2026-09-30T12:00:00.000Z";
const now = Date.parse(timestamp);
function envelope(overrides: Partial<PubsubUnsignedEnvelope> = {}): PubsubUnsignedEnvelope {
  return {
    version: 1, id: randomUUID(), from_instance: randomUUID(), from_company: randomUUID(),
    from_agent: null, from_role: "board", to_instance: randomUUID(), to_company: randomUUID(),
    to_topic: "fleet.chat.workload", payload: { instruction: "coordinate", labels: ["alpha", "beta"] },
    timestamp, nonce: randomUUID(), ...overrides,
  };
}

describe("PubSub Ed25519 protocol", () => {
  it("verifies a signed envelope across JSON wire roundtrips and reordered payload keys", () => {
    const unsigned = envelope({ payload: { z: 1, nested: { b: [false, null, "é"], a: 2 } } });
    const signed = signPubsubEnvelope(unsigned, alice.privateKey);
    const wire = JSON.parse(JSON.stringify(signed));
    wire.payload = { nested: { a: 2, b: [false, null, "é"] }, z: 1 };
    expect(verifyPubsubEnvelope(wire, alicePublic, now)).toEqual(wire);
    expect(signPubsubEnvelope({ ...unsigned, payload: wire.payload }, alice.privateKey).signature).toBe(signed.signature);
    expect(() => verifyPubsubEnvelope(wire, bobPublic, now)).toThrow("signature");
  });

  it.each([
    ["id", randomUUID()], ["from_instance", randomUUID()], ["from_company", randomUUID()],
    ["to_instance", randomUUID()], ["to_company", randomUUID()], ["to_topic", "fleet.task.created"],
    ["payload", { instruction: "stolen" }], ["timestamp", "2026-09-30T12:00:01.000Z"],
    ["nonce", randomUUID()], ["from_role", "system"],
  ])("authenticates the %s field", (field, value) => {
    const signed = signPubsubEnvelope(envelope(), alice.privateKey);
    expect(() => verifyPubsubEnvelope({ ...signed, [field]: value }, alicePublic, now)).toThrow("signature");
  });

  it("authenticates CEO identity and rejects role/agent shape spoofing", () => {
    const signed = signPubsubEnvelope(envelope({ from_role: "ceo", from_agent: randomUUID() }), alice.privateKey);
    expect(() => verifyPubsubEnvelope({ ...signed, from_agent: randomUUID() }, alicePublic, now)).toThrow("signature");
    expect(pubsubEnvelopeSchema.safeParse({ ...signed, from_agent: null }).success).toBe(false);
    expect(pubsubEnvelopeSchema.safeParse({ ...signed, from_role: "employee" }).success).toBe(false);
    expect(pubsubEnvelopeSchema.safeParse({ ...signed, from_role: "board" }).success).toBe(false);
    expect(pubsubPublishSchema.safeParse({ topic: signed.to_topic, payload: null, role: "ceo" }).success).toBe(false);
  });

  it.each([-1, 1])("enforces both timestamp window boundaries (%s)", (direction) => {
    const signed = signPubsubEnvelope(envelope(), alice.privateKey);
    expect(verifyPubsubEnvelope(signed, alicePublic, now + direction * PUBSUB_TIMESTAMP_WINDOW_MS).id).toBe(signed.id);
    expect(() => verifyPubsubEnvelope(signed, alicePublic, now + direction * (PUBSUB_TIMESTAMP_WINDOW_MS + 1))).toThrow("five-minute");
  });

  it("rejects noncanonical timestamps, malformed signatures and unsigned extension fields", () => {
    const signed = signPubsubEnvelope(envelope(), alice.privateKey);
    for (const invalid of ["not-a-date", "2026-09-30T12:00:00Z", "2026-09-30T12:00:00.000+00:00"]) {
      expect(pubsubEnvelopeSchema.safeParse({ ...signed, timestamp: invalid }).success).toBe(false);
    }
    expect(() => verifyPubsubEnvelope({ ...signed, signature: signed.signature + "==" }, alicePublic, now)).toThrow("envelope");
    expect(() => verifyPubsubEnvelope({ ...signed, signature: "A".repeat(86) }, alicePublic, now)).toThrow("signature");
    expect(() => verifyPubsubEnvelope({ ...signed, allow: true }, alicePublic, now)).toThrow("envelope");
    expect(() => verifyPubsubEnvelope({ ...signed, version: 2 }, alicePublic, now)).toThrow("envelope");
  });

  it("keeps retry identity stable but detects changed content and routing", () => {
    const unsigned = envelope();
    const original = signPubsubEnvelope(unsigned, alice.privateKey);
    const retry = signPubsubEnvelope({ ...unsigned, nonce: randomUUID(), timestamp: "2026-09-30T12:00:02.000Z" }, alice.privateKey);
    expect(pubsubMessageDigest(retry)).toBe(pubsubMessageDigest(original));
    for (const changed of [
      { ...retry, payload: "different" }, { ...retry, to_company: randomUUID() },
      { ...retry, from_company: randomUUID() }, { ...retry, to_topic: "fleet.chat.other" },
      { ...retry, from_role: "system" as const },
    ]) expect(pubsubMessageDigest(changed)).not.toBe(pubsubMessageDigest(original));
  });

  it("binds P2P topics to exactly the signed endpoints in either order", () => {
    const unsigned = envelope({ from_role: "ceo", from_agent: randomUUID() });
    unsigned.to_topic = `fleet.p2p.${unsigned.from_instance}.${unsigned.to_instance}`;
    const signed = signPubsubEnvelope(unsigned, alice.privateKey);
    expect(verifyPubsubEnvelope(signed, alicePublic, now).to_topic).toBe(unsigned.to_topic);
    expect(pubsubTopicBindsEndpoints(signed.to_topic, unsigned.to_instance, unsigned.from_instance)).toBe(true);
    expect(pubsubTopicBindsEndpoints(signed.to_topic, unsigned.from_instance, randomUUID())).toBe(false);
    expect(() => signPubsubEnvelope({ ...unsigned, to_instance: randomUUID() }, alice.privateKey)).toThrow("P2P");
    expect(() => verifyPubsubEnvelope({ ...signed, to_instance: randomUUID() }, alicePublic, now)).toThrow("P2P");
  });

  it("rejects non-Ed25519 trust and accidental private-key registration", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => normalizePubsubPublicKey(rsa.publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow("Ed25519");
    expect(() => normalizePubsubPublicKey(alice.privateKey.export({ format: "pem", type: "pkcs8" }).toString())).toThrow("Ed25519");
    expect(() => signPubsubEnvelope(envelope(), rsa.privateKey)).toThrow("Ed25519");
  });
});

describe("PubSub bounded JSON and topic grants", () => {
  it("measures serialized UTF-8 bytes, including JSON string quoting", () => {
    expect(pubsubPayloadSchema.safeParse("a".repeat(PUBSUB_MAX_PAYLOAD_BYTES - 2)).success).toBe(true);
    expect(pubsubPayloadSchema.safeParse("a".repeat(PUBSUB_MAX_PAYLOAD_BYTES - 1)).success).toBe(false);
    expect(pubsubPayloadSchema.safeParse("é".repeat(PUBSUB_MAX_PAYLOAD_BYTES / 2)).success).toBe(false);
    expect(pubsubPayloadSchema.safeParse(null).success).toBe(true);
  });

  it("rejects coercible values, cycles, sparse arrays and excessive nesting", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = null;
    for (let count = 0; count < 34; count++) deep = [deep];
    for (const invalid of [undefined, NaN, Infinity, 1n, new Date(), [undefined], { x: undefined }, new Array(2), cyclic, deep]) {
      expect(pubsubPayloadSchema.safeParse(invalid).success).toBe(false);
    }
    expect(canonicalPubsubJson({ z: [2, 1], a: { b: false, a: null } })).toBe('{"a":{"a":null,"b":false},"z":[2,1]}');
  });

  it("reserves the signed-envelope wrapper so near-limit payloads still publish, sign and digest", () => {
    // The unsigned envelope canonicalizes as one root plus eleven scalar fields
    // around the payload: a payload sized to the reserved budget must keep the
    // full envelope within the hard limit for signing and digest construction.
    const nearLimit = Array.from({ length: PUBSUB_NODE_LIMIT - PUBSUB_ENVELOPE_WRAPPER_NODES - 1 }, () => null);
    expect(pubsubPublishSchema.safeParse({ topic: "fleet.chat.workload", payload: nearLimit }).success).toBe(true);
    const signed = signPubsubEnvelope(envelope({ payload: nearLimit }), alice.privateKey);
    expect(verifyPubsubEnvelope(signed, alicePublic, now)).toEqual(signed);
    expect(pubsubMessageDigest(signed)).toMatch(/^[0-9a-f]{64}$/);
    // One node more exceeds the reserved budget: reject at publish, not at signing.
    const overLimit = Array.from({ length: PUBSUB_NODE_LIMIT - PUBSUB_ENVELOPE_WRAPPER_NODES }, () => null);
    expect(pubsubPublishSchema.safeParse({ topic: "fleet.chat.workload", payload: overLimit }).success).toBe(false);
  });

  it("rejects depth-32 payloads at publish with the complexity error", () => {
    let deep: unknown = null;
    for (let count = 0; count < 32; count++) deep = [deep]; // payload leaf at depth 32
    const result = pubsubPublishSchema.safeParse({ topic: "fleet.chat.workload", payload: deep });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain("PubSub JSON is too complex");
    // Depth 31 stays publishable: the envelope adds exactly one more level.
    let shallow: unknown = null;
    for (let count = 0; count < 31; count++) shallow = [shallow];
    expect(pubsubPublishSchema.safeParse({ topic: "fleet.chat.workload", payload: shallow }).success).toBe(true);
  });

  it("limits wildcard grants to fleet namespaces and segment boundaries", () => {
    expect(pubsubTopicMatches("fleet.chat.*", "fleet.chat.example")).toBe(true);
    expect(pubsubTopicMatches("fleet.chat.*", "fleet.task.example")).toBe(false);
    expect(pubsubTopicMatches("fleet.chat.example", "fleet.chat.examples")).toBe(false);
    for (const invalid of ["*", "fleet.*", "fleet.chat.ex*", "fleet.chat.*.x", "fleet.chat.", "fleet.chat." + "a".repeat(65)]) {
      expect(pubsubTopicPatternSchema.safeParse(invalid).success).toBe(false);
    }
    expect(pubsubTopicPatternSchema.safeParse("fleet.chat.*").success).toBe(true);
    expect(pubsubTopicSchema.safeParse("fleet.chat.*").success).toBe(false);
  });
});

describe("PubSub peer endpoints", () => {
  it.each([
    ["https://peer.example", "https://peer.example/api/pubsub/deliver"],
    ["http://127.0.0.1:3100", "http://127.0.0.1:3100/api/pubsub/deliver"],
    ["http://[::1]:3100", "http://[::1]:3100/api/pubsub/deliver"],
    ["http://localhost:3100/api/pubsub/deliver", "http://127.0.0.1:3100/api/pubsub/deliver"],
  ])("accepts explicit secure endpoint %s", (input, expected) => {
    expect(pubsubDeliveryUrl(input)).toBe(expected);
  });

  it.each([
    "http://peer.example", "http://192.168.1.1", "http://127.0.0.1.evil.example",
    "https://user:secret@peer.example", "https://peer.example?token=secret", "https://peer.example#fragment",
    "https://peer.example/redirect", "file:///etc/passwd", "ftp://127.0.0.1/", "not-a-url",
  ])("rejects unsafe endpoint %s", (input) => {
    expect(() => pubsubDeliveryUrl(input)).toThrow();
  });
});
