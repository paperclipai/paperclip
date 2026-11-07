import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, createDb, closeRegisteredClients, authUsers, companies, mcpOauthGrants } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../lib/dedicated-test-database-url.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createCloudWarmStandby } from "../services/cloud-warm-standby.js";
import { initializeCloudRuntimeIdentity, getCloudRuntimeIdentity, resetCloudRuntimeIdentityForTests, resetCloudControlReplayFenceForTests, CLOUD_RUNTIME_IDENTITY_HEADER } from "../services/cloud-runtime-identity.js";
import * as oauthModule from "../services/public-mcp/oauth.js";
import { removeTestHome } from "./helpers/remove-test-home.js";

type Tenant={stackId:string;companyId?:string;slug:string;publicOrigin:string;upstreamOrigin:string;instanceId:string};
type Projection={userId:string;companyId:string;grantId:string;clientId:string;resource:string;purpose:"agent"};
type Control={stackId:string;action:"mcp-dot:principal";requestId:string};
type PrincipalInput={tenant:Tenant;accessToken:string;upstreamClientId:string;selectingUserId:string;canonicalVerifiedResource:string;requestedCompanyId?:string};
type Namespace={instanceId:string};
type Instance={id:string;status:string;kind:string;companyStackId?:string;activeOrigin?:string;origins:string[]};
type Stack={id:string;primaryHost:string;stackSlug:string};
type Registry={updateStackWakeState:(id:string,input:unknown)=>Promise<unknown>;createFleetReleaseArtifact:(input:unknown)=>Promise<unknown>;importFeatureCatalog:(input:unknown)=>Promise<unknown>;getAssistantMcpStack:(id:string)=>Promise<Stack|undefined>;getGlobalUser:(id:string)=>Promise<unknown>;hasActiveStackMembership:(stack:string,user:string)=>Promise<boolean>;assistantMcpStore:()=>unknown;mcpClientMirrorStore:()=>{readCurrent:(stack:string,origin:string)=>Promise<Namespace|undefined>;getClient:(binding:{stackId:string;companyId:string;origin:string;instanceId:string},id:string,receipt:Namespace)=>Promise<unknown>}};
type Instances={putCloudStackInstance:(input:unknown)=>Promise<unknown>;getInstance:(id:string)=>Promise<Instance|undefined>;setCloudStackOrigins:(input:{id:string;companyStackId:string;origins:string[];activeOrigin:string;now:Date})=>Promise<unknown>};
type Router=new(input:{registry:{findStackByHost:(host:string)=>Promise<Stack|undefined>;findStackBySlug:(slug:string)=>Promise<Stack|undefined>};baseDomain:string})=>{resolveRoute:(input:{trustedHost:string})=>Promise<{kind:string;target?:{stackId:string;primaryHost:string;stackSlug:string;activeAppOrigin?:string}}>};

