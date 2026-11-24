import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { AWS_MCP_READ_ONLY_SESSION_POLICIES, type AwsMcpClients } from "../services/connectors/aws/mcp-credentials.js";
import { resetWorkloadIdentityKeyCacheForTests, workloadIdentityService } from "../services/workload-identity.js";
import { forgetMcpHttpSessions } from "../services/mcp-http.js";
import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/error-handler.js";

const actor = { actorType: "user" as const, actorId: "aws-test-user", actorSource: "local_implicit" as const };
const ACCESS_KEY_ID = "AKIAEXAMPLE1234567";
const SECRET_ACCESS_KEY = "fixture-secret-access-key";
const awsTool = (name: string, readOnlyHint: boolean) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint } });

function asConfig(config: unknown): { methodConfig: Record<string, unknown> } {
  return config as { methodConfig: Record<string, unknown> };
}

describe("AWS connector with minted credentials", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "aws-mcp-connector-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://acme.paperclip.app");
    fixture = await startEmbeddedPostgresTestDatabase("aws-mcp-connector-");
    db = createDb(fixture.connectionString);
    resetWorkloadIdentityKeyCacheForTests();
  }, 120_000);
  afterAll(async () => {
    await fixture?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function company() {
    const [row] = await db.insert(companies).values({ name: `AWS ${randomUUID()}`, issuePrefix: `A${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: row!.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: row!.id, name: "Ops agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    return { org: row!, agent: agent! };
  }

  function harness() {
    let tokens = 0;
    const session = (label: string) => ({ accessKeyId: `ASIA${label}`, secretAccessKey: "s", sessionToken: "t", expiration: new Date(Date.now() + 3_600_000) });
    const aws = {
      assumeRoleWithWebIdentity: vi.fn(async (_input: Parameters<AwsMcpClients["assumeRoleWithWebIdentity"]>[0]) => session("WEB")),
      assumeRole: vi.fn(async () => session("ROLE")),
      getFederationToken: vi.fn(async () => session("FED")),
      createMcpToken: vi.fn(async () => ({ token: `mcp-${++tokens}`, expiresInSeconds: 3599 })),
    } satisfies AwsMcpClients;
    const requests: { url: string; method: string; headers: Headers }[] = [];
    const rejected = new Set<string>();
    const send = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      requests.push({ url, method: body.method, headers });
      const authorization = headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer mcp-") || rejected.has(authorization)) {
        return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      }
      if (body.method === "initialize") return Response.json({ id: body.id, jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "Mcp-Session-Id": `s-${authorization}` } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      // Like AWS's server: tool calls only work inside an initialized MCP session.
      if (body.method === "tools/call" && !headers.get("mcp-session-id")) {
        return Response.json({ id: body.id, jsonrpc: "2.0", error: { code: -32600, message: "Session ID is required for this operation." } });
      }
      if (body.method === "tools/list") return Response.json({ id: body.id, jsonrpc: "2.0", result: { tools: [awsTool("aws___run_script", false), awsTool("aws___list_regions", true)] } });
      return Response.json({ id: body.id, jsonrpc: "2.0", result: { content: [{ type: "text", text: "regions" }] } });
    };
    const common = { deploymentMode: "local_trusted" as const, deploymentExposure: "private" as const, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 as const }], remoteHttpRequest: send, awsMcpClients: aws };
    return { aws, requests, rejected, service: toolAccessService(db, common), gateway: createToolGatewayService(db, { ...common, toolActionSigningSecret: "fixture-signing-key" }) };
  }

  it("saves a role draft through the API and returns what to configure in AWS", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org } = await company();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: actor.actorId, source: "local_implicit", isInstanceAdmin: true } as Express.Request["actor"]; next(); });
    app.use("/api", toolAccessRoutes(db, { paperclipCloudConnector: null }));
    app.use(errorHandler);
    // The role does not exist yet, so the draft is saved without a role ARN.
    const draft = await request(app).post(`/api/companies/${org.id}/tools/apps/connect`).send({
      galleryKey: "aws", connectionMethodKey: "aws-role", saveDraft: true,
      configValues: { roleArn: "", endpointRegion: "us-east-1", accessLevel: "read_only" },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBeLessThan(300);
    const connectionId = draft.body.connectionId as string;
    // The setup screen reopens a resumed draft by these stored keys.
    const [stored] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    expect(stored).toMatchObject({ status: "draft", config: { sourceTemplateKey: "aws", connectionMethodKey: "aws-role" } });
    const setup = await request(app).get(`/api/tool-connections/${connectionId}/aws-setup`).expect(200);
    const issuer = `https://acme.paperclip.app/oidc/companies/${org.id}`;
    expect(setup.body).toMatchObject({
      available: true, issuer, audience: "sts.amazonaws.com", subject: `connection:${connectionId}`,
      roleName: `paperclip-${connectionId}`, savedRoleArn: null, issuerPublished: true,
    });
    const host = issuer.replace("https://", "");
    const template = JSON.parse(setup.body.cloudFormationTemplate);
    const role = template.Resources.PaperclipRole.Properties;
    expect(role).toMatchObject({ RoleName: `paperclip-${connectionId}` });
    expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toEqual({
      [`${host}:aud`]: "sts.amazonaws.com", [`${host}:sub`]: `connection:${connectionId}`,
    });
    expect(template.Resources.PaperclipIdentityProvider.Properties.Url).toBe(issuer);
    expect(setup.body.trustPolicy.Statement[0].Principal.Federated).toBe(`arn:aws:iam::ACCOUNT_ID:oidc-provider/${host}`);
    expect(JSON.stringify(setup.body)).not.toMatch(/secret|private/i);
    // A reconnect may change the access level before it is saved; the guide follows the level being set up.
    const full = await request(app).get(`/api/tool-connections/${connectionId}/aws-setup?accessLevel=full`).expect(200);
    expect(full.body.accessLevel).toBe("full");
    expect(JSON.parse(full.body.cloudFormationTemplate).Parameters.AccessPolicyArn.Default).toBeUndefined();

    // After the address changes, setup for the old address could never pass, so it asks for a new save,
    // and saving the draft again records the current address.
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://renamed.paperclip.app");
    try {
      await request(app).get(`/api/tool-connections/${connectionId}/aws-setup`).expect(200, { available: false, reason: "address_changed" });
      await request(app).post(`/api/companies/${org.id}/tools/apps/connect`).send({
        galleryKey: "aws", connectionMethodKey: "aws-role", saveDraft: true, resumeConnectionId: connectionId,
        configValues: { endpointRegion: "us-east-1", accessLevel: "read_only" },
      }).expect((res) => expect(res.status, JSON.stringify(res.body)).toBeLessThan(300));
      const resaved = await request(app).get(`/api/tool-connections/${connectionId}/aws-setup`).expect(200);
      expect(resaved.body).toMatchObject({ available: true, issuer: `https://renamed.paperclip.app/oidc/companies/${org.id}` });
    } finally {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://acme.paperclip.app");
    }

    // A draft never keeps a role ARN AWS has not accepted: the setup steps would tell an AWS
    // administrator to update that role, so any role named in a draft would be at risk.
    const unchecked = await request(app).post(`/api/companies/${org.id}/tools/apps/connect`).send({
      galleryKey: "aws", connectionMethodKey: "aws-role", saveDraft: true,
      configValues: { roleArn: "arn:aws:iam::123456789012:role/OrganizationAccountAccessRole", endpointRegion: "us-east-1", accessLevel: "read_only" },
    });
    expect(unchecked.status, JSON.stringify(unchecked.body)).toBeLessThan(300);
    const [uncheckedRow] = await db.select().from(toolConnections).where(eq(toolConnections.id, unchecked.body.connectionId));
    expect(JSON.stringify(uncheckedRow!.config)).not.toContain("OrganizationAccountAccessRole");
    const uncheckedSetup = await request(app).get(`/api/tool-connections/${unchecked.body.connectionId}/aws-setup`).expect(200);
    expect(uncheckedSetup.body.savedRoleArn).toBeNull();

    const keyDraft = await request(app).post(`/api/companies/${org.id}/tools/apps/connect`).send({
      galleryKey: "aws", connectionMethodKey: "aws-access-key", saveDraft: true,
      configValues: { endpointRegion: "us-east-1", accessLevel: "read_only" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    });
    await request(app).get(`/api/tool-connections/${keyDraft.body.connectionId}/aws-setup`).expect(422);
  });

  it("stays unavailable until the experimental setting is on", async () => {
    const { org } = await company();
    const { service } = harness();
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: false });
    await expect(service.connectGalleryApp(org.id, {
      galleryKey: "aws", connectionMethodKey: "aws-access-key",
      configValues: { endpointRegion: "us-east-1", accessLevel: "read_only" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    }, actor)).rejects.toThrow();
  });

  it("access key: lists and calls tools with a minted token, never sending the stored key", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org, agent } = await company();
    const { service, gateway, aws, requests, rejected } = harness();
    const connected = await service.connectGalleryApp(org.id, {
      galleryKey: "aws", connectionMethodKey: "aws-access-key",
      configValues: { endpointRegion: "eu-west-1", accessLevel: "read_only" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    }, actor);
    expect(connected.catalog.map((entry) => entry.toolName).sort()).toEqual(["aws___list_regions", "aws___run_script"]);
    expect(requests[0]!.url).toBe("https://aws-mcp.eu-west-1.api.aws/mcp");
    expect(aws.getFederationToken).toHaveBeenCalledWith(expect.objectContaining({
      region: "eu-west-1", credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      policyArns: AWS_MCP_READ_ONLY_SESSION_POLICIES,
    }));
    for (const request of requests) {
      const sent = JSON.stringify([...request.headers.entries()]);
      expect(sent).not.toContain(ACCESS_KEY_ID);
      expect(sent).not.toContain(SECRET_ACCESS_KEY);
    }
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(JSON.stringify(row!.config)).not.toContain(SECRET_ACCESS_KEY);
    expect(row!.credentialRefs.filter((ref) => ref.placement === "header")).toEqual([]);

    await service.finishGalleryAppConnection(org.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);
    const call = () => gateway.executeTestCall({ companyId: org.id, connectionId: connected.connectionId, agentId: agent.id, userId: actor.actorId, toolName: "aws___list_regions", parameters: {} });
    const mintsAfterSetup = aws.createMcpToken.mock.calls.length;
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    // The first agent call reuses the token minted while setup listed the tools.
    expect(aws.createMcpToken.mock.calls.length).toBe(mintsAfterSetup);
    const mintsBefore = aws.createMcpToken.mock.calls.length;
    expect(await call()).toMatchObject({ decision: "allowed" });
    expect(aws.createMcpToken.mock.calls.length).toBe(mintsBefore);

    // AWS refuses the cached token: Paperclip mints a fresh one, never replays the call, and the retry works.
    const lastAuthorization = requests.at(-1)!.headers.get("authorization")!;
    rejected.add(lastAuthorization);
    const toolCalls = () => requests.filter((request) => request.method === "tools/call").length;
    const callsBefore = toolCalls();
    expect(await call()).toMatchObject({ error: { reasonCode: "credentials_refreshed_retry_required", message: expect.stringContaining("AWS refused the saved credentials") } });
    expect(toolCalls()).toBe(callsBefore + 1);
    expect(aws.createMcpToken.mock.calls.length).toBe(mintsBefore + 1);
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    expect(requests.at(-1)!.headers.get("authorization")).not.toBe(lastAuthorization);
  });

  it("a shared connection never reads a personal grant's keys", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org } = await company();
    const { service, aws } = harness();
    const connected = await service.connectGalleryApp(org.id, {
      galleryKey: "aws", connectionMethodKey: "aws-access-key",
      configValues: { endpointRegion: "us-east-1", accessLevel: "full" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    }, actor);
    const [organization] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.connectionId));
    // A leftover personal grant for the same person, with refs that are not the organization's keys.
    await db.insert(connectionGrants).values({
      companyId: org.id, connectionId: connected.connectionId, kind: "user", subjectUserId: actor.actorId, status: "active",
      credentialSecretRefs: [{ secretId: randomUUID(), versionSelector: "latest", configPath: "credentials.accessKeyId" }],
    });
    await service.checkHealth(connected.connectionId, actor);
    expect(aws.createMcpToken).toHaveBeenLastCalledWith(expect.objectContaining({
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    }));
    expect(organization!.kind).toBe("organization");
  });

  it("access key: a personal connection reads its owner's keys", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org } = await company();
    const { service, aws } = harness();
    const connected = await service.connectGalleryApp(org.id, {
      galleryKey: "aws", connectionMethodKey: "aws-access-key", grantKind: "user",
      configValues: { endpointRegion: "us-east-1", accessLevel: "full" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    }, actor);
    expect(connected.catalog).toHaveLength(2);
    expect(aws.createMcpToken).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    }));
  });

  it("mints a fresh token when AWS refuses the cached one while opening an MCP session", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org, agent } = await company();
    const { service, gateway, aws, requests, rejected } = harness();
    const connected = await service.connectGalleryApp(org.id, {
      galleryKey: "aws", connectionMethodKey: "aws-access-key",
      configValues: { endpointRegion: "us-east-1", accessLevel: "full" },
      credentialValues: { "credentials.accessKeyId": ACCESS_KEY_ID, "credentials.secretAccessKey": SECRET_ACCESS_KEY },
    }, actor);
    await service.finishGalleryAppConnection(org.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);
    const call = () => gateway.executeTestCall({ companyId: org.id, connectionId: connected.connectionId, agentId: agent.id, userId: actor.actorId, toolName: "aws___list_regions", parameters: {} });
    expect(await call()).toMatchObject({ decision: "allowed" });
    // AWS stops accepting the cached token, and the MCP session is gone, so the next call starts by opening a session.
    for (const request of requests) rejected.add(request.headers.get("authorization") ?? "");
    forgetMcpHttpSessions(connected.connectionId);
    const mintsBefore = aws.createMcpToken.mock.calls.length;
    const initializesBefore = requests.filter((request) => request.method === "initialize").length;
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    expect(aws.createMcpToken.mock.calls.length).toBe(mintsBefore + 1);
    expect(requests.filter((request) => request.method === "initialize").length).toBe(initializesBefore + 2);
  });

  it("role: proves the connection with a Paperclip-signed token and reports AWS refusals plainly", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAwsConnector: true });
    const { org } = await company();
    const { service, aws, requests, rejected } = harness();
    const roleInput = {
      galleryKey: "aws", connectionMethodKey: "aws-role",
      configValues: { roleArn: "arn:aws:iam::123456789012:role/paperclip-agents", endpointRegion: "us-east-1", accessLevel: "full" },
    };
    // The role must trust a connection that already exists, so setup saves a draft first without contacting AWS,
    // and publishes the company's issuer so AWS can validate it when the customer registers it.
    // The role is created after the draft (it is named after it), so the draft has no role ARN yet.
    const draft = await service.connectGalleryApp(org.id, {
      ...roleInput, configValues: { endpointRegion: "us-east-1", accessLevel: "full" }, saveDraft: true,
    }, actor);
    expect(draft.catalog).toEqual([]);
    expect(aws.assumeRoleWithWebIdentity).not.toHaveBeenCalled();
    expect(await workloadIdentityService(db).publicKeySet(org.id)).not.toBeNull();
    const connected = await service.connectGalleryApp(org.id, { ...roleInput, resumeConnectionId: draft.connectionId }, actor);
    expect(connected.connectionId).toBe(draft.connectionId);
    expect(connected.catalog).toHaveLength(2);
    const [recorded] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(recorded!.config.workloadIdentityIssuer).toBe(`https://acme.paperclip.app/oidc/companies/${org.id}`);
    const call = aws.assumeRoleWithWebIdentity.mock.calls[0]![0];
    expect(call).toMatchObject({ region: "us-east-1", roleArn: "arn:aws:iam::123456789012:role/paperclip-agents", policyArns: undefined });
    const claims = JSON.parse(Buffer.from(call.webIdentityToken.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims).toMatchObject({
      iss: `https://acme.paperclip.app/oidc/companies/${org.id}`,
      sub: `connection:${connected.connectionId}`,
      aud: "sts.amazonaws.com",
    });

    // AWS stops accepting the cached token and the role no longer trusts this connection.
    for (const request of requests) rejected.add(request.headers.get("authorization") ?? "");
    aws.assumeRoleWithWebIdentity.mockRejectedValueOnce(Object.assign(new Error("arn:aws:iam::123456789012:role/x is not authorized"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }));
    const health = await service.checkHealth(connected.connectionId, actor).catch((error: unknown) => error);
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(row!.healthMessage ?? JSON.stringify(health)).toContain("AWS refused this connection's role");
    expect(row!.healthMessage ?? "").not.toContain("123456789012");
    expect(health).toMatchObject({ status: 422, details: { code: "aws_role_access_denied" } });

    // The instance's address changes: Paperclip stops with a clear message instead of a role refusal from AWS.
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://renamed.paperclip.app");
    try {
      for (const request of requests) rejected.add(request.headers.get("authorization") ?? "");
      await service.checkHealth(connected.connectionId, actor).catch(() => undefined);
      const [moved] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      expect(moved!.healthMessage).toContain("address changed");
      // Reconnect opens the AWS step for a finished connection, set up for the current address.
      await service.finishGalleryAppConnection(org.id, connected.connectionId, {
        enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents",
      }, actor);
      // Setup steps tell an administrator to update the saved role, so only the role named after this
      // connection is offered: a role with any other name (in any account) could be an unrelated one.
      expect(await service.getAwsSetup(org.id, connected.connectionId)).toMatchObject({
        available: true, issuer: `https://renamed.paperclip.app/oidc/companies/${org.id}`, savedRoleArn: null,
      });
      const ownRole = `arn:aws:iam::123456789012:role/paperclip-${connected.connectionId}`;
      const [current] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      await db.update(toolConnections).set({ config: { ...current!.config, methodConfig: { ...asConfig(current!.config).methodConfig, roleArn: ownRole } } })
        .where(eq(toolConnections.id, connected.connectionId));
      expect(await service.getAwsSetup(org.id, connected.connectionId)).toMatchObject({ savedRoleArn: ownRole });
      // After the administrator registers the new address in AWS, reconnecting records it and works again.
      const reconnected = await service.connectGalleryApp(org.id, { ...roleInput, reconnectConnectionId: connected.connectionId }, actor);
      expect(reconnected.catalog).toHaveLength(2);
      const [restored] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
      expect(restored!.config.workloadIdentityIssuer).toBe(`https://renamed.paperclip.app/oidc/companies/${org.id}`);
    } finally {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://acme.paperclip.app");
    }
  });
});
