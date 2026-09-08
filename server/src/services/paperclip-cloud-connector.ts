import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  GITHUB_CONNECTOR_PROFILES,
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  isGitHubConnectorProfileId,
  isGoogleWorkspaceConnectorProfileId,
  type GitHubConnectorProfileId,
  type GoogleWorkspaceConnectorProfileId,
} from "@paperclipai/shared";
import {
  loadPaperclipCloudConnectorIdentity,
  paperclipCloudConnectorEnrollmentStatus,
} from "./paperclip-cloud-connector-enrollment.js";

export const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const GMAIL_CONNECTOR_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;
export { GOOGLE_WORKSPACE_CONNECTOR_PROFILES };

export type PaperclipCloudConnectorEnvironment = "development" | "staging" | "production";
export type PaperclipCloudConnectorOperation = "status" | "session" | "claim" | "refresh" | "revoke" | "webhook-bind" | "event-lease" | "event-ack";
export type PaperclipCloudConnectorProfileId = GoogleWorkspaceConnectorProfileId | GitHubConnectorProfileId;
export type PaperclipCloudConnectorProvider = "google" | "github";

export type PaperclipCloudConnectorConfig = {
  baseUrl: string;
  instanceId: string;
  environment: PaperclipCloudConnectorEnvironment;
  signPrivateKey: string;
  sealPrivateKey: string;
};

export type SealedConnectorCredentials = {
  v: 1;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
  subject: string;
  companyId: string;
  instanceId: string;
  environment: PaperclipCloudConnectorEnvironment;
  provider: PaperclipCloudConnectorProvider;
  profile: string;
  appSlug?: string;
};

export type SealedGmailCredentials = SealedConnectorCredentials & { provider: "google" };
export type SealedGoogleWorkspaceCredentials = SealedGmailCredentials;

export type SealedConnectorEvents = {
  v: 1;
  instanceId: string;
  environment: PaperclipCloudConnectorEnvironment;
  leaseId: string;
  events: Array<{
    id: string;
    provider: "github";
    event: string;
    action: string | null;
    installationId: string | null;
    repositoryId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
    bindingIds: string[];
  }>;
};

type SealedEnvelope = {
  v: 1;
  alg: "X25519-HKDF-SHA256-A256GCM";
  purpose: "initial" | "access" | "events";
  provider: PaperclipCloudConnectorProvider;
  profile: PaperclipCloudConnectorProfileId;
  epk: string;
  iv: string;
  ct: string;
};

type ConnectorResponse = {
  confirmationUrl?: unknown;
  authorizationUrl?: unknown;
  handoff?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  claimId?: unknown;
  sealed?: unknown;
  profiles?: unknown;
  protocolVersion?: unknown;
  providers?: unknown;
  active?: unknown;
  status?: unknown;
  leaseId?: unknown;
  events?: unknown;
  acknowledged?: unknown;
};

const ENDPOINTS: Record<PaperclipCloudConnectorOperation, string> = {
  status: "/v1/connector/instance-status",
  session: "/v1/connector/sessions",
  claim: "/v1/connector/claims",
  refresh: "/v1/connector/refresh",
  revoke: "/v1/connector/revoke",
  "webhook-bind": "/v1/connector/webhook-bindings",
  "event-lease": "/v1/connector/events/lease",
  "event-ack": "/v1/connector/events/ack",
};
const JWS_TYP = "paperclip-cloud-connector-request+jwt";
const SEAL_ALGORITHM = "X25519-HKDF-SHA256-A256GCM";
const AES_TAG_BYTES = 16;
const RAW_PRIVATE_KEY_BYTES = 32;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** A stable, intentionally detail-free error for all remote broker failures. */
export class PaperclipCloudConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PaperclipCloudConnectorError";
  }
}

