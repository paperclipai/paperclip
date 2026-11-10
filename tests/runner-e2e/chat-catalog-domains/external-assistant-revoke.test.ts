import {expect,it} from "vitest";
import {gradePersonalRevoke} from "./external-assistant-revoke.js";
import {beginConnection} from "../public-mcp-client.js";
const REPLY="Only you can revoke it: open [Assistant connections](/COM/apps/assistant-connection) and revoke Old test assistant. The website task keeps running.";
function valid(){const grant=(id:string,clientName:string)=>({id,clientName,companyId:"company",scopes:["paperclip:read"],revokedAt:null as string|null});const old=grant("old","Old test assistant"),other=grant("other","Current test assistant"),task={id:"website",assigneeAgentId:"morgan",status:"in_progress"};return {scenarioId:"assistant-connections.revoke-personal-grant",companyId:"company",leadId:"ceo",reply:REPLY,phaseReplies:[{runId:"ceo-run",body:REPLY}],connections:[],profiles:[],secrets:[],endpoints:[],interactions:[],links:["/COM/apps/assistant-connection"],humanQueries:[],activity:[{entityId:"website",action:"issue.updated",agentId:"morgan",details:{status:"done"}},{entityId:"website",action:"issue.created",actorType:"user",actorId:"person"},{entityId:"old",action:"mcp.tool_called",actorType:"user",actorId:"person",details:{operation:"paperclip_create_task",requestId:"delegation-request"}},{entityId:"old",action:"mcp.connection_revoked",actorType:"user",actorId:"person"}],runs:[{id:"worker-run",contextSnapshot:{issueId:"website"},agentId:"morgan",status:"succeeded"}],state:{delegationRequestId:"delegation-request",before:[old,other],after:[{...old,revokedAt:"2026-10-26T00:00:00Z"},other],oldGrantId:"old",otherGrantId:"other",sameHuman:true,personId:"person",oldCreatedTaskId:"website",task,workerWasReallyWaiting:true,modelDirectedPersonalUI:true,personalUiLink:"/COM/apps/assistant-connection",oldGrantActiveBeforeHuman:true,exactOldButtonClicked:true,agentManagementStatus:401,oldCallAfterStatus:401,oldRefreshRejected:true,otherUsableAfter:true,taskAfter:{...task,status:"done"},workerActiveAtRevocation:true,humanAtRevocationId:"person",sameWorkerStillRunningAfterRevocation:true,activeAfterWindowMs:5000,neutralGateReleased:true,workerRunId:"worker-run",secretScanComplete:true,secretLeaked:false}};}
it("accepts actual selected-client revocation with the same delegated worker's ordinary lifecycle",()=>expect(gradePersonalRevoke(valid()).passed).toBe(true));
it("rejects wrong-client human rescue, false completion, stale tokens, interrupted work and unscanned outputs",()=>{
 for(const mutate of [
  (o:ReturnType<typeof valid>)=>{o.state.oldCallAfterStatus=200;},
  (o:ReturnType<typeof valid>)=>{o.state.oldGrantActiveBeforeHuman=false;},
  (o:ReturnType<typeof valid>)=>{o.phaseReplies=[];},
  (o:ReturnType<typeof valid>)=>{o.links=[];},
  (o:ReturnType<typeof valid>)=>{delete (o.state as Record<string,unknown>).personalUiLink;},
  (o:ReturnType<typeof valid>)=>{o.activity.push({entityId:"website",action:"issue.updated",agentId:"ceo",details:{status:"cancelled"}});},
  (o:ReturnType<typeof valid>)=>{o.state.exactOldButtonClicked=false;},
  (o:ReturnType<typeof valid>)=>{o.state.otherUsableAfter=false;},
  (o:ReturnType<typeof valid>)=>{o.state.delegationRequestId="another-request";},
  (o:ReturnType<typeof valid>)=>{o.state.after[1]={...o.state.after[1]!,scopes:["paperclip:read","paperclip:write"]};},
  (o:ReturnType<typeof valid>)=>{o.state.humanAtRevocationId="other-person";},
  (o:ReturnType<typeof valid>)=>{o.state.workerActiveAtRevocation=false;},
  (o:ReturnType<typeof valid>)=>{o.state.taskAfter.status="cancelled";},
  (o:ReturnType<typeof valid>)=>{o.runs[0]!.id="replacement-run";},
  (o:ReturnType<typeof valid>)=>{o.state.sameWorkerStillRunningAfterRevocation=false;},
  (o:ReturnType<typeof valid>)=>{o.state.secretScanComplete=false;},
  (o:ReturnType<typeof valid>)=>{o.activity[0]!.agentId="ceo";},
 ]){const o=valid();mutate(o);expect(gradePersonalRevoke(o).passed).toBe(false);}
});
it("accepts any wording once the saved outcome is right, since reply text is not graded",()=>{
 for(const reply of ["Only you can do this from Assistant connections. Revoke Old test assistant there; the website task keeps running.","I can't disconnect assistants for you. Use the page linked here; Morgan's website work stays assigned."]){const o=valid();o.reply=reply;o.phaseReplies=[{runId:"ceo-run",body:reply}];expect(gradePersonalRevoke(o).passed).toBe(true);}
 expect(gradePersonalRevoke(undefined).passed).toBe(false);
});
it("accepts the native status committer's done transition from the same worker run",()=>{
 const o=valid();o.activity[0]={entityId:"website",action:"issue.updated",actorType:"system",agentId:null,runId:"worker-run",details:{source:"native_status_decision",toStatus:"done"}} as never;expect(gradePersonalRevoke(o).passed).toBe(true);
 const p=valid();p.activity[0]={entityId:"website",action:"issue.updated",actorType:"system",agentId:null,runId:"replacement-run",details:{source:"native_status_decision",toStatus:"done"}} as never;expect(gradePersonalRevoke(p).passed).toBe(false);
});
it("rejects unsafe optional client labels before any OAuth/provider operation",async()=>{
 await expect(beginConnection(true,undefined,false,"Old test assistant\nInjected")).rejects.toThrow("label");
 await expect(beginConnection(true,undefined,false,"")).rejects.toThrow("label");
 await expect(beginConnection(true,undefined,false,"Old\u0000assistant")).rejects.toThrow("label");
});
