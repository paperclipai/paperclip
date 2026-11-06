import {expect,it,vi} from "vitest";
import type {ChatCatalogContext} from "../chat-catalog-contract.js";
const port=vi.hoisted(()=>({observation:{} as Record<string,unknown>}));
vi.mock("./identity-support.js",async original=>({...await original<typeof import("./identity-support.js")>(),identityWorker:async()=>({id:"morgan"}),probeAgentPermission:async()=>403}));
vi.mock("./external-support.js",async original=>({...await original<typeof import("./external-support.js")>(),observeExternal:async(_ctx:unknown,state:unknown)=>({...port.observation,state})}));
vi.mock("./external-secret-scan.js",async original=>({...await original<typeof import("./external-secret-scan.js")>(),scanReachableSecretOutputs:async()=>({complete:true,leaked:false})}));
import {companySecretExternalCases} from "./external-company-secret.js";
it("the actual direct-ACK observer fetches its canonical human without preseeded source comments",async()=>{
 const controller={id:"controller",companyId:"company",scope:"company",ownerUserId:null,userSecretDefinitionId:null,key:"openrouter_api_key",name:"Runner E2E controller",provider:"local_encrypted",status:"active",managedMode:"paperclip_managed",latestVersion:1},human={id:"human",companyId:"company",issueId:"source",authorUserId:"person",body:"Add our deployment API key so Morgan can use it."};
 const get=vi.fn(async(path:string)=>{if(path.endsWith("/secret-providers"))return[{id:"local_encrypted"}];if(path==="/api/auth/get-session")return{user:{id:"person"}};if(path==="/api/agents/morgan")return{adapterConfig:{env:{}}};if(path.endsWith("/secrets"))return[controller];if(path.endsWith("/usage"))return{bindings:[]};if(path==="/api/issues/source/comments?order=asc")return[human];throw new Error("Unexpected public metadata read");});
 const ctx={input:{privateSecrets:[],fixtures:{company:{id:"company",issuePrefix:"RUN"},secretRefs:{OPENROUTER_API_KEY:{type:"secret_ref",secretId:"controller",version:"latest"}}},api:{get}},issue:()=>({id:"source"})} as unknown as ChatCatalogContext;
 const definition=companySecretExternalCases[0]!,state=await definition.setup(ctx);Object.assign(state,{sourceIssueId:"source",initialConfirmationId:"ack",secretId:"new",nativeBindingRequired:true});
 expect(Object.hasOwn(state,"companySourceComments")).toBe(false);expect(state.followupCommentId).toBeUndefined();expect(state.companySecretApproval).toBeUndefined();
 port.observation={secrets:[controller],tasks:[],runs:[],activity:[]};await definition.observe(ctx,state);
 expect(state.companySourceComments).toEqual([human]);expect(get).toHaveBeenCalledWith("/api/issues/source/comments?order=asc");
});
