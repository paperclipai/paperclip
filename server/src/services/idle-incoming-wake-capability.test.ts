import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseIdleCapabilities } from "./idle-incoming-wake-capability.js";
import {
  verifyCloudControlAssertion,
  resetCloudControlReplayFenceForTests,
  CLOUD_CONTROL_AUDIENCE,
  CLOUD_CONTROL_JWS_TYPE,
  CLOUD_RUNTIME_IDENTITY_ISSUER,
} from "./cloud-runtime-identity.js";
const incoming = {
  version: 1 as const,
  ownerId: "00000000-0000-4000-8000-000000000001",
  generation: "a".repeat(64),
  apiKeyProof: { version: 1 as const, challenge: "c".repeat(64) },
  routes: ["tenant-api-http-v2" as const],
};
const invalid: unknown[] = [
  null,
  {},
  { other: true },
  { deadlineCatalog: "other" },
  { incomingWake: { ...incoming, version: 2 } },
  { incomingWake: { ...incoming, routes: ["all"] } },
  {
    incomingWake: {
      ...incoming,
      routes: ["tenant-api-http-v2", "tenant-api-http-v2"],
    },
  },
  { incomingWake: { ...incoming, ownerId: "other" } },
  { incomingWake: { ...incoming, extra: true } },
  {
    incomingWake: {
      ...incoming,
      githubBroker: {
        instanceId: "instance",
        bindingsFingerprint: "b".repeat(64),
      },
    },
  },
  { incomingWake: { ...incoming, routes: ["github-broker-events-v1"] } },
];

describe("signed idle capabilities", () => {
  it.each(invalid)("rejects unknown/partial capabilities: %j", (value) => {
    expect(() => parseIdleCapabilities(value)).toThrow();
  });
  it("detaches and freezes the exact known catalogs", () => {
    const source = {
      incomingWake: { ...incoming, routes: [...incoming.routes] },
      deadlineCatalog: "domain_deadlines_v1",
    };
    const parsed = parseIdleCapabilities(source);
    source.incomingWake.routes.length = 0;
    expect(parsed.incomingWake?.routes).toEqual(["tenant-api-http-v2"]);
    expect(Object.isFrozen(parsed.incomingWake?.routes)).toBe(true);
  });
  it("binds capability to signed stack, action and replay fence", () => {
    resetCloudControlReplayFenceForTests();
    const pair = generateKeyPairSync("ed25519");
    const now = new Date("2099-01-01T00:00:00Z");
    const jwk = {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "idle",
      use: "sig",
      alg: "EdDSA",
    };
    const env = {
      PAPERCLIP_CLOUD_STACK_ID: "stack",
      PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [jwk] }),
    };
    const encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const token = (overrides: object = {}) => {
      const header = encode({
        alg: "EdDSA",
        typ: CLOUD_CONTROL_JWS_TYPE,
        kid: "idle",
      });
      const body = encode({
        v: 1,
        iss: CLOUD_RUNTIME_IDENTITY_ISSUER,
        aud: CLOUD_CONTROL_AUDIENCE,
        sub: "stack",
        action: "task-drain:read",
        requestId: "same",
        iat: now.getTime() / 1000,
        exp: now.getTime() / 1000 + 60,
        idleCapabilities: {
          incomingWake: incoming,
          deadlineCatalog: "domain_deadlines_v1",
        },
        ...overrides,
      });
      return `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), pair.privateKey).toString("base64url")}`;
    };
    const verify = (compactJws: string) =>
      verifyCloudControlAssertion({
        compactJws,
        env,
        now,
        expectedAction: "task-drain:read",
      });
    expect(() => verify(token({ sub: "foreign" }))).toThrow();
    expect(() => verify(token({ action: "task-drain:start" }))).toThrow();
    expect(() =>
      verify(token({ idleCapabilities: { deadlineCatalog: "unknown" } })),
    ).toThrow();
    expect(verify(token()).idleCapabilities?.incomingWake).toEqual(incoming);
    expect(() => verify(token())).toThrow(/already been used/);
  });
});
