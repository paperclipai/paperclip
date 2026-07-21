import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConnectProtocolError,
  createRelaySignature,
  handshakeRequestSchema,
  relayEnvelopeSchema,
  signRequestEnvelope,
  verifyRelaySignature,
  verifyProviderWebhook,
  verifyRequestEnvelope,
  type ReplayStore,
} from "./index.js";

function replayStore(): ReplayStore {
  const seen = new Set<string>();
  return {
    consume(instanceId, jti) {
      const key = `${instanceId}:${jti}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

describe("connect protocol", () => {
  it("requires a wrapping key for transient-custody handshakes", () => {
    const result = handshakeRequestSchema.safeParse({
      providerSlug: "vercel",
      methodKey: "oauth",
      custodyMode: "B2",
      clientOwnership: "platform_shared",
      connectionRef: "6d80eb21-e24e-4c5c-8bd8-3f94eb7fb6b7",
      returnUrl: "https://instance.example/connections/claim",
      scopes: [],
    });
    expect(result.success).toBe(false);
  });

  it("validates byte-preserving relay envelopes", () => {
    expect(relayEnvelopeSchema.parse({
      v: 1,
      deliveryId: "dl_01K0EXAMPLE",
      connectionPublicRef: "cn_01K0EXAMPLE",
      providerSlug: "vercel",
      receivedAt: "2026-07-21T18:04:05.000Z",
      attempt: 1,
      provider: { headers: { "x-vercel-signature": "abc" }, bodyB64: "eyJvayI6dHJ1ZX0=" },
      verification: { profile: "vercel@1", result: "verified", keyId: "primary" },
    }).provider.bodyB64).toBe("eyJvayI6dHJ1ZX0=");
  });

  it("rejects a forged relay envelope signature", () => {
    const body = Buffer.from('{"deliveryId":"dl_1"}');
    const relaySecret = randomBytes(32);
    const signature = createRelaySignature({ body, relaySecret });
    const forgedBody = Buffer.from('{"deliveryId":"dl_2"}');
    expect(verifyRelaySignature({
      body: forgedBody,
      relaySecret,
      signature,
      timestamp: "1784656800",
      now: new Date("2026-07-21T18:00:00.000Z"),
    })).toBe(false);
  });

  it("rejects stale relay signatures", () => {
    const body = Buffer.from("payload");
    const relaySecret = randomBytes(32);
    expect(verifyRelaySignature({
      body,
      relaySecret,
      signature: createRelaySignature({ body, relaySecret }),
      timestamp: "1784656200",
      now: new Date("2026-07-21T18:00:00.000Z"),
    })).toBe(false);
  });

  it("verifies the pinned webhook profile", () => {
    const rawBody = Buffer.from('{"type":"deployment.created"}');
    const secret = "vercel-webhook-secret";
    const signature = createRelaySignature({ body: rawBody, relaySecret: Buffer.from(secret) }).slice(3);
    expect(verifyProviderWebhook({
      profile: { profile: "vercel@1", scheme: "hmac-sha256", signatureHeader: "x-vercel-signature", encoding: "hex", prefix: "" },
      rawBody,
      headers: { "X-Vercel-Signature": signature },
      secret,
    })).toBe("verified");
  });

  it("rejects webhook signature downgrade attempts", () => {
    const rawBody = Buffer.from("payload");
    const secret = "secret";
    const sha1 = createHmac("sha1", secret).update(rawBody).digest("hex");
    const profile = { profile: "provider@1", scheme: "hmac-sha256" as const, signatureHeader: "x-signature", encoding: "hex" as const, prefix: "" };
    expect(verifyProviderWebhook({ profile, rawBody, headers: {}, secret })).toBe("rejected");
    expect(verifyProviderWebhook({ profile, rawBody, headers: { "x-signature": sha1, "x-paperclip-verifier-profile": "none" }, secret })).toBe("rejected");
  });

  it("verifies an EdDSA request once and rejects its replay", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const store = replayStore();
    const compactJws = signRequestEnvelope({
      body: { claimCode: "claim-code-with-enough-entropy" },
      instanceId: "in_devinstance",
      keyId: "key_1",
      privateKey,
      path: "/v1/claims",
      now: new Date("2026-07-21T18:00:00.000Z"),
      jti: "nonce-with-at-least-128-bits",
    });

    const input = {
      compactJws,
      publicKey,
      expectedInstanceId: "in_devinstance",
      expectedPath: "/v1/claims",
      replayStore: store,
      now: new Date("2026-07-21T18:00:01.000Z"),
    };
    await expect(verifyRequestEnvelope(input)).resolves.toMatchObject({ body: { claimCode: "claim-code-with-enough-entropy" } });
    await expect(verifyRequestEnvelope(input)).rejects.toMatchObject({ code: "replayed_jti", status: 401 });
  });

  it("rejects a valid signature bound to the wrong path", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const compactJws = signRequestEnvelope({
      body: {},
      instanceId: "in_devinstance",
      keyId: "key_1",
      privateKey,
      path: "/v1/claims",
      now: new Date("2026-07-21T18:00:00.000Z"),
    });
    await expect(verifyRequestEnvelope({
      compactJws,
      publicKey,
      expectedInstanceId: "in_devinstance",
      expectedPath: "/v1/handshakes",
      replayStore: replayStore(),
      now: new Date("2026-07-21T18:00:01.000Z"),
    })).rejects.toEqual(new ConnectProtocolError("invalid_envelope", 401));
  });
});
