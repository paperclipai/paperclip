import express from "express";
import request from "supertest";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, createDb, heartbeatRuns, issueComments, issues, runIdentityContexts, toolApplications, toolConnectionInstalls, toolConnections, userSecretDefinitions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { filterResolvedGitHubConnectionsForRun, resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async (_company: string, input: { responsibleUserId: string }) => ({ value: `test-token-${input.responsibleUserId}` })),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("operation-time GitHub credential resolution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-broker-signing-secret"); database = await startEmbeddedPostgresTestDatabase("paperclip-github-operation-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); }, 60_000);
  async function seed() {
    const companyId=randomUUID(), agentId=randomUUID(), runId=randomUUID(), issueId=randomUUID();
    await db.insert(companies).values({ id:companyId, name:companyId, issuePrefix:companyId.slice(0,8) });
    await db.insert(agents).values({ id:agentId, companyId, name:"Shared", role:"engineer", adapterType:"codex_local" });
    await db.insert(issues).values({ id:issueId, companyId, title:"Identity test" });
    await db.insert(heartbeatRuns).values({ id:runId, companyId, agentId, status:"running", contextSnapshot:{issueId} });
    await db.insert(companyMemberships).values(["A","B"].map(principalId => ({companyId, principalType:"user", principalId, status:"active", membershipRole:"member"})));
    await initializeRunIdentity(db,{companyId,runId,responsibleUserId:"A",cause:"instruction"});
    return {companyId,agentId,runId,issueId};
  }
  async function grant(input: Awaited<ReturnType<typeof seed>>, user: string, dedicated=false) {
    const applicationId=randomUUID(), connectionId=randomUUID(), secretId=randomUUID(), definitionId=randomUUID(), id=randomUUID();
    await db.insert(toolApplications).values({id:applicationId, companyId:input.companyId, name:applicationId,type:"mcp_http"});
    await db.insert(toolConnections).values({id:connectionId,companyId:input.companyId,applicationId,name:connectionId,uid:connectionId,transport:"mcp_remote",status:"active",enabled:true,credentialPolicy:dedicated?"per_agent":"per_user",config:{sourceTemplateKey:"github"}});
    await db.insert(toolConnectionInstalls).values({companyId:input.companyId,connectionId,targetType:"agent",targetId:input.agentId});
    if (!dedicated) await db.insert(userSecretDefinitions).values({id:definitionId,companyId:input.companyId,key:definitionId,name:"Test GitHub"});
    await db.insert(companySecrets).values({id:secretId,companyId:input.companyId,key:secretId,name:`Test token ${secretId}`,scope:dedicated?"company":"user",ownerUserId:dedicated?null:user,userSecretDefinitionId:dedicated?null:definitionId});
    await db.insert(connectionGrants).values({id,companyId:input.companyId,connectionId,kind:dedicated?"agent":"user",subjectUserId:dedicated?null:user,subjectAgentId:dedicated?input.agentId:null,status:"active",credentialSecretRefs:[{secretId,configPath:"oauth.access_token",versionSelector:"latest"}],providerTenant:{github:{userId:user,login:user,installationCount:1,repositoryCount:1,repositorySelection:"selected",installationIds:["1"],installationOwnerLogins:[user]}}});
    return {id,connectionId,secretId,definitionId};
  }
  async function switchTo(input: Awaited<ReturnType<typeof seed>>, user:string) {
    const id=randomUUID();
    await db.insert(issueComments).values({id,companyId:input.companyId,issueId:input.issueId,authorUserId:user,body:"Next instruction"});
    const context=await reserveSteeredIdentity(db,{...input,messageId:id});
    await acceptSteeredIdentity(db,context!);
  }
  it("resolves A → B → A without retaining tokens, and records only redacted diagnostics", async () => {
    const input=await seed(); await grant(input,"A"); await grant(input,"B");
    for (const user of ["A","B","A"]) {
      await switchTo(input,user);
      const result=await resolveGitHubOperationCredentials(db,input);
      expect(result).toMatchObject({status:"available",login:user,source:"personal"});
      expect(result.env.GH_TOKEN).toBe(`test-token-${user}`);
      expect(result.env.GIT_AUTHOR_EMAIL).toBe(`${user}+${user}@users.noreply.github.com`);
    }
    const history=await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId,input.runId));
    expect(JSON.stringify(history)).not.toContain("test-token-");
  });
  it("returns no credential for unconnected users, removed membership, or ambiguous personal accounts", async () => {
    const input=await seed(); await grant(input,"A");
    await switchTo(input,"B");
    expect((await resolveGitHubOperationCredentials(db,input)).env).toEqual({});
    await switchTo(input,"A");
    await db.update(companyMemberships).set({status:"inactive"}).where(eq(companyMemberships.companyId,input.companyId));
    expect((await resolveGitHubOperationCredentials(db,input)).status).toBe("unavailable");
    await db.update(companyMemberships).set({status:"active"}).where(eq(companyMemberships.companyId,input.companyId));
    const differentAccount = await grant(input,"A");
    await db.update(connectionGrants).set({providerTenant:{github:{userId:"other-github-id",login:"A",installationCount:1,repositoryCount:1,repositorySelection:"selected",installationIds:["1"],installationOwnerLogins:["A"]}}}).where(eq(connectionGrants.id,differentAccount.id));
    expect((await resolveGitHubOperationCredentials(db,input)).reason).toMatch(/More than one/);
    await expect(resolveGitHubOperationCredentials(db,{...input,companyId:randomUUID()})).rejects.toThrow();
  });
  it.each([true, false])("prefers the healthy duplicate regardless of grant age (%s)", async (healthyNewer) => {
    const input = await seed();
    const healthy = await grant(input, "A");
    const broken = await grant(input, "A");
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, healthy.connectionId));
    await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "GitHub access changed during refresh. Try again." }).where(eq(toolConnections.id, broken.connectionId));
    await db.update(connectionGrants).set({ createdAt: new Date(healthyNewer ? "2026-02-01" : "2026-01-01") }).where(eq(connectionGrants.id, healthy.id));
    await db.update(connectionGrants).set({ createdAt: new Date(healthyNewer ? "2026-01-01" : "2026-02-01") }).where(eq(connectionGrants.id, broken.id));
    expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
      status: "available", connectionId: healthy.connectionId, grantId: healthy.id, authenticationMode: "managed",
    });
  });

  it("retries credential acquisition once using another grant for the same account", async () => {
    const input = await seed();
    const older = await grant(input, "A");
    const newer = await grant(input, "A");
    await db.update(connectionGrants).set({ createdAt: new Date("2026-01-01") }).where(eq(connectionGrants.id, older.id));
    await db.update(connectionGrants).set({ createdAt: new Date("2026-02-01") }).where(eq(connectionGrants.id, newer.id));
    vault.resolveUserSecretValue.mockRejectedValueOnce(new Error("secret provider failed"));
    expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "available", grantId: older.id });
  });

  it("uses one stable grant when the same person connects the same GitHub account twice", async () => {
    const input = await seed();
    const first = await grant(input, "A");
    const second = await grant(input, "A");
    await db.update(connectionGrants).set({createdAt:new Date("2026-01-01"),updatedAt:new Date("2027-01-01")}).where(eq(connectionGrants.id,first.id));
    await db.update(connectionGrants).set({createdAt:new Date("2026-02-01")}).where(eq(connectionGrants.id,second.id));
    const context = {...input,responsibleUserId:"A"};
    expect((await resolveManagedGitHubIdentitySelection(db,input.companyId,context)).grant?.id).toBe(second.id);
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"available",login:"A",source:"personal"});
    const connections = [first,second].map(row => ({id:row.connectionId,config:{sourceTemplateKey:"github"}}));
    expect(await filterResolvedGitHubConnectionsForRun({db,...context,connections})).toEqual([connections[1]]);
    // A newer webhook on the old connection must not change the selected policy.
    await db.update(connectionGrants).set({updatedAt:new Date("2028-01-01")}).where(eq(connectionGrants.id,first.id));
    expect((await resolveManagedGitHubIdentitySelection(db,input.companyId,context)).grant?.id).toBe(second.id);
    await db.update(connectionGrants).set({status:"revoked"}).where(eq(connectionGrants.id,second.id));
    expect((await resolveManagedGitHubIdentitySelection(db,input.companyId,context)).grant?.id).toBe(first.id);
    await db.update(toolConnections).set({enabled:false}).where(eq(toolConnections.id,first.connectionId));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"unavailable",env:{}});
  });
  it("does not conflate missing GitHub account IDs or another agent's connection audience", async () => {
    const input = await seed();
    const first = await grant(input,"A");
    const duplicate = await grant(input,"A");
    await db.update(connectionGrants).set({providerTenant:null}).where(eq(connectionGrants.id,duplicate.id));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"unavailable",env:{}});
    await db.update(toolConnectionInstalls).set({targetId:randomUUID()}).where(eq(toolConnectionInstalls.connectionId,duplicate.connectionId));
    expect((await resolveManagedGitHubIdentitySelection(db,input.companyId,{...input,responsibleUserId:"A"})).grant?.id).toBe(first.id);
    await switchTo(input,"B");
    expect((await resolveGitHubOperationCredentials(db,input)).env).toEqual({});
  });
  it.each(["missing-ref", "disabled-secret", "missing-secret", "wrong-owner", "disabled-definition", "no-repositories"])(
    "ignores an incomplete newer duplicate when the same account has an eligible grant (%s)", async (problem) => {
      const input = await seed();
      const first = await grant(input,"A");
      const second = await grant(input,"A");
      await db.update(connectionGrants).set({createdAt:new Date("2026-01-01")}).where(eq(connectionGrants.id,first.id));
      await db.update(connectionGrants).set({createdAt:new Date("2026-02-01")}).where(eq(connectionGrants.id,second.id));
      if (problem === "missing-ref") await db.update(connectionGrants).set({credentialSecretRefs:[]}).where(eq(connectionGrants.id,second.id));
      if (problem === "disabled-secret") await db.update(companySecrets).set({status:"disabled"}).where(eq(companySecrets.id,second.secretId));
      if (problem === "disabled-definition") await db.update(userSecretDefinitions).set({status:"disabled"}).where(eq(userSecretDefinitions.id,second.definitionId));
      if (problem === "missing-secret") await db.delete(companySecrets).where(eq(companySecrets.id,second.secretId));
      if (problem === "wrong-owner") await db.update(companySecrets).set({ownerUserId:"B"}).where(eq(companySecrets.id,second.secretId));
      if (problem === "no-repositories") await db.update(connectionGrants).set({providerTenant:{github:{userId:"A",login:"A",installationCount:0,repositoryCount:0,repositorySelection:"none",installationIds:[],installationOwnerLogins:[]}}}).where(eq(connectionGrants.id,second.id));
      expect((await resolveManagedGitHubIdentitySelection(db,input.companyId,{...input,responsibleUserId:"A"})).grant?.id).toBe(first.id);
      expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"available",login:"A"});
      const connections = [first,second].map(row => ({id:row.connectionId,config:{sourceTemplateKey:"github"}}));
      expect(await filterResolvedGitHubConnectionsForRun({db,...input,responsibleUserId:"A",connections})).toEqual([connections[0]]);
    },
  );
  it("retains dedicated override semantics when the dedicated account has duplicate grants", async () => {
    const input = await seed();
    await grant(input,"A");
    const first = await grant(input,"robot",true);
    const second = await grant(input,"robot",true);
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"available",source:"dedicated",login:"robot"});
    await db.update(connectionGrants).set({status:"revoked"}).where(eq(connectionGrants.id,first.id));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"available",source:"dedicated",login:"robot"});
    await db.update(connectionGrants).set({status:"revoked"}).where(eq(connectionGrants.id,second.id));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"unavailable",source:"dedicated",env:{}});
  });
  it("honors dedicated overrides and never substitutes personal credentials when revoked or disabled", async () => {
    const input=await seed(); await grant(input,"A"); const dedicated=await grant(input,"robot",true);
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"available",source:"dedicated",login:"robot"});
    await db.update(connectionGrants).set({status:"revoked"}).where(eq(connectionGrants.id,dedicated.id));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"unavailable",source:"dedicated",env:{}});
    await db.update(connectionGrants).set({status:"active"}).where(eq(connectionGrants.id,dedicated.id));
    await db.update(toolConnections).set({enabled:false}).where(eq(toolConnections.id,dedicated.connectionId));
    expect(await resolveGitHubOperationCredentials(db,input)).toMatchObject({status:"unavailable",source:"dedicated",env:{}});
  });
  it("does not resolve the company default person's GitHub", async () => {
    const input=await seed(); await grant(input,"A");
    await db.update(runIdentityContexts).set({cause:"company_default"}).where(eq(runIdentityContexts.runId,input.runId));
    expect((await resolveGitHubOperationCredentials(db,input)).env).toEqual({});
  });
  it("requires a run-scoped runtime capability and never accepts browser authentication or supplied identities", async () => {
    const input = await seed(); await grant(input, "A");
    const app = express(); app.use(express.json()); app.use(runtimeConnectionIntentRoutes(db)); app.use(errorHandler);
    const tokenInput = {...input, responsibleUserId: "A", scope: "github_credentials" as const};
    const token = createRuntimeToolsToken(tokenInput)!.token;
    const post = () => request(app).post("/runtime-tools/github/credentials");
    const a = await post().set("Authorization", `Bearer ${token}`).send({responsibleUserId: "B"});
    expect((await post().set("Authorization", `Bearer ${token}`).set("Sec-Fetch-Mode", "cors")).status).toBe(200);
    expect(a.status).toBe(200); expect(a.body.login).toBe("A"); expect(a.headers["cache-control"]).toBe("no-store");
    for (const [header, value] of [["Origin", "http://127.0.0.1"], ["Cookie", "session=test"], ["Sec-Fetch-Site", "same-origin"]]) {
      expect((await post().set("Authorization", `Bearer ${token}`).set(header!,value!)).status).toBe(403);
    }
    const wrongScope = createRuntimeToolsToken({...tokenInput, scope: "connection_intents"})!.token;
    expect((await post().set("Authorization", `Bearer ${wrongScope}`)).status).toBe(401);
    const wrongAgent = createRuntimeToolsToken({...tokenInput, agentId: randomUUID()})!.token;
    expect((await post().set("Authorization", `Bearer ${wrongAgent}`)).status).toBe(403);
    // The runner bridge replaces Authorization, but forwards the separate run capability.
    expect((await post().set("Authorization", "Bearer bridge-host-token").set("x-paperclip-github-capability",token)).status).toBe(200);
    await switchTo(input,"B");
    const b = await post().set("Authorization", `Bearer ${token}`);
    expect(b.status).toBe(200); expect(b.body.env).toEqual({});
    await db.update(heartbeatRuns).set({status: "succeeded"}).where(eq(heartbeatRuns.id,input.runId));
    expect((await post().set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });

});
