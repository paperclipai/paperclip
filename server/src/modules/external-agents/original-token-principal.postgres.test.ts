import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, createDb, closeRegisteredClients, companies, authUsers, mcpOauthGrants } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../../lib/dedicated-test-database-url.js";
import { accessService } from "../../services/access.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createMcpApiDispatch, createPublicMcpExecutor } from "../../services/public-mcp/capabilities.js";
import { createPublicMcpOAuth } from "../../services/public-mcp/oauth.js";
import { publicMcpIngressRoutes, publicMcpManagementRoutes } from "../../routes/public-mcp.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { readDotOriginalTokenPrincipal } from "./original-token-principal.js";

const url=resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_PRINCIPAL_LEAF_TEST_DATABASE_URL");
const origin="https://dot-principal-leaf.example.test",resource=origin+"/mcp/runner";
describe.skipIf(!url)("actual OAuth producer and original-token principal leaf; no Cloud transport",()=>{
  let db:ReturnType<typeof createDb>,app:express.Express,oauth:ReturnType<typeof createPublicMcpOAuth>;
  let companyId:string,otherCompanyId:string,userId:string,number=0,calls=0;
  beforeAll(async()=>{vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));await applyPendingMigrations(url!);},90_000);
  afterAll(()=>{vi.unstubAllEnvs();});
  beforeEach(async()=>{
    db=createDb(url!,{maxConnections:2,applicationName:"dot-principal-current-leaf"});
    companyId=randomUUID();otherCompanyId=randomUUID();userId=randomUUID();number++;calls=0;
    await db.insert(companies).values([{id:companyId,name:"Dot principal leaf",issuePrefix:`DPL${number}`},{id:otherCompanyId,name:"Other principal leaf",issuePrefix:`DPO${number}`}]);
    await db.insert(authUsers).values({id:userId,name:"Selected user",email:userId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    await accessService(db).ensureMembership(companyId,"user",userId,"owner","active");
    await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:true});
    oauth=createPublicMcpOAuth(db,{origin,resource});
    app=express();app.use(express.json());
    app.use((req,_res,next)=>{req.actor={type:"none",source:"none"};next();});
    const personal=createPublicMcpOAuth(db,{origin,resource:origin+"/mcp/paperclip"}),dispatch=createMcpApiDispatch(express.Router());
    app.use(publicMcpIngressRoutes(oauth,createPublicMcpExecutor(db,oauth,dispatch)));
    app.use((req,_res,next)=>{if(req.get("x-selected-operator")===userId)req.actor={type:"board",source:"session",userId,companyIds:[companyId],memberships:[{companyId,membershipRole:"owner",status:"active"}]};next();});
    app.use("/api",publicMcpManagementRoutes(personal,oauth));app.use(errorHandler);
  });
  afterEach(async()=>{if(db)await db.$client.end({timeout:1});if(url)await closeRegisteredClients(url,{scope:"database"});});
  async function issue(){
    const redirect="https://chatgpt.com/connector_platform/oauth/callback";
    const registration=await request(app).post("/mcp/runner/oauth/register").send({client_name:"Actual principal leaf",redirect_uris:[redirect],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"});
    expect(registration.status,JSON.stringify(registration.body)).toBe(201);
    const clientId=registration.body.client_id,verifier=randomBytes(48).toString("base64url");
    const start=await request(app).get("/mcp/runner/oauth/authorize").query({client_id:clientId,redirect_uri:redirect,response_type:"code",resource,scope:"paperclip:agent offline_access",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
    expect(start.status,JSON.stringify(start.body)).toBe(303);
    const id=new URL(start.headers.location,origin).pathname.split("/").at(-1)!;
    const consent=await request(app).post(`/api/mcp/requests/${id}/consent`).set("Origin",origin).set("x-selected-operator",userId).send({decision:"approve",companyId,allowWrites:false});
    expect(consent.status,JSON.stringify(consent.body)).toBe(200);
    const tokens=await request(app).post("/mcp/runner/oauth/token").send({grant_type:"authorization_code",client_id:clientId,redirect_uri:redirect,resource,code:new URL(consent.body.redirectUrl).searchParams.get("code"),code_verifier:verifier});
    expect(tokens.status,JSON.stringify(tokens.body)).toBe(200);
    const [grant]=await db.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.companyId,companyId),eq(mcpOauthGrants.userId,userId),eq(mcpOauthGrants.clientId,clientId)));
    expect(grant).toMatchObject({companyId,userId,clientId,purpose:"agent",resource,agentId:null,revokedAt:null});expect(grant.scopes).toContain("paperclip:agent");
    return{clientId,token:tokens.body.access_token,refresh:tokens.body.refresh_token,grant};
  }
  function project(input:Parameters<typeof readDotOriginalTokenPrincipal>[1]){
    return readDotOriginalTokenPrincipal({mode:oauth.mode,config:oauth.config,authenticate:token=>{calls++;return oauth.authenticate(token);}},input);
  }
  it("projects a real unpaired grant once, refreshes it and rejects normal revocation",async()=>{
    const issued=await issue(),input={accessToken:issued.token,upstreamClientId:issued.clientId,selectingUserId:userId,canonicalVerifiedResource:resource,requestedCompanyId:companyId};
    expect(await project(input)).toEqual({userId,companyId,grantId:issued.grant.id,clientId:issued.clientId,resource,purpose:"agent"});expect(calls).toBe(1);
    const refresh=await request(app).post("/mcp/runner/oauth/token").send({grant_type:"refresh_token",client_id:issued.clientId,resource,refresh_token:issued.refresh});expect(refresh.status,JSON.stringify(refresh.body)).toBe(200);
    expect((await project({...input,accessToken:refresh.body.access_token})).grantId).toBe(issued.grant.id);expect(calls).toBe(2);
    const revoked=await request(app).post("/mcp/runner/oauth/revoke").send({client_id:issued.clientId,resource,token:refresh.body.refresh_token,token_type_hint:"refresh_token"});expect(revoked.status,JSON.stringify(revoked.body)).toBe(200);
    await expect(project({...input,accessToken:refresh.body.access_token})).rejects.toThrow();expect(calls).toBe(3);
    expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,issued.grant.id)))[0].revokedAt).not.toBeNull();
  },30_000);
  it("retains client, selecting-user, company, current membership and feature authority",async()=>{
    const issued=await issue(),input={accessToken:issued.token,upstreamClientId:issued.clientId,selectingUserId:userId,canonicalVerifiedResource:resource};
    for(const change of [{upstreamClientId:"foreign-client"},{selectingUserId:"foreign-user"},{requestedCompanyId:otherCompanyId}]){
      const before=calls;await expect(project({...input,...change})).rejects.toMatchObject({code:"invalid_grant"});expect(calls).toBe(before+1);
    }
    const before=calls;await expect(project({...input,canonicalVerifiedResource:origin+"/mcp/paperclip"})).rejects.toThrow();expect(calls).toBe(before);
    await accessService(db).ensureMembership(companyId,"user",userId,"owner","suspended");await expect(project(input)).rejects.toThrow();
    await accessService(db).ensureMembership(companyId,"user",userId,"owner","active");expect((await project(input)).grantId).toBe(issued.grant.id);
    await instanceSettingsService(db).updateExperimental({enableOpenAiDot:false});await expect(project(input)).rejects.toThrow();
    await instanceSettingsService(db).updateExperimental({enableOpenAiDot:true});expect((await project(input)).grantId).toBe(issued.grant.id);
  },30_000);
});
