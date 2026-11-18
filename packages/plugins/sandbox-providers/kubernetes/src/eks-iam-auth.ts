/**
 * EKS IAM authentication for the Kubernetes sandbox provider (TECH-8817).
 *
 * An EKS bearer token is `k8s-aws-v1.` + base64url(presigned STS
 * GetCallerIdentity URL), with the `x-k8s-aws-id: <clusterName>` header signed
 * into the URL. This is what `aws eks get-token` and aws-iam-authenticator
 * produce. The API server sends the URL to STS to learn the caller's IAM
 * identity, then maps it to Kubernetes groups through the cluster's access
 * entries.
 *
 * The token is minted here, in the plugin worker, from the AWS SDK default
 * credential chain (on ECS: the task role, through the container credential
 * endpoint). It is never stored in the environment config, so the server's
 * per-lease runtime config cache never holds one. Each HTTP request and each
 * exec/watch WebSocket connect asks the token source for a token; the source
 * reuses a cached token until it is close to expiry, then mints a new one.
 * Tokens are kept in memory only and are never logged.
 */
import { createHash, createHmac } from "node:crypto";
import type { User } from "@kubernetes/client-node";

// Structural copy of client-node's (unexported) `Authenticator` interface.
interface Authenticator {
  isAuthProvider(user: User): boolean;
  applyAuthentication(user: User, opts: { headers?: Record<string, unknown> }): Promise<void>;
}

export const EKS_IAM_AUTH_PROVIDER_NAME = "paperclip-eks-iam";

/** EKS accepts a token for 15 minutes after its X-Amz-Date; `aws eks get-token` reports 14. */
export const EKS_TOKEN_VALIDITY_MS = 14 * 60_000;
/** Mint a new token once the cached one has less than this left. */
export const EKS_TOKEN_REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
/** Matches aws-iam-authenticator and `aws eks get-token`. */
const PRESIGN_EXPIRES_SEC = 60;
const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export type AwsCredentialProvider = () => Promise<AwsCredentials>;

// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone).
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * AWS Signature Version 4 query-string presigning (GET, no body). Returns the
 * full presigned URL. Exported for the known-vector test.
 */
