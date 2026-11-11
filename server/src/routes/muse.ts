import express, { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { MUSE_PUBLIC_ROUTES, MUSE_MAX_BODY_BYTES, MUSE_OAUTH_SCOPES, MUSE_RESOURCE_PATH, musePairSchema, museRefreshSchema, museCommandSchema, museQuerySchema, museCleanupSchema, museDetectorCleanupSchema, museStopBoundarySchema, museDetectorCleanupAttestationSchema } from "@paperclipai/shared";
import { museExternalAgents } from "../modules/external-agents/index.js";
import { museIdentity } from "../services/muse-identity.js";
import { museOAuth } from "../services/muse-oauth.js";
import { McpOAuthError } from "../services/public-mcp/oauth.js";
import { museReceiver } from "../services/muse-receiver.js";
import { museReceiverAssets, musePublicOrigin } from "../services/muse-setup.js";
import { museInvitationService } from "../services/muse-invitations.js";
import { agentService } from "../services/agents.js";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";
import { authorizationService } from "../services/authorization.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { HttpError, badRequest, forbidden, notFound, unauthorized, payloadTooLarge } from "../errors.js";
function bearer(req:Request) {const header=req.get("authorization")??"";if(!/^Bearer [A-Za-z0-9_-]{20,200}$/.test(header))throw unauthorized("A Muse bearer credential is required.");return header.slice(7);}
/** Exact manifest is registered here and consumed by Cloud. No adjacent namespace has machine authority. */
export function museTransportRoutes(db:Db,publicOrigin?:string,options:{allowLegacyCredentials?:boolean}={}) {
  const router=Router(),identity=museIdentity(db),broker=museExternalAgents(db,{publicOrigin}),receiver=museReceiver(db);
  router.use((req,res,next)=>{
    if(!req.originalUrl.startsWith("/api/muse"))return next();
    const rawPath=req.originalUrl.split("?")[0];
    if(!MUSE_PUBLIC_ROUTES.some(route=>route.method===req.method&&route.path===rawPath)||(req.originalUrl.includes("?")&&rawPath!=="/api/muse/v1/oauth/authorize"))return res.status(404).json({error:"Muse protocol route not found"});
    res.set("Cache-Control","no-store").set("Referrer-Policy","no-referrer");return next();
  });
  router.use("/api/muse/v1",express.json({limit:MUSE_MAX_BODY_BYTES,strict:true}));
  router.use("/api/muse/v1/oauth",express.urlencoded({extended:false,limit:"16kb"}));
  async function authenticateWorker(req:Request,kind:"access"|"cleanup"|"detector_cleanup"="access",stopControl=false) {
    const value=bearer(req);
    try {
      return await (options.allowLegacyCredentials&&!value.startsWith("pcmcp_at_") ? identity.authenticate(value,kind,{stopControl}) : identity.authenticateOAuthAccess(value,publicOrigin,{stopControl}));
    }catch(error){
      // Worker transport uses REST errors. OAuth protocol errors retain their
      // retryable status without leaking token or provider exception details.
      if(error instanceof McpOAuthError)throw new HttpError(error.status,error.status===401?"Connect Muse again.":"Muse authentication is temporarily unavailable.");
      throw error;
    }
  }
  function bound(req:Request) {if(Buffer.byteLength(JSON.stringify(req.body??{}))>MUSE_MAX_BODY_BYTES)throw payloadTooLarge("Muse body exceeds protocol limit.");}
  for(const route of MUSE_PUBLIC_ROUTES) {
    const handler=async(req:Request,res:express.Response)=>{
      bound(req);
      const asset = /^\/api\/muse\/v1\/assets\/([123456789])\/(manifest\.json|client\.py|detector\.sh|instructions\.md)$/.exec(route.path);
      if (asset) {
        const assets = await museReceiverAssets(asset[1] === "1" ? 1 : asset[1] === "2" ? 2 : asset[1] === "3" ? 3 : asset[1] === "4" ? 4 : asset[1] === "5" ? 5 : asset[1] === "6" ? 6 : asset[1] === "7" ? 7 : asset[1] === "8" ? 8 : 9);
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        if (asset[2] === "manifest.json") res.json(assets.manifest);
        else res.type("text/plain").send(asset[2] === "client.py" ? assets.client : asset[2] === "detector.sh" ? assets.detector : assets.instructions);
        return;
      }
      if(route.path.startsWith("/api/muse/v1/oauth/")) {
        if(Buffer.byteLength(JSON.stringify(req.body??{}))>16_384)throw payloadTooLarge("OAuth body exceeds protocol limit.");
        const oauth=museOAuth(db,publicOrigin),source=req.ip??req.socket.remoteAddress??"unknown";
        try {
          if(route.path.endsWith("/register")){res.status(201).json(await oauth.register(req.body,source));return;}
          if(route.path.endsWith("/authorize")){res.redirect(303,await oauth.authorize(req.query,source));return;}
          if(route.path.endsWith("/token")){res.json(await oauth.token(req.body??{}));return;}
          if(route.path.endsWith("/revoke")){
            const value=z.object({token:z.string().min(1).max(200),client_id:z.string().min(1).max(2048),resource:z.literal(oauth.config.resource).optional()}).strip().safeParse(req.body);
            if(!value.success)throw new McpOAuthError("invalid_request","A token, client_id and matching resource are required.");
            await oauth.revokeToken(value.data.token,value.data.client_id);res.status(200).end();return;
          }
          await oauth.assertEnabled();
          res.json({issuer:oauth.issuer,authorization_endpoint:oauth.issuer+"/authorize",token_endpoint:oauth.issuer+"/token",registration_endpoint:oauth.issuer+"/register",revocation_endpoint:oauth.issuer+"/revoke",
            resource:oauth.config.resource,scopes_supported:MUSE_OAUTH_SCOPES,grant_types_supported:["authorization_code","refresh_token"],response_types_supported:["code"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],authorization_response_iss_parameter_supported:true});return;
        }catch(error){if(error instanceof McpOAuthError){res.status(error.status).json({error:error.code,error_description:error.message});return;}throw error;}
      }
      if(route.path.endsWith("/pair")) {if(!options.allowLegacyCredentials)throw notFound("Legacy test pairing is unavailable.");const value=musePairSchema.parse(req.body);res.json(await identity.pair(value.ticket,value.clientVersion));return;}
      if(route.path.endsWith("/refresh")) {if(!options.allowLegacyCredentials)throw notFound("Legacy test refresh is unavailable.");const value=museRefreshSchema.parse(req.body);res.json(await identity.refresh(value.refreshToken));return;}
      if(route.path.endsWith("/signal")) {const bindingId=z.uuid().parse(req.get("X-Paperclip-Muse-Binding"));res.json(await receiver.signal(bindingId,musePublicOrigin(publicOrigin)+MUSE_RESOURCE_PATH));return;}
      if(route.path.endsWith("/cleanup")) {const value=museCleanupSchema.parse(req.body);const subject=await authenticateWorker(req,"cleanup",true);res.json(await broker.cleanup(subject,value));return;}
      if(route.path.endsWith("/detector-cleanup")) {const value=museDetectorCleanupSchema.parse(req.body),subject=await authenticateWorker(req,"detector_cleanup");if(value.bindingId!==subject.bindingId||value.generation!==subject.generation)throw forbidden("Detector cleanup identity mismatch.");res.json(await broker.detectorCleanup(subject,"detectorRemoved" in value));return;}
      const query=route.path.endsWith("/queries")?museQuerySchema.safeParse(req.body):null;
      // Only a validated, content-free mailbox read may use disabled stop auth.
      const subject=await authenticateWorker(req,"access",!!query?.success&&query.data.query==="mailbox");
      if(route.path.endsWith("/commands"))res.json(await broker.act(subject,museCommandSchema.parse(req.body)));
      else res.json(await broker.inspect(subject,museQuerySchema.parse(req.body)));
    };
    if(route.method==="GET")router.get(route.path,handler);else router.post(route.path,handler);
  }
  return router;
}
export function museBoardRoutes(db:Db,publicOrigin?:string) {
  const router=Router(),broker=museExternalAgents(db,{publicOrigin}),invitations=museInvitationService(db);
  async function scope(req:Request,write=false) {
    const companyId=z.uuid().parse(req.params.companyId);assertBoard(req);assertCompanyAccess(req,companyId);
    const operatorId=req.actor.userId;
    if(!operatorId||!["session","cloud_tenant","board_key"].includes(req.actor.source??"")||req.actor.memberships?.find(m=>m.companyId===companyId)?.membershipRole==="viewer")throw forbidden("Sign in as a company operator to configure Muse.");
    const agentId=req.params.agentId?z.uuid().parse(req.params.agentId):undefined;
    if(write) {const decision=await authorizationService(db).decide({actor:req.actor,action:agentId?"agent_config:update":"agents:create",resource:agentId?{type:"agent",companyId,agentId}:{type:"company",companyId},scope:{requiresChangeGrant:true}});if(!decision.allowed)throw forbidden(decision.explanation);}
    if(agentId){const agent=await agentService(db).getById(agentId);if(!agent||agent.companyId!==companyId)throw notFound("Agent not found.");}
    return {companyId,agentId,operatorId};
  }
  const invite="/companies/:companyId/muse-invitations",path="/companies/:companyId/agents/:agentId/muse-binding";
  const identitySchema=z.object({bindingId:z.uuid(),generation:z.number().int().positive(),expectedRevision:z.number().int().positive()}).strict();
  router.get(invite,async(req,res)=>{const s=await scope(req,true);res.set("Cache-Control","no-store").json(await invitations.resume(s.companyId,s.operatorId));});
  router.post(invite,async(req,res)=>{const s=await scope(req,true),input=z.object({name:z.string().trim().min(1).max(100),role:z.string().trim().min(1).max(100)}).strict().parse(req.body);res.set("Cache-Control","no-store").json(await invitations.create(s.companyId,s.operatorId,input));});
  router.get(path,async(req,res)=>{const s=await scope(req),agent=(await agentService(db).getById(s.agentId!))!;let origin:string|null=null;try{origin=musePublicOrigin(publicOrigin);}catch{/* setup diagnostic remains visible */}res.set("Cache-Control","no-store").json({enabled:await broker.enabled(),publicOrigin:origin,agentStatus:agent.status,agentLifecycleState:agent.lifecycleState,canConfigureConnection:canConfigureAgentConnection(agent),binding:await broker.bindingForAgent(s.companyId,s.agentId!),usage:null,cost:null});});
  router.post(path,async(req,res)=>{const s=await scope(req,true),input=z.object({replaceBindingId:z.uuid().optional(),expectedRevision:z.number().int().positive().optional()}).strict().parse(req.body??{});res.set("Cache-Control","no-store").status(201).json(await broker.createPairing({...s,agentId:s.agentId!,...input}));});
  router.post(path+"/verify",async(req,res)=>{const s=await scope(req,true);res.json(await broker.verify(s.companyId,s.agentId!,identitySchema.parse(req.body),s.operatorId));});
  router.post(path+"/revoke",async(req,res)=>{const s=await scope(req,true);await broker.revoke(s.companyId,s.agentId!,s.operatorId,identitySchema.parse(req.body));res.status(204).end();});
  router.post(path+"/attest-detector-cleanup",async(req,res)=>{const s=await scope(req,true);res.set("Cache-Control","no-store").json(await broker.attestDetectorCleanup(s.companyId,s.agentId!,s.operatorId,museDetectorCleanupAttestationSchema.parse(req.body),req.actor));});
  router.post(path+"/attest-stop",async(req,res)=>{const s=await scope(req,true),input=z.object({boundary:museStopBoundarySchema,expectedRevision:z.number().int().positive(),workerStopped:z.literal(true)}).strict().parse(req.body);res.json(await broker.attestStop(s.companyId,s.agentId!,s.operatorId,input));});
  return router;
}
