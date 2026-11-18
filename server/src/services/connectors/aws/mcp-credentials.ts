import { createHash } from "node:crypto";
import {
  AssumeRoleCommand,
  AssumeRoleWithWebIdentityCommand,
  GetFederationTokenCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { CreateOAuth2TokenWithIAMCommand, SigninClient } from "@aws-sdk/client-signin";
import { getConnectableAppDefinition } from "@paperclipai/shared";

/**
 * Credentials for AWS's hosted MCP server, minted on the control plane for each
 * connection. A connection proves who it is with a Paperclip-signed OIDC token
 * (role method) or its own stored access key, gets short-lived AWS credentials,
 * and exchanges them for a one-hour MCP bearer token. Agents never see any of it.
 */

export const AWS_MCP_SOURCE_TEMPLATE_KEY = "aws";
/** The `credentialMinter` value AWS methods declare in their app definition. */
export const AWS_MCP_CREDENTIAL_MINTER = "aws_mcp";
export const AWS_MCP_METHOD_KEYS = ["aws-role", "aws-access-key"] as const;
export type AwsMcpMethodKey = (typeof AWS_MCP_METHOD_KEYS)[number];
export const AWS_MCP_ENDPOINT_REGIONS = [
  "us-east-1", "us-west-2", "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
] as const;
export const AWS_MCP_STS_AUDIENCE = "sts.amazonaws.com";
export const AWS_MCP_TOKEN_RESOURCE = "aws-mcp.amazonaws.com";
/** Read-only sessions also need the sign-in policy, or AWS refuses the token exchange. */
export const AWS_MCP_READ_ONLY_SESSION_POLICIES = [
  "arn:aws:iam::aws:policy/ReadOnlyAccess",
  "arn:aws:iam::aws:policy/AWSMCPSignInOAuthAccessPolicy",
] as const;
export const AWS_MCP_ACCESS_KEY_ID_PATH = "credentials.accessKeyId";
export const AWS_MCP_SECRET_ACCESS_KEY_PATH = "credentials.secretAccessKey";
const SESSION_SECONDS = 3600;
/** Each AWS request in a mint must finish within this, so a stalled AWS never holds a tool call. */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;
/** Mint again this long before the token expires, so an in-flight call never carries an expiring token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;

export type AwsMcpAccessLevel = "read_only" | "full";

export interface AwsMcpSettings {
  method: AwsMcpMethodKey;
  roleArn: string | null;
  endpointRegion: (typeof AWS_MCP_ENDPOINT_REGIONS)[number];
  accessLevel: AwsMcpAccessLevel;
}

export interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type AwsMcpCredentialErrorCode =
  | "aws_mcp_settings_invalid"
  | "aws_identity_unavailable"
  | "aws_issuer_changed"
  | "aws_role_access_denied"
  | "aws_access_key_invalid"
  | "aws_mcp_signin_denied"
  | "aws_unavailable";

/** A failure with a plain-language message. AWS's own message is never shown, since it can carry account IDs and ARNs. */
export class AwsMcpCredentialError extends Error {
  constructor(
    readonly code: AwsMcpCredentialErrorCode,
    readonly status: number,
    message: string,
    readonly health: "degraded" | "error",
    readonly awsErrorName?: string,
  ) {
    super(message);
    this.name = "AwsMcpCredentialError";
  }
}

interface ConnectionLike {
  id: string;
  transport: string;
  config: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The credential minter the connection's method declares in its app definition, if any. */
export function connectionCredentialMinter(connection: ConnectionLike): string | null {
  if (connection.transport !== "mcp_remote") return null;
  const slug = connection.config.sourceTemplateKey;
  const methodKey = connection.config.connectionMethodKey;
  if (typeof slug !== "string" || typeof methodKey !== "string") return null;
  const method = getConnectableAppDefinition(slug)?.methods.find((candidate) => candidate.key === methodKey);
  return method?.credentialMinter ?? null;
}

/** The method's declaration decides: a connection whose method mints AWS MCP credentials. */
export function isAwsMcpConnection(connection: ConnectionLike): boolean {
  return connectionCredentialMinter(connection) === AWS_MCP_CREDENTIAL_MINTER;
}

/** Saved settings, rechecked at call time: the URL must be AWS's endpoint for the saved region. */
export function awsMcpSettings(connection: ConnectionLike & { config: Record<string, unknown> }): AwsMcpSettings {
  const invalid = () => new AwsMcpCredentialError(
    "aws_mcp_settings_invalid", 422,
    "This AWS connection's settings are incomplete. Reconnect AWS.", "error",
  );
  const method = connection.config.connectionMethodKey;
  if (!(AWS_MCP_METHOD_KEYS as readonly unknown[]).includes(method)) throw invalid();
  const values = asRecord(connection.config.methodConfig);
  const endpointRegion = values.endpointRegion;
  if (!(AWS_MCP_ENDPOINT_REGIONS as readonly unknown[]).includes(endpointRegion)) throw invalid();
  if (connection.config.url !== `https://aws-mcp.${endpointRegion}.api.aws/mcp`) throw invalid();
  const roleArn = typeof values.roleArn === "string" && values.roleArn.trim() ? values.roleArn.trim() : null;
  if (roleArn !== null && !ROLE_ARN_PATTERN.test(roleArn)) throw invalid();
  if (method === "aws-role" && !roleArn) throw invalid();
  const accessLevel = values.accessLevel === "full" ? "full" : "read_only";
  return {
    method: method as AwsMcpMethodKey,
    roleArn,
    endpointRegion: endpointRegion as AwsMcpSettings["endpointRegion"],
    accessLevel,
  };
}

/** `paperclip-<name>` in the characters STS allows, so CloudTrail shows which connection acted. */
export function awsSessionName(connectionName: string, maxLength = 64): string {
  const cleaned = connectionName.toLowerCase().replace(/[^a-z0-9+=,.@-]+/g, "-").replace(/^-+|-+$/g, "");
  return `paperclip-${cleaned || "connection"}`.slice(0, maxLength);
}

/** The four AWS calls the minter makes. Tests replace them with a fake AWS. */
export interface AwsMcpClients {
  assumeRoleWithWebIdentity(input: {
    region: string; roleArn: string; sessionName: string; webIdentityToken: string; policyArns?: readonly string[]; signal?: AbortSignal;
  }): Promise<AwsSessionCredentials>;
  assumeRole(input: {
    region: string; credentials: AwsSessionCredentials; roleArn: string; sessionName: string; policyArns?: readonly string[]; signal?: AbortSignal;
  }): Promise<AwsSessionCredentials>;
  getFederationToken(input: {
    region: string; credentials: AwsSessionCredentials; name: string; policyArns: readonly string[]; signal?: AbortSignal;
  }): Promise<AwsSessionCredentials>;
  createMcpToken(input: { region: string; credentials: AwsSessionCredentials; signal?: AbortSignal }): Promise<{ token: string; expiresInSeconds: number }>;
}

function stsCredentials(value: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } | undefined): AwsSessionCredentials {
  if (!value?.AccessKeyId || !value.SecretAccessKey) throw new Error("AWS returned no credentials");
  return {
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    sessionToken: value.SessionToken,
    expiration: value.Expiration,
  };
}

const policyArnList = (arns?: readonly string[]) => arns?.length ? { PolicyArns: arns.map((arn) => ({ arn })) } : {};

export const sdkAwsMcpClients: AwsMcpClients = {
  async assumeRoleWithWebIdentity(input) {
    // No caller credentials: the signed web identity token is the proof.
    const sts = new STSClient({ region: input.region, credentials: { accessKeyId: "none", secretAccessKey: "none" } });
    const out = await sts.send(new AssumeRoleWithWebIdentityCommand({
      RoleArn: input.roleArn, RoleSessionName: input.sessionName, WebIdentityToken: input.webIdentityToken,
      DurationSeconds: SESSION_SECONDS, ...policyArnList(input.policyArns),
    }), { abortSignal: input.signal });
    return stsCredentials(out.Credentials);
  },
  async assumeRole(input) {
    const sts = new STSClient({ region: input.region, credentials: input.credentials });
    const out = await sts.send(new AssumeRoleCommand({
      RoleArn: input.roleArn, RoleSessionName: input.sessionName,
      DurationSeconds: SESSION_SECONDS, ...policyArnList(input.policyArns),
    }), { abortSignal: input.signal });
    return stsCredentials(out.Credentials);
  },
  async getFederationToken(input) {
    const sts = new STSClient({ region: input.region, credentials: input.credentials });
    const out = await sts.send(new GetFederationTokenCommand({
      Name: input.name, DurationSeconds: SESSION_SECONDS, ...policyArnList(input.policyArns),
    }), { abortSignal: input.signal });
    return stsCredentials(out.Credentials);
  },
  async createMcpToken(input) {
    const signin = new SigninClient({ region: input.region, credentials: input.credentials });
    const out = await signin.send(new CreateOAuth2TokenWithIAMCommand({
      grantType: "client_credentials", resource: AWS_MCP_TOKEN_RESOURCE,
    } as ConstructorParameters<typeof CreateOAuth2TokenWithIAMCommand>[0]), { abortSignal: input.signal });
    const token = (out as { accessToken?: string }).accessToken;
    const expiresInSeconds = (out as { expiresIn?: number }).expiresIn ?? SESSION_SECONDS;
    if (!token) throw new Error("AWS returned no MCP token");
    return { token, expiresInSeconds };
  },
};

type Step = "identity" | "role" | "access_key" | "federation" | "signin";

function awsErrorName(error: unknown): string | undefined {
  const record = asRecord(error);
  return typeof record.name === "string" ? record.name : undefined;
}

function awsHttpStatus(error: unknown): number | undefined {
  const status = asRecord(asRecord(error).$metadata).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

/** Maps an AWS failure to a stable code and a message that names the fix, never AWS's raw text. */
export function classifyAwsMcpError(step: Step, error: unknown): AwsMcpCredentialError {
  if (error instanceof AwsMcpCredentialError) return error;
  const name = awsErrorName(error);
  const status = awsHttpStatus(error);
  const details = asRecord(asRecord(error).details);
  if (step === "identity") {
    if (details.code === "workload_identity_issuer_changed") {
      return new AwsMcpCredentialError(
        "aws_issuer_changed", 409,
        "This Paperclip instance's address changed since AWS was connected. Register the new identity provider address in AWS, then reconnect AWS.",
        "error",
      );
    }
    if (details.code === "workload_identity_unavailable") {
      return new AwsMcpCredentialError(
        "aws_identity_unavailable", 422,
        "The AWS role method needs this Paperclip instance to have a stable public HTTPS address. Use an access key instead.",
        "error",
      );
    }
    return new AwsMcpCredentialError("aws_unavailable", 503, "Paperclip could not prepare this AWS connection's identity. Try again.", "degraded");
  }
  const transient = !status || status >= 500 || status === 429
    || ["ThrottlingException", "Throttling", "TimeoutError", "RequestTimeout", "IDPCommunicationError"].includes(name ?? "");
  if (transient) {
    return new AwsMcpCredentialError("aws_unavailable", 503, "AWS did not respond. Try again shortly.", "degraded", name);
  }
  if (step === "signin") {
    return new AwsMcpCredentialError(
      "aws_mcp_signin_denied", 403,
      "AWS refused the MCP sign-in. Attach the AWSMCPSignInOAuthAccessPolicy managed policy to this connection's role or user.",
      "error", name,
    );
  }
  if (step === "role") {
    return new AwsMcpCredentialError(
      "aws_role_access_denied", 403,
      "AWS refused this connection's role. Check that the role exists and trusts this connection.",
      "error", name,
    );
  }
  return new AwsMcpCredentialError(
    "aws_access_key_invalid", 403,
    step === "federation"
      ? "AWS refused a read-only session for this access key. Allow sts:GetFederationToken for this IAM user."
      : "AWS did not accept this connection's access key. Check that the key is active, or reconnect AWS with a new key.",
    "error", name,
  );
}

export interface AwsMcpMintInput {
  companyId: string;
  connectionId: string;
  connectionName: string;
  /** Changes whenever the connection or its grant is edited, so any edit makes a fresh token. */
  revision: string;
  grantId: string;
  /** The issuer recorded at setup; signing stops with a clear message if the instance address changed. */
  expectedIssuer?: string | null;
  settings: AwsMcpSettings;
  /** Reads a stored credential field by config path (access-key method only). */
  readSecret(configPath: string): Promise<string>;
  forceRefresh?: boolean;
}

export interface AwsMcpCredentialMinterOptions {
  clients?: AwsMcpClients;
  /** Signs a connection identity token (the workload identity issuer). */
  signConnectionToken(input: { companyId: string; connectionId: string; audience: string; expectedIssuer?: string | null }): Promise<{ token: string }>;
  now?: () => number;
  /** Deadline for each AWS request (default 10 s). */
  stepTimeoutMs?: number;
}

interface CacheEntry { fingerprint: string; header: string; refreshAt: number }

export function createAwsMcpCredentialMinter(options: AwsMcpCredentialMinterOptions) {
  const clients = options.clients ?? sdkAwsMcpClients;
  const now = options.now ?? (() => Date.now());
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<string>>();

  async function step<T>(name: Step, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("AWS request timed out"), { name: "TimeoutError" }));
      }, stepTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } catch (error) {
      throw classifyAwsMcpError(name, error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function sessionCredentials(input: AwsMcpMintInput): Promise<AwsSessionCredentials> {
    const { settings } = input;
    const region = settings.endpointRegion;
    const sessionName = awsSessionName(input.connectionName);
    const readOnlyPolicies = settings.accessLevel === "read_only" ? AWS_MCP_READ_ONLY_SESSION_POLICIES : undefined;
    if (settings.method === "aws-role") {
      const { token } = await step("identity", () => options.signConnectionToken({
        companyId: input.companyId, connectionId: input.connectionId, audience: AWS_MCP_STS_AUDIENCE,
        expectedIssuer: input.expectedIssuer,
      }));
      return step("role", (signal) => clients.assumeRoleWithWebIdentity({
        region, roleArn: settings.roleArn!, sessionName, webIdentityToken: token, policyArns: readOnlyPolicies, signal,
      }));
    }
    const base: AwsSessionCredentials = {
      accessKeyId: await input.readSecret(AWS_MCP_ACCESS_KEY_ID_PATH),
      secretAccessKey: await input.readSecret(AWS_MCP_SECRET_ACCESS_KEY_PATH),
    };
    if (settings.roleArn) {
      return step("role", (signal) => clients.assumeRole({
        region, credentials: base, roleArn: settings.roleArn!, sessionName, policyArns: readOnlyPolicies, signal,
      }));
    }
    if (readOnlyPolicies) {
      // Federation token names allow at most 32 characters.
      return step("federation", (signal) => clients.getFederationToken({
        region, credentials: base, name: awsSessionName(input.connectionName, 32), policyArns: readOnlyPolicies, signal,
      }));
    }
    return base;
  }

  async function mintHeader(input: AwsMcpMintInput, fingerprint: string, key: string): Promise<string> {
    const credentials = await sessionCredentials(input);
    const { token, expiresInSeconds } = await step("signin", (signal) => clients.createMcpToken({
      region: input.settings.endpointRegion, credentials, signal,
    }));
    const expiresAt = Math.min(
      now() + expiresInSeconds * 1000,
      credentials.expiration ? credentials.expiration.getTime() : Number.POSITIVE_INFINITY,
    );
    const header = `Bearer ${token}`;
    // Drop tokens past their refresh point, so the cache only ever holds live tokens (removed connections included).
    for (const [cachedKey, entry] of cache) if (entry.refreshAt <= now()) cache.delete(cachedKey);
    cache.set(key, { fingerprint, header, refreshAt: expiresAt - REFRESH_MARGIN_MS });
    return header;
  }

  return {
    /** The Authorization header for one connection and grant, cached until about 55 minutes in. */
    async authorizationHeader(input: AwsMcpMintInput): Promise<Record<string, string>> {
      const key = `${input.companyId}:${input.connectionId}:${input.grantId}`;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([input.revision, input.settings]))
        .digest("base64url");
      const cached = cache.get(key);
      if (!input.forceRefresh && cached && cached.fingerprint === fingerprint && cached.refreshAt > now()) {
        return { Authorization: cached.header };
      }
      if (input.forceRefresh || (cached && cached.fingerprint !== fingerprint)) cache.delete(key);
      const flightKey = `${key}:${fingerprint}`;
      let flight = inFlight.get(flightKey);
      if (!flight) {
        flight = mintHeader(input, fingerprint, key).finally(() => inFlight.delete(flightKey));
        inFlight.set(flightKey, flight);
      }
      return { Authorization: await flight };
    },
    /** How many tokens are cached (observability and tests). */
    cachedTokenCount(): number {
      return cache.size;
    },
    /** Drops every cached token for a connection, for example after AWS answers 401. */
    evict(companyId: string, connectionId: string) {
      const prefix = `${companyId}:${connectionId}:`;
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    },
  };
}