export function presignSigV4Url(input: {
  host: string;
  path: string;
  service: string;
  region: string;
  query: Record<string, string>;
  /** Extra headers to sign besides `host`; names must be lowercase. */
  headers?: Record<string, string>;
  credentials: AwsCredentials;
  date: Date;
  expiresSec: number;
  payloadHash?: string;
}): string {
  const timestamp = amzDate(input.date);
  const dateStamp = timestamp.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const headers: Record<string, string> = { host: input.host, ...input.headers };
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");

  const query: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(input.expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  if (input.credentials.sessionToken) query["X-Amz-Security-Token"] = input.credentials.sessionToken;
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    input.path,
    canonicalQuery,
    headerNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join(""),
    signedHeaders,
    input.payloadHash ?? EMPTY_PAYLOAD_SHA256,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return `https://${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Regional STS host; China regions use the amazonaws.com.cn partition. */
export function stsHostForRegion(region: string): string {
  return region.startsWith("cn-") ? `sts.${region}.amazonaws.com.cn` : `sts.${region}.amazonaws.com`;
}

/** Build an EKS bearer token. Pure: the clock and credentials are inputs. */
export function buildEksToken(input: {
  clusterName: string;
  region: string;
  credentials: AwsCredentials;
  date: Date;
}): string {
  const url = presignSigV4Url({
    host: stsHostForRegion(input.region),
    path: "/",
    service: "sts",
    region: input.region,
    query: { Action: "GetCallerIdentity", Version: "2011-06-15" },
    headers: { "x-k8s-aws-id": input.clusterName },
    credentials: input.credentials,
    date: input.date,
    expiresSec: PRESIGN_EXPIRES_SEC,
  });
  return `k8s-aws-v1.${Buffer.from(url, "utf8").toString("base64url")}`;
}

let defaultCredentialProvider: AwsCredentialProvider | null = null;

// The SDK's default chain (env, web identity, ECS container endpoint, IMDS, ...),
// created lazily so kubeconfig-mode workers never load or call it. The SDK
// memoizes and refreshes the credentials itself.
async function loadDefaultCredentialProvider(): Promise<AwsCredentialProvider> {
  if (!defaultCredentialProvider) {
    const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
    defaultCredentialProvider = defaultProvider() as AwsCredentialProvider;
  }
  return defaultCredentialProvider;
}

/**
 * Hands out an EKS token for one cluster, minting a new one when the cached
 * token has less than {@link EKS_TOKEN_REFRESH_BEFORE_EXPIRY_MS} left.
 * Concurrent callers share one in-flight mint.
 */
export class EksTokenSource {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly clusterName: string,
    private readonly region: string,
    private readonly credentials?: AwsCredentialProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > EKS_TOKEN_REFRESH_BEFORE_EXPIRY_MS) {
      return this.cached.token;
    }
    if (!this.inFlight) {
      this.inFlight = this.mint().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async mint(): Promise<string> {
    const provider = this.credentials ?? (await loadDefaultCredentialProvider());
    let credentials: AwsCredentials;
    try {
      credentials = await provider();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`EKS IAM auth: could not load AWS credentials from the default chain: ${reason}`);
    }
    const mintedAtMs = this.now();
    const token = buildEksToken({
      clusterName: this.clusterName,
      region: this.region,
      credentials,
      date: new Date(mintedAtMs),
    });
    // A token signed with session credentials is useless once they expire.
    const credentialExpiryMs = credentials.expiration?.getTime() ?? Number.POSITIVE_INFINITY;
    this.cached = { token, expiresAtMs: Math.min(mintedAtMs + EKS_TOKEN_VALIDITY_MS, credentialExpiryMs) };
    return token;
  }
}

const tokenSources = new Map<string, EksTokenSource>();

/** One token source (and token cache) per region and cluster, for the worker's lifetime. */
export function getEksTokenSource(clusterName: string, region: string): EksTokenSource {
  const key = `${region}/${clusterName}`;
  let source = tokenSources.get(key);
  if (!source) {
    source = new EksTokenSource(clusterName, region);
    tokenSources.set(key, source);
  }
  return source;
}

/**
 * `@kubernetes/client-node` authenticator. The client calls it on every API
 * request, watch and exec/attach WebSocket connect, so a reconnect after a
 * token expired always presents a current token. An open WebSocket is
 * authenticated once at upgrade and is not cut off when its token expires.
 */
export class EksIamAuthenticator implements Authenticator {
  constructor(private readonly source: EksTokenSource) {}

  isAuthProvider(user: User): boolean {
    return user?.authProvider?.name === EKS_IAM_AUTH_PROVIDER_NAME;
  }

  async applyAuthentication(_user: User, opts: { headers?: Record<string, unknown> }): Promise<void> {
    const token = await this.source.getToken();
    opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` };
  }
}

/**
 * Clusters the deployment lets the server's own IAM identity authenticate to,
 * from `PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS`: comma-separated
 * `<clusterName>=<endpoint>` pairs. The environment config is editable by
 * company admins; this operator-set list pins both the cluster name the token
 * is signed for and the endpoint it is sent to, so an admin cannot point the
 * server's identity at another cluster, or send its token to a same-named
 * cluster elsewhere. Unset (or no valid pair) means eks-iam auth is off.
 */
export function eksIamAllowedClusters(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const allowed = new Set<string>();
  for (const raw of (env.PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS ?? "").split(",")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const name = raw.slice(0, eq).trim();
    const endpoint = raw.slice(eq + 1).trim().replace(/\/+$/, "");
    if (name && endpoint) allowed.add(`${name}=${endpoint}`);
  }
  return allowed;
}

export function isEksIamClusterAllowed(
  auth: { clusterName: string; endpoint: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return eksIamAllowedClusters(env).has(`${auth.clusterName}=${auth.endpoint.replace(/\/+$/, "")}`);
}

export function eksIamNotAllowedMessage(auth: { clusterName: string }): string {
  return `EKS IAM auth to cluster "${auth.clusterName}" at this endpoint is not enabled on this deployment (PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS).`;
}

export function assertEksIamClusterAllowed(
  auth: { clusterName: string; endpoint: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isEksIamClusterAllowed(auth, env)) throw new Error(eksIamNotAllowedMessage(auth));
}
