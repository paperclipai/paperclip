import {createHash} from "node:crypto";
import {describe,it,expect} from "vitest";
import {gradeSlackThread} from "./external-slack-thread.js";
function valid(){
 const body="<!doctype html><html><body><h1>Acorn Notes</h1><p>A calm notebook.</p></body></html>",sha256=createHash("sha256").update(body).digest("hex");
 const receipt={query:"Ask Morgan to build the launch page and let me know here when it is ready.",endpointId:"endpoint",conversationId:"source-conversation",issueId:"source",humanCommentId:"human-comment",linkedPaperclipUserId:"person",providerCalls:1,provider:{workspaceId:"T123",channelId:"C123",threadId:"1234567890.000001",canonicalMessageId:"1234567890.000002",senderUserId:"U123"}};
 const other={...receipt,query:"Other status query",conversationId:"other-conversation",issueId:"other",runId:"other-run",provider:{...receipt.provider,threadId:"1234567889.000001"}};
 const run=(id:string,agentId:string,issueId:string)=>({id,companyId:"company",agentId,runtimeMode:"native",status:"succeeded",contextSnapshot:{issueId}});
 const message={id:"1234567889.000002",user:"UBOT",text:"No projects are blocked.",files:[] as string[]};
 return {scenarioId:"chat-channels.reply-in-thread",companyId:"company",leadId:"ceo",origin:"http://127.0.0.1:3399",reply:"Morgan finished. ACORN-3 is ready.",state:{worker:{id:"morgan"},project:{id:"project"},originalQuery:receipt.query,botUserId:"UBOT"},phaseReplies:[{runId:"completion",body:"Morgan finished. ACORN-3 is ready."}],tasks:[{id:"build",companyId:"company",identifier:"ACORN-3",assigneeAgentId:"morgan",projectId:"project",status:"done"}],runs:[run("other-run","ceo","other"),run("source-run","ceo","source"),run("build-run","morgan","build"),run("completion","ceo","source")],connections:[],profiles:[],secrets:[],endpoints:[],interactions:[],activity:[{action:"issue.created",entityId:"build",actorType:"agent",agentId:"ceo"}],links:[],humanQueries:[receipt.query],thread:{source:receipt,other,before:[message],after:[structuredClone(message)],messages:[{id:"1234567890.000003",user:"UBOT",text:"Morgan finished. ACORN-3 is ready.",files:[] as string[]}],duplicate:{canonicalDeliveryCaptured:true,duplicateReplayed:true},activity:[{kind:"delivery",status:"processed",summary:"message processed · 1 duplicate ignored"},{kind:"publication",status:"published",summary:"Response to external conversation"}],attachments:[{id:"attachment",issueId:"build",originatingRunId:"build-run",sha256}],products:[{issueId:"build",createdByRunId:"build-run",type:"artifact",status:"active",metadata:{attachmentId:"attachment"}}],files:[{id:"attachment",hash:sha256,body,rendered:{sha256,usableSignup:true,nodes:[{tag:"H1",text:"Acorn Notes",role:null,href:null,inNavigation:false,color:"rgb(0, 0, 0)",background:"rgb(255, 255, 255)"},{tag:"P",text:"A calm notebook for the whole research team.",role:null,href:null,inNavigation:false,color:"rgb(0, 0, 0)",background:"rgb(255, 255, 255)"}]}}]}};
}
describe("real Slack native handoff, result and duplicate isolation",()=>{
 it("accepts independently attributed build bytes and one actual original-thread completion",()=>expect(gradeSlackThread(valid()).passed).toBe(true));
 it("rejects another task/thread/person, extra runs, stale or fabricated files and duplicate completions",()=>{
  for(const mutate of [
   (o:ReturnType<typeof valid>)=>{o.thread.other.provider.threadId=o.thread.source.provider.threadId;},
   (o:ReturnType<typeof valid>)=>{o.thread.other.linkedPaperclipUserId="another-person";},
   (o:ReturnType<typeof valid>)=>{o.thread.after.push({id:"leak",user:"UBOT",text:"ACORN-3 is ready",files:[]});},
   (o:ReturnType<typeof valid>)=>{o.thread.before=[];o.thread.after=[];},
   (o:ReturnType<typeof valid>)=>{o.tasks.push({...o.tasks[0]!,id:"duplicate-task"});},
   (o:ReturnType<typeof valid>)=>{o.runs.push({...o.runs[0]!,id:"unrelated-run",contextSnapshot:{issueId:"unrelated"}});},
   (o:ReturnType<typeof valid>)=>{o.thread.files[0]!.body="<html><h1>Previous Acorn Notes page</h1></html>";},
   (o:ReturnType<typeof valid>)=>{o.thread.attachments[0]!.originatingRunId="older-run";},
   (o:ReturnType<typeof valid>)=>{o.thread.messages.push({...o.thread.messages[0]!,id:"duplicate-response"});},
   (o:ReturnType<typeof valid>)=>{o.thread.duplicate.duplicateReplayed=false;},
   (o:ReturnType<typeof valid>)=>{o.thread.files[0]!.rendered.nodes=[];},
   (o:ReturnType<typeof valid>)=>{o.thread.files[0]!.rendered.usableSignup=false;},
   (o:ReturnType<typeof valid>)=>{o.thread.messages[0]!.text="I'll let you know here when ACORN-3 is ready.";},
  ]){const o=valid();mutate(o);expect(gradeSlackThread(o).passed).toBe(false);}
 });
 it("requires actual evidence rather than a truthful prose-only status",()=>{
  expect(gradeSlackThread(undefined).passed).toBe(false);
  const o=valid();expect(gradeSlackThread({...o,thread:{...o.thread,products:undefined}}).passed).toBe(false);
  expect(gradeSlackThread({...o,thread:{...o.thread,source:undefined}}).passed).toBe(false);
 });
});