export function paperclipCloudConnectorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipCloudConnectorConfig | null {
  const localIdentity = loadPaperclipCloudConnectorIdentity();
  const legacyConfigured = [
    env.PAPERCLIP_ID_CONNECTOR_INSTANCE_ID,
    env.PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY,
    env.PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY,
    env.PAPERCLIP_ID_CONNECTOR_ENVIRONMENT,
    env.PAPERCLIP_ID_CONNECTOR_BASE_URL,
  ].some((value) => Boolean(value?.trim()));
  const managedInstanceId = env.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID?.trim();
  const managedSignPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY?.trim();
  const managedSealPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY?.trim();
  const managedEnvironment = env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT?.trim();
  const hasManagedIdentityOverride = [managedInstanceId, managedSignPrivateKey, managedSealPrivateKey]
    .some(Boolean);
  const localStatus = hasManagedIdentityOverride ? null : paperclipCloudConnectorEnrollmentStatus(env);
  const hasActiveLocalIdentity = localIdentity?.status === "active" && localStatus?.configured === true;
  if (!hasManagedIdentityOverride && !hasActiveLocalIdentity && legacyConfigured) {
    throw new PaperclipCloudConnectorError(
      "Paperclip ID connector settings use an incompatible legacy protocol; enroll this instance with Paperclip Cloud",
      "CONNECTOR_MIGRATION_REQUIRED",
    );
  }
  if (!hasManagedIdentityOverride && !hasActiveLocalIdentity) return null;

  const instanceId = hasManagedIdentityOverride ? managedInstanceId : localIdentity!.instanceId;
  const signPrivateKey = hasManagedIdentityOverride ? managedSignPrivateKey : localIdentity!.signPrivateKey;
  const sealPrivateKey = hasManagedIdentityOverride ? managedSealPrivateKey : localIdentity!.sealPrivateKey;
  const environment = hasManagedIdentityOverride ? managedEnvironment : localIdentity!.environment;
  const baseUrl = env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL?.trim()
    || (hasActiveLocalIdentity ? localIdentity!.brokerBaseUrl : undefined)
    || "https://my.paperclip.app";
  const values = [instanceId, signPrivateKey, sealPrivateKey, environment];
  if (values.some((value) => !value)) {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector configuration is incomplete", "CONNECTOR_CONFIG_INCOMPLETE");
  }
  if (environment !== "development" && environment !== "staging" && environment !== "production") {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector environment is invalid", "CONNECTOR_CONFIG_INVALID");
  }
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && isLoopback(parsedBaseUrl.hostname))) {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector URL must use HTTPS", "CONNECTOR_CONFIG_INVALID");
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector URL is invalid", "CONNECTOR_CONFIG_INVALID");
  }
  const brokerHost = parsedBaseUrl.hostname.toLowerCase();
  if ((brokerHost === "my.paperclip.app" && environment !== "production")
    || (brokerHost === "my-staging.paperclip.app" && environment !== "staging")) {
    throw new PaperclipCloudConnectorError(
      "Paperclip Cloud connector broker and environment do not match",
      "CONNECTOR_CONFIG_INVALID",
    );
  }
  parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/$/, "");
  return {
    baseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    instanceId: instanceId!,
    environment,
    signPrivateKey: signPrivateKey!,
    sealPrivateKey: sealPrivateKey!,
  };
}

