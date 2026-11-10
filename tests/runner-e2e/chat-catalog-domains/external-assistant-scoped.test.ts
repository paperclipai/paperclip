import { describe,expect,it } from "vitest";
import { scopedAssistantExternalCases } from "./external-assistant-scoped.js";
function valid(){const task={id:"task",companyId:"acorn",title:"Website",assigneeAgentId:"morgan",identifier:"ACORN-1"},query="Create a website task for Morgan in Acorn.";return {scenarioId:"assistant-connections.use-scoped-client",origin:"http://fixture.invalid",companyId:"acorn",leadId:"ceo",reply:"Created the queued website task.",phaseReplies:[],connections:[],profiles:[],secrets:[],endpoints:[],interactions:[],activity:[{entityId:"task",actorType:"user",actorId:"human",action:"issue.created"},{entityId:"grant",actorType:"user",actorId:"human",action:"mcp.tool_called"}],links:[],runs:[],humanQueries:[],state:{companionSurfaceResult:{query,reply:"Created http://fixture.invalid/ACORN/issues/ACORN-1; Morgan is paused so work is queued.",model:"gpt-5.4-mini",providerResponseIds:["resp_model"],usage:{inputTokens:200,outputTokens:100},messages:[{role:"user",content:query},{role:"assistant",content:"Created."}],toolCalls:[{name:"paperclip_create_task",arguments:{requestId:"11111111-1111-4111-8111-111111111111",companyId:"acorn",assigneeAgentId:"morgan"},result:{structuredContent:{task},content:[]}}],links:["http://fixture.invalid/ACORN/issues/ACORN-1"]},createCapabilityListed:true,commentDenied:true,updateDenied:true,controlUnchanged:true,directRestStatus:401,crossCompanyDenied:true,otherCompanyTaskCount:0,morganPaused:true,createdTasks:[task],morganId:"morgan",companyPrefix:"ACORN",connectedUserId:"human",grantId:"grant",privateScanComplete:true,privateLeaked:false}};}
describe("actual external-assistant scoped mutation oracle",()=>{
 const definition=scopedAssistantExternalCases[0]!;
 it("accepts a real model-selected scoped create with independently observed task and human attribution",()=>expect(definition.grade(valid()).passed).toBe(true));
 it("rejects broad write authority, scripted task prepopulation, wrong identities, missing usage and false runtime claims",()=>{for(const mutate of [
  (o:ReturnType<typeof valid>)=>{o.state.commentDenied=false;},
  (o:ReturnType<typeof valid>)=>{o.state.updateDenied=false;},
  (o:ReturnType<typeof valid>)=>{o.state.controlUnchanged=false;},
  (o:ReturnType<typeof valid>)=>{o.state.companionSurfaceResult.toolCalls=[];},
  (o:ReturnType<typeof valid>)=>{o.state.companionSurfaceResult.query="Please create the fixture task using these supplied IDs.";},
  (o:ReturnType<typeof valid>)=>{o.state.companionSurfaceResult.usage.outputTokens=0;},
  (o:ReturnType<typeof valid>)=>{o.state.companionSurfaceResult.providerResponseIds=[];},
  (o:ReturnType<typeof valid>)=>{o.state.createdTasks[0]!.assigneeAgentId="ceo";},
  (o:ReturnType<typeof valid>)=>{o.activity[0]!.actorType="agent";},
  (o:ReturnType<typeof valid>)=>{o.state.directRestStatus=200;},
  (o:ReturnType<typeof valid>)=>{o.state.companionSurfaceResult.reply="Morgan is already building the website.";},
  (o:ReturnType<typeof valid>)=>{o.state.privateLeaked=true;},
 ]){const o=valid();mutate(o);expect(definition.grade(o).passed).toBe(false);}});
 it("preserves the distinct companion declaration and rejects absent observations",()=>{expect(definition.journeyKind).toBe("scoped-external-assistant");expect(definition.expectedRunCount).toBe(0);expect(definition.expectedHumanMessageCount).toBe(0);expect(definition.grade({reply:"Created."}).passed).toBe(false);});
});
