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
  GOOGLE_WORKSPACE_CONNECTOR_PROFILES,
  isGoogleWorkspaceConnectorProfileId,
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
export type PaperclipCloudConnectorOperation = "status" | "session" | "claim" | "refresh" | "revoke";

export type PaperclipCloudConnectorConfig = {
  baseUrl: string;
  instanceId: string;
  environment: PaperclipCloudConnectorEnvironment;
  signPrivateKey: string;
  sealPrivateKey: string;
};

export type SealedGmailCredentials = {
  v: 1;
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  accessTokenExpiresAt: string;
  scopes: string[];
  subject: string;
  companyId: string;
  instanceId: string;
  environment: PaperclipCloudConnectorEnvironment;
  provider: "google";
  profile: string;
};

export type SealedGoogleWorkspaceCredentials = SealedGmailCredentials;

type SealedEnvelope = {
  v: 1;
  alg: "X25519-HKDF-SHA256-A256GCM";
  purpose: "initial" | "access";
  provider: "google";
  profile: GoogleWorkspaceConnectorProfileId;
  epk: string;
  iv: string;
  ct: string;
};

type ConnectorResponse = {
  confirmationUrl?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  claimId?: unknown;
  sealed?: unknown;
  profiles?: unknown;
  protocolVersion?: unknown;
  providers?: unknown;
  active?: unknown;
  status?: unknown;
};

const ENDPOINTS: Record<PaperclipCloudConnectorOperation, string> = {
  status: "/v1/connector/instance-status",
  session: "/v1/connector/sessions",
  claim: "/v1/connector/claims",
  refresh: "/v1/connector/refresh",
  revoke: "/v1/connector/revoke",
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
    claims: { subject: string; companyId: string; profile?: GoogleWorkspaceConnectorProfileId; returnUri?: string; returnState?: string; claimId?: string; redemptionId?: string },
    secret?: { field: "refreshToken" | "token"; value: string },
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
      payload.prv = "google";
      payload.prf = claims.profile;
      payload.scp = [...GOOGLE_WORKSPACE_CONNECTOR_PROFILES[claims.profile].scopes];
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
    profile: GoogleWorkspaceConnectorProfileId,
  ): SealedGmailCredentials {
    const envelope = parseEnvelope(response.sealed, purpose);
    const credentials = unseal(
      envelope,
      sealKey,
      config.instanceId,
      config.environment,
      "google",
      profile,
      GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes,
    );
    if (
      credentials.instanceId !== config.instanceId
      || credentials.environment !== config.environment
      || credentials.subject !== subject
      || credentials.companyId !== companyId
      || credentials.provider !== "google"
    ) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud Gmail credential binding did not match", "CONNECTOR_BINDING_MISMATCH");
    }
    if (credentials.profile !== profile) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud connector profile binding did not match", "CONNECTOR_BINDING_MISMATCH");
    }
    if (!sameStringSet(credentials.scopes, GOOGLE_WORKSPACE_CONNECTOR_PROFILES[profile].scopes)) {
      throw new PaperclipCloudConnectorError("Paperclip Cloud Gmail scope grant did not match", "REAUTHORIZATION_REQUIRED");
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
    async getCapabilities(): Promise<GoogleWorkspaceConnectorProfileId[]> {
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
        typeof value === "string" && isGoogleWorkspaceConnectorProfileId(value) ? [value] : []
      ))];
    },
    async startAuthorization(values: { subject: string; companyId: string; profile?: GoogleWorkspaceConnectorProfileId; returnUri: string; returnState: string }) {
      const profile = values.profile ?? "gmail.draft";
      const response = await call("session", { ...values, profile });
      if (typeof response.confirmationUrl !== "string" || typeof response.expiresAt !== "string") {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid session", "CONNECTOR_BAD_RESPONSE");
      }
      const confirmationUrl = new URL(response.confirmationUrl);
      const expectedBroker = new URL(config.baseUrl);
      if (confirmationUrl.origin !== expectedBroker.origin || confirmationUrl.pathname !== "/connections/confirm") {
        throw new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid confirmation URL", "CONNECTOR_BAD_RESPONSE");
      }
      return { authorizationUrl: confirmationUrl.toString(), expiresAt: response.expiresAt };
    },
    async claim(values: { subject: string; companyId: string; profile?: GoogleWorkspaceConnectorProfileId; claimId: string; redemptionId: string }) {
      const profile = values.profile ?? "gmail.draft";
      return openCredentials(await call("claim", { ...values, profile }), sealPurpose("initial", profile), values.subject, values.companyId, profile);
    },
    async refresh(values: { subject: string; companyId: string; profile?: GoogleWorkspaceConnectorProfileId; refreshToken: string }) {
      const profile = values.profile ?? "gmail.draft";
      return openCredentials(
        await call("refresh", { ...values, profile }, { field: "refreshToken", value: values.refreshToken }),
        sealPurpose("access", profile),
        values.subject,
        values.companyId,
        profile,
      );
    },
    async revoke(values: { subject: string; companyId: string; profile?: GoogleWorkspaceConnectorProfileId; token: string }) {
      await call("revoke", { ...values, profile: values.profile ?? "gmail.draft" }, { field: "token", value: values.token });
    },
  };
}