export type AwsMcpCredentialMinter = ReturnType<typeof createAwsMcpCredentialMinter>;

const sharedMinters = new WeakMap<object, AwsMcpCredentialMinter>();

/**
 * One minter per database, shared by the gateway and connection health checks so
 * a token minted for discovery is reused by the next call, and an eviction after a
 * 401 applies everywhere.
 */
export function sharedAwsMcpCredentialMinter(
  db: object,
  signConnectionToken: AwsMcpCredentialMinterOptions["signConnectionToken"],
  clients?: AwsMcpClients,
): AwsMcpCredentialMinter {
  // Test fakes get one shared minter per fake, like production gets one per database.
  const owner = clients ?? db;
  let minter = sharedMinters.get(owner);
  if (!minter) {
    minter = createAwsMcpCredentialMinter({ signConnectionToken, clients });
    sharedMinters.set(owner, minter);
  }
  return minter;
}

interface RevisionSource {
  status: string;
  enabled: boolean;
  credentialSecretRefs: Array<{ secretId: string; versionSelector?: unknown; configPath: string }>;
}

/**
 * What a cached token depends on besides the saved settings: which stored key it
 * came from and whether the grant is live. Health and last-used
 * stamps change on every call, so update times are deliberately not part of it.
 */
export function awsMcpCredentialRevision(
  connection: RevisionSource,
  grant?: { id: string; status: string; credentialSecretRefs: RevisionSource["credentialSecretRefs"] } | null,
): string {
  const refs = (grant?.credentialSecretRefs ?? connection.credentialSecretRefs)
    .map((ref) => `${ref.configPath}=${ref.secretId}@${String(ref.versionSelector ?? "latest")}`)
    .sort();
  // Connection status is deliberately absent: finishing setup must not discard the token setup minted,
  // and the gateway refuses a disabled connection before it asks for credentials.
  return JSON.stringify([grant?.id ?? null, grant?.status ?? null, refs]);
}

