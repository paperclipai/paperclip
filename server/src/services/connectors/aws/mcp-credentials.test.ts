import { describe, expect, it, vi } from "vitest";
import {
  AWS_MCP_READ_ONLY_SESSION_POLICIES,
  AwsMcpCredentialError,
  awsMcpSettings,
  awsSessionName,
  classifyAwsMcpError,
  createAwsMcpCredentialMinter,
  isAwsMcpConnection,
  type AwsMcpClients,
  type AwsMcpMintInput,
  type AwsMcpSettings,
} from "./mcp-credentials.js";

function fakeAws(overrides: Partial<AwsMcpClients> = {}) {
  let tokens = 0;
  const session = (label: string) => ({ accessKeyId: `ASIA${label}`, secretAccessKey: "secret", sessionToken: "session", expiration: new Date(Date.now() + 3600_000) });
  const clients = {
    assumeRoleWithWebIdentity: vi.fn(async () => session("WEB")),
    assumeRole: vi.fn(async () => session("ROLE")),
    getFederationToken: vi.fn(async () => session("FED")),
    createMcpToken: vi.fn(async () => ({ token: `mcp-token-${++tokens}`, expiresInSeconds: 3599 })),
    ...overrides,
  } satisfies AwsMcpClients;
  return clients;
}

const roleSettings: AwsMcpSettings = { method: "aws-role", roleArn: "arn:aws:iam::123456789012:role/agents", endpointRegion: "us-east-1", accessLevel: "read_only" };
const keySettings: AwsMcpSettings = { method: "aws-access-key", roleArn: null, endpointRegion: "eu-west-1", accessLevel: "read_only" };

function input(settings: AwsMcpSettings, extra: Partial<AwsMcpMintInput> = {}): AwsMcpMintInput {
  return {
    companyId: "company-1", connectionId: "connection-1", connectionName: "AWS Prod", grantId: "grant-1",
    revision: "r1", settings,
    readSecret: async (path) => (path === "credentials.accessKeyId" ? "AKIAEXAMPLE" : "stored-secret"),
    ...extra,
  };
}

