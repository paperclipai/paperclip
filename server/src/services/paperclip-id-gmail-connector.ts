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

export const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const GMAIL_CONNECTOR_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export type PaperclipIdConnectorEnvironment = "development" | "staging" | "production";
export type PaperclipIdConnectorOperation = "session" | "claim" | "refresh" | "revoke";

export type PaperclipIdGmailConnectorConfig = {
  baseUrl: string;
  instanceId: string;
  environment: PaperclipIdConnectorEnvironment;
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
};

type SealedEnvelope = {
  v: 1;
  alg: "X25519-HKDF-SHA256-A256GCM";
  purpose: "gmail-initial-tokens" | "gmail-access-token";
  epk: string;
  iv: string;
  ct: string;
};

type ConnectorResponse = {
  authorizationUrl?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  claimId?: unknown;
  sealed?: unknown;
};

const ENDPOINTS: Record<PaperclipIdConnectorOperation, string> = {
  session: "/api/connect/sessions",
  claim: "/api/connect/claims",
  refresh: "/api/connect/refresh",
  revoke: "/api/connect/revoke",
};
const JWS_TYP = "paperclip-connector-request+jwt";
const SEAL_ALGORITHM = "X25519-HKDF-SHA256-A256GCM";
const AES_TAG_BYTES = 16;
const RAW_PRIVATE_KEY_BYTES = 32;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** A stable, intentionally detail-free error for all remote broker failures. */
export class PaperclipIdConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PaperclipIdConnectorError";
  }
}

export function paperclipIdGmailConnectorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipIdGmailConnectorConfig | null {
  const instanceId = env.PAPERCLIP_ID_CONNECTOR_INSTANCE_ID?.trim();
  const signPrivateKey = env.PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY?.trim();
  const sealPrivateKey = env.PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY?.trim();
  const environment = env.PAPERCLIP_ID_CONNECTOR_ENVIRONMENT?.trim();
  const baseUrl = env.PAPERCLIP_ID_CONNECTOR_BASE_URL?.trim() || "https://id.paperclip.app";
  const values = [instanceId, signPrivateKey, sealPrivateKey, environment];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value)) {
    throw new PaperclipIdConnectorError("Paperclip ID Gmail connector configuration is incomplete", "CONNECTOR_CONFIG_INCOMPLETE");
  }
  if (environment !== "development" && environment !== "staging" && environment !== "production") {
    throw new PaperclipIdConnectorError("Paperclip ID Gmail connector environment is invalid", "CONNECTOR_CONFIG_INVALID");
  }
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && !(parsedBaseUrl.protocol === "http:" && isLoopback(parsedBaseUrl.hostname))) {
    throw new PaperclipIdConnectorError("Paperclip ID Gmail connector URL must use HTTPS", "CONNECTOR_CONFIG_INVALID");
  }
  if (parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new PaperclipIdConnectorError("Paperclip ID Gmail connector URL is invalid", "CONNECTOR_CONFIG_INVALID");
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

export function createPaperclipIdGmailConnector(input: {
  config: PaperclipIdGmailConnectorConfig;
  request?: typeof fetch;
  now?: () => number;
}) {
  const config = input.config;
  const request = input.request ?? fetch;
  const now = input.now ?? Date.now;
  const signingKey = privateKey(config.signPrivateKey, "ed25519");
  const sealKey = privateKey(config.sealPrivateKey, "x25519");

  async function call(
    operation: PaperclipIdConnectorOperation,
    claims: { subject: string; companyId: string; returnUri?: string; returnState?: string; claimId?: string },
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
      throw new PaperclipIdConnectorError("Paperclip ID Gmail connector is unavailable", "CONNECTOR_UNAVAILABLE");
    }
    if (operation === "revoke" && response.status === 204) return {};
    if (!response.ok) {
      throw new PaperclipIdConnectorError(
        "Paperclip ID Gmail connector rejected the request",
        response.status === 409 ? "REAUTHORIZATION_REQUIRED" : "CONNECTOR_REQUEST_FAILED",
        response.status,
      );
    }
    try {
      return await response.json() as ConnectorResponse;
    } catch {
      throw new PaperclipIdConnectorError("Paperclip ID Gmail connector returned an invalid response", "CONNECTOR_BAD_RESPONSE");
    }
  }

  function openCredentials(
    response: ConnectorResponse,
    purpose: SealedEnvelope["purpose"],
    subject: string,
    companyId: string,
  ): SealedGmailCredentials {
    const envelope = parseEnvelope(response.sealed, purpose);
    const credentials = unseal(envelope, sealKey, config.instanceId, config.environment);
    if (credentials.subject !== subject || credentials.companyId !== companyId) {
      throw new PaperclipIdConnectorError("Paperclip ID Gmail credential binding did not match", "CONNECTOR_BINDING_MISMATCH");
    }
    if (!sameStringSet(credentials.scopes, GMAIL_CONNECTOR_SCOPES)) {
      throw new PaperclipIdConnectorError("Paperclip ID Gmail scope grant did not match", "REAUTHORIZATION_REQUIRED");
    }
    return credentials;
  }

  return {
    async startAuthorization(values: { subject: string; companyId: string; returnUri: string; returnState: string }) {
      const response = await call("session", values);
      if (typeof response.authorizationUrl !== "string" || typeof response.expiresAt !== "string") {
        throw new PaperclipIdConnectorError("Paperclip ID Gmail connector returned an invalid session", "CONNECTOR_BAD_RESPONSE");
      }
      if (!sameStringSet(response.scopes, GMAIL_CONNECTOR_SCOPES)) {
        throw new PaperclipIdConnectorError("Paperclip ID Gmail connector returned an invalid scope set", "CONNECTOR_BAD_RESPONSE");
      }
      const authorizationUrl = new URL(response.authorizationUrl);
      if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com") {
        throw new PaperclipIdConnectorError("Paperclip ID Gmail connector returned an invalid authorization URL", "CONNECTOR_BAD_RESPONSE");
      }
      return { authorizationUrl: authorizationUrl.toString(), expiresAt: response.expiresAt };
    },
    async claim(values: { subject: string; companyId: string; claimId: string }) {
      return openCredentials(await call("claim", values), "gmail-initial-tokens", values.subject, values.companyId);
    },
    async refresh(values: { subject: string; companyId: string; refreshToken: string }) {
      return openCredentials(
        await call("refresh", values, { field: "refreshToken", value: values.refreshToken }),
        "gmail-access-token",
        values.subject,
        values.companyId,
      );
    },
    async revoke(values: { subject: string; companyId: string; token: string }) {
      await call("revoke", values, { field: "token", value: values.token });
    },
  };
}

export type PaperclipIdGmailConnector = ReturnType<typeof createPaperclipIdGmailConnector>;

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
    throw new PaperclipIdConnectorError(`Paperclip ID ${curve} private key is invalid`, "CONNECTOR_CONFIG_INVALID");
  }
}

function parseEnvelope(value: unknown, purpose: SealedEnvelope["purpose"]): SealedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badEnvelope();
  const candidate = value as Partial<SealedEnvelope>;
  if (candidate.v !== 1 || candidate.alg !== SEAL_ALGORITHM || candidate.purpose !== purpose
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
    const aad = Buffer.from([1, SEAL_ALGORITHM, envelope.purpose, instanceId, environment].join("\n"), "utf8");
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
      || typeof parsed.subject !== "string" || typeof parsed.companyId !== "string") {
      throw badEnvelope();
    }
    return parsed as SealedGmailCredentials;
  } catch (error) {
    if (error instanceof PaperclipIdConnectorError) throw error;
    throw badEnvelope();
  }
}

function badEnvelope() {
  return new PaperclipIdConnectorError("Paperclip ID Gmail connector returned an invalid sealed credential", "CONNECTOR_BAD_RESPONSE");
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

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
