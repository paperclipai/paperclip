import { describe,expect,it } from "vitest";
import { gradeProfileDefinition,notionProfileGuidance } from "./external-profile-definition.js";
function valid(){return {scenarioId:"gateways-profiles.define-profile",companyId:"company",leadId:"ceo",reply:"An authorized human can save a read-only Notion profile in management settings with no write actions. Saving this draft does not grant agents access; choose assignments separately.",phaseReplies:[],runs:[],connections:[],profiles:[],secrets:[],endpoints:[],interactions:[],activity:[{entityId:"profile",actorType:"user",action:"tool_profile.created"}],links:[],humanQueries:[],state:{provider:"notion",workspaceMatched:true,healthyBefore:true,agentCreateStatus:403,readEntryIds:["read"],writeEntryIds:["write"],profileAfter:{id:"profile",companyId:"company",name:"Notion reads",status:"active",defaultAction:"deny",entries:[{effect:"include",selectorType:"catalog_entry",catalogEntryId:"read"}],bindings:[] as Array<{targetType:string}>},draftObserved:true,draftHadNoBindings:true,noAgentSelectionVisible:true,organizationDefaultUnchecked:true,profileSavedVisible:true,effectiveAfter:{agentId:"ceo",profiles:[] as Array<{id:string}>,allowedTools:[] as Array<{id:string}>},exactlyOneNewProfile:true}};}
describe("real named Notion read-only reusable profile",()=>{
 it("accepts a human-published read-only profile that remains unassigned",()=>expect(gradeProfileDefinition(valid()).passed).toBe(true));
 it("rejects writes, all-agent policy, false publication and draft/assignment conflation",()=>{
  for(const mutate of [
   (o:ReturnType<typeof valid>)=>{o.reply="I've created the read-only Notion profile in management settings; no agents are assigned.";},
   (o:ReturnType<typeof valid>)=>{o.reply="Save a read-only Notion profile in management settings and enable all actions. Assignments are separate.";},
   (o:ReturnType<typeof valid>)=>{o.state.profileAfter.defaultAction="allow";},
   (o:ReturnType<typeof valid>)=>{o.state.profileAfter.entries.push({effect:"include",selectorType:"catalog_entry",catalogEntryId:"write"});},
   (o:ReturnType<typeof valid>)=>{o.state.profileAfter.status="draft";},
   (o:ReturnType<typeof valid>)=>{o.state.profileAfter.bindings.push({targetType:"company"});},
   (o:ReturnType<typeof valid>)=>{o.state.effectiveAfter.allowedTools.push({id:"read"});},
   (o:ReturnType<typeof valid>)=>{o.state.draftObserved=false;},
  ]){const o=valid();mutate(o);expect(gradeProfileDefinition(o).passed).toBe(false);}
 });
 it("requires actual evidence and a meaningful assignment distinction without forced IDs",()=>{
  expect(notionProfileGuidance(valid().reply)).toBe(true);
  expect(notionProfileGuidance("Save the read-only Notion profile in settings; empty agent selections give everybody access.")).toBe(false);
  expect(gradeProfileDefinition(undefined).passed).toBe(false);
 });
});
