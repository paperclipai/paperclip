import { randomBytes, type KeyObject } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import {
  claimRequestSchema, claimResponseSchema, grantTokenRequestSchema, grantTokenResponseSchema,
  handshakeRequestSchema, handshakeResponseSchema, relayRegistrationRequestSchema,
  relayRegistrationResponseSchema, signRequestEnvelope,
} from "@paperclip/connect-protocol";

export class ConnectServiceResponseError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export class ConnectClaimInterceptionError extends ConnectServiceResponseError {
  constructor() { super(409, "claim_already_consumed"); }
}
export type ConnectBrokerTransport = { request(path: string, compactJws: string): Promise<{ status: number; body: unknown }> };
export function createSignedConnectBrokerClient(input: { instanceId: string; keyId: string; privateKey: KeyObject; transport: ConnectBrokerTransport }) {
  async function request(path: string, body: unknown) {
    const compactJws = signRequestEnvelope({ body, instanceId: input.instanceId, keyId: input.keyId, privateKey: input.privateKey, path });
    const response = await input.transport.request(path, compactJws);
    if (response.status >= 400) {
      const code = typeof (response.body as { error?: unknown })?.error === "string" ? (response.body as { error: string }).error : "connect_service_error";
      if (response.status === 409 && code === "claim_already_consumed") throw new ConnectClaimInterceptionError();
      throw new ConnectServiceResponseError(response.status, code);
    }
    return response.body;
  }
  return {
    createHandshake: async (body: unknown) => handshakeResponseSchema.parse(await request("/v1/handshakes", handshakeRequestSchema.parse(body))),
    claim: async (claimCode: string) => claimResponseSchema.parse(await request("/v1/claims", claimRequestSchema.parse({ claimCode }))),
    mintGrantToken: async (grantRef: string, grantWrapKey: string) => grantTokenResponseSchema.parse(await request(`/v1/grants/${encodeURIComponent(grantRef)}/token`, grantTokenRequestSchema.parse({ grantWrapKey }))),
    registerRelay: async (body: unknown) => relayRegistrationResponseSchema.parse(await request("/v1/connections/register", relayRegistrationRequestSchema.parse(body))),
  };
}
export type ConnectBrokerClient = ReturnType<typeof createSignedConnectBrokerClient>;
type SecretRef = { secretId: string; versionSelector: "latest"; configPath: string; required: boolean; label: string };
export type ConnectionBrokerVault = { put(input: { companyId: string; connectionId: string; purpose: "grant" | "relay"; value: string }): Promise<SecretRef> };
export type ConnectionBrokerStore = {
  saveGrant(input: { companyId: string; connectionId: string; kind: "workspace" | "user"; subjectUserId: string | null; credentialSecretRefs: SecretRef[]; custodyMode: "A" | "B2"; serviceGrantRef: string | null; tokenMeta: { scopes: string[]; expiresAt?: string | null } }): Promise<{ id: string }>;
  registerRelay(input: { companyId: string; connectionId: string; connectionPublicRef: string; intakeUrls: string[]; relaySecretRef: { secretId: string; versionSelector: "latest" } }): Promise<void>;
};
export function connectionBrokerStore(db: Db): ConnectionBrokerStore {
  return {
    async saveGrant(input) {
      const providerTenant = { name: `brokered:${input.custodyMode}`, externalId: input.serviceGrantRef ?? undefined, tokenMeta: input.tokenMeta };
      const condition = input.kind === "user" ? eq(connectionGrants.subjectUserId, input.subjectUserId!) : eq(connectionGrants.isDefault, true);
      const existing = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(eq(connectionGrants.connectionId, input.connectionId), condition)).limit(1).then((rows) => rows[0] ?? null);
      if (existing) return db.update(connectionGrants).set({ credentialSecretRefs: input.credentialSecretRefs, providerTenant, status: "active", updatedAt: new Date() }).where(eq(connectionGrants.id, existing.id)).returning({ id: connectionGrants.id }).then((rows) => rows[0]);
      return db.insert(connectionGrants).values({ companyId: input.companyId, connectionId: input.connectionId, kind: input.kind, subjectUserId: input.subjectUserId, credentialSecretRefs: input.credentialSecretRefs, providerTenant, isDefault: input.kind === "workspace" }).returning({ id: connectionGrants.id }).then((rows) => rows[0]);
    },
    async registerRelay(input) {
      const connection = await db.select({ config: toolConnections.config }).from(toolConnections).where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, input.companyId))).limit(1).then((rows) => rows[0]);
      if (!connection) throw new Error("Tool connection not found");
      await db.update(toolConnections).set({ config: { ...connection.config, relay: { publicRef: input.connectionPublicRef, intakeUrls: input.intakeUrls, secretId: input.relaySecretRef.secretId, secretVersion: input.relaySecretRef.versionSelector } }, updatedAt: new Date() }).where(eq(toolConnections.id, input.connectionId));
    },
  };
}
export function connectionBrokerService(input: { client: ConnectBrokerClient; store: ConnectionBrokerStore; vault: ConnectionBrokerVault; enabled?: boolean }) {
  const assertEnabled = () => { if (!input.enabled) throw new ConnectServiceResponseError(403, "mode_not_allowed"); };
  return {
    startOAuth: async (body: unknown) => { assertEnabled(); return input.client.createHandshake(body); },
    async claimOAuth(params: { companyId: string; connectionId: string; claimCode: string; kind: "workspace" | "user"; subjectUserId?: string | null }) {
      assertEnabled();
      const claim = await input.client.claim(params.claimCode);
      if (claim.custodyMode !== "A" && claim.custodyMode !== "B2") throw new ConnectServiceResponseError(403, "mode_not_allowed");
      const serviceGrantRef = claim.custodyMode === "A" ? claim.grantRef : null;
      const sealedGrant = claim.custodyMode === "A" ? (await input.client.mintGrantToken(claim.grantRef, randomBytes(32).toString("base64url"))).grantSealed : claim.grantSealed;
      const secretRef = await input.vault.put({ companyId: params.companyId, connectionId: params.connectionId, purpose: "grant", value: sealedGrant });
      const grant = await input.store.saveGrant({ companyId: params.companyId, connectionId: params.connectionId, kind: params.kind, subjectUserId: params.kind === "user" ? params.subjectUserId ?? null : null, credentialSecretRefs: [secretRef], custodyMode: claim.custodyMode, serviceGrantRef, tokenMeta: claim.tokenMeta });
      return { grantId: grant.id, custodyMode: claim.custodyMode, tokenMeta: claim.tokenMeta };
    },
    async registerRelay(params: { companyId: string; connectionId: string; providerSlug: string; intakeUrls: string[] }) {
      assertEnabled();
      const registration = await input.client.registerRelay({ connectionRef: params.connectionId, providerSlug: params.providerSlug, intakeUrls: params.intakeUrls });
      const secretRef = await input.vault.put({ companyId: params.companyId, connectionId: params.connectionId, purpose: "relay", value: registration.relaySecret });
      await input.store.registerRelay({ companyId: params.companyId, connectionId: params.connectionId, connectionPublicRef: registration.connectionPublicRef, intakeUrls: registration.intakeUrls, relaySecretRef: secretRef });
      return registration;
    },
  };
}