/** The role method proves itself with the company's issuer, which must be published before the customer registers it in AWS. */
export function awsMcpMethodUsesIssuer(appSlug: string | null | undefined, methodKey: string | null | undefined): boolean {
  return appSlug === AWS_MCP_SOURCE_TEMPLATE_KEY && methodKey === "aws-role";
}


/** Where setup records the issuer a role connection's AWS trust was created for. */
export const AWS_MCP_ISSUER_CONFIG_KEY = "workloadIdentityIssuer";

type SecretRefLike = RevisionSource["credentialSecretRefs"][number];

/**
 * The shared minting pipeline for the gateway and connection health checks: builds
 * the minter input from the connection and grant and reads stored keys through the
 * caller's resolver. Failures are AwsMcpCredentialError; errors from `readRef`
 * (the caller's own secret resolution) pass through unchanged.
 */
export async function resolveAwsMcpAuthorization<Ref extends SecretRefLike>(input: {
  minter: AwsMcpCredentialMinter;
  connection: ConnectionLike & { companyId: string; name: string; status: string; enabled: boolean; credentialSecretRefs: Ref[] };
  grant: { id: string; status: string; credentialSecretRefs: Ref[] } | null;
  forceRefresh?: boolean;
  readRef(ref: Ref): Promise<string>;
}): Promise<Record<string, string>> {
  const { connection, grant } = input;
  const refs = grant?.credentialSecretRefs ?? connection.credentialSecretRefs;
  const recordedIssuer = connection.config[AWS_MCP_ISSUER_CONFIG_KEY];
  return input.minter.authorizationHeader({
    companyId: connection.companyId,
    connectionId: connection.id,
    connectionName: connection.name,
    grantId: grant?.id ?? "shared",
    revision: awsMcpCredentialRevision(connection, grant),
    settings: awsMcpSettings(connection),
    expectedIssuer: typeof recordedIssuer === "string" ? recordedIssuer : null,
    forceRefresh: input.forceRefresh,
    readSecret: async (configPath) => {
      const ref = refs.find((candidate) => candidate.configPath === configPath);
      if (!ref) {
        throw new AwsMcpCredentialError(
          "aws_access_key_invalid", 422,
          "This AWS connection has no saved access key. Reconnect AWS.", "error",
        );
      }
      return input.readRef(ref);
    },
  });
}
