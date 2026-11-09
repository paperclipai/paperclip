import {generateKeyPairSync} from "node:crypto";
import {createServer,request as nodeRequest} from "node:http";
import path from "node:path";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {afterEach,describe,expect,it,vi} from "vitest";
import type {Db} from "@paperclipai/db";
import {createPublicMcpOAuth,McpOAuthError,type McpPrincipal} from "./oauth.js";
import {authorizeDotCloudEvent} from "./dot-cloud-event-authority.js";
import {eventFetch,type EventFetch} from "./event-webhooks.js";

const origin="https://tenant.event-transport.example.test",resource=origin+"/mcp/runner";
const companyId="11111111-1111-4111-8111-111111111111",grantId="22222222-2222-4222-8222-222222222222";
vi.mock("../cloud-runtime-identity.js",async importOriginal=>({...await importOriginal<typeof import("../cloud-runtime-identity.js")>(),
  getCloudRuntimeIdentity:()=>({stackId:"stack",claimId:"controlled-current-claim",canonicalOrigin:"https://tenant.event-transport.example.test"})}));

// This is a controlled enrolled-HTTP/transport test. No OAuth grant is created:
// the App's final local-grant port ALWAYS denies, after the real Cloud owner.
describe("Dot enrolled authority uses the supplied owned transport",()=>{
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
  it("reaches the actual enrolled router and then rechecks local grant without granting authority",async()=>{
    const root=process.env.PAPERCLIP_DOT_PRINCIPAL_CLOUD_CHECKOUT;
    if(!root||!path.isAbsolute(root))throw new Error("Explicit source-qualified own Cloud checkout is required");
    const home=await mkdtemp(path.join(tmpdir(),"dot-event-authority-"));vi.stubEnv("PAPERCLIP_HOME",home);vi.stubEnv("PAPERCLIP_CONFIG",path.join(home,"config.json"));
    try{
    const load=(name:string)=>import(pathToFileURL(path.join(root,"dist",name)).href);
    const [brokers,stores,providers,clients,crypto,authorities,bindings]=await Promise.all([
      load("connections/broker.js"),load("connections/store.js"),load("connections/providers.js"),load("assistant-mcp/store.js"),
      load("assistant-mcp/crypto.js"),load("assistant-mcp/dot-subscription-authority.js"),load("assistant-mcp/dot-subscription-binding.js"),
    ]);
    const signing=generateKeyPairSync("ed25519"),sealing=generateKeyPairSync("x25519");
    const signPublic=signing.publicKey.export({format:"jwk"}).x,signPrivate=signing.privateKey.export({format:"jwk"}).d;
    const sealPublic=sealing.publicKey.export({format:"jwk"}).x,sealPrivate=sealing.privateKey.export({format:"jwk"}).d;
    if(!signPublic||!signPrivate||!sealPublic||!sealPrivate)throw new Error("Owned test keys are unavailable");
    const store=new stores.InMemoryConnectorStore(),clientStore=new clients.InMemoryAssistantMcpStore();
    store.instances.set("instance",{id:"instance",kind:"cloud_stack",companyStackId:"stack",environment:"test",signPublicKey:signPublic,sealPublicKey:sealPublic,
      origins:[origin],activeOrigin:origin,label:"Controlled transport",status:"active",createdAt:new Date(),updatedAt:new Date()});
    await clientStore.putClient({id:"downstream",name:"Controlled proof input",redirectUris:[],validation:"registered",issuerOrigin:origin,boundStackId:"stack",boundCompanyId:companyId});
    let member=true,reverseReads=0,localChecks=0,httpRequests=0,connections=0;
    const key=Buffer.alloc(32,71),expiresAt=Date.now()+60_000;
    const read=authorities.createDotSubscriptionAuthority({namespace:{stackId:"stack",instanceId:"instance",companyId,origin},encryptionKey:key,store:clientStore,
      resolveTenant:async(user:string,stack:string)=>member&&user==="selected-user"&&stack==="stack"?{stackId:"stack",instanceId:"instance",slug:"workspace",companyId,publicOrigin:origin,upstreamOrigin:"https://internal.example.test"}:undefined});
    const bindingReader=bindings.createDotSubscriptionBindingReader({read});
    let broker:{handle:(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse,url:URL)=>Promise<boolean>}|undefined;
    let virtualCloud="";
    const server=createServer((req,res)=>{httpRequests++;void(async()=>{
      if(!broker||!await broker.handle(req,res,new URL(req.url??"/",virtualCloud))){res.writeHead(404);res.end("closed");}
    })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end("closed");});});
    server.on("connection",()=>{connections++;});
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
    try{
      const address=server.address();if(!address||typeof address==="string")throw new Error("Owned listener is unavailable");
      virtualCloud="https://127.0.0.1:"+address.port;
      broker=new brokers.ConnectorBroker({publicOrigin:virtualCloud,environment:"test",store,providers:providers.providerRegistryFromEnvironment({}),
        secrets:{resolve:async()=>{throw new Error("No provider secret is used");}},authenticate:async()=>{throw new Error("No browser authority is used");},
        resolveCloudStackOrigin:async()=>origin,dotSubscriptionAuthority:async(input:unknown)=>{reverseReads++;return bindingReader(input);}});
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL",virtualCloud);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID","instance");
      vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT","test");vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",signPrivate);vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",sealPrivate);
      const proof=new crypto.AssistantEnvelope(key,resource).seal("access",{profile:"dot-mcp",authorityVersion:1,instanceId:"instance",clientId:"downstream",tenantClientId:"upstream",
        userId:"selected-user",stackId:"stack",tenantOrigin:origin,companyId,grantId,scope:"paperclip:agent offline_access",token:"unusable-controlled-proof-input",expiresAt});
      const principal:McpPrincipal={grant:{id:grantId,companyId,userId:"selected-user",clientId:"upstream",resource,purpose:"agent",agentId:null,scopes:["paperclip:agent","offline_access"],
        revokedAt:null,revocationRevision:0,revocationIndexReceipt:null,createdAt:new Date()},actor:{type:"none",source:"mcp_oauth",companyId},company:{id:companyId,name:"No local grant",issuePrefix:"NONE",status:"active"}};
      let databaseCalls=0;
      const noDatabase={select:()=>{databaseCalls++;throw new Error("No database access is permitted in this PG0 control");},transaction:()=>{databaseCalls++;throw new Error("No transaction is permitted in this PG0 control");}} as unknown as Db;
      const oauth=createPublicMcpOAuth(noDatabase,{origin,resource});
      vi.spyOn(oauth,"authorizeGrant").mockImplementation(async()=>{localChecks++;throw new McpOAuthError("access_denied","No local grant is created by this transport test",403);});
      const mappedPort:EventFetch=(url,init)=>{
        const target=new URL(url);if(target.origin!==virtualCloud||target.pathname!=="/v1/connector/mcp-dot-subscription-authority"||target.search||target.hash||target.username||target.password||init.method!=="POST"||init.redirect!=="error"||typeof init.body!=="string")return Promise.reject(new Error("Unknown owned authority route"));
        const body=init.body;
        return new Promise<Response>((resolve,reject)=>{
          const req=nodeRequest("http://127.0.0.1:"+address.port+target.pathname,{method:"POST",headers:{...Object.fromEntries(new Headers(init.headers)),host:target.host},signal:init.signal??undefined,agent:false},res=>{
            const status=res.statusCode;if(status===undefined){res.resume();reject(new Error("Owned authority reply has no HTTP status"));return;}
            const parts:Buffer[]=[];let length=0;res.on("data",(part:Buffer)=>{length+=part.length;if(length>16_384){res.destroy(new Error("Owned authority reply exceeded normal16KiB bound"));return;}parts.push(part);});
            res.on("error",reject);res.on("end",()=>resolve(new Response(Buffer.concat(parts),{status,headers:{"content-type":"application/json"}})));
          });req.on("error",reject);req.end(body);
        });
      };
      // Normal SSRF rejects the private virtual URL without any socket or DNS
      // permission change. The explicit test transport is a separate boundary.
      await expect(eventFetch(virtualCloud+"/v1/connector/mcp-dot-subscription-authority",{method:"POST",redirect:"error"})).rejects.toMatchObject({reason:"invalid_destination"});
      expect(connections).toBe(0);expect(httpRequests).toBe(0);expect(reverseReads).toBe(0);
      const chosenPort:EventFetch=mappedPort;let portEntered=0;
      const reversePort:EventFetch=(url,init)=>{portEntered++;return chosenPort(url,init);};
      await expect(authorizeDotCloudEvent(oauth,principal,{token:proof,expiresAt,transport:"tenant-dot-v1"},reversePort,Date.now)).rejects.toMatchObject({code:-32602,message:"Hosted Dot subscription authority is unavailable."});
      // Baseline default port never reaches the actual enrolled HTTP owner.
      // The treatment maps only this owned virtual endpoint, then still DENIES
      // at the mandatory local recheck. No grant or usable outcome is forged.
      expect({portEntered}).toEqual({portEntered:1});expect({connections,httpRequests}).toEqual({connections:reverseReads,httpRequests:reverseReads});
      expect(reverseReads,"OWNED_REVERSE_AUTHORITY_NOT_REACHED").toBe(1);expect({httpRequests,connections,localChecks}).toEqual({httpRequests:1,connections:1,localChecks:1});
      member=false;
      await expect(authorizeDotCloudEvent(oauth,principal,{token:proof,expiresAt,transport:"tenant-dot-v1"},mappedPort,Date.now)).rejects.toMatchObject({code:-32602});
      expect({reverseReads,localChecks}).toEqual({reverseReads:2,localChecks:1});
      await expect(mappedPort("https://unknown.event-transport.example.test/",{method:"POST",redirect:"error"})).rejects.toThrow("Unknown owned authority route");
      expect(httpRequests).toBe(2);expect(connections).toBe(2);expect(databaseCalls).toBe(0);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    }finally{await rm(home,{recursive:true,force:true});}
  });
});
