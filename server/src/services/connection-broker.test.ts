import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyRequestEnvelope, type ReplayStore } from "@paperclip/connect-protocol";
import { companies, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  ConnectClaimInterceptionError,
  ConnectServiceResponseError,
  connectionBrokerStore,
  connectionBrokerService,
  createSignedConnectBrokerClient,
  type ConnectionBrokerStore,
} from "./connection-broker.js";

const INSTANCE_ID = "in_testinstance";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
function fixture(mode: "A" | "B2" = "A") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const replay = new Set<string>();
  const claims = new Map([["claim-code-at-least-22-chars", { owner: INSTANCE_ID, attempts: 0, consumed: false, idempotencyKey: "", response: null as Record<string, unknown> | null }]]);
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
          const { claimCode: code, idempotencyKey } = envelope.body as { claimCode: string; idempotencyKey: string };
          const claim = claims.get(code);
          if (!claim) return { status: 404, body: { error: "unknown_claim" } };
          if (claim.attempts >= 5) return { status: 404, body: { error: "unknown_claim" } };
          if (claim.owner !== envelope.iss) { claim.attempts += 1; return { status: 403, body: { error: "claim_instance_mismatch" } }; }
          if (claim.consumed) {
            return claim.idempotencyKey === idempotencyKey && claim.response
              ? { status: 200, body: claim.response }
              : { status: 409, body: { error: "claim_already_consumed" } };
          }
          claim.consumed = true;
          claim.idempotencyKey = idempotencyKey;
          claim.response = mode === "A"
            ? { custodyMode: "A", grantRef: "gr_testgrant", tokenMeta: { scopes: ["read"], expiresAt: null } }
            : { custodyMode: "B2", grantSealed: "sealed-refresh", tokenMeta: { scopes: ["read"], expiresAt: null } };
          return { status: 200, body: claim.response };
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
  const claimStates = new Map<string, { claim: Awaited<ReturnType<typeof client.claim>> }>();
  const store: ConnectionBrokerStore = {
    saveGrant: async (input) => { saved.push(input); return { id: "grant-local" }; },
    registerRelay: async () => undefined,
    assertActiveUserMembership: async () => undefined,
    loadClaimState: async ({ claimCodeHash }) => claimStates.get(claimCodeHash) ?? null,
    saveClaimState: async ({ claimCodeHash, claim }) => { claimStates.set(claimCodeHash, { claim }); },
    clearClaimState: async ({ claimCodeHash }) => { claimStates.delete(claimCodeHash); },
  };
  const service = connectionBrokerService({ client, store, enabled: true, vault: { put: async (input) => { secrets.push(input); return { secretId: `secret-${input.purpose}`, versionSelector: "latest", configPath: `broker.${input.purpose}`, required: true, label: input.purpose }; } } });
  return { service, client, store, saved, secrets, claims, claimStates, transport, getCapturedEnvelope: () => capturedEnvelope };
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
    await expect(f.client.claim("claim-code-at-least-22-chars", "b".repeat(64))).rejects.toBeInstanceOf(ConnectClaimInterceptionError);
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

  it("resumes locally after the remote claim succeeds but vault persistence fails", async () => {
    const f = fixture("B2");
    let failVault = true;
    const service = connectionBrokerService({
      client: f.client,
      store: f.store,
      enabled: true,
      vault: { put: async (input) => {
        if (failVault) { failVault = false; throw new Error("vault unavailable"); }
        return { secretId: "secret-grant", versionSelector: "latest", configPath: "broker.grant", required: true, label: input.purpose };
      } },
    });
    const params = { companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" as const };
    await expect(service.claimOAuth(params)).rejects.toThrow("vault unavailable");
    expect(f.claims.get(params.claimCode)?.consumed).toBe(true);
    expect(f.claimStates.size).toBe(1);
    await expect(service.claimOAuth(params)).resolves.toMatchObject({ custodyMode: "B2" });
    expect(f.claimStates.size).toBe(0);
  });

  it("retries the remote claim idempotently when local recovery persistence fails", async () => {
    const f = fixture("B2");
    let failSave = true;
    const service = connectionBrokerService({
      client: f.client,
      store: {
        ...f.store,
        saveClaimState: async (input) => {
          if (failSave) { failSave = false; throw new Error("database unavailable"); }
          await f.store.saveClaimState(input);
        },
      },
      enabled: true,
      vault: { put: async (input) => ({ secretId: "secret-grant", versionSelector: "latest", configPath: "broker.grant", required: true, label: input.purpose }) },
    });
    const params = { companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "workspace" as const };

    await expect(service.claimOAuth(params)).rejects.toThrow("database unavailable");
    expect(f.claims.get(params.claimCode)?.consumed).toBe(true);
    await expect(service.claimOAuth(params)).resolves.toMatchObject({ custodyMode: "B2" });
  });

  it("rejects user grants before consuming a claim when membership is inactive", async () => {
    const f = fixture();
    const service = connectionBrokerService({
      client: f.client,
      store: { ...f.store, assertActiveUserMembership: async () => { throw new ConnectServiceResponseError(403, "user_not_company_member"); } },
      enabled: true,
      vault: { put: async () => { throw new Error("unreachable"); } },
    });
    await expect(service.claimOAuth({ companyId: "company", connectionId: CONNECTION_ID, claimCode: "claim-code-at-least-22-chars", kind: "user", subjectUserId: "user-1" })).rejects.toMatchObject({ status: 403, code: "user_not_company_member" });
    expect(f.claims.get("claim-code-at-least-22-chars")?.consumed).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("connection broker claim recovery persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-broker-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("preserves independent concurrent claim recovery records", async () => {
    const company = await db.insert(companies).values({ name: "Broker Claims", issuePrefix: "BCL" }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({ companyId: company.id, name: "Broker App", type: "mcp_http" }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Broker Connection",
      uid: "broker-claim-recovery",
      transport: "rest_api",
      enabled: true,
      config: {},
    }).returning().then((rows) => rows[0]!);
    const store = connectionBrokerStore(db);
    const claimA = { custodyMode: "B2" as const, grantSealed: "sealed-a", tokenMeta: { scopes: ["read"], expiresAt: null } };
    const claimB = { custodyMode: "B2" as const, grantSealed: "sealed-b", tokenMeta: { scopes: ["write"], expiresAt: null } };

    await Promise.all([
      store.saveClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-a", claim: claimA }),
      store.saveClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-b", claim: claimB }),
    ]);

    await expect(store.loadClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-a" })).resolves.toEqual({ claim: claimA });
    await expect(store.loadClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-b" })).resolves.toEqual({ claim: claimB });
    await store.clearClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-a" });
    await expect(store.loadClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-a" })).resolves.toBeNull();
    await expect(store.loadClaimState({ companyId: company.id, connectionId: connection.id, claimCodeHash: "hash-b" })).resolves.toEqual({ claim: claimB });
  });
});
