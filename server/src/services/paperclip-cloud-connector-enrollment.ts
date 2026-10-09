import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { runtimePublicOrigin } from "./cloud-runtime-identity.js";

const IDENTITY_VERSION = 1;
const ENROLLMENT_FILE = "paperclip-cloud-connector.json";
const REQUEST_TYPE = "paperclip-cloud-connector-request+jwt";

export type LocalConnectorEnvironment = "development" | "staging" | "production";

type PendingEnrollment = {
  enrollmentId: string;
  returnState: string;
  origin: string;
  expiresAt: string;
  companyId?: string;
  initiatedBy?: string;
  returnTo?: string;
};

export type PaperclipCloudConnectorIdentity = {
  version: 1;
  instanceId: string;
  environment: LocalConnectorEnvironment;
  brokerBaseUrl: string;
  signPrivateKey: string;
  signPublicKey: string;
  sealPrivateKey: string;
  sealPublicKey: string;
  status: "unenrolled" | "pending" | "active";
  origins: string[];
  pending?: PendingEnrollment;
  enrolledAt?: string;
};

export type PaperclipCloudConnectorEnrollmentStatus = {
  configured: boolean;
  status: PaperclipCloudConnectorIdentity["status"] | "not_configured" | "suspended" | "unverified";
  brokerBaseUrl: string;
  instanceId: string | null;
  environment: LocalConnectorEnvironment;
  origins: string[];
  verificationUrl?: string;
  expiresAt?: string;
};

export function paperclipCloudConnectorIdentityPath(): string {
  return path.join(resolvePaperclipInstanceRoot(), "secrets", ENROLLMENT_FILE);
}

export function loadPaperclipCloudConnectorIdentity(): PaperclipCloudConnectorIdentity | null {
  const filePath = paperclipCloudConnectorIdentityPath();
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parseIdentity(parsed);
  } catch {
    return null;
  }
}