export function createPaperclipCloudConnector(input: {
  config: PaperclipCloudConnectorConfig;
  request?: typeof fetch;
  now?: () => number;
}) {
  const config = input.config;
  const request = input.request ?? fetch;
  const now = input.now ?? Date.now;
  const signingKey = privateKey(config.signPrivateKey, "ed25519");
  const sealKey = privateKey(config.sealPrivateKey, "x25519");

  async function call(
    operation: PaperclipCloudConnectorOperation,
    claims: { subject: string; companyId: string; profile?: PaperclipCloudConnectorProfileId; returnUri?: string; returnState?: string; claimId?: string; redemptionId?: string },
    secret?: { field: "refreshToken" | "token" | "binding" | "acknowledgement"; value: string },
  ): Promise<ConnectorResponse> {
    const endpoint = new URL(ENDPOINTS[operation], `${config.baseUrl}/`).toString();
    const issuedAt = Math.floor(now() / 1000);
    const payload: Record<string, unknown> = {
      iss: config.instanceId,
      aud: endpoint,
      sub: claims.subject,
      cid: claims.companyId,
      env: config.environment,
      op: operation,
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: randomUUID(),
    };
    if (claims.returnUri !== undefined) payload.ruri = claims.returnUri;
    if (claims.returnState !== undefined) payload.rst = claims.returnState;
    if (claims.claimId !== undefined) payload.cl = claims.claimId;
    if (claims.redemptionId !== undefined) payload.rid = claims.redemptionId;
    if (claims.profile !== undefined) {
      const definition = connectorProfileDefinition(claims.profile);
      payload.prv = definition.provider;
      payload.prf = claims.profile;
      payload.scp = [...definition.scopes];
    }
    if (secret) payload.sh = await sha256Base64Url(secret.value);
    const body = {
      request: signRequest(payload, signingKey),
      ...(secret ? { [secret.field]: secret.value } : {}),
    };
    let response: Response;
    try {
      response = await request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector is unavailable", "CONNECTOR_UNAVAILABLE");
    }
    if (operation === "revoke" && response.status === 204) return {};
    if (!response.ok) {
      throw new PaperclipCloudConnectorError(
        "Paperclip Cloud connector rejected the request",
        response.status === 409 ? "REAUTHORIZATION_REQUIRED" : "CONNECTOR_REQUEST_FAILED",
        response.status,
      );
    }
    try {
      return await response.json() as ConnectorResponse;
    } catch {
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid response", "CONNECTOR_BAD_RESPONSE");
    }
  }

  function openCredentials(
    response: ConnectorResponse,
    purpose: SealedEnvelope["purpose"],
    subject: string,
    companyId: string,
    profile: PaperclipCloudConnectorProfileId,
  ): SealedConnectorCredentials {
    const definition = connectorProfileDefinition(profile);
    const envelope = parseEnvelope(response.sealed, purpose, definition.provider, profile);
    const credentials = unseal(
      envelope,
      sealKey,
      config.instanceId,
      config.environment,
      definition.provider,
      profile,
      definition.scopes,
    );
    if (
      credentials.instanceId !== config.instanceId
      || credentials.environment !== config.environment
      || credentials.subject !== subject
      || credentials.companyId !== companyId
      || credentials.provider !== definition.provider
    ) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud credential binding did not match", "CONNECTOR_BINDING_MISMATCH");
    }
    if (credentials.profile !== profile) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector profile binding did not match", "CONNECTOR_BINDING_MISMATCH");
    }
    if (!sameStringSet(credentials.scopes, definition.scopes)) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud scope grant did not match", "REAUTHORIZATION_REQUIRED");
    }
    return credentials;
  }

  return {
    async getInstanceStatus(): Promise<"active" | "suspended" | "removed"> {
      let response: ConnectorResponse;
      try {
        response = await call("status", {
          subject: "instance-status",
          companyId: "instance-status",
        });
      } catch (error) {
        if (error instanceof PaperclipCloudConnectorError && error.status === 401) return "removed";
        throw error;
      }
      if (response.status === "active" && response.active === true) return "active";
      if (response.status === "suspended" && response.active === false) return "suspended";
      if (response.status === "removed" && response.active === false) return "removed";
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid instance status", "CONNECTOR_BAD_RESPONSE");
    },
    async getCapabilities(): Promise<PaperclipCloudConnectorProfileId[]> {
      let response: ConnectorResponse;
      try {
        response = await call("status", {
          subject: "instance-capabilities",
          companyId: "instance-capabilities",
        });
      } catch {
        return [];
      }
      if (response.active !== true || response.status !== "active" || !Array.isArray(response.profiles)) return [];
      return [...new Set(response.profiles.flatMap((value) =>
        typeof value === "string" && isPaperclipCloudConnectorProfileId(value) ? [value] : []
      ))];
    },
    async startAuthorization(values: { subject: string; companyId: string; profile?: PaperclipCloudConnectorProfileId; returnUri: string; returnState: string }) {
      const profile = values.profile ?? "gmail.draft";
      const response = await call("session", { ...values, profile });
      if (typeof response.confirmationUrl !== "string" || typeof response.expiresAt !== "string") {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid session", "CONNECTOR_BAD_RESPONSE");
      }
      let confirmationUrl: URL;
      try {
        confirmationUrl = new URL(response.confirmationUrl);
      } catch {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid confirmation URL", "CONNECTOR_BAD_RESPONSE");
      }
      const expectedBroker = new URL(config.baseUrl);
      if (
        confirmationUrl.origin !== expectedBroker.origin
        || confirmationUrl.pathname !== "/connections/confirm"
        || confirmationUrl.username
        || confirmationUrl.password
        || confirmationUrl.hash
      ) {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid confirmation URL", "CONNECTOR_BAD_RESPONSE");
      }
      let authorizationUrl: URL | undefined;
      if (response.authorizationUrl !== undefined) {
        if (typeof response.authorizationUrl !== "string") {
          throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid provider URL", "CONNECTOR_BAD_RESPONSE");
        }
        try {
          authorizationUrl = new URL(response.authorizationUrl);
        } catch {
          throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid provider URL", "CONNECTOR_BAD_RESPONSE");
        }
        if (
          authorizationUrl.protocol !== "https:"
          || authorizationUrl.username
          || authorizationUrl.password
          || authorizationUrl.hash
          || !isExpectedProviderAuthorizationUrl(profile, authorizationUrl)
        ) {
          throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid provider URL", "CONNECTOR_BAD_RESPONSE");
        }
      }
      const handoff = parseCloudHandoff(response.handoff);
      return {
        authorizationUrl: authorizationUrl?.toString() ?? confirmationUrl.toString(),
        expiresAt: response.expiresAt,
        ...(handoff ? { handoff } : {}),
      };
    },
    async claim(values: { subject: string; companyId: string; profile?: PaperclipCloudConnectorProfileId; claimId: string; redemptionId: string }) {
      const profile = values.profile ?? "gmail.draft";
      return openCredentials(await call("claim", { ...values, profile }), sealPurpose("initial", profile), values.subject, values.companyId, profile);
    },
    async refresh(values: { subject: string; companyId: string; profile?: PaperclipCloudConnectorProfileId; refreshToken: string }) {
      const profile = values.profile ?? "gmail.draft";
      return openCredentials(
        await call("refresh", { ...values, profile }, { field: "refreshToken", value: values.refreshToken }),
        sealPurpose("access", profile),
        values.subject,
        values.companyId,
        profile,
      );
    },
    async revoke(values: { subject: string; companyId: string; profile?: PaperclipCloudConnectorProfileId; token: string }) {
      await call("revoke", { ...values, profile: values.profile ?? "gmail.draft" }, { field: "token", value: values.token });
    },
    async setWebhookBinding(values: {
      subject: string;
      companyId: string;
      id: string;
      installationId: string;
      connectionId: string;
      grantId: string;
      active: boolean;
      accessToken?: string;
    }) {
      if (values.active && !values.accessToken) {
        throw new PaperclipCloudConnectorError(
          "GitHub access token is required to authorize a webhook binding",
          "CONNECTOR_CONFIG_INVALID",
        );
      }
      const binding = JSON.stringify({
        id: values.id,
        installationId: values.installationId,
        connectionId: values.connectionId,
        grantId: values.grantId,
        active: values.active,
        ...(values.active ? { accessToken: values.accessToken } : {}),
      });
      await call("webhook-bind", { ...values, profile: "github.code" }, { field: "binding", value: binding });
    },
    async leaseEvents(values: { subject: string; companyId: string }): Promise<{ leaseId: string; events: SealedConnectorEvents["events"] } | null> {
      const response = await call("event-lease", values);
      if (Array.isArray(response.events) && response.events.length === 0) return null;
      if (typeof response.leaseId !== "string") {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid event lease", "CONNECTOR_BAD_RESPONSE");
      }
      const envelope = parseEnvelope(response.sealed, "events", "github", "github.code");
      const opened = unsealEvents(envelope, sealKey, config.instanceId, config.environment);
      if (opened.leaseId !== response.leaseId) {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector event lease did not match", "CONNECTOR_BINDING_MISMATCH");
      }
      return { leaseId: opened.leaseId, events: opened.events };
    },
    async acknowledgeEvents(values: { subject: string; companyId: string; leaseId: string; deliveryIds: string[] }): Promise<number> {
      const acknowledgement = JSON.stringify({ leaseId: values.leaseId, deliveryIds: values.deliveryIds });
      const response = await call("event-ack", values, { field: "acknowledgement", value: acknowledgement });
      const acknowledged = response.acknowledged;
      if (typeof acknowledged !== "number" || !Number.isSafeInteger(acknowledged) || acknowledged < 0) {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid acknowledgement", "CONNECTOR_BAD_RESPONSE");
      }
      return acknowledged;
    },
  };
}

