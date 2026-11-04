import { describe,expect,it,vi } from "vitest";
vi.mock("./identity-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./identity-support.js")>(), identityWorker: vi.fn(async () => ({id:"morgan"})), probeAgentPermission: vi.fn(async () => 403) }));
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { companySecretExternalCases,deploymentSecretGuidance,companySecretControllerBaseline,companySecretControllersUnchanged } from "./external-company-secret.js";
const controller={id:"controller",companyId:"company",scope:"company",ownerUserId:null,userSecretDefinitionId:null,key:"openrouter_api_key",name:"Runner E2E controller",provider:"local_encrypted",status:"active",managedMode:"paperclip_managed",latestVersion:1};
const controllerRefs={OPENROUTER_API_KEY:{type:"secret_ref",secretId:"controller",version:"latest"}} as const;
function valid(){return {scenarioId:"secrets.configure-company-secret",companyId:"company",leadId:"ceo",reply:"The deployment key reference is now bound for Morgan. This confirms configuration, not a runtime delivery test.",phaseReplies:[{runId:"first",body:"Use secure secret settings for the deployment key, then bind its reference in Morgan's environment variables. Do not paste the key here."},{runId:"second",body:"The deployment key reference is now bound for Morgan. This confirms configuration, not a runtime delivery test."}],runs:[{id:"first",status:"succeeded"},{id:"second",status:"succeeded"}],connections:[],profiles:[],secrets:[{id:"secret",name:"Deployment API key",status:"active"}],endpoints:[],interactions:[],activity:[{entityId:"secret",action:"secret.created",actorType:"user"}],links:[],humanQueries:[],state:{initialRunId:"first",agentCreateStatus:403,secretCountBeforeHuman:1,controllerSecretBaseline:[controller],controllerSecretsPreserved:true,operatorChannel:"private-browser-company-secret-and-public-browser-binding",secretUiVisible:true,humanSubmittedSecurely:true,storageClean:true,secureBrowserUntraced:true,secretId:"secret",morganId:"morgan",bindings:[{targetType:"agent",targetId:"morgan",configPath:"env.DEPLOYMENT_API_KEY",versionSelector:"latest"}],savedReferenceMatches:true,morganBindingVisible:true,bindingHumanAttributed:true,secretScanComplete:true,secretLeaked:false}};}
describe("secure company credential and Morgan-only binding",()=>{
 const definition=companySecretExternalCases[0]!;
 it("accepts actual human UI entry/reference binding and a separate metadata confirmation",()=>expect(definition.grade(valid()).passed).toBe(true));
 it("rejects prematurely completed or wrong-consumer guidance before human action",()=>{
  expect(deploymentSecretGuidance(valid().phaseReplies[0]!.body)).toBe(true);
  expect(deploymentSecretGuidance("Use secure secret settings for the deployment key and Morgan's environment binding. Do not bind it to all agents.")).toBe(true);
  for(const text of ["I've already added the deployment key and bound it for Morgan in secret settings.","I've created the deployment key for Morgan in secure settings, but not tested runtime binding.","Use secure secret settings and bind the deployment key to all agents, including Morgan.","Paste the deployment credential here, then use secure settings to bind Morgan's environment."])expect(deploymentSecretGuidance(text)).toBe(false);
 });
 it("rejects untraced-claim-only, wrong reference/consumer/version and incomplete/leaking outcomes",()=>{
  for(const mutate of [
   (o:ReturnType<typeof valid>)=>{o.state.agentCreateStatus=201;},
   (o:ReturnType<typeof valid>)=>{o.state.secretCountBeforeHuman=2;},
   (o:ReturnType<typeof valid>)=>{o.state.operatorChannel="opened-ui-then-hidden-api";},
   (o:ReturnType<typeof valid>)=>{o.state.bindings[0]!.targetId="ceo";},
   (o:ReturnType<typeof valid>)=>{o.state.bindings[0]!.versionSelector="1";},
   (o:ReturnType<typeof valid>)=>{o.state.savedReferenceMatches=false;},
   (o:ReturnType<typeof valid>)=>{o.state.secretScanComplete=false;},
   (o:ReturnType<typeof valid>)=>{o.state.secretLeaked=true;},
   (o:ReturnType<typeof valid>)=>{o.phaseReplies[1]!.runId="first";},
   (o:ReturnType<typeof valid>)=>{o.phaseReplies[1]!.body="Morgan's deployment key is not yet bound or available.";},
  ]){const o=valid();mutate(o);expect(definition.grade(o).passed).toBe(false);}
  expect(definition.grade(undefined).passed).toBe(false);
 });
});

