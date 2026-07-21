import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRequestEnvelope, type ReplayStore } from "@paperclip/connect-protocol";
import {
  ConnectClaimInterceptionError,
  ConnectServiceResponseError,
  connectionBrokerService,
  createSignedConnectBrokerClient,
  type ConnectionBrokerStore,
} from "./connection-broker.js";

const INSTANCE_ID = "in_testinstance";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
function fixture(mode: "A" | "B2" = "A") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const replay = new Set<string>();
  const claims = new Map([["claim-code-at-least-22-chars", { owner: INSTANCE_ID, attempts: 0, consumed: false }]]);
  const saved: Parameters<ConnectionBrokerStore["saveGrant"]>[0][] = [];
  const secrets: Array<{ purpose: string; value: string }> = [];
  const replayStore: ReplayStore = { consume: (_instance, jti) => !replay.has(jti) && Boolean(replay.add(jti)) };
  let capturedEnvelope = "";
  const transport = {
    async request(path: string, compactJws: string) {
      capturedEnvelope = compactJws;
      try {
        const envelope = await verifyRequestEnvelope({ compactJws, publicKey, expectedInstanceId: INSTANCE_ID, expectedPath: path, replayStore });
        if (path === "/v1/claims") {
          const code = (envelope.body as { claimCode: string }).claimCode;
          const claim = claims.get(code);
          if (!claim) return { status: 404, body: { error: "unknown_claim" } };
          if (claim.attempts >= 5) return { status: 404, body: { error: "unknown_claim" } };
          if (claim.owner !== envelope.iss) { claim.attempts += 1; return { status: 403, body: { error: "claim_instance_mismatch" } }; }
          if (claim.consumed) return { status: 409, body: { error: "claim_already_consumed" } };
          claim.consumed = true;
          return mode === "A"
            ? { status: 200, body: { custodyMode: "A", grantRef: "gr_testgrant", tokenMeta: { scopes: ["read"], expiresAt: null } } }
            : { status: 200, body: { custodyMode: "B2", grantSealed: "sealed-refresh", tokenMeta: { scopes: ["read"], expiresAt: null } } };
        }
        if (path.endsWith("/token")) return { status: 200, body: { grantSealed: "sealed-access", tokenMeta: { scopes: ["read"], expiresAt: null } } };
        if (path === "/v1/handshakes") return { status: 201, body: { handshakeId: "hs_test", authorizeUrl: "https://connect.example/authorize", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        if (path === "/v1/connections/register") return { status: 201, body: { connectionPublicRef: "cn_test", intakeUrls: ["https://connect.example/intake/cn_test"], relaySecret: "relay-secret" } };
        return { status: 404, body: { error: "not_found" } };
      } catch (error) {
        return { status: 401, body: { error: error instanceof Error ? error.message : "invalid_envelope" } };
      }
    },
  };
  const client = createSignedConnectBrokerClient({ instanceId: INSTANCE_ID, keyId: "key-1", privateKey, transport });
  const store: ConnectionBrokerStore = {
    saveGrant: async (input) => { saved.push(input); return { id: "grant-local" }; },
    registerRelay: async () => undefined,
  };
  const service = connectionBrokerService({ client, store, enabled: true, vault: { put: async (input) => { secrets.push(input); return { secretId: `secret-${input.purpose}`, versionSelector: "latest", configPath: `broker.${input.purpose}`, required: true, label: input.purpose }; } } });
  return { service, saved, secrets, claims, transport, getCapturedEnvelope: () => capturedEnvelope };
}

describe("connection broker", () => {
  it.each(["A", "B2"] as const)("claims and persists custody mode %s", async (mode) => {
    const f = fixture(mode);
    const result = await f.service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" });
    expect(result.custodyMode).toBe(mode);
    expect(f.saved[0]?.custodyMode).toBe(mode);
    expect(f.secrets[0]?.value).toBe(mode === "A" ? "sealed-access" : "sealed-refresh");
  });

  it("surfaces a 409 redemption as an interception alert", async () => {
    const f = fixture();
    await f.service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" });
    await expect(f.service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" })).rejects.toBeInstanceOf(ConnectClaimInterceptionError);
  });

  it("does not consume mismatched claims and locks the service-side double after five attempts", async () => {
    const f = fixture();
    const claim = f.claims.get("claim-code-at-least-22-chars")!;
    claim.owner = "in_otherinstance";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(f.service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" })).rejects.toMatchObject({ status: 403, code: "claim_instance_mismatch" });
      expect(claim.consumed).toBe(false);
    }
    expect(claim.attempts).toBe(5);
    await expect(f.service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" })).rejects.toMatchObject({ status: 404, code: "unknown_claim" });
  });

  it("rejects replay of an already signed request", async () => {
    const f = fixture();
    await f.service.startOAuth({ providerSlug: "vercel", methodKey: "oauth", custodyMode: "A", clientOwnership: "platform_shared", connectionRef: CONNECTION_ID, returnUrl: "https://instance.example/claim", scopes: [] });
    const replay = await f.transport.request("/v1/handshakes", f.getCapturedEnvelope());
    expect(replay).toEqual({ status: 401, body: { error: "replayed_jti" } });
  });

  it("defaults brokered mode off", async () => {
    const f = fixture();
    const disabled = connectionBrokerService({ client: (f.service as never), store: {} as never, vault: {} as never });
    await expect(disabled.startOAuth({})).rejects.toEqual(new ConnectServiceResponseError(403, "mode_not_allowed"));
  });
});