function parseCloudHandoff(value: unknown): { kind: "paperclip_cloud"; session: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid handoff", "CONNECTOR_BAD_RESPONSE");
  }
  const record = value as Record<string, unknown>;
  const session = record.session;
  if (
    record.kind !== "tenant_background"
    || typeof session !== "string"
    || session.length < 16
    || session.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(session)
  ) {
    throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid handoff", "CONNECTOR_BAD_RESPONSE");
  }
  return { kind: "paperclip_cloud", session };
}

export type PaperclipCloudConnector = ReturnType<typeof createPaperclipCloudConnector>;
export type PaperclipCloudGoogleWorkspaceConnector = PaperclipCloudConnector;

/** Accept persisted Paperclip ID-era records while all new records use the Cloud strategy. */
export function isPaperclipCloudConnectorStrategy(value: unknown): boolean {
  return value === "paperclip_cloud_connector" || value === "paperclip_id_connector";
}

let capabilityCache: { key: string; expiresAt: number; profiles: PaperclipCloudConnectorProfileId[] } | null = null;

export async function paperclipCloudConnectorCapabilitiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaperclipCloudConnectorProfileId[]> {
  let config: PaperclipCloudConnectorConfig | null;
  try {
    config = paperclipCloudConnectorConfigFromEnv(env);
  } catch (error) {
    // Gallery discovery is useful even while connector enrollment is pending or
    // local connector settings are incomplete. Treat every connector-config
    // error as "no managed profiles" here; enrollment/status surfaces still
    // report the actionable configuration problem.
    if (error instanceof PaperclipCloudConnectorError) return [];
    throw error;
  }
  if (!config) return [];
  const key = `${config.baseUrl}|${config.instanceId}|${config.environment}`;
  if (capabilityCache?.key === key && capabilityCache.expiresAt > Date.now()) return capabilityCache.profiles;
  const connector = createPaperclipCloudConnector({ config });
  const profiles = await connector.getCapabilities();
  capabilityCache = { key, expiresAt: Date.now() + 60_000, profiles };
  return profiles;
}