const url=resolveExternalTestDatabaseUrl("PAPERCLIP_DOT_PRINCIPAL_HOP_TEST_DATABASE_URL");
const origin="https://principal-hop.paperclip.app",cloudOrigin="https://cloud.principal-hop.example.test",stackId="principal-hop-stack",slug="principal-hop";
const resource=origin+"/mcp/runner",redirect="https://chatgpt.com/connector_platform/oauth/callback";
const listen=async(server:Server)=>{server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("Missing owned principal listener");return `http://127.0.0.1:${address.port}`;};
const close=async(server:Server|undefined)=>{if(!server?.listening)return;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};
describe.skipIf(!url)("normal App signed original-principal HTTP hop with actual OAuth and Cloud signer",()=>{
  let db:ReturnType<typeof createDb>,app:express.Express|undefined,home:string,cloudServer:Server|undefined,appServer:Server|undefined;
  let cloudService:{handler:(req:IncomingMessage,res:ServerResponse)=>unknown;stopBackgroundTasks:()=>void}|undefined,restoreOAuth:(()=>void)|undefined;
  let signer:{publicJwks:string;signClaim:(input:{stackId:string;claimId:string;previousOrigin:string;canonicalOrigin:string;stackSlug:string})=>string;signControlAssertion:(input:{stackId:string;action:"mcp-dot:principal";requestId:string})=>string};
  let makeClient:(input:{signControlAssertion:(input:Control)=>string;refreshTenant:(user:string,stack:string)=>Promise<Tenant|undefined>;fetchImplementation:typeof fetch})=>(input:PrincipalInput)=>Promise<Projection>;
  let projectTenant:(tenant:Omit<Tenant,"instanceId">,binding:{stackId:string;origin:string;instanceId:string})=>Tenant|undefined;
  let registry:Registry,connectorStore:Instances,CloudStackRouter:Router,metadataCompany:(id:string)=>string;
  let cloudLoopback="",appLoopback="",upstreamOrigin="",sessionCalls=0,authenticateCalls=0,unexpectedFetches=0,casePassed=false;
  const userId=randomUUID(),companyId=randomUUID(),otherCompanyId=randomUUID(),instanceId="inst_"+randomUUID();
  const originalFetch=globalThis.fetch;
  const mapped:typeof fetch=async(input,init)=>{
    const target=new URL(input instanceof Request?input.url:String(input));
    const base=target.origin===cloudOrigin?cloudLoopback:target.origin===origin||target.origin===upstreamOrigin?appLoopback:undefined;
    if(!base){unexpectedFetches++;throw new Error("Unexpected off-host principal fixture request");}
    const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));headers.set("host",new URL(target.origin===cloudOrigin?cloudOrigin:origin).host);
    return originalFetch(new URL(target.pathname+target.search,base),{...init,headers});
  };
  beforeAll(async()=>{
    const checkout=process.env.PAPERCLIP_DOT_PRINCIPAL_CLOUD_CHECKOUT;if(!checkout||!path.isAbsolute(checkout))throw new Error("Explicit own compiled current Cloud checkout required");
    const load=(name:string)=>import(pathToFileURL(path.join(checkout,"dist",name)).href);
    const [runtime,principal,resolver,memory,provisioner,fake,stores,secretStore,providers,service,routing,identity]=await Promise.all([
      load("runtime/runtime-identity-assertion.js"),load("assistant-mcp/dot-principal.js"),load("assistant-mcp/client-resolver.js"),load("provisioner/memory.js"),load("provisioner/provisioner.js"),load("providers/fake.js"),load("connections/store.js"),load("providers/neon.js"),load("connections/providers.js"),load("service/app.js"),load("routing/router.js"),load("identity/tenant-company.js"),
    ]);
    makeClient=principal.createDotPrincipalClient;projectTenant=resolver.dotPrincipalTenantFromBinding;CloudStackRouter=routing.CloudStackRouter;metadataCompany=identity.tenantPaperclipCompanyIdForStack;
    home=await mkdtemp(path.join(tmpdir(),"dot-principal-hop-"));vi.stubEnv("PAPERCLIP_HOME",home);vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));
    const control=generateKeyPairSync("ed25519"),sign=generateKeyPairSync("ed25519"),seal=generateKeyPairSync("x25519"),kid="principal-hop-current";
    const publicJwks=JSON.stringify({keys:[{...control.publicKey.export({format:"jwk"}),kid,alg:"EdDSA",use:"sig"}]});
    signer=runtime.createRuntimeIdentitySignerFromEnv({CLOUD_HARNESS_RUNTIME_IDENTITY_SIGNING_JWK:JSON.stringify({...control.privateKey.export({format:"jwk"}),kid,alg:"EdDSA",use:"sig"}),CLOUD_HARNESS_RUNTIME_IDENTITY_JWKS:publicJwks},{required:true});
    registry=new memory.InMemoryCloudHarnessRegistry();const provider=new fake.FakeCloudStackProvider();connectorStore=new stores.InMemoryConnectorStore();
    await registry.createFleetReleaseArtifact({id:"principal-hop-release",appVersion:"principal-hop"});await registry.importFeatureCatalog({releaseArtifactId:"principal-hop-release",catalogVersion:"principal-hop",features:{"cloud.feature-masking":{tier:"managed"}}});
    await new provisioner.CloudStackProvisioner({registry,provider}).provisionDevelopmentStack({idempotencyKey:stackId,accountGroup:{id:"principal-hop-account",slug,displayName:"Principal hop"},owner:{id:userId,email:userId+"@example.test"},stack:{stackId,accountGroupId:"principal-hop-account",stackSlug:slug,displayName:"Principal hop",kind:"demo",primaryHost:new URL(origin).hostname,region:"us-east-1"},versionPlan:{appVersion:"principal-hop",schemaVersion:"fixture",rolloutTrack:"stable"},sleepPolicy:{desiredState:"awake"},primaryCompany:{paperclipCompanyId:otherCompanyId,displayName:"Primary not consent",defaultBudgetCents:0}});
    await registry.updateStackWakeState(stackId,{providerRefs:[{provider:"railway",resourceType:"service_domain:web",externalId:"principal-hop-domain",name:"tenant",metadata:{upstreamOrigin:"https://principal-hop-provider.example.test"}}],lifecycleState:"active",sleepState:"awake"});
    await connectorStore.putCloudStackInstance({id:instanceId,kind:"cloud_stack",companyStackId:stackId,environment:"test",signPublicKey:sign.publicKey.export({format:"jwk"}).x!,sealPublicKey:seal.publicKey.export({format:"jwk"}).x!,origins:[origin],activeOrigin:origin,label:"Principal hop actual enrolled namespace",status:"active",createdAt:new Date(),updatedAt:new Date()});
    vi.stubGlobal("fetch",mapped);
    cloudService=service.createCloudHarnessService({registry,provider,baseDomain:"paperclip.app",customerAppOrigin:cloudOrigin,runtimeIdentity:signer,incomingMcpWakeEnabled:true,tenantSessionSigningKey:"principal-hop-tenant-session-".repeat(3),customerSessionSigningKey:"principal-hop-customer-session-".repeat(3),appVersion:"principal-hop",schemaVersion:"fixture",assistantMcp:{store:registry.assistantMcpStore(),encryptionKey:Buffer.alloc(32,9)},connector:{environment:"test",providers:providers.providerRegistryFromEnvironment({}),fetchImplementation:mapped,secrets:{resolve:async()=>{throw new Error("No external provider");}},store:connectorStore,stackEnrollment:{secrets:new secretStore.InMemoryProviderSecretStore(),secretRefPrefix:"secret://principal-hop"}}});
    cloudServer=createServer((req,res)=>{const current=cloudService;if(!current)throw new Error("Missing normal Cloud handler");current.handler(req,res);});cloudLoopback=await listen(cloudServer);
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID",stackId);vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN","principal-hop-tenant-token");vi.stubEnv("PAPERCLIP_CLOUD_WARM_STANDBY","1");
    vi.stubEnv("PAPERCLIP_PUBLIC_URL",origin);vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL",origin);vi.stubEnv("PAPERCLIP_API_URL",origin);vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS",publicJwks);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID",instanceId);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT","test");vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL",cloudOrigin);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",sign.privateKey.export({format:"jwk"}).d!);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",seal.privateKey.export({format:"jwk"}).d!);
    await applyPendingMigrations(url!);db=createDb(url!,{maxConnections:2,applicationName:"dot-principal-normal-app"});resetCloudRuntimeIdentityForTests();resetCloudControlReplayFenceForTests();await initializeCloudRuntimeIdentity(db);
    const standby=await createCloudWarmStandby(db);expect(standby()).toBe(true);
    const createOAuth=oauthModule.createPublicMcpOAuth;const spy=vi.spyOn(oauthModule,"createPublicMcpOAuth").mockImplementation((...args)=>{const owner=createOAuth(...args);if(owner.mode==="openai_dot_agent"){const original=owner.authenticate;owner.authenticate=token=>{authenticateCalls++;return original.call(owner,token);};}return owner;});restoreOAuth=()=>spy.mockRestore();
    const {createApp}=await import("../app.js");
    app=await createApp(db,{uiMode:"none",serverPort:3100,storageService:createStorageService(createLocalDiskStorageProvider(path.join(home,"objects"))),deploymentMode:"authenticated",deploymentExposure:"private",bindHost:"127.0.0.1",allowedHostnames:[new URL(origin).hostname],authPublicBaseUrl:origin,authReady:true,companyDeletionEnabled:false,managedPluginAutoInstall:[],cloudWarmStandby:standby,decisionServiceOptions:{wakeOriginAgent:async()=>null},resolveSession:async req=>{sessionCalls++;if(req.get("x-selected-operator")!==userId)return null;const [user]=await db.select().from(authUsers).where(eq(authUsers.id,userId));return user?{session:{id:"principal-hop-session",userId},user}:null;}});
    await app.locals.bundledPluginsStartup;appServer=createServer(app);appLoopback=await listen(appServer);
  },90_000);
  afterAll(async()=>{
    const errors:unknown[]=[];
    try{await app?.locals.paperclipShutdown?.();}catch(error){errors.push(error);}
    try{await close(appServer);}catch(error){errors.push(error);}
    try{cloudService?.stopBackgroundTasks();await close(cloudServer);}catch(error){errors.push(error);}
    try{if(db)await db.$client.end({timeout:1});if(url)await closeRegisteredClients(url,{scope:"database"});}catch(error){errors.push(error);}
    restoreOAuth?.();resetCloudRuntimeIdentityForTests();resetCloudControlReplayFenceForTests();vi.unstubAllEnvs();vi.unstubAllGlobals();
    if(!errors.length&&casePassed&&home)removeTestHome(home);
    if(errors.length)throw new AggregateError(errors,"Principal normal App owned cleanup failed");
  },30_000);
  it("keeps normal host/runtime/standby/actor order and projects real OAuth through the real Cloud signer/client",async()=>{
    if(!app)throw new Error("Missing normal App");const host=new URL(origin).host,path="/mcp/runner/oauth/cloud-principal",wire={accessToken:"unissued-preclaim-canary",upstreamClientId:"unissued-client",selectingUserId:userId,canonicalVerifiedResource:resource,expectedInstanceId:instanceId};
    const before=sessionCalls;
    expect((await request(app).post(path).set("Host","foreign.example.test").send(wire)).status).toBe(403);
    expect((await request(app).post(path).set("Host",host).set(CLOUD_RUNTIME_IDENTITY_HEADER,"wrong-endpoint").send(wire)).status).toBe(400);
    expect((await request(app).post(path).set("Host",host).send(wire)).status).toBe(503);expect(getCloudRuntimeIdentity()).toBeNull();expect(authenticateCalls).toBe(0);expect(sessionCalls).toBe(before);
    const claim=signer.signClaim({stackId,claimId:randomUUID(),previousOrigin:origin,canonicalOrigin:origin,stackSlug:slug});
    const health=await request(app).get("/api/health").set("Host",host).set(CLOUD_RUNTIME_IDENTITY_HEADER,claim);expect(health.status,JSON.stringify(health.body)).toBe(200);expect(getCloudRuntimeIdentity()).toMatchObject({stackId,canonicalOrigin:origin});
    await db.insert(companies).values([{id:companyId,name:"Grant company",issuePrefix:"HPG"},{id:otherCompanyId,name:"Primary not consent",issuePrefix:"HPP"}]);await db.insert(authUsers).values({id:userId,name:"Selected user",email:userId+"@example.test",createdAt:new Date(),updatedAt:new Date()});await accessService(db).ensureMembership(companyId,"user",userId,"owner","active");await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:true});
    const registration=await request(app).post("/mcp/runner/oauth/register").set("Host",host).send({client_name:"Actual signed principal",redirect_uris:[redirect],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"});expect(registration.status,JSON.stringify(registration.body)).toBe(201);
    const clientId=registration.body.client_id,verifier=randomBytes(48).toString("base64url");const start=await request(app).get("/mcp/runner/oauth/authorize").set("Host",host).query({client_id:clientId,redirect_uri:redirect,response_type:"code",resource,scope:"paperclip:agent offline_access",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});expect(start.status).toBe(303);
    const id=new URL(start.headers.location,origin).pathname.split("/").at(-1)!;const consent=await request(app).post(`/api/mcp/requests/${id}/consent`).set("Host",host).set("Origin",origin).set("x-selected-operator",userId).send({decision:"approve",companyId,allowWrites:false});expect(consent.status,JSON.stringify(consent.body)).toBe(200);
    const tokens=await request(app).post("/mcp/runner/oauth/token").set("Host",host).send({grant_type:"authorization_code",client_id:clientId,redirect_uri:redirect,resource,code:new URL(consent.body.redirectUrl).searchParams.get("code"),code_verifier:verifier});expect(tokens.status,JSON.stringify(tokens.body)).toBe(200);
    const [grant]=await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId,clientId));expect(grant).toMatchObject({companyId,userId,clientId,purpose:"agent",resource,agentId:null,revokedAt:null});
    const stack=await registry.getAssistantMcpStack(stackId);if(!stack)throw new Error("Missing normally provisioned stack");const route=await new CloudStackRouter({registry:{findStackByHost:async(value:string)=>value===stack.primaryHost?stack:undefined,findStackBySlug:async(value:string)=>value===stack.stackSlug?stack:undefined},baseDomain:"paperclip.app"}).resolveRoute({trustedHost:stack.primaryHost});expect(route.kind).toBe("tenant");if(!route.target?.activeAppOrigin)throw new Error("Missing normal verified tenant route");upstreamOrigin=route.target.activeAppOrigin;
    await vi.waitFor(async()=>{const receipt=await registry.mcpClientMirrorStore().readCurrent(stackId,origin);expect(receipt).toBeDefined();if(!receipt)throw new Error("No actual published namespace");expect(await registry.mcpClientMirrorStore().getClient({stackId,companyId:metadataCompany(stackId),origin,instanceId},clientId,receipt)).toBeDefined();},{timeout:10_000,interval:50});
    const currentTenant=async(selected:string,targetStack:string)=>{
      if(selected!==userId||targetStack!==stackId||!await registry.getGlobalUser(selected)||!await registry.hasActiveStackMembership(stackId,selected))return undefined;
      const freshStack=await registry.getAssistantMcpStack(stackId);if(!freshStack)return undefined;
      const freshRoute=await new CloudStackRouter({registry:{findStackByHost:async(value:string)=>value===freshStack.primaryHost?freshStack:undefined,findStackBySlug:async(value:string)=>value===freshStack.stackSlug?freshStack:undefined},baseDomain:"paperclip.app"}).resolveRoute({trustedHost:freshStack.primaryHost});
      if(freshRoute.kind!=="tenant"||freshRoute.target?.stackId!==stackId||!freshRoute.target.activeAppOrigin)return undefined;
      const receipt=await registry.mcpClientMirrorStore().readCurrent(stackId,origin);const actual=receipt?await connectorStore.getInstance(receipt.instanceId):undefined;
      if(actual?.status!=="active"||actual.kind!=="cloud_stack"||actual.companyStackId!==stackId||actual.activeOrigin!==origin||!actual.origins.includes(origin))return undefined;
      return projectTenant({stackId,companyId:metadataCompany(stackId),slug:freshRoute.target.stackSlug,publicOrigin:`https://${freshRoute.target.primaryHost}`,upstreamOrigin:freshRoute.target.activeAppOrigin},{stackId,origin,instanceId:actual.id});
    };
    const tenant=await currentTenant(userId,stackId);expect(tenant?.instanceId).toBe(instanceId);if(!tenant)throw new Error("No actual current tenant namespace");
    const project=makeClient({signControlAssertion:(input:{stackId:string;action:"mcp-dot:principal";requestId:string})=>signer.signControlAssertion(input),refreshTenant:currentTenant,fetchImplementation:mapped});
    const input={tenant,accessToken:tokens.body.access_token,upstreamClientId:clientId,selectingUserId:userId,canonicalVerifiedResource:resource,requestedCompanyId:companyId};
    const beforeAuth=authenticateCalls,beforeSession=sessionCalls;expect(await project(input)).toEqual({userId,companyId,grantId:grant.id,clientId,resource,purpose:"agent"});expect(authenticateCalls).toBe(beforeAuth+1);expect(sessionCalls).toBe(beforeSession);
    const refresh=await request(app).post("/mcp/runner/oauth/token").set("Host",host).send({grant_type:"refresh_token",client_id:clientId,resource,refresh_token:tokens.body.refresh_token});expect(refresh.status).toBe(200);expect((await project({...input,accessToken:refresh.body.access_token})).grantId).toBe(grant.id);
    await expect(project({...input,upstreamClientId:"foreign-client"})).rejects.toThrow();await expect(project({...input,selectingUserId:"foreign-user"})).rejects.toThrow();await expect(project({...input,requestedCompanyId:otherCompanyId})).rejects.toThrow();
    await connectorStore.setCloudStackOrigins({id:instanceId,companyStackId:stackId,origins:["https://replacement.paperclip.app"],activeOrigin:"https://replacement.paperclip.app",now:new Date()});await expect(project(input)).rejects.toThrow();await connectorStore.setCloudStackOrigins({id:instanceId,companyStackId:stackId,origins:[origin],activeOrigin:origin,now:new Date()});
    const revoked=await request(app).post("/mcp/runner/oauth/revoke").set("Host",host).send({client_id:clientId,resource,token:refresh.body.refresh_token,token_type_hint:"refresh_token"});expect(revoked.status).toBe(200);await expect(project({...input,accessToken:refresh.body.access_token})).rejects.toThrow();expect((await db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,grant.id)))[0].revokedAt).not.toBeNull();expect(unexpectedFetches).toBe(0);casePassed=true;
  },90_000);
});