export type PaperclipCloudConnector = ReturnType<typeof createPaperclipCloudConnector>;
export type PaperclipCloudGoogleWorkspaceConnector = PaperclipCloudConnector;

/** Accept persisted Paperclip ID-era records while all new records use the Cloud strategy. */
export function isPaperclipCloudConnectorStrategy(value: unknown): boolean {
  return value === "paperclip_cloud_connector" || value === "paperclip_id_connector";
}

let capabilityCache: { key: string; expiresAt: number; profiles: GoogleWorkspaceConnectorProfileId[] } | null = null;

export async function paperclipCloudConnectorCapabilitiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GoogleWorkspaceConnectorProfileId[]> {
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

function parseEnvelope(value: unknown, purpose: SealedEnvelope["purpose"]): SealedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badEnvelope();
  const candidate = value as Partial<SealedEnvelope>;
  if (candidate.v !== 1 || candidate.alg !== SEAL_ALGORITHM || candidate.purpose !== purpose
    || candidate.provider !== "google" || !candidate.profile || !isGoogleWorkspaceConnectorProfileId(candidate.profile)
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
  provider: "google",
  profile: GoogleWorkspaceConnectorProfileId,
  scopes: readonly string[],
): SealedGmailCredentials {
  try {
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
    const parsed = JSON.parse(plaintext.toString("utf8")) as Partial<SealedGmailCredentials>;
    if (parsed.v !== 1 || typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0
      || !(parsed.refreshToken === null || typeof parsed.refreshToken === "string")
      || typeof parsed.tokenType !== "string" || typeof parsed.accessTokenExpiresAt !== "string"
      || !Array.isArray(parsed.scopes) || !parsed.scopes.every((scope) => typeof scope === "string")
      || typeof parsed.subject !== "string" || typeof parsed.companyId !== "string"
      || typeof parsed.instanceId !== "string" || typeof parsed.environment !== "string"
      || parsed.provider !== provider || parsed.profile !== profile) {
      throw badEnvelope();
    }
    return parsed as SealedGmailCredentials;
  } catch (error) {
    if (error instanceof PaperclipCloudConnectorError) throw error;
    throw badEnvelope();
  }
}

function badEnvelope() {
  return new PaperclipCloudConnectorError("Paperclip Cloud connector returned an invalid sealed credential", "CONNECTOR_BAD_RESPONSE");
}

function sealPurpose(
  kind: "initial" | "access",
  _profile: GoogleWorkspaceConnectorProfileId,
): SealedEnvelope["purpose"] {
  return kind;
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