function signRequest(payload: Record<string, unknown>, key: KeyObject): string {
  const header = { alg: "EdDSA", typ: JWS_TYP };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput, "utf8"), key).toString("base64url")}`;
}

function privateKey(value: string, curve: "ed25519" | "x25519"): KeyObject {
  try {
    let parsed: KeyObject;
    if (value.includes("BEGIN PRIVATE KEY")) {
      parsed = createPrivateKey(value);
    } else {
      const raw = Buffer.from(value, "base64url");
      parsed = raw.length === RAW_PRIVATE_KEY_BYTES
        ? createPrivateKey({
        key: Buffer.concat([curve === "ed25519" ? ED25519_PKCS8_PREFIX : X25519_PKCS8_PREFIX, raw]),
        format: "der",
        type: "pkcs8",
        })
        : createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    }
    if (parsed.asymmetricKeyType !== curve) throw new Error("wrong key type");
    return parsed;
  } catch {
    throw new PaperclipCloudConnectorError(`Paperclip Cloud ${curve} private key is invalid`, "CONNECTOR_CONFIG_INVALID");
  }
}

function parseEnvelope(
  value: unknown,
  purpose: SealedEnvelope["purpose"],
  provider: PaperclipCloudConnectorProvider,
  profile: PaperclipCloudConnectorProfileId,
): SealedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badEnvelope();
  const candidate = value as Partial<SealedEnvelope>;
  if (candidate.v !== 1 || candidate.alg !== SEAL_ALGORITHM || candidate.purpose !== purpose
    || candidate.provider !== provider || candidate.profile !== profile
    || typeof candidate.epk !== "string" || typeof candidate.iv !== "string" || typeof candidate.ct !== "string") {
    throw badEnvelope();
  }
  return candidate as SealedEnvelope;
}

function unseal(
  envelope: SealedEnvelope,
  recipientPrivateKey: KeyObject,
  instanceId: string,
  environment: string,
  provider: PaperclipCloudConnectorProvider,
  profile: PaperclipCloudConnectorProfileId,
  scopes: readonly string[],
): SealedConnectorCredentials {
  try {
    const parsed = decryptEnvelope(envelope, recipientPrivateKey, instanceId, environment, provider, profile, scopes) as Partial<SealedConnectorCredentials>;
    if (parsed.v !== 1 || typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0
      || !(parsed.refreshToken === null || typeof parsed.refreshToken === "string")
      || typeof parsed.tokenType !== "string"
      || !(parsed.accessTokenExpiresAt === null || typeof parsed.accessTokenExpiresAt === "string")
      || !(parsed.refreshTokenExpiresAt === null || typeof parsed.refreshTokenExpiresAt === "string")
      || !Array.isArray(parsed.scopes) || !parsed.scopes.every((scope) => typeof scope === "string")
      || typeof parsed.subject !== "string" || typeof parsed.companyId !== "string"
      || typeof parsed.instanceId !== "string" || typeof parsed.environment !== "string"
      || !(parsed.appSlug === undefined || (typeof parsed.appSlug === "string" && /^[a-z0-9-]{1,100}$/.test(parsed.appSlug)))
      || parsed.provider !== provider || parsed.profile !== profile) {
      throw badEnvelope();
    }
    return parsed as SealedConnectorCredentials;
  } catch (error) {
    if (error instanceof PaperclipCloudConnectorError) throw error;
    throw badEnvelope();
  }
}

function unsealEvents(
  envelope: SealedEnvelope,
  recipientPrivateKey: KeyObject,
  instanceId: string,
  environment: PaperclipCloudConnectorEnvironment,
): SealedConnectorEvents {
  try {
    const parsed = decryptEnvelope(envelope, recipientPrivateKey, instanceId, environment, "github", "github.code", []) as Partial<SealedConnectorEvents>;
    if (parsed.v !== 1 || parsed.instanceId !== instanceId || parsed.environment !== environment
      || typeof parsed.leaseId !== "string" || !Array.isArray(parsed.events)) throw badEnvelope();
    for (const event of parsed.events) {
      if (!isRecord(event) || typeof event.id !== "string" || event.provider !== "github"
        || typeof event.event !== "string" || !isRecord(event.payload) || !Array.isArray(event.bindingIds)
        || !event.bindingIds.every((id) => typeof id === "string")) throw badEnvelope();
    }
    return parsed as SealedConnectorEvents;
  } catch (error) {
    if (error instanceof PaperclipCloudConnectorError) throw error;
    throw badEnvelope();
  }
}

function decryptEnvelope(
  envelope: SealedEnvelope,
  recipientPrivateKey: KeyObject,
  instanceId: string,
  environment: string,
  provider: PaperclipCloudConnectorProvider,
  profile: PaperclipCloudConnectorProfileId,
  scopes: readonly string[],
): unknown {
  const ephemeralRaw = Buffer.from(envelope.epk, "base64url");
  if (ephemeralRaw.length !== 32) throw badEnvelope();
  const ephemeralKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralRaw]),
    format: "der",
    type: "spki",
  });
  const recipientJwk = createPublicKey(recipientPrivateKey).export({ format: "jwk" }) as { x?: string };
  if (!recipientJwk.x) throw badEnvelope();
  const recipientRaw = Buffer.from(recipientJwk.x, "base64url");
  if (envelope.provider !== provider || envelope.profile !== profile) throw badEnvelope();
  const aad = Buffer.from([
    1,
    SEAL_ALGORITHM,
    envelope.purpose,
    instanceId,
    environment,
    provider,
    profile,
    [...scopes].sort().join(" "),
  ].join("\n"), "utf8");
  const key = Buffer.from(hkdfSync(
    "sha256",
    diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralKey }),
    Buffer.concat([ephemeralRaw, recipientRaw]),
    aad,
    32,
  ));
  const iv = Buffer.from(envelope.iv, "base64url");
  const combined = Buffer.from(envelope.ct, "base64url");
  if (iv.length !== 12 || combined.length <= AES_TAG_BYTES) throw badEnvelope();
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AES_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(combined.subarray(-AES_TAG_BYTES));
  const plaintext = Buffer.concat([
    decipher.update(combined.subarray(0, -AES_TAG_BYTES)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

function badEnvelope() {
  return new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid sealed credential", "CONNECTOR_BAD_RESPONSE");
}

function sealPurpose(
  kind: "initial" | "access",
  _profile: PaperclipCloudConnectorProfileId,
): SealedEnvelope["purpose"] {
  return kind;
}

function connectorProfileDefinition(profile: PaperclipCloudConnectorProfileId): {
  provider: PaperclipCloudConnectorProvider;
  scopes: readonly string[];
} {
  if (isGitHubConnectorProfileId(profile)) {
    return { provider: "github", scopes: GITHUB_CONNECTOR_PROFILES[profile].scopes };
  }
  return { provider: "google", scopes: GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes };
}

function isExpectedProviderAuthorizationUrl(
  profile: PaperclipCloudConnectorProfileId,
  url: URL,
): boolean {
  if (isGitHubConnectorProfileId(profile)) {
    return url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize";
  }
  return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
}

function isPaperclipCloudConnectorProfileId(value: string): value is PaperclipCloudConnectorProfileId {
  return isGoogleWorkspaceConnectorProfileId(value) || isGitHubConnectorProfileId(value);
}

async function sha256Base64Url(value: string): Promise<string> {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && value.length === expected.length
    && expected.every((item) => value.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
