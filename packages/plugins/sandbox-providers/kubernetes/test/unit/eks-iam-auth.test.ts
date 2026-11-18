import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { CoreV1Api, Exec } from "@kubernetes/client-node";
// The real handler `Exec` uses; its socket factory is the client's own test seam.
import { WebSocketHandler } from "@kubernetes/client-node/dist/web-socket-handler.js";
import {
  EKS_TOKEN_REFRESH_BEFORE_EXPIRY_MS,
  EKS_TOKEN_VALIDITY_MS,
  EksTokenSource,
  buildEksToken,
  presignSigV4Url,
  type AwsCredentials,
} from "../../src/eks-iam-auth.js";
import { createKubeConfig } from "../../src/kube-client.js";
import { parseKubernetesProviderConfig } from "../../src/types.js";
import plugin from "../../src/plugin.js";

// AWS documentation example credentials (not real).
const EXAMPLE_CREDS: AwsCredentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const AUTH = {
  type: "eks-iam" as const,
  clusterName: "paperclip-prod-sandbox",
  region: "us-east-1",
  endpoint: "https://ABCDEF0123456789.gr7.us-east-1.eks.amazonaws.com",
  caData: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==",
};
const ALLOW_ENV = { PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS: `other=https://x.eks.amazonaws.com, paperclip-prod-sandbox=${AUTH.endpoint}` };

function decodeToken(token: string): URL {
  expect(token.startsWith("k8s-aws-v1.")).toBe(true);
  const body = token.slice("k8s-aws-v1.".length);
  expect(body).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
  return new URL(Buffer.from(body, "base64url").toString("utf8"));
}