describe("AWS MCP credential minter", () => {
  it("passes the issuer recorded at setup to the signer", async () => {
    const sign = vi.fn(async () => ({ token: "jwt" }));
    const minter = createAwsMcpCredentialMinter({ clients: fakeAws(), signConnectionToken: sign });
    await minter.authorizationHeader(input(roleSettings, { expectedIssuer: "https://a.example/oidc/companies/c" }));
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ expectedIssuer: "https://a.example/oidc/companies/c" }));
  });

  it("role method: signs a connection token for STS and limits read-only sessions", async () => {
    const clients = fakeAws();
    const sign = vi.fn(async () => ({ token: "paperclip-jwt" }));
    const minter = createAwsMcpCredentialMinter({ clients, signConnectionToken: sign });
    expect(await minter.authorizationHeader(input(roleSettings))).toEqual({ Authorization: "Bearer mcp-token-1" });
    expect(sign).toHaveBeenCalledWith({ companyId: "company-1", connectionId: "connection-1", audience: "sts.amazonaws.com", expectedIssuer: undefined });
    expect(clients.assumeRoleWithWebIdentity).toHaveBeenCalledWith({
      region: "us-east-1", roleArn: roleSettings.roleArn, sessionName: "paperclip-aws-prod",
      webIdentityToken: "paperclip-jwt", policyArns: AWS_MCP_READ_ONLY_SESSION_POLICIES, signal: expect.any(AbortSignal),
    });
    expect(clients.createMcpToken).toHaveBeenCalledWith({ region: "us-east-1", credentials: expect.objectContaining({ accessKeyId: "ASIAWEB" }), signal: expect.any(AbortSignal) });

    await minter.authorizationHeader(input({ ...roleSettings, accessLevel: "full" }, { connectionId: "connection-2" }));
    expect(clients.assumeRoleWithWebIdentity).toHaveBeenLastCalledWith(expect.objectContaining({ policyArns: undefined }));
  });

  it("access-key method: federation token for read only, the key itself for full, AssumeRole with a role", async () => {
    const clients = fakeAws();
    const sign = vi.fn();
    const minter = createAwsMcpCredentialMinter({ clients, signConnectionToken: sign });
    await minter.authorizationHeader(input(keySettings));
    expect(clients.getFederationToken).toHaveBeenCalledWith({
      region: "eu-west-1", credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "stored-secret" },
      name: "paperclip-aws-prod", policyArns: AWS_MCP_READ_ONLY_SESSION_POLICIES, signal: expect.any(AbortSignal),
    });
    expect(clients.createMcpToken).toHaveBeenLastCalledWith({ region: "eu-west-1", credentials: expect.objectContaining({ accessKeyId: "ASIAFED" }), signal: expect.any(AbortSignal) });

    await minter.authorizationHeader(input({ ...keySettings, accessLevel: "full" }, { connectionId: "c-full" }));
    expect(clients.createMcpToken).toHaveBeenLastCalledWith({ region: "eu-west-1", credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "stored-secret" }, signal: expect.any(AbortSignal) });

    await minter.authorizationHeader(input({ ...keySettings, roleArn: "arn:aws:iam::123456789012:role/x" }, { connectionId: "c-role" }));
    expect(clients.assumeRole).toHaveBeenCalledWith(expect.objectContaining({
      roleArn: "arn:aws:iam::123456789012:role/x", policyArns: AWS_MCP_READ_ONLY_SESSION_POLICIES,
    }));
    expect(sign).not.toHaveBeenCalled();
  });

  it("caches per connection and grant, and mints again on edit, forced refresh, expiry or eviction", async () => {
    let clock = Date.now();
    const clients = fakeAws();
    const minter = createAwsMcpCredentialMinter({ clients, signConnectionToken: async () => ({ token: "jwt" }), now: () => clock });
    const header = () => minter.authorizationHeader(input(roleSettings)).then((h) => h.Authorization);
    expect(await header()).toBe("Bearer mcp-token-1");
    expect(await header()).toBe("Bearer mcp-token-1");
    expect(clients.createMcpToken).toHaveBeenCalledTimes(1);

    expect((await minter.authorizationHeader(input(roleSettings, { revision: "r2" }))).Authorization).toBe("Bearer mcp-token-2");
    expect((await minter.authorizationHeader(input(roleSettings, { revision: "r2", forceRefresh: true }))).Authorization).toBe("Bearer mcp-token-3");

    clock += 56 * 60 * 1000; // past the 55-minute refresh point
    expect((await minter.authorizationHeader(input(roleSettings, { revision: "r2" }))).Authorization).toBe("Bearer mcp-token-4");

    minter.evict("company-1", "connection-1");
    expect((await minter.authorizationHeader(input(roleSettings, { revision: "r2" }))).Authorization).toBe("Bearer mcp-token-5");
    expect((await minter.authorizationHeader(input(roleSettings, { grantId: "grant-2", revision: "r2" }))).Authorization).toBe("Bearer mcp-token-6");
  });

  it("keeps only live tokens: an expired token is pruned when the next one is stored", async () => {
    let clock = Date.now();
    const minter = createAwsMcpCredentialMinter({ clients: fakeAws(), signConnectionToken: async () => ({ token: "jwt" }), now: () => clock });
    await minter.authorizationHeader(input(roleSettings, { connectionId: "old" }));
    expect(minter.cachedTokenCount()).toBe(1);
    clock += 56 * 60 * 1000;
    await minter.authorizationHeader(input(roleSettings, { connectionId: "new" }));
    expect(minter.cachedTokenCount()).toBe(1);
  });

  it("shares one mint between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const clients = fakeAws({ createMcpToken: vi.fn(async () => { await gate; return { token: "only", expiresInSeconds: 3599 }; }) });
    const minter = createAwsMcpCredentialMinter({ clients, signConnectionToken: async () => ({ token: "jwt" }) });
    const calls = Array.from({ length: 5 }, () => minter.authorizationHeader(input(roleSettings)));
    release();
    expect(new Set((await Promise.all(calls)).map((h) => h.Authorization))).toEqual(new Set(["Bearer only"]));
    expect(clients.createMcpToken).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a stalled AWS request, aborts it, and lets the next call try again", async () => {
    let aborted = false;
    let stall = true;
    const clients = fakeAws({
      assumeRoleWithWebIdentity: vi.fn((input: { signal?: AbortSignal }) => {
        if (!stall) return Promise.resolve({ accessKeyId: "ASIAOK", secretAccessKey: "s", sessionToken: "t" });
        return new Promise<never>(() => { input.signal?.addEventListener("abort", () => { aborted = true; }); });
      }),
    });
    const minter = createAwsMcpCredentialMinter({ clients, signConnectionToken: async () => ({ token: "jwt" }), stepTimeoutMs: 50 });
    const callers = [minter.authorizationHeader(input(roleSettings)), minter.authorizationHeader(input(roleSettings))];
    for (const caller of callers) await expect(caller).rejects.toMatchObject({ code: "aws_unavailable", status: 503, health: "degraded" });
    expect(aborted).toBe(true);
    stall = false;
    expect(await minter.authorizationHeader(input(roleSettings))).toEqual({ Authorization: "Bearer mcp-token-1" });
  });

  it("maps AWS failures to stable codes and messages without AWS's own text", async () => {
    const awsError = (name: string, httpStatusCode: number) =>
      Object.assign(new Error(`AWS says arn:aws:iam::123456789012:role/secret-name ${name}`), { name, $metadata: { httpStatusCode } });
    const denied = createAwsMcpCredentialMinter({
      clients: fakeAws({ assumeRoleWithWebIdentity: vi.fn(async () => { throw awsError("AccessDenied", 403); }) }),
      signConnectionToken: async () => ({ token: "jwt" }),
    });
    const error = await denied.authorizationHeader(input(roleSettings)).catch((e) => e);
    expect(error).toMatchObject({ code: "aws_role_access_denied", status: 403, health: "error", awsErrorName: "AccessDenied" });
    expect(error.message).not.toContain("123456789012");

    expect(classifyAwsMcpError("signin", awsError("UnauthorizedException", 401))).toMatchObject({ code: "aws_mcp_signin_denied", status: 403 });
    expect(classifyAwsMcpError("access_key", awsError("InvalidClientTokenId", 403))).toMatchObject({ code: "aws_access_key_invalid" });
    expect(classifyAwsMcpError("federation", awsError("AccessDenied", 403)).message).toContain("sts:GetFederationToken");
    expect(classifyAwsMcpError("role", awsError("ServiceUnavailable", 503))).toMatchObject({ code: "aws_unavailable", status: 503, health: "degraded" });
    expect(classifyAwsMcpError("role", awsError("Throttling", 400))).toMatchObject({ code: "aws_unavailable" });
    expect(classifyAwsMcpError("identity", Object.assign(new Error("x"), { details: { code: "workload_identity_unavailable" } })))
      .toMatchObject({ code: "aws_identity_unavailable", status: 422 });
    expect(classifyAwsMcpError("identity", Object.assign(new Error("x"), { details: { code: "workload_identity_issuer_changed" } })))
      .toMatchObject({ code: "aws_issuer_changed", status: 409, message: expect.stringContaining("address changed") });

    const failing = createAwsMcpCredentialMinter({
      clients: fakeAws({ createMcpToken: vi.fn(async () => { throw awsError("UnauthorizedException", 401); }) }),
      signConnectionToken: async () => ({ token: "jwt" }),
    });
    await expect(failing.authorizationHeader(input(roleSettings))).rejects.toBeInstanceOf(AwsMcpCredentialError);
    // A failed mint is not cached: the next call tries AWS again.
    await expect(failing.authorizationHeader(input(roleSettings))).rejects.toMatchObject({ code: "aws_mcp_signin_denied" });
  });

  it("accepts only AWS's endpoint for the saved region and valid role ARNs", () => {
    const connection = (config: Record<string, unknown>) => ({ id: "c", transport: "mcp_remote", config: {
      sourceTemplateKey: "aws", connectionMethodKey: "aws-role", url: "https://aws-mcp.us-east-1.api.aws/mcp",
      methodConfig: { roleArn: "arn:aws:iam::123456789012:role/agents", endpointRegion: "us-east-1", accessLevel: "full" }, ...config,
    } });
    expect(isAwsMcpConnection(connection({}))).toBe(true);
    expect(isAwsMcpConnection(connection({ connectionMethodKey: "other" }))).toBe(false);
    // Detection follows the method's credentialMinter declaration, not a hard-coded list.
    expect(isAwsMcpConnection(connection({ sourceTemplateKey: "pagerduty", connectionMethodKey: "mcp-api-key-us" }))).toBe(false);
    expect(isAwsMcpConnection({ ...connection({}), transport: "local_stdio" })).toBe(false);
    expect(awsMcpSettings(connection({}))).toEqual({ method: "aws-role", roleArn: "arn:aws:iam::123456789012:role/agents", endpointRegion: "us-east-1", accessLevel: "full" });
    expect(() => awsMcpSettings(connection({ url: "https://evil.example.com/mcp" }))).toThrow(AwsMcpCredentialError);
    expect(() => awsMcpSettings(connection({ url: "https://aws-mcp.eu-west-1.api.aws/mcp" }))).toThrow(AwsMcpCredentialError);
    expect(() => awsMcpSettings(connection({ methodConfig: { roleArn: "not-an-arn", endpointRegion: "us-east-1" } }))).toThrow(AwsMcpCredentialError);
    expect(() => awsMcpSettings(connection({ methodConfig: { endpointRegion: "us-east-1" } }))).toThrow(AwsMcpCredentialError);
    // An unknown access level is treated as read only, never as full.
    expect(awsMcpSettings(connection({ methodConfig: { roleArn: "arn:aws:iam::123456789012:role/agents", endpointRegion: "us-east-1", accessLevel: "admin" } })).accessLevel).toBe("read_only");
  });

  it("builds session names STS accepts", () => {
    expect(awsSessionName("AWS Prod (us)")).toBe("paperclip-aws-prod-us");
    expect(awsSessionName("!!!")).toBe("paperclip-connection");
    expect(awsSessionName("x".repeat(200))).toHaveLength(64);
    expect(awsSessionName("x".repeat(200), 32)).toHaveLength(32);
  });
});
