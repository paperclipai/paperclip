import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import pino from "pino";
import request from "supertest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_PAT_METHOD } from "../services/connectors/azure-devops/index.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => secrets.get(secretId) ?? "",
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: secrets.get(input.definitionId) ?? "" }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Azure Git runtime credential route", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const chunks: string[] = [];
  const logStream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const app = express();

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "azure-runtime-route-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-azure-git-runtime-route-");
    db = createDb(database.connectionString);
    app.use(express.json());
    app.use(createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, logStream)));
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    secrets.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }, 60_000);
  afterEach(() => vi.unstubAllGlobals());

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Azure runtime route", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Azure runner", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Clone Azure repository" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "route-user", status: "active", membershipRole: "member" });
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "route-user", cause: "instruction" });

    const applicationId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID(), secretId = randomUUID();
    const token = "azure-runtime-route-pat-secret-canary";
    secrets.set(secretId, token);
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `azure-route-${applicationId}`, name: "Azure DevOps", type: "rest_api", status: "active" });
    await db.insert(companySecrets).values({ id: secretId, companyId, key: `azure-route-${secretId}`, name: "Azure PAT", scope: "company" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Azure DevOps", uid: connectionId,
      transport: "rest_api", authKind: "api_key", credentialSource: "paperclip_vault", status: "active", enabled: true,
      credentialPolicy: "per_agent", config: { sourceTemplateKey: "azure-devops", connectionMethodKey: AZURE_DEVOPS_PAT_METHOD,
        url: AZURE_DEVOPS_API_URL, methodConfig: { organization: "contoso" } } });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "agent", subjectAgentId: agentId, status: "active",
      credentialSecretRefs: [{ secretId, configPath: "credentials.authorization", versionSelector: "latest" }] });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId });
    return { companyId, agentId, runId, issueId, repoUrl: "https://dev.azure.com/contoso/Project/_git/repo", token };
  }

  function tokenFor(input: Awaited<ReturnType<typeof seed>>, scope: "git_credentials" | "github_credentials" = "git_credentials", companyId = input.companyId) {
    const created = createRuntimeToolsToken({ companyId, agentId: input.agentId, runId: input.runId, responsibleUserId: "route-user", scope });
    if (!created) throw new Error("runtime token signing is not configured");
    return created.token;
  }

  function mockAzureProvider(input: Awaited<ReturnType<typeof seed>>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://dev.azure.com/contoso/_apis/git/repositories?api-version=7.1");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
      expect(init?.redirect).toBe("error");
      return Response.json({ value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "Project" } }] });
    }));
    return request(app).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${tokenFor(input)}`)
      .send({ repositoryUrl: input.repoUrl });
  }

  it("resolves Azure Git credentials only for a git_credentials token bound to a live run", async () => {
    const input = await seed();
    const response = await mockAzureProvider(input);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({ status: "available", env: { PAPERCLIP_AZURE_GIT_TOKEN: input.token } });
    expect(chunks.join("")).not.toContain(input.token);

    const wrongScope = await request(app).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${tokenFor(input, "github_credentials")}`)
      .send({ repositoryUrl: input.repoUrl });
    expect(wrongScope.status).toBe(401);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, input.runId));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("must not contact provider after run ends"); }));
    const endedRun = await request(app).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${tokenFor(input)}`)
      .send({ repositoryUrl: input.repoUrl });
    expect(endedRun.status).toBe(403);
    expect(chunks.join("")).not.toContain(input.token);
  });

  it("rejects board/browser authentication, cross-company claims, and extra credential fields", async () => {
    const input = await seed();
    const validToken = tokenFor(input);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const post = () => request(app).post("/runtime-tools/git/credentials");
    expect((await post().set("Authorization", "Bearer board-session-token").send({ repositoryUrl: input.repoUrl })).status).toBe(401);
    expect((await post().set("Authorization", `Bearer ${validToken}`).set("Origin", "https://paperclip.example").send({ repositoryUrl: input.repoUrl })).status).toBe(403);
    expect((await post().set("Authorization", `Bearer ${validToken}`).set("Cookie", "session=board-session").send({ repositoryUrl: input.repoUrl })).status).toBe(403);
    expect((await post().set("Authorization", `Bearer ${validToken}`).set("Sec-Fetch-Site", "same-origin").send({ repositoryUrl: input.repoUrl })).status).toBe(403);

    const foreignCompanyToken = tokenFor(input, "git_credentials", randomUUID());
    expect((await post().set("Authorization", `Bearer ${foreignCompanyToken}`).send({ repositoryUrl: input.repoUrl })).status).toBe(403);

    const bodyCanary = "unexpected-body-token-secret-canary";
    const invalidBody = await post().set("Authorization", `Bearer ${validToken}`)
      .send({ repositoryUrl: input.repoUrl, token: bodyCanary });
    expect(invalidBody.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chunks.join("")).not.toContain(bodyCanary);
    expect(chunks.join("")).not.toContain(input.token);
  });

  it("does not log secrets when the provider request fails", async () => {
    const input = await seed();
    const providerErrorCanary = "provider-error-token-secret-canary";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`provider failure included ${providerErrorCanary}`); }));
    const response = await request(app).post("/runtime-tools/git/credentials")
      .set("Authorization", `Bearer ${tokenFor(input)}`)
      .send({ repositoryUrl: input.repoUrl });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(providerErrorCanary);
    expect(chunks.join("")).not.toContain(providerErrorCanary);
    expect(chunks.join("")).not.toContain(input.token);
  });
});