describe("presignSigV4Url", () => {
  it("matches the AWS SigV4 query-string example (S3 GET test.txt, 2013-05-24)", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignSigV4Url({
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      service: "s3",
      region: "us-east-1",
      query: {},
      credentials: EXAMPLE_CREDS,
      date: new Date("2013-05-24T00:00:00Z"),
      expiresSec: 86400,
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    expect(url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")).toBe(true);
  });
});

describe("buildEksToken", () => {
  const sessionCreds = { ...EXAMPLE_CREDS, sessionToken: "FQoGZXIvYXdzEXAMPLE/session+token==" };
  const date = new Date("2026-11-18T12:00:00Z");

  it("presigns STS GetCallerIdentity with the cluster name header signed, like aws-iam-authenticator", () => {
    const url = decodeToken(buildEksToken({ clusterName: "paperclip-prod-sandbox", region: "us-east-1", credentials: sessionCreds, date }));
    expect(url.origin).toBe("https://sts.us-east-1.amazonaws.com");
    expect(url.pathname).toBe("/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      Action: "GetCallerIdentity",
      Version: "2011-06-15",
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKIAIOSFODNN7EXAMPLE/20261118/us-east-1/sts/aws4_request",
      "X-Amz-Date": "20261118T120000Z",
      "X-Amz-Expires": "60",
      "X-Amz-Security-Token": "FQoGZXIvYXdzEXAMPLE/session+token==",
      "X-Amz-SignedHeaders": "host;x-k8s-aws-id",
      // Cross-checked against @smithy/signature-v4 5.7.4 presign() with the same inputs.
      "X-Amz-Signature": "ea4582386ab0e70a4eb45ff7f8379732dbbac98e7ae8cd8a2c8f55bd0bfca414",
    });
  });

  it("is deterministic for a fixed clock and credentials, and binds the cluster name", () => {
    const a = buildEksToken({ clusterName: "c1", region: "us-east-1", credentials: EXAMPLE_CREDS, date });
    expect(buildEksToken({ clusterName: "c1", region: "us-east-1", credentials: EXAMPLE_CREDS, date })).toBe(a);
    expect(buildEksToken({ clusterName: "c2", region: "us-east-1", credentials: EXAMPLE_CREDS, date })).not.toBe(a);
    expect(decodeToken(a).searchParams.has("X-Amz-Security-Token")).toBe(false);
  });
});

describe("EksTokenSource", () => {
  it("reuses a token until it is within the refresh margin, then mints a new one", async () => {
    let now = Date.parse("2026-11-18T12:00:00Z");
    const provider = vi.fn(async () => EXAMPLE_CREDS);
    const source = new EksTokenSource("c1", "us-east-1", provider, () => now);

    const first = await source.getToken();
    now += EKS_TOKEN_VALIDITY_MS - EKS_TOKEN_REFRESH_BEFORE_EXPIRY_MS - 1_000;
    expect(await source.getToken()).toBe(first);
    expect(provider).toHaveBeenCalledTimes(1);

    now += 2_000; // inside the refresh margin, still before expiry
    const second = await source.getToken();
    expect(second).not.toBe(first);
    expect(decodeToken(second).searchParams.get("X-Amz-Date")).toBe("20261118T120901Z");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not keep a token past the expiry of the credentials that signed it", async () => {
    let now = Date.parse("2026-11-18T12:00:00Z");
    const provider = vi.fn(async () => ({ ...EXAMPLE_CREDS, expiration: new Date(now + 6 * 60_000) }));
    const source = new EksTokenSource("c1", "us-east-1", provider, () => now);
    const first = await source.getToken();
    now += 2 * 60_000; // credentials have 4 min left: inside the refresh margin
    expect(await source.getToken()).not.toBe(first);
  });

  it("shares one mint between concurrent callers", async () => {
    const provider = vi.fn(async () => EXAMPLE_CREDS);
    const source = new EksTokenSource("c1", "us-east-1", provider, () => Date.parse("2026-11-18T12:00:00Z"));
    const tokens = await Promise.all([source.getToken(), source.getToken(), source.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("reports a credential failure without caching it", async () => {
    const provider = vi.fn().mockRejectedValueOnce(new Error("no credentials")).mockResolvedValue(EXAMPLE_CREDS);
    const source = new EksTokenSource("c1", "us-east-1", provider, () => Date.parse("2026-11-18T12:00:00Z"));
    await expect(source.getToken()).rejects.toThrow(/could not load AWS credentials.*no credentials/);
    await expect(source.getToken()).resolves.toMatch(/^k8s-aws-v1\./);
  });
});

describe("createKubeConfig with eks-iam auth", () => {
  function setup() {
    let now = Date.parse("2026-11-18T12:00:00Z");
    const source = new EksTokenSource(AUTH.clusterName, AUTH.region, async () => EXAMPLE_CREDS, () => now);
    const kc = createKubeConfig({ auth: AUTH }, { tokenSource: source, env: ALLOW_ENV });
    return { kc, advance: (ms: number) => { now += ms; } };
  }

  it("uses the configured endpoint and CA and no stored token", () => {
    const { kc } = setup();
    expect(kc.getCurrentCluster()).toMatchObject({ server: AUTH.endpoint, caData: AUTH.caData, skipTLSVerify: false });
    expect(kc.getCurrentUser()?.token).toBeUndefined();
  });

  it("refuses a cluster the deployment has not allowed", () => {
    expect(() => createKubeConfig({ auth: AUTH }, { env: {} })).toThrow(/PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS/);
    expect(() => createKubeConfig({ auth: AUTH }, { env: { PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS: "," } })).toThrow();
    // The name alone is not enough: a same-named cluster at another endpoint is refused.
    expect(() =>
      createKubeConfig(
        { auth: { ...AUTH, endpoint: "https://OTHER.gr7.us-east-1.eks.amazonaws.com" } },
        { env: ALLOW_ENV },
      ),
    ).toThrow(/not enabled/);
    expect(() =>
      createKubeConfig({ auth: AUTH }, { env: { PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS: "paperclip-prod-sandbox" } }),
    ).toThrow();
  });

  it("puts a bearer token on API requests and fetch-based watches, refreshed after expiry", async () => {
    const { kc, advance } = setup();
    const a = await kc.applyToFetchOptions({});
    const tokenA = (a.headers as Headers).get("Authorization");
    expect(tokenA).toMatch(/^Bearer k8s-aws-v1\./);

    const headers: Record<string, string> = {};
    await kc.applySecurityAuthentication({
      setHeaderParam: (k: string, v: string) => { headers[k] = v; },
      setAgent: () => {},
    } as never);
    expect(headers.Authorization).toBe(tokenA);

    advance(EKS_TOKEN_VALIDITY_MS + 60_000);
    const b = await kc.applyToFetchOptions({});
    expect((b.headers as Headers).get("Authorization")).not.toBe(tokenA);
    expect(kc.makeApiClient(CoreV1Api)).toBeDefined();
  });

  it("re-authenticates an exec WebSocket reconnect after the first token expired", async () => {
    const { kc, advance } = setup();
    const seen: string[] = [];
    const factory = (_uri: string, _protocols: string[], opts: { headers?: Record<string, string> }) => {
      seen.push(opts.headers?.Authorization ?? "");
      const client: Record<string, unknown> = { close: () => {} };
      setImmediate(() => (client.onopen as () => void)());
      return client;
    };
    const exec = new Exec(kc, new WebSocketHandler(kc, factory as never));
    const run = () =>
      exec.exec("ns", "pod", "c", ["true"], new PassThrough(), new PassThrough(), null, false);

    await run();
    advance(20 * 60_000); // a long exec outlives its token; the next connect must not reuse it
    await run();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^Bearer k8s-aws-v1\./);
    expect(seen[1]).toMatch(/^Bearer k8s-aws-v1\./);
    expect(seen[1]).not.toBe(seen[0]);
    expect(decodeToken(seen[1]!.slice("Bearer ".length)).searchParams.get("X-Amz-Date")).toBe("20261118T122000Z");
  });
});

describe("config validation for the eks-iam auth mode", () => {
  it("accepts eks-iam auth with no kubeconfig secret", () => {
    const parsed = parseKubernetesProviderConfig({ auth: AUTH });
    expect(parsed.auth).toEqual(AUTH);
    expect(parsed.kubeconfig).toBeUndefined();
    expect(parsed.inCluster).toBe(false);
  });

  it.each([
    ["kubeconfig", { auth: AUTH, kubeconfig: "apiVersion: v1\n" }],
    ["inCluster", { auth: AUTH, inCluster: true }],
  ])("rejects eks-iam combined with %s", (_name, config) => {
    expect(() => parseKubernetesProviderConfig(config)).toThrow(/cannot be combined/);
  });

  it.each([
    ["a non-EKS endpoint", { endpoint: "https://attacker.example.com" }],
    ["an http endpoint", { endpoint: "http://abc.gr7.us-east-1.eks.amazonaws.com" }],
    ["a bad region", { region: "useast1" }],
    ["a bad cluster name", { clusterName: "bad name" }],
    ["non-base64 CA", { caData: "not base64!" }],
    ["an unknown key", { token: "x" }],
  ])("rejects %s", (_name, override) => {
    expect(() => parseKubernetesProviderConfig({ auth: { ...AUTH, ...override } })).toThrow();
  });

  it("onEnvironmentValidateConfig rejects a cluster missing from the deployment allow-list", async () => {
    vi.stubEnv("PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS", "");
    try {
      const denied = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "kubernetes", config: { auth: AUTH } } as never);
      expect(denied.ok).toBe(false);
      expect(denied.errors?.[0]).toMatch(/not enabled on this deployment/);

      vi.stubEnv("PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS", ALLOW_ENV.PAPERCLIP_K8S_EKS_IAM_ALLOWED_CLUSTERS);
      const allowed = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "kubernetes", config: { auth: AUTH } } as never);
      expect(allowed.ok).toBe(true);
      expect(allowed.normalizedConfig?.auth).toEqual(AUTH);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