export function paperclipCloudConnectorEnrollmentStatus(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipCloudConnectorEnrollmentStatus {
  const identity = loadPaperclipCloudConnectorIdentity();
  const managedInstanceId = env.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID?.trim();
  const managedSignPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY?.trim();
  const managedSealPrivateKey = env.PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY?.trim();
  const managedEnvironment = env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT?.trim();
  const hasManagedIdentityOverride = hasManagedConnectorIdentityOverride(env);
  if (hasManagedIdentityOverride) {
    const { brokerBaseUrl, environment } = connectorTarget(env);
    if (!managedInstanceId || !managedSignPrivateKey || !managedSealPrivateKey || !managedEnvironment) {
      return {
        configured: false,
        status: "unverified",
        brokerBaseUrl,
        instanceId: null,
        environment,
        origins: [],
      };
    }
    const resolvedOrigin = runtimePublicOrigin(env);
    const publicOrigin = resolvedOrigin ? normalizeInstanceOrigin(resolvedOrigin) : undefined;
    return {
      configured: true,
      status: "active",
      brokerBaseUrl,
      instanceId: managedInstanceId,
      environment,
      origins: publicOrigin ? [publicOrigin] : [],
    };
  }
  const { brokerBaseUrl, environment } = connectorTarget(env, identity);
  if (!identity) {
    return { configured: false, status: "not_configured", brokerBaseUrl, instanceId: null, environment, origins: [] };
  }
  if (!identityMatchesTarget(identity, { brokerBaseUrl, environment })) {
    return {
      configured: false,
      status: "unverified",
      brokerBaseUrl,
      instanceId: null,
      environment,
      origins: [],
    };
  }
  return {
    configured: identity.status === "active",
    status: identity.status,
    brokerBaseUrl,
    instanceId: identity.instanceId,
    environment,
    origins: [...identity.origins],
    ...(identity.pending ? {
      verificationUrl: `${brokerBaseUrl}/connections/enroll?id=${encodeURIComponent(identity.pending.enrollmentId)}`,
      expiresAt: identity.pending.expiresAt,
    } : {}),
  };
}

export async function startPaperclipCloudConnectorEnrollment(input: {
  origin: string;
  label?: string;
  companyId?: string;
  initiatedBy?: string;
  returnTo?: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<PaperclipCloudConnectorEnrollmentStatus> {
  return withEnrollmentMutationLock(() => startPaperclipCloudConnectorEnrollmentUnlocked(input));
}

async function startPaperclipCloudConnectorEnrollmentUnlocked(input: {
  origin: string;
  label?: string;
  companyId?: string;
  initiatedBy?: string;
  returnTo?: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<PaperclipCloudConnectorEnrollmentStatus> {
  const env = input.env ?? process.env;
  const request = input.request ?? fetch;
  if (hasManagedConnectorIdentityOverride(env)) {
    throw new Error("Paperclip Cloud self-host enrollment is unavailable with managed identity configuration");
  }
  const origin = normalizeInstanceOrigin(input.origin);
  const existingIdentity = loadPaperclipCloudConnectorIdentity();
  const target = connectorTarget(env, existingIdentity);
  let identity: PaperclipCloudConnectorIdentity;
  if (!existingIdentity) {
    identity = createIdentity(env);
  } else if (!identityMatchesTarget(existingIdentity, target)) {
    if (existingIdentity.status === "active") {
      throw new Error("Paperclip Cloud connector is enrolled with another target");
    }
    identity = createIdentity(env);
  } else {
    identity = existingIdentity;
  }
  if (identity.status === "pending" && identity.pending && Date.parse(identity.pending.expiresAt) > Date.now()) {
    if (identity.pending.origin !== origin) {
      throw new Error("Paperclip Cloud enrollment is already pending for another origin");
    }
    if (identity.pending.companyId !== input.companyId) {
      throw new Error("Paperclip Cloud enrollment is already pending for another company");
    }
    if (input.initiatedBy && identity.pending.initiatedBy && identity.pending.initiatedBy !== input.initiatedBy) {
      throw new Error("Paperclip Cloud enrollment is already pending for another administrator");
    }
    return paperclipCloudConnectorEnrollmentStatus(env);
  }
  const returnState = randomBytes(32).toString("base64url");
  const returnUri = `${origin}/api/tools/oauth/cloud-connector/enrollment-callback`;
  const response = await request(`${identity.brokerBaseUrl}/v1/connector/enrollments`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      instanceId: identity.instanceId,
      environment: identity.environment,
      origin,
      returnUri,
      returnState,
      label: input.label?.trim() || process.env.PAPERCLIP_INSTANCE_ID?.trim() || "Self-hosted Paperclip",
      signPublicKey: identity.signPublicKey,
      sealPublicKey: identity.sealPublicKey,
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) throw new Error("Paperclip Cloud enrollment is unavailable");
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.enrollmentId !== "string" || typeof body.verificationUrl !== "string" || typeof body.expiresAt !== "string") {
    throw new Error("Paperclip Cloud returned an invalid enrollment response");
  }
  const verificationUrl = new URL(body.verificationUrl);
  if (verificationUrl.origin !== identity.brokerBaseUrl
    || verificationUrl.username || verificationUrl.password || verificationUrl.hash
    || verificationUrl.pathname !== "/connections/enroll"
    || verificationUrl.searchParams.size !== 1
    || verificationUrl.searchParams.get("id") !== body.enrollmentId) {
    throw new Error("Paperclip Cloud returned an invalid enrollment destination");
  }
  identity = {
    ...identity,
    status: "pending",
    pending: {
      enrollmentId: body.enrollmentId,
      returnState,
      origin,
      expiresAt: body.expiresAt,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}),
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    },
  };
  saveIdentity(identity);
  return {
    ...paperclipCloudConnectorEnrollmentStatus(env),
    verificationUrl: verificationUrl.toString(),
    expiresAt: body.expiresAt,
  };
}

export async function completePaperclipCloudConnectorEnrollment(input: {
  enrollmentId: string;
  approvalCode: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<PaperclipCloudConnectorEnrollmentStatus> {
  return withEnrollmentMutationLock(() => completePaperclipCloudConnectorEnrollmentUnlocked(input));
}

async function completePaperclipCloudConnectorEnrollmentUnlocked(input: {
  enrollmentId: string;
  approvalCode: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<PaperclipCloudConnectorEnrollmentStatus> {
  const identity = loadPaperclipCloudConnectorIdentity();
  const pending = identity?.pending;
  if (hasManagedConnectorIdentityOverride(input.env ?? process.env)
    || !identity || !pending || identity.status !== "pending"
    || pending.enrollmentId !== input.enrollmentId || pending.returnState !== input.state
    || Date.parse(pending.expiresAt) <= Date.now()
    || !identityMatchesTarget(identity, connectorTarget(input.env ?? process.env, identity))) {
    throw new Error("Invalid or expired Paperclip Cloud enrollment state");
  }
  const audience = `${identity.brokerBaseUrl}/v1/connector/enrollment-claims`;
  const now = Math.floor(Date.now() / 1_000);
  const requestToken = signRequest({
    iss: identity.instanceId,
    aud: audience,
    sub: "self-hosted-admin",
    cid: "self-hosted",
    env: identity.environment,
    op: "enroll",
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    ah: hash(input.approvalCode),
  }, privateKey(identity.signPrivateKey));
  const response = await (input.request ?? fetch)(audience, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ request: requestToken, enrollmentId: input.enrollmentId, approvalCode: input.approvalCode }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) throw new Error("Paperclip Cloud enrollment could not be completed");
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || body.id !== identity.instanceId || body.environment !== identity.environment
    || !Array.isArray(body.origins) || !body.origins.includes(pending.origin)) {
    throw new Error("Paperclip Cloud returned an invalid enrollment binding");
  }
  saveIdentity({
    ...identity,
    status: "active",
    origins: body.origins.filter((value): value is string => typeof value === "string"),
    pending: undefined,
    enrolledAt: new Date().toISOString(),
  });
  return paperclipCloudConnectorEnrollmentStatus(input.env ?? process.env);
}

function createIdentity(env: NodeJS.ProcessEnv): PaperclipCloudConnectorIdentity {
  const signing = generateKeyPairSync("ed25519");
  const sealing = generateKeyPairSync("x25519");
  const { brokerBaseUrl, environment } = connectorTarget(env);
  const identity: PaperclipCloudConnectorIdentity = {
    version: IDENTITY_VERSION,
    instanceId: `inst_${randomUUID()}`,
    environment,
    brokerBaseUrl,
    signPrivateKey: rawKey(signing.privateKey, "d"),
    signPublicKey: rawKey(signing.publicKey, "x"),
    sealPrivateKey: rawKey(sealing.privateKey, "d"),
    sealPublicKey: rawKey(sealing.publicKey, "x"),
    status: "unenrolled",
    origins: [],
  };
  saveIdentity(identity);
  return identity;
}

function saveIdentity(identity: PaperclipCloudConnectorIdentity): void {
  const filePath = paperclipCloudConnectorIdentityPath();
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
}

function parseIdentity(value: unknown): PaperclipCloudConnectorIdentity {
  if (!isRecord(value) || value.version !== IDENTITY_VERSION
    || typeof value.instanceId !== "string" || !value.instanceId.startsWith("inst_")
    || !isEnvironment(value.environment) || typeof value.brokerBaseUrl !== "string"
    || typeof value.signPrivateKey !== "string" || typeof value.signPublicKey !== "string"
    || typeof value.sealPrivateKey !== "string" || typeof value.sealPublicKey !== "string"
    || (value.status !== "unenrolled" && value.status !== "pending" && value.status !== "active")
    || !Array.isArray(value.origins) || !value.origins.every((origin) => typeof origin === "string")) {
    throw new Error("Invalid Paperclip Cloud connector identity");
  }
  return value as PaperclipCloudConnectorIdentity;
}

function connectorEnvironment(
  env: NodeJS.ProcessEnv,
  fallback?: LocalConnectorEnvironment,
  brokerBaseUrl = "https://my.paperclip.app",
): LocalConnectorEnvironment {
  const host = new URL(brokerBaseUrl).hostname.toLowerCase();
  const inferred = host === "my.paperclip.app"
    ? "production"
    : host === "my-staging.paperclip.app"
      ? "staging"
      : "development";
  const value = env.PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT?.trim() || fallback || inferred;
  if (!isEnvironment(value)) throw new Error("Paperclip Cloud connector environment is invalid");
  if ((host === "my.paperclip.app" && value !== "production")
    || (host === "my-staging.paperclip.app" && value !== "staging")) {
    throw new Error("Paperclip Cloud connector broker and environment do not match");
  }
  return value;
}

function connectorTarget(
  env: NodeJS.ProcessEnv,
  identity?: PaperclipCloudConnectorIdentity | null,
): Pick<PaperclipCloudConnectorIdentity, "brokerBaseUrl" | "environment"> {
  const brokerOverride = env.PAPERCLIP_CLOUD_CONNECTOR_BASE_URL?.trim() || undefined;
  const brokerBaseUrl = normalizeBrokerOrigin(
    brokerOverride ?? identity?.brokerBaseUrl ?? "https://my.paperclip.app",
  );
  return {
    brokerBaseUrl,
    environment: connectorEnvironment(env, brokerOverride ? undefined : identity?.environment, brokerBaseUrl),
  };
}

function identityMatchesTarget(
  identity: PaperclipCloudConnectorIdentity,
  target: Pick<PaperclipCloudConnectorIdentity, "brokerBaseUrl" | "environment">,
): boolean {
  return identity.brokerBaseUrl === target.brokerBaseUrl && identity.environment === target.environment;
}

function hasManagedConnectorIdentityOverride(env: NodeJS.ProcessEnv): boolean {
  return [
    env.PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID,
    env.PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY,
    env.PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY,
  ].some((value) => Boolean(value?.trim()));
}

function isEnvironment(value: unknown): value is LocalConnectorEnvironment {
  return value === "development" || value === "staging" || value === "production";
}

function normalizeBrokerOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new Error("Paperclip Cloud connector URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Paperclip Cloud connector URL must be an origin");
  }
  return url.origin;
}

function normalizeInstanceOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new Error("Paperclip Cloud enrollment requires HTTPS except on loopback");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Paperclip Cloud enrollment requires an exact origin");
  }
  return url.origin;
}

function privateKey(raw: string): KeyObject {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(raw, "base64url")]), format: "der", type: "pkcs8" });
}

function rawKey(key: KeyObject, field: "d" | "x"): string {
  const value = (key.export({ format: "jwk" }) as Record<string, unknown>)[field];
  if (typeof value !== "string") throw new Error("Unable to export connector key");
  return value;
}

function signRequest(payload: Record<string, unknown>, key: KeyObject): string {
  const header = { alg: "EdDSA", typ: REQUEST_TYPE };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput, "utf8"), key).toString("base64url")}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let enrollmentMutationTail: Promise<void> = Promise.resolve();

async function withEnrollmentMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = enrollmentMutationTail;
  let release!: () => void;
  enrollmentMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
