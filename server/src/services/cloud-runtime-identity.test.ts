import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLOUD_RUNTIME_IDENTITY_AUDIENCE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
  CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
  runtimeCanonicalOrigin,
  runtimePublicOrigin,
  verifyCloudRuntimeIdentityAssertion,
} from "./cloud-runtime-identity.js";

const STACK_ID = "stack-pool-123";
const POOL_ORIGIN = "https://pool-123.staging.paperclip.app";
const CANONICAL_ORIGIN = "https://gonzo.staging.paperclip.app";
const NOW = new Date("2099-01-01T00:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const publicJwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "runtime-identity-test-key",
  use: "sig",
  alg: "EdDSA",
};
const env = {
  PAPERCLIP_CLOUD_STACK_ID: STACK_ID,
  PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [publicJwk] }),
} as NodeJS.ProcessEnv;

function encodeJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertion(input: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signingKey?: KeyObject;
} = {}) {
  const iat = Math.floor(NOW.getTime() / 1000);
  const header = encodeJson({
    alg: "EdDSA",
    typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE,
    kid: publicJwk.kid,
    ...input.header,
  });
  const payload = encodeJson({
    v: 1,
    iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
    aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
    sub: STACK_ID,
    claimId: "pool-entry-123",
    previousOrigin: POOL_ORIGIN,
    canonicalOrigin: CANONICAL_ORIGIN,
    stackSlug: "gonzo",
    iat,
    exp: iat + 300,
    ...input.claims,
  });
  const signature = sign(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    input.signingKey ?? pair.privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyAssertion(compactJws: string, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return verifyCloudRuntimeIdentityAssertion({
    compactJws,
    env: { ...env, ...overrides },
    now: NOW,
    expectedPreviousOrigin: POOL_ORIGIN,
  });
}

describe("verifyCloudRuntimeIdentityAssertion", () => {
  it("preserves distinct self-hosted public and authentication origins", () => {
    const selfHostedEnv = {
      PAPERCLIP_PUBLIC_URL: "https://app.example.test",
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: "https://auth.example.test",
      PAPERCLIP_API_URL: "https://api.example.test",
    } as NodeJS.ProcessEnv;

    expect(runtimePublicOrigin(selfHostedEnv)).toBe("https://app.example.test");
    expect(runtimeCanonicalOrigin()).toBeNull();
  });

  it("accepts a Cloud-signed claim for this exact stack and pool origin", () => {
    expect(verifyAssertion(assertion())).toMatchObject({
      sub: STACK_ID,
      claimId: "pool-entry-123",
      canonicalOrigin: CANONICAL_ORIGIN,
      stackSlug: "gonzo",
    });
  });

  it("rejects forged signatures and unknown signing keys", () => {
    const attacker = generateKeyPairSync("ed25519");
    expect(() => verifyAssertion(assertion({ signingKey: attacker.privateKey }))).toThrow("signature is invalid");
    expect(() => verifyAssertion(assertion({ header: { kid: "unknown" } }))).toThrow("unknown signing key");
  });

  it.each([
    ["expired", { exp: Math.floor(NOW.getTime() / 1000) - 1 }],
    ["wrong audience", { aud: "someone-else" }],
    ["cross-stack", { sub: "stack-someone-else" }],
    ["wrong pool origin", { previousOrigin: "https://someone-else.staging.paperclip.app" }],
    ["non-HTTPS destination", { canonicalOrigin: "http://gonzo.staging.paperclip.app" }],
    ["path-bearing destination", { canonicalOrigin: `${CANONICAL_ORIGIN}/GON` }],
    ["slug mismatch", { stackSlug: "kermit" }],
    ["partial claims", { claimId: undefined }],
  ])("rejects %s assertions", (_label, claims) => {
    expect(() => verifyAssertion(assertion({ claims }))).toThrow();
  });

  it("rejects an altered signed destination", () => {
    const valid = assertion();
    const [header, payload, signature] = valid.split(".");
    const altered = encodeJson({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
      canonicalOrigin: "https://attacker.example.com",
    });
    expect(() => verifyAssertion(`${header}.${altered}.${signature}`)).toThrow("signature is invalid");
  });
});
