import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  activityLog, agents, applyPendingMigrations, companies, companyMemberships, companySecrets,
  connectionGrants, createDb, ensurePostgresDatabase, heartbeatRuns, issues, issueThreadInteractions,
  toolAccessAuditEvents, toolActionRequests, toolApplications, toolCatalogEntries, toolConnections, toolInvocations, userSecretDeclarations,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { summarizeToolValue } from "../services/tool-content-guards.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat/run-preparation.js";
import { createAssignedMcpTools } from "../services/native-runtime/assigned-mcp-tools.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// These provider fixtures exercise Paperclip's real setup, vault, policy, and
// run gateway. They do not establish live provider permissions or deployment.
const actor = { actorType: "user" as const, actorId: "deployment-connector-owner" };
const projectRef = "abcdefghijklmnopqrst";
const teamId = "team_fixture123";
const projectId = "prj_fixture123";
const deploymentId = "dpl_fixture123";
const environmentSecret = "synthetic-deployment-environment-secret";
const providers = [
  {
    slug: "supabase",
    methodKey: "management-api",
    methodConfig: { projectRef },
    read: { name: "supabase_get_project", parameters: {}, receipt: projectRef },
    deploy: {
      name: "supabase_deploy_edge_function",
      parameters: {
        slug: "hello", entrypoint_path: "index.ts", verify_jwt: true,
        files: [{ name: "index.ts", content: 'Deno.serve(() => new Response("hello"))' }],
      },
      receipt: "hello",
    },
    configure: {
      name: "supabase_update_auth_config",
      parameters: { config: { site_url: "https://app.example", uri_allow_list: "https://app.example/**" } },
      receipt: "https://app.example",
    },
    configureSecret: {
      name: "supabase_upsert_edge_function_secret",
      parameters: { name: "SERVICE_TOKEN", secretValue: environmentSecret },
      receipt: "SERVICE_TOKEN",
    },
  },
  {
    slug: "vercel",
    methodKey: "rest-api-key",
    methodConfig: { teamId },
    read: { name: "vercel_list_projects", parameters: {}, receipt: projectId },
    deploy: {
      name: "vercel_create_deployment",
      parameters: { projectId, name: "fixture-app", files: [{ file: "index.html", content: "<h1>Hello</h1>" }], target: "preview" },
      receipt: deploymentId,
    },
    configure: {
      name: "vercel_upsert_environment_variable",
      parameters: { projectId, key: "SERVICE_TOKEN", secretValue: environmentSecret, target: ["preview"] },
      receipt: "SERVICE_TOKEN",
    },
  },
] as const;
type Provider = typeof providers[number];
const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("Deployment connector governance", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) {
      const url = new URL(external);
      if (process.env.PAPERCLIP_TEST_REUSE_DEPLOYMENT_DATABASE === "1") {
        // Only an explicitly named synthetic fixture database may be reused.
        // Each test still creates its own company and connection identities.
        if (!/^\/deployment_connectors_[a-f0-9]{32}$/.test(url.pathname)) {
          throw new Error("Reuse requires an isolated deployment_connectors fixture database");
        }
      } else {
        url.pathname = `/deployment_connectors_${randomUUID().replaceAll("-", "")}`;
      }
      await ensurePostgresDatabase(external, url.pathname.slice(1));
      await applyPendingMigrations(url.toString());
      db = createDb(url.toString());
    } else {
      temp = await startEmbeddedPostgresTestDatabase("deployment-connectors-");
      db = createDb(temp.connectionString);
    }
  }, 30000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function createCompany() {
    const [company] = await db.insert(companies).values({ name: "Deployment fixture", issuePrefix: `D${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
    return company;
  }

  async function fixture(provider: Provider, personal = false, secretValues = [environmentSecret]) {
    const company = await createCompany();
    let credential = `synthetic-${provider.slug}-credential`;
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${credential}`);
      expect(["error", "manual"]).toContain(init.redirect);
      const parsed = new URL(url);
      const method = init.method ?? "GET";
      if (provider.slug === "supabase") {
        expect(parsed.origin).toBe("https://api.supabase.com");
        const prefix = `/v1/projects/${projectRef}`;
        if (parsed.pathname === prefix && method === "GET") return Response.json({ id: projectRef, name: "Fixture project", status: "ACTIVE_HEALTHY", organization_id: "fixture-org", region: "us-east-1" });
        if (parsed.pathname === `${prefix}/config/auth`) {
          if (method === "PATCH") expect(JSON.parse(String(init.body))).toEqual(providers[0].configure.parameters.config);
          return Response.json({ site_url: "https://app.example", uri_allow_list: "https://app.example/**", jwt_secret: credential });
        }
        if (parsed.pathname === `${prefix}/functions/deploy` && method === "POST") {
          expect(parsed.searchParams.get("slug")).toBe("hello");
          expect(Buffer.isBuffer(init.body)).toBe(true);
          const form = await new Response(init.body, { headers: init.headers }).formData();
          expect(JSON.parse(String(form.get("metadata")))).toMatchObject({ entrypoint_path: "index.ts", verify_jwt: true });
          expect(await (form.get("file") as Blob).text()).toBe(providers[0].deploy.parameters.files[0].content);
          return Response.json({ id: randomUUID(), slug: "hello", name: "hello", status: "ACTIVE", version: 1 });
        }
        if (parsed.pathname === `${prefix}/secrets` && method === "POST") {
          const body = JSON.parse(String(init.body));
          expect(body).toEqual([{ name: "SERVICE_TOKEN", value: expect.any(String) }]);
          expect(secretValues).toContain(body[0].value);
          return Response.json(body);
        }
      } else {
        expect(parsed.origin).toBe("https://api.vercel.com");
        if (parsed.pathname === `/v2/teams/${teamId}` && method === "GET") return Response.json({ id: teamId, name: "Fixture team" });
        expect(parsed.searchParams.get("teamId")).toBe(teamId);
        if (parsed.pathname === "/v10/projects" && method === "GET") return Response.json({ projects: [{ id: projectId, name: "fixture-app", accountId: teamId }], pagination: { count: 1, next: null } });
        if (parsed.pathname === `/v9/projects/${projectId}` && method === "GET") return Response.json({ id: projectId, name: "fixture-app", accountId: teamId });
        if (parsed.pathname === "/v7/deployments" && method === "GET") {
          expect(parsed.searchParams.get("projectId")).toBe(projectId);
          expect(parsed.searchParams.get("limit")).toBe("1");
          return Response.json({ deployments: [{ uid: "dpl_existing123", projectId, readyState: "ERROR" }] });
        }
        if (parsed.pathname === "/v13/deployments" && method === "POST") {
          expect(JSON.parse(String(init.body))).toMatchObject({ project: projectId, files: [{ file: "index.html", data: "<h1>Hello</h1>", encoding: "utf-8" }] });
          return Response.json({ id: deploymentId, projectId, name: "fixture-app", url: "fixture-app.vercel.app", readyState: "BUILDING", target: null });
        }
        if (parsed.pathname === `/v10/projects/${projectId}/env` && method === "POST") {
          expect(parsed.searchParams.get("upsert")).toBe("true");
          const body = JSON.parse(String(init.body));
          expect(body).toMatchObject({ key: "SERVICE_TOKEN", value: expect.any(String), target: ["preview"], type: "encrypted" });
          expect(secretValues).toContain(body.value);
          return Response.json({ created: { id: "env_fixture", ...body }, failed: [] });
        }
      }
      throw new Error(`Unexpected ${provider.slug} fixture request: ${method} ${parsed.pathname}`);
    });
    const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connected = await service.connectGalleryApp(company.id, {
      galleryKey: provider.slug, connectionMethodKey: provider.methodKey,
      configValues: provider.methodConfig, ...(personal ? { grantKind: "user" as const } : {}),
      credentialValues: { "credentials.authorization": credential },
    }, actor);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Deployer", role: "engineer", adapterType: "process" }).returning();
    await service.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] },
    }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Deploy fixture app", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      scopeKind: "issue", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request, toolActionSigningSecret: "synthetic-deployment-action-signing-secret" });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const tools = await gateway.listToolsForSession(session.token);
    const call = (action: { name: string; parameters: unknown }) => {
      const tool = tools.find(candidate => candidate.upstreamToolName === action.name);
      expect(tool, action.name).toBeTruthy();
      return gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: action.parameters, idempotencyKey: randomUUID() });
    };
    return { company, service, connected, agent, issue, run, request, gateway, session, tools, call,
      credential: () => credential, rotateCredential: () => { credential = `synthetic-${provider.slug}-replacement`; return credential; } };
  }

  describe.each(providers)("$slug", provider => {
    it("recognizes reviewed REST readiness and completes an existing connection card", async () => {
      const f = await fixture(provider, true);
      await f.service.putConnectionInstalls(f.connected.connectionId, {
        installs: [{ targetType: "agent", targetId: f.agent.id }],
      }, actor);
      const intents = connectionIntentService(db);
      const claims = { sub: f.agent.id, company_id: f.company.id, run_id: f.run.id, responsible_user_id: actor.actorId };
      f.request.mockClear();
      const found = await intents.search(claims, provider.slug);
      expect(found.results).toContainEqual(expect.objectContaining({
        service: provider.slug, state: "ready", connectionId: f.connected.connectionId,
      }));
      expect(await intents.request(claims, provider.slug)).toMatchObject({
        state: "ready", connectionId: f.connected.connectionId, interactionId: null,
      });
      const [card] = await db.insert(issueThreadInteractions).values({
        companyId: f.company.id, issueId: f.issue.id, sourceRunId: f.run.id,
        kind: "connection_intent", status: "pending", addresseeUserId: actor.actorId,
        requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
        payload: { version: 1, serviceSlug: provider.slug, serviceName: provider.slug,
          requestingAgentId: f.agent.id, requestingAgentName: f.agent.name, phase: "requested" },
      }).returning();
      expect(await intents.complete(card.id, f.connected.connectionId, actor.actorId)).toMatchObject({
        status: "accepted", result: { outcome: "connected", connectionId: f.connected.connectionId },
      });
      expect(await intents.usableConnectionForAgent({ companyId: f.company.id, agentId: f.agent.id,
        responsibleUserId: "another-user", serviceSlug: provider.slug })).toBeNull();
      expect(f.request).not.toHaveBeenCalled();
    });

    it("delivers reviewed REST actions through native assignments without admitting unsupported or inactive connections", async () => {
      vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
      onTestFinished(() => vi.unstubAllEnvs());
      const f = await fixture(provider, true);
      await f.service.putConnectionInstalls(f.connected.connectionId, {
        installs: [{ targetType: "agent", targetId: f.agent.id }],
      }, actor);
      const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent: f.agent, runId: f.run.id });
      expect(snapshot.bindingId).not.toBeNull();
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id,
        expectedAssignmentDigest: snapshot.digest });
      expect(servers).toHaveLength(1);
      const assigned = await createAssignedMcpTools({ gateway: f.gateway,
        gatewayPublicId: new URL(servers[0].url).pathname.split("/").at(-1)!, bearerToken: servers[0].token! });
      const found = await assigned.execute({ tool: "paperclip_search_assigned_tools", arguments: { query: provider.read.name } }) as { tools: Array<{ name: string }> };
      expect(found.tools).toHaveLength(1);
      expect(JSON.stringify(await assigned.execute({ tool: "paperclip_call_assigned_tool",
        arguments: { name: found.tools[0].name, arguments: provider.read.parameters } }))).toContain(provider.read.receipt);

      const intents = connectionIntentService(db);
      const original = f.connected.connection;
      f.request.mockClear();
      for (const change of [
        { enabled: false },
        { status: "archived" as const },
        { config: { ...original.config, url: "https://unsupported.example" } },
      ]) {
        await db.update(toolConnections).set({ status: "active", enabled: true, config: original.config, ...change })
          .where(eq(toolConnections.id, original.id));
        expect(await intents.usableConnectionForAgent({ companyId: f.company.id, agentId: f.agent.id,
          responsibleUserId: actor.actorId, serviceSlug: provider.slug })).toBeNull();
        expect((await resolveNativeRuntimeMcpSnapshot({ db, agent: f.agent, runId: f.run.id })).bindingId).toBeNull();
        expect(await buildPaperclipRuntimeMcpServers({ db, agent: f.agent, runId: f.run.id })).toEqual([]);
      }
      expect(f.request).not.toHaveBeenCalled();
    });

    it("rejects unknown setup settings before saving credentials or contacting the provider", async () => {
      const company = await createCompany();
      const request = vi.fn(async () => { throw new Error("Unexpected provider request"); });
      const service = toolAccessService(db, { remoteHttpRequest: request });
      await expect(service.connectGalleryApp(company.id, {
        galleryKey: provider.slug, connectionMethodKey: provider.methodKey,
        configValues: { ...provider.methodConfig, serverUrl: "https://attacker.example" },
        credentialValues: { "credentials.authorization": "synthetic-rejected-setup-key" },
      }, actor)).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id))).toHaveLength(0);
    });

    it("cleans up failed personal setup without echoing provider credentials", async () => {
      const company = await createCompany();
      const credential = "synthetic-invalid-provider-token";
      const request = vi.fn(async () => Response.json({ error: `Rejected ${credential}` }, { status: 401 }));
      const service = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      let failure: unknown;
      try {
        await service.connectGalleryApp(company.id, {
          galleryKey: provider.slug, connectionMethodKey: provider.methodKey, configValues: provider.methodConfig,
          grantKind: "user", credentialValues: { "credentials.authorization": credential },
        }, actor);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(credential);
      expect(request).toHaveBeenCalled();
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, company.id))).toHaveLength(0);
      const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id));
      expect(secrets.every(secret => secret.status !== "active" || secret.deletedAt !== null)).toBe(true);
      expect(await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.companyId, company.id))).toHaveLength(0);
    });

    it.each([false, true])("vaults the selected identity and executes governed deployment/configuration (personal=%s)", async personal => {
      const f = await fixture(provider, personal);
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connected.connectionId));
      expect(grant).toMatchObject({ kind: personal ? "user" : "organization", status: "active" });
      expect(grant.credentialSecretRefs).toHaveLength(1);
      expect(grant.credentialSecretRefs[0].configPath).toBe("credentials.authorization");
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0].secretId));
      expect(secret).toMatchObject({ scope: personal ? "user" : "company", ownerUserId: personal ? actor.actorId : null });
      if (personal) {
        const declarations = await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.targetId, f.connected.connectionId));
        expect(declarations).toEqual(expect.arrayContaining([expect.objectContaining({
          configPath: "credentials.authorization", userSecretDefinitionId: secret.userSecretDefinitionId,
        })]));
        expect(f.connected.connection.credentialSecretRefs).toEqual([]);
      }
      expect(f.connected.catalog.find(entry => entry.toolName === provider.read.name)).toMatchObject({ isReadOnly: true, riskLevel: "read" });
      for (const action of [provider.deploy, provider.configure]) {
        expect(f.connected.catalog.find(entry => entry.toolName === action.name)).toMatchObject({ isReadOnly: false });
      }
      expect(JSON.stringify(f.connected)).not.toContain(f.credential());
      f.request.mockClear();
      await expect(f.service.mintConnectionTokenForAgent({
        connectionId: f.connected.connectionId, companyId: f.company.id, agentId: f.agent.id, runId: f.run.id, body: {},
      })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("cannot be exported") });
      expect(f.request).not.toHaveBeenCalled();
      const actions = [provider.read, provider.deploy, provider.configure, ...(provider.slug === "supabase" ? [provider.configureSecret] : [])];
      for (const action of actions) {
        const result = await f.call(action);
        expect(JSON.stringify(result)).toContain(action.receipt);
        expect(JSON.stringify(result)).not.toContain(f.credential());
        expect(JSON.stringify(result)).not.toContain(environmentSecret);
      }
      if (provider.slug === "supabase") {
        expect(f.request.mock.calls.some(([url, init]) => new URL(url).pathname === `/v1/projects/${projectRef}/config/auth` && init.method === "PATCH")).toBe(true);
      }
      const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.connectionId, f.connected.connectionId));
      expect(invocations).toHaveLength(actions.length);
      expect(invocations.every(invocation => invocation.runId === f.run.id && invocation.issueId === f.issue.id && invocation.agentId === f.agent.id && invocation.status === "succeeded")).toBe(true);
      const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
      const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
      const visible = JSON.stringify({ connection: await f.service.getConnection(f.connected.connectionId), invocations, audits, activity });
      expect(visible).not.toContain(f.credential());
      expect(visible).not.toContain(environmentSecret);
    });

    it("enforces changed Off policies and quarantined deployment contracts on an existing run", async () => {
      const f = await fixture(provider);
      await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
        enabledCatalogEntryIds: f.connected.catalog.filter(entry => entry.toolName !== provider.configure.name).map(entry => entry.id),
        askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
      }, actor);
      f.request.mockClear();
      await expect(f.call(provider.configure)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
      const deployment = f.connected.catalog.find(entry => entry.toolName === provider.deploy.name)!;
      await db.update(toolCatalogEntries).set({ schemaHash: "earlier-schema", versionHash: "earlier-version" }).where(eq(toolCatalogEntries.id, deployment.id));
      expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName === provider.deploy.name)).toBe(false);
      await expect(f.call(provider.deploy)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
      const refreshed = await f.service.refreshCatalog(f.connected.connectionId, actor, { enableAllByDefault: true });
      expect(refreshed.catalog.find(entry => entry.toolName === provider.deploy.name)?.status).toBe("quarantined");
      f.request.mockClear();
      await expect(f.call(provider.deploy)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    });

    it("posts an Ask-first deployment request without reaching the provider", async () => {
      const f = await fixture(provider);
      const deployment = f.connected.catalog.find(entry => entry.toolName === provider.deploy.name)!;
      await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
        enabledCatalogEntryIds: f.connected.catalog.map(entry => entry.id),
        askFirstCatalogEntryIds: [deployment.id], access: { agentIds: [f.agent.id] },
      }, actor);
      f.request.mockClear();
      await expect(f.call(provider.deploy)).rejects.toMatchObject({ reasonCode: "approval_required" });
      expect(f.request).not.toHaveBeenCalled();
      const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ status: "pending", companyId: f.company.id, issueId: f.issue.id, requestedByAgentId: f.agent.id });
      expect(JSON.stringify(requests)).not.toContain(f.credential());
    });

    it("encrypts pending secret configuration and executes the original value only after approval", async () => {
      const f = await fixture(provider);
      const configure = provider.slug === "supabase" ? provider.configureSecret : provider.configure;
      const entry = f.connected.catalog.find(candidate => candidate.toolName === configure.name)!;
      await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
        enabledCatalogEntryIds: f.connected.catalog.map(candidate => candidate.id),
        askFirstCatalogEntryIds: [entry.id], access: { agentIds: [f.agent.id] },
      }, actor);
      f.request.mockClear();
      await expect(f.call(configure)).rejects.toMatchObject({ reasonCode: "approval_required" });
      expect(f.request).not.toHaveBeenCalled();
      const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
      expect(pending.status).toBe("pending");
      expect(pending.signedArguments).toEqual(expect.any(String));
      expect(Buffer.from(pending.signedArguments!, "base64url").toString("utf8")).not.toContain(environmentSecret);
      expect(JSON.stringify(pending)).not.toContain(environmentSecret);
      const approved = await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending.id, actor: { userId: actor.actorId } });
      expect(approved).toMatchObject({ status: "executed" });
      // Provider fixture assertions check the decrypted original value exactly.
      expect(f.request.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
      const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.company.id));
      const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
      const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
      expect(JSON.stringify({ approved, invocations, audits, requests })).not.toContain(environmentSecret);
      expect(JSON.stringify({ approved, invocations, audits, requests })).not.toContain(f.credential());
    });

    it.each(["allowed", "ask_first", "ask_first_legacy"] as const)("distinguishes changed secrets and replays identical writes without exposing values (%s)", async mode => {
      const askFirst = mode !== "allowed";
      const secrets = ["synthetic-secret-first-value", "synthetic-secret-second-value"];
      const f = await fixture(provider, false, secrets);
      const configure = provider.slug === "supabase" ? provider.configureSecret : provider.configure;
      const tool = f.tools.find(candidate => candidate.upstreamToolName === configure.name)!;
      const write = (secretValue: string) => f.gateway.executeTool({
        sessionToken: f.session.token, tool: tool.name,
        parameters: { ...configure.parameters, secretValue },
      });
      if (askFirst) {
        const entry = f.connected.catalog.find(candidate => candidate.toolName === configure.name)!;
        await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
          enabledCatalogEntryIds: f.connected.catalog.map(candidate => candidate.id),
          askFirstCatalogEntryIds: [entry.id], access: { agentIds: [f.agent.id] },
        }, actor);
      }
      const execute = async (secretValue: string) => {
        if (askFirst) {
          await expect(write(secretValue)).rejects.toMatchObject({ reasonCode: "approval_required" });
          const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
          const pending = requests.filter(request => request.status === "pending");
          expect(pending).toHaveLength(1);
          await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending[0].id, actor: { userId: actor.actorId } });
          if (mode === "ask_first_legacy" && secretValue === secrets[0]) {
            // Historical rows used the redacted summary hash. Their signed
            // payload must still distinguish a later change to the secret.
            await db.update(toolActionRequests).set({
              canonicalArgumentsHash: summarizeToolValue({ ...configure.parameters, secretValue }).sha256,
            }).where(eq(toolActionRequests.id, pending[0].id));
          }
        }
        return write(secretValue);
      };
      f.request.mockClear();
      const first = await execute(secrets[0]);
      const second = await execute(secrets[1]);
      const replay = await write(secrets[1]);
      expect(first.status).toBe(askFirst ? "replayed" : "completed");
      expect(second.status).toBe(askFirst ? "replayed" : "completed");
      expect(second.invocationId).not.toBe(first.invocationId);
      expect(replay).toMatchObject({ status: "replayed", invocationId: second.invocationId });
      const writes = f.request.mock.calls.filter(([, init]) => init.method === "POST");
      expect(writes).toHaveLength(2);
      expect(writes.map(([, init]) => {
        const body = JSON.parse(String(init.body));
        return provider.slug === "supabase" ? body[0].value : body.value;
      })).toEqual(secrets);
      const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.company.id));
      expect(invocations).toHaveLength(2);
      expect(new Set(invocations.map(invocation => invocation.argumentsHash)).size).toBe(2);
      const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
      const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
      expect(requests).toHaveLength(askFirst ? 2 : 0);
      const visible = JSON.stringify({ first, second, replay, invocations, audits, requests });
      for (const secret of secrets) expect(visible).not.toContain(secret);
    });

    it("requires reconciliation before retrying an ambiguous completed legacy secret write", async () => {
      const secrets = ["synthetic-legacy-secret-first-value", "synthetic-legacy-secret-second-value"];
      const f = await fixture(provider, false, secrets);
      const configure = provider.slug === "supabase" ? provider.configureSecret : provider.configure;
      const tool = f.tools.find(candidate => candidate.upstreamToolName === configure.name)!;
      const write = (secretValue: string, idempotencyKey?: string) => f.gateway.executeTool({
        sessionToken: f.session.token, tool: tool.name,
        parameters: { ...configure.parameters, secretValue }, idempotencyKey,
      });
      const first = await write(secrets[0]);
      expect(first.status).toBe("completed");
      const [saved] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, first.invocationId));
      const argumentsHash = saved.argumentsSummary!.sha256;
      const legacyScope = {
        companyId: saved.companyId, runId: saved.runId, issueId: saved.issueId,
        applicationId: saved.applicationId, connectionId: saved.connectionId,
        catalogEntryId: saved.catalogEntryId, toolName: saved.toolName, argumentsHash,
      };
      // This reproduces the persisted default key used before full argument
      // identity. Its redacted summary cannot prove which secret was written.
      const canonicalScope = Object.fromEntries(Object.keys(legacyScope).sort().map(key => [key, legacyScope[key as keyof typeof legacyScope]]));
      const legacyKey = `side_effect:${createHash("sha256").update(JSON.stringify(canonicalScope)).digest("hex")}`;
      await db.update(toolInvocations).set({ argumentsHash, idempotencyKey: legacyKey }).where(eq(toolInvocations.id, first.invocationId));

      f.request.mockClear();
      for (const secretValue of secrets) {
        await expect(write(secretValue)).rejects.toMatchObject({
          status: 409,
          reasonCode: "legacy_tool_idempotency_unverifiable",
          details: { reasonCode: "legacy_tool_idempotency_unverifiable", invocationId: first.invocationId },
        });
      }
      expect(f.request).not.toHaveBeenCalled();

      const explicitKey = randomUUID();
      const second = await write(secrets[1], explicitKey);
      const replay = await write(secrets[1], explicitKey);
      expect(second).toMatchObject({ status: "completed" });
      expect(second.invocationId).not.toBe(first.invocationId);
      expect(replay).toMatchObject({ status: "replayed", invocationId: second.invocationId });
      const writes = f.request.mock.calls.filter(([, init]) => init.method === "POST");
      expect(writes).toHaveLength(1);
      const body = JSON.parse(String(writes[0][1].body));
      expect(provider.slug === "supabase" ? body[0].value : body.value).toBe(secrets[1]);
      const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.company.id));
      expect(invocations).toHaveLength(2);
      const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.company.id));
      const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
      expect(requests).toHaveLength(0);
      const visible = JSON.stringify({ first, second, replay, invocations, audits });
      for (const secret of secrets) expect(visible).not.toContain(secret);
    });

    it("keeps another company and another responsible user outside a personal connection", async () => {
      const f = await fixture(provider, true);
      const foreign = await createCompany();
      await expect(f.service.getConnection(f.connected.connectionId, foreign.id)).rejects.toMatchObject({ status: 404 });
      await expect(f.service.reconnectGalleryApp(f.connected.connectionId, foreign.id, {
        credentialValues: { "credentials.authorization": "synthetic-foreign-replacement" },
      }, actor)).rejects.toMatchObject({ status: 404 });
      const [agent] = await db.insert(agents).values({ companyId: foreign.id, name: "Foreign deployer", role: "engineer", adapterType: "process" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: foreign.id, agentId: agent.id,
        scopeKind: "company", invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId }).returning();
      const session = await f.gateway.createSession({ companyId: foreign.id, agentId: agent.id, runId: run.id });
      const deploy = f.tools.find(tool => tool.upstreamToolName === provider.deploy.name)!;
      expect((await f.gateway.listToolsForSession(session.token)).some(tool => tool.upstreamToolName === provider.deploy.name)).toBe(false);
      f.request.mockClear();
      await expect(f.gateway.executeTool({ sessionToken: session.token, tool: deploy.name, parameters: provider.deploy.parameters })).rejects.toThrow();
      await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: "another-user", membershipRole: "admin", status: "active" });
      await expect(f.service.reconnectGalleryApp(f.connected.connectionId, f.company.id, {
        credentialValues: { "credentials.authorization": "synthetic-foreign-replacement" },
      }, { actorType: "user", actorId: "another-user" })).rejects.toMatchObject({ status: 403 });
      await db.update(heartbeatRuns).set({ responsibleUserId: "another-user" }).where(eq(heartbeatRuns.id, f.run.id));
      await expect(f.call(provider.deploy)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    });

    it("rotates credentials without widening saved policies and removes access and owned secrets", async () => {
      const f = await fixture(provider, true);
      await f.service.finishGalleryAppConnection(f.company.id, f.connected.connectionId, {
        enabledCatalogEntryIds: f.connected.catalog.filter(entry => entry.toolName !== provider.deploy.name).map(entry => entry.id),
        askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
      }, actor);
      const replacement = f.rotateCredential();
      const reconnected = await f.service.reconnectGalleryApp(f.connected.connectionId, f.company.id, {
        credentialValues: { "credentials.authorization": replacement },
      }, actor);
      expect(reconnected.connection.id).toBe(f.connected.connectionId);
      expect(JSON.stringify(reconnected)).not.toContain(replacement);
      expect(JSON.stringify(await f.call(provider.read))).toContain(provider.read.receipt);
      f.request.mockClear();
      await expect(f.call(provider.deploy)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
      const removed = await f.service.archiveConnection(f.connected.connectionId, f.company.id, actor);
      expect(removed.connection).toMatchObject({ status: "archived", enabled: false });
      expect(removed.removal.secretsRevoked).toBeGreaterThan(0);
      expect(JSON.stringify(removed)).not.toContain(replacement);
      const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.company.id));
      expect(secrets.every(secret => secret.status !== "active" || secret.deletedAt !== null)).toBe(true);
      expect((await f.gateway.listToolsForSession(f.session.token)).some(tool => tool.upstreamToolName === provider.read.name)).toBe(false);
      f.request.mockClear();
      await expect(f.call(provider.read)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    });
  });

  it.each(["mcp_remote", "rest_api"] as const)("rejects a transport switch on an active Supabase application before saving credentials (from %s)", async transport => {
    const f = await fixture(providers[0]);
    const applicationType = transport === "mcp_remote" ? "mcp_http" : "rest_api";
    if (transport === "mcp_remote") {
      await db.update(toolConnections).set({ transport, config: {
        ...f.connected.connection.config, url: "https://mcp.supabase.com/mcp", connectionMethodKey: "mcp-api-key",
      } }).where(eq(toolConnections.id, f.connected.connectionId));
      await db.update(toolApplications).set({ type: applicationType }).where(eq(toolApplications.id, f.connected.application.id));
    }
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, f.connected.application.id));
    const connectionsBefore = await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.company.id));
    const secretsBefore = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.company.id));
    expect(application).toMatchObject({ status: "active", type: applicationType });
    expect(connectionsBefore).toHaveLength(1);
    expect(connectionsBefore[0]).toMatchObject({ status: "active", transport });
    expect(secretsBefore).toHaveLength(1);
    f.request.mockClear();

    await expect(f.service.connectGalleryApp(f.company.id, {
      galleryKey: "supabase", applicationId: application.id,
      connectionMethodKey: transport === "mcp_remote" ? "management-api" : "mcp-api-key",
      configValues: { projectRef },
      credentialValues: { "credentials.authorization": "synthetic-rejected-transport-switch-token" },
    }, actor)).rejects.toMatchObject({
      status: 409, details: { code: "connection_transport_change_not_supported" },
    });

    expect(f.request).not.toHaveBeenCalled();
    const [applicationAfter] = await db.select().from(toolApplications).where(eq(toolApplications.id, application.id));
    expect(applicationAfter).toEqual(application);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.company.id))).toEqual(connectionsBefore);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.company.id))).toEqual(secretsBefore);
  });

  it("keeps an archived Supabase MCP identity separate when connecting Management API", async () => {
    const provider = providers[0];
    const f = await fixture(provider);
    await f.service.archiveConnection(f.connected.connectionId, f.company.id, actor);
    await db.update(toolConnections).set({ transport: "mcp_remote", config: {
      ...f.connected.connection.config, url: "https://mcp.supabase.com/mcp", connectionMethodKey: "mcp-api-key",
    } }).where(eq(toolConnections.id, f.connected.connectionId));
    await db.update(toolApplications).set({ type: "mcp_http" }).where(eq(toolApplications.id, f.connected.application.id));
    const input = {
      galleryKey: provider.slug, connectionMethodKey: provider.methodKey, configValues: provider.methodConfig,
      credentialValues: { "credentials.authorization": f.credential() },
    };
    f.request.mockClear();
    for (const retained of [{ reconnectConnectionId: f.connected.connectionId }, { applicationId: f.connected.application.id }]) {
      await expect(f.service.connectGalleryApp(f.company.id, { ...input, ...retained }, actor)).rejects.toMatchObject({
        status: 409, details: { code: "connection_transport_change_not_supported" },
      });
    }
    expect(f.request).not.toHaveBeenCalled();
    const [retained] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connected.connectionId));
    expect(retained).toMatchObject({ status: "archived", enabled: false, transport: "mcp_remote", credentialSecretRefs: [] });
    const connected = await f.service.connectGalleryApp(f.company.id, input, actor);
    expect(connected.connectionId).not.toBe(f.connected.connectionId);
    expect(connected.application.id).not.toBe(f.connected.application.id);
    expect(connected.application.type).toBe("rest_api");
    expect(connected.connection.transport).toBe("rest_api");
    await f.service.finishGalleryAppConnection(f.company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] },
    }, actor);
    const tools = await f.gateway.listToolsForSession(f.session.token);
    const read = tools.find(tool => tool.upstreamToolName === provider.read.name)!;
    expect(read).toBeTruthy();
    expect(JSON.stringify(await f.gateway.executeTool({ sessionToken: f.session.token, tool: read.name, parameters: {} }))).toContain(projectRef);
  });
});
