import {
  createHmac,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

export const CONNECT_SERVICE_AUDIENCE = "https://connect.paperclip.ing";
export const CONNECT_ENVELOPE_TOLERANCE_SECONDS = 300;
export const CONNECT_REPLAY_WINDOW_SECONDS = 600;
export const RELAY_SIGNATURE_TOLERANCE_SECONDS = 300;

const opaqueId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`));

export const custodyModeSchema = z.enum(["A", "B", "B2"]);
export const clientOwnershipSchema = z.enum(["platform_shared", "platform_provisioned", "customer"]);

export const handshakeRequestSchema = z.object({
  providerSlug: z.string().min(1),
  methodKey: z.string().min(1),
  custodyMode: custodyModeSchema,
  clientOwnership: clientOwnershipSchema,
  connectionRef: z.string().uuid(),
  grantWrapKey: z.string().min(1).optional(),
  returnUrl: z.string().url(),
  scopes: z.array(z.string().min(1)),
  byoClient: z.object({ clientId: z.string().min(1) }).optional(),
  migrationOf: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (value.custodyMode !== "A" && !value.grantWrapKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["grantWrapKey"],
      message: "grantWrapKey is required for custody modes B and B2",
    });
  }
  if (value.clientOwnership === "customer" && !value.byoClient) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["byoClient"],
      message: "byoClient is required for customer-owned clients",
    });
  }
});

export const handshakeResponseSchema = z.object({
  handshakeId: opaqueId("hs"),
  authorizeUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export const claimRequestSchema = z.object({ claimCode: z.string().min(22) });

export const tokenMetadataSchema = z.object({
  scopes: z.array(z.string()),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const claimResponseSchema = z.union([
  z.object({ custodyMode: z.literal("A"), grantRef: opaqueId("gr"), tokenMeta: tokenMetadataSchema }),
  z.object({ custodyMode: z.enum(["B", "B2"]), grantSealed: z.string().min(1), tokenMeta: tokenMetadataSchema }),
]);

export const relayEnvelopeSchema = z.object({
  v: z.literal(1),
  deliveryId: opaqueId("dl"),
  connectionPublicRef: opaqueId("cn"),
  providerSlug: z.string().min(1),
  receivedAt: z.string().datetime(),
  attempt: z.number().int().positive(),
  provider: z.object({
    headers: z.record(z.string(), z.string()),
    bodyB64: z.string(),
  }),
  verification: z.object({
    profile: z.string().min(1),
    result: z.enum(["verified", "unsigned"]),
    keyId: z.string().min(1).nullable().optional(),
  }),
});

export type RelayEnvelope = z.infer<typeof relayEnvelopeSchema>;

export const webhookVerifierProfileSchema = z.object({
  profile: z.string().min(1),
  scheme: z.enum(["hmac-sha256", "hmac-sha1", "static-token", "none"]),
  signatureHeader: z.string().min(1).transform((value) => value.toLowerCase()),
  encoding: z.enum(["hex", "base64"]).default("hex"),
  prefix: z.string().default(""),
});

export type WebhookVerifierProfile = z.infer<typeof webhookVerifierProfileSchema>;

function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function verifyProviderWebhook(input: {
  profile: WebhookVerifierProfile;
  rawBody: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  secret?: Uint8Array | string;
}): "verified" | "unsigned" | "rejected" {
  const profile = webhookVerifierProfileSchema.parse(input.profile);
  if (profile.scheme === "none") return "unsigned";
  if (input.secret === undefined) return "rejected";

  const headers = new Map(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const headerValue = headers.get(profile.signatureHeader);
  const actual = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!actual) return "rejected";

  if (profile.scheme === "static-token") {
    const expected = typeof input.secret === "string" ? input.secret : Buffer.from(input.secret).toString("utf8");
    return constantTimeEqual(`${profile.prefix}${expected}`, actual) ? "verified" : "rejected";
  }

  const algorithm = profile.scheme === "hmac-sha256" ? "sha256" : "sha1";
  const digest = createHmac(algorithm, input.secret).update(input.rawBody).digest(profile.encoding);
  return constantTimeEqual(`${profile.prefix}${digest}`, actual) ? "verified" : "rejected";
}

export const requestEnvelopePayloadSchema = z.object({
  iss: opaqueId("in"),
  aud: z.literal(CONNECT_SERVICE_AUDIENCE),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(22),
  htm: z.literal("POST"),
  htu: z.string().startsWith("/v1/"),
  body: z.unknown(),
});

export type RequestEnvelopePayload = z.infer<typeof requestEnvelopePayloadSchema>;

export type ReplayStore = {
  consume(instanceId: string, jti: string, expiresAt: number): boolean | Promise<boolean>;
};

export type EnvelopeVerificationErrorCode =
  | "invalid_envelope"
  | "replayed_jti"
  | "instance_revoked";

export class ConnectProtocolError extends Error {
  constructor(
    readonly code: EnvelopeVerificationErrorCode,
    readonly status: 401 | 403,
  ) {
    super(code);
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function newJti(): string {
  return randomBytes(16).toString("base64url");
}

export function signRequestEnvelope(input: {
  body: unknown;
  instanceId: string;
  keyId: string;
  privateKey: KeyObject;
  path: string;
  now?: Date;
  jti?: string;
}): string {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = encodeJson({ alg: "EdDSA", kid: input.keyId, typ: "paperclip-connect-req+jws" });
  const payload = encodeJson({
    iss: input.instanceId,
    aud: CONNECT_SERVICE_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + CONNECT_ENVELOPE_TOLERANCE_SECONDS,
    jti: input.jti ?? newJti(),
    htm: "POST",
    htu: input.path,
    body: input.body,
  });
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature = signBytes(null, signingInput, input.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export async function verifyRequestEnvelope(input: {
  compactJws: string;
  publicKey: KeyObject;
  expectedInstanceId: string;
  expectedPath: string;
  replayStore: ReplayStore;
  revoked?: boolean;
  now?: Date;
}): Promise<RequestEnvelopePayload> {
  const segments = input.compactJws.split(".");
  if (segments.length !== 3) throw new ConnectProtocolError("invalid_envelope", 401);
  const [protectedHeader, payloadSegment, signatureSegment] = segments;

  try {
    const header = z.object({
      alg: z.literal("EdDSA"),
      kid: z.string().min(1),
      typ: z.literal("paperclip-connect-req+jws"),
    }).parse(decodeJson(protectedHeader));
    void header;
    const signature = Buffer.from(signatureSegment, "base64url");
    const valid = verifyBytes(
      null,
      Buffer.from(`${protectedHeader}.${payloadSegment}`, "ascii"),
      input.publicKey,
      signature,
    );
    if (!valid) throw new ConnectProtocolError("invalid_envelope", 401);
    if (input.revoked) throw new ConnectProtocolError("instance_revoked", 403);

    const payload = requestEnvelopePayloadSchema.parse(decodeJson(payloadSegment));
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      payload.iss !== input.expectedInstanceId ||
      payload.htm !== "POST" ||
      payload.htu !== input.expectedPath ||
      Math.abs(now - payload.iat) > CONNECT_ENVELOPE_TOLERANCE_SECONDS ||
      payload.exp < now ||
      payload.exp > payload.iat + CONNECT_ENVELOPE_TOLERANCE_SECONDS
    ) {
      throw new ConnectProtocolError("invalid_envelope", 401);
    }
    const consumed = await input.replayStore.consume(payload.iss, payload.jti, payload.iat + CONNECT_REPLAY_WINDOW_SECONDS);
    if (!consumed) throw new ConnectProtocolError("replayed_jti", 401);
    return payload;
  } catch (error) {
    if (error instanceof ConnectProtocolError) throw error;
    throw new ConnectProtocolError("invalid_envelope", 401);
  }
}

export function createRelaySignature(input: {
  body: Uint8Array;
  relaySecret: Uint8Array;
}): string {
  return `v1=${createHmac("sha256", input.relaySecret).update(input.body).digest("hex")}`;
}

export function verifyRelaySignature(input: {
  body: Uint8Array;
  relaySecret: Uint8Array;
  signature: string;
  timestamp: string;
  now?: Date;
}): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp)) return false;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > RELAY_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createRelaySignature(input), "ascii");
  const actual = Buffer.from(input.signature, "ascii");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