it("admits only exact controller-bootstrap secrets while leaving deployment entry uncompleted",async()=>{
 const api={get:vi.fn(async(route:string)=>route.endsWith("/secret-providers")?[{id:"local_encrypted",configured:true}]:[controller])};
 const ctx={input:{api,privateSecrets:[],fixtures:{company:{id:"company"},secretRefs:controllerRefs}}} as unknown as ChatCatalogContext;
 const state=await companySecretExternalCases[0]!.setup(ctx);
 expect(state).toMatchObject({morganId:"morgan",agentCreateStatus:403,controllerSecretBaseline:[controller]});
 expect(state.secretId).toBeUndefined();
});

it("rejects extra, foreign, personal, duplicated or precompleted deployment secrets in the controller baseline",()=>{
 const baseline=[controller] as Parameters<typeof companySecretControllerBaseline>[0];
 expect(companySecretControllerBaseline(baseline,"company",controllerRefs)).toEqual([controller]);
 for(const rows of [[...baseline,{...controller,id:"extra"}], [{...controller,companyId:"foreign"}], [{...controller,scope:"user",ownerUserId:"person"}], [{...controller,key:"DEPLOYMENT_API_KEY",name:"Deployment API key"}], [{...controller,key:"OPENROUTER_API_KEY"}], [{...controller,id:"foreign"}], [...baseline,...baseline]]) expect(()=>companySecretControllerBaseline(rows as typeof baseline,"company",controllerRefs)).toThrow();

 const precompleted={...controller,key:"deployment_api_key",name:"Pre-existing deployment reference"};
 expect(()=>companySecretControllerBaseline([precompleted] as typeof baseline,"company",{DEPLOYMENT_API_KEY:controllerRefs.OPENROUTER_API_KEY} as unknown as Parameters<typeof companySecretControllerBaseline>[2])).toThrow();
 expect(()=>companySecretControllerBaseline(baseline,"company",{})).toThrow();
 expect(()=>companySecretControllerBaseline(baseline,"company",{OPENROUTER_API_KEY:{...controllerRefs.OPENROUTER_API_KEY,version:"1"}} as unknown as Parameters<typeof companySecretControllerBaseline>[2])).toThrow();
 expect(()=>companySecretControllerBaseline(baseline,"company",{...controllerRefs,OPENAI_API_KEY:controllerRefs.OPENROUTER_API_KEY})).toThrow();
});
it("requires the original controller metadata and version before and after secure human entry",()=>{
 const baseline=[controller] as Parameters<typeof companySecretControllerBaseline>[0];
 expect(companySecretControllersUnchanged(baseline,baseline)).toBe(true);
 for(const change of [{latestVersion:2},{companyId:"foreign"},{scope:"user"},{ownerUserId:"person"},{status:"revoked"},{provider:"other"},{name:"Changed"},{key:"OTHER"}]) expect(companySecretControllersUnchanged([{...controller,...change}] as typeof baseline,baseline)).toBe(false);
 expect(companySecretControllersUnchanged([],baseline)).toBe(false);
 expect(companySecretControllersUnchanged([...baseline,...baseline],baseline)).toBe(false);
 const o=valid();o.state.controllerSecretsPreserved=false;expect(companySecretExternalCases[0]!.grade(o).passed).toBe(false);
 const missing=valid();missing.state.controllerSecretBaseline=[];expect(companySecretExternalCases[0]!.grade(missing).passed).toBe(false);
});
it("preserves company handoff safety across warning and settings follow-on clauses", () => {
  const context = "Use secure settings for Morgan's deployment credential environment binding. ";
  expect(deploymentSecretGuidance(context + "Never share your credential but send the key here in chat.")).toBe(false);
  expect(deploymentSecretGuidance(context + "Enter your credential in the secure form, not in chat but you can review it in settings.")).toBe(true);
});
it("rejects a positive chat destination attached to secure company entry without an exclusion", () => {
  expect(deploymentSecretGuidance("Use secure settings for Morgan's deployment credential environment binding. Enter your credential in the secure form then in chat.")).toBe(false);
});

it("distinguishes subordinate chat requests from coordinated company warnings", () => {
  const context = "Use secure settings for Morgan's deployment credential environment binding. ";
  expect(deploymentSecretGuidance(context + "Please paste the credential you want to share here in chat.")).toBe(false);
  expect(deploymentSecretGuidance(context + "You must never paste or share your credential here.")).toBe(true);
});
