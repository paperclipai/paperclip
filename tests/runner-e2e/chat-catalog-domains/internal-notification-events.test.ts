import { expect, it } from "vitest";
import { bindNotificationPublicEvents, publicNotificationFrame, type NotificationObserverInput } from "./internal-notification-events.js";
const base=Date.parse("2026-10-28T00:00:00.000Z"),iso=(n:number)=>new Date(base+n).toISOString();
function example():[NotificationObserverInput,NotificationObserverInput]{
 const activity=[1,2].map(n=>({id:`audit-${n}`,companyId:"company",entityType:"issue",entityId:"task",action:"issue.comment_added",actorType:"agent",actorId:"ceo",createdAt:iso(n*3000+1),details:{commentId:`comment-${n}`}}));
 const comments=[1,2].map(n=>({id:`comment-${n}`,companyId:"company",issueId:"task",authorAgentId:"ceo",authorUserId:null,createdAt:iso(n*3000),deletedAt:null}));
 const person=(principalId:string):NotificationObserverInput=>({
  principalId,sessionPrincipalId:principalId,overflow:false,baselineActivityIds:[],baselineCommentIds:[],
  activity:structuredClone(activity),comments:structuredClone(comments),
  frames:[1,2].map(n=>({eventId:n+100,companyId:"company",taskId:"task",actorType:"agent" as const,actorId:"ceo",
    eventCreatedAt:iso(n*3000+2),eligible:principalId==="alex"||n===2,at:base+n*3000+3})),
 });
 return[person("alex"),person("riley")];
}
it("binds actual public shapes without details to exact saved comments and common per-person event identities",()=>{
 const observers=example(),result=bindNotificationPublicEvents("company","task",observers);expect(result.complete).toBe(true);expect(result.frames[0]!.map(f=>[f.eventId,f.commentId,f.activityId,f.eligible])).toEqual([[101,"comment-1","audit-1",true],[102,"comment-2","audit-2",true]]);expect(result.frames[1]!.map(f=>[f.eventId,f.commentId,f.eligible])).toEqual([[101,"comment-1",false],[102,"comment-2",true]]);
 const message={id:101,companyId:"company",type:"activity.logged",createdAt:iso(3002),toastEligible:false,payload:{action:"issue.comment_added",entityType:"issue",entityId:"task",actorType:"agent",actorId:"ceo"}};
 expect(publicNotificationFrame(message,"company","task",base+3003)).toEqual(observers[1].frames[0]);expect(publicNotificationFrame({...message,payload:{...message.payload,details:{commentId:"untrusted-private-field"}}},"company","task",base+3003)).toEqual(observers[1].frames[0]);
});
it.each([
 ["wrong principal",(o:ReturnType<typeof example>)=>{o[1].principalId="alex";}],
 ["wrong signed-in session",(o:ReturnType<typeof example>)=>{o[1].sessionPrincipalId="other";}],
 ["prior comment boundary",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.baselineCommentIds.push("older-unobserved-comment"));}],
 ["prior comment audit",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.baselineActivityIds.push("audit-1"));}],
 ["capture overflow",(o:ReturnType<typeof example>)=>{o[0].overflow=true;}],
 ["missing recipient event",(o:ReturnType<typeof example>)=>{o[1].frames.pop();}],
 ["different received event ID",(o:ReturnType<typeof example>)=>{o[1].frames[0]!.eventId=99;}],
 ["duplicate received event",(o:ReturnType<typeof example>)=>{o[0].frames.push(structuredClone(o[0].frames[0]!));}],
 ["wrong task event",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.frames[0]!.taskId="other");}],
 ["wrong company event",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.frames[0]!.companyId="other");}],
 ["wrong event actor",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.frames[0]!.actorId="other");}],
 ["missing audit comment",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.activity[0]!.details={});}],
 ["duplicate saved activity",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.activity.push(structuredClone(p.activity[0]!)));}],
 ["duplicate saved comment",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.comments.push(structuredClone(p.comments[0]!)));}],
 ["wrong saved comment author",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.comments[0]!.authorAgentId="other");}],
 ["wrong saved activity actor",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.activity[0]!.actorId="other");}],
 ["deleted saved comment",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.comments[0]!.deletedAt=iso(9999));}],
 ["references old baseline comment",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.baselineCommentIds.push("comment-1"));}],
 ["saved comment without activity",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.activity.pop());}],
 ["saved activity without event",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.frames.pop());}],
 ["ambiguous audit order",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.activity[1]!.createdAt=p.activity[0]!.createdAt);}],
 ["ambiguous comment order",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.comments[1]!.createdAt=p.comments[0]!.createdAt);}],
 ["event before saved audit",(o:ReturnType<typeof example>)=>{o.forEach(p=>p.frames[0]!.eventCreatedAt=iso(1));}],
 ["different authorized evidence",(o:ReturnType<typeof example>)=>{o[1].activity[0]!.id="different-audit";}],
] as const)("rejects %s instead of inventing a comment/event binding",(_label,mutate)=>{const observers=example();mutate(observers);expect(bindNotificationPublicEvents("company","task",observers)).toMatchObject({complete:false,frames:[[],[]]});});
it("rejects unrelated task events, missing eligibility, malformed timestamps and wrong scope at capture",()=>{
 const message={id:1,companyId:"company",type:"activity.logged",createdAt:iso(1),toastEligible:true,payload:{action:"issue.comment_added",entityType:"issue",entityId:"task",actorType:"user",actorId:"alex"}};
 for(const changed of [{...message,toastEligible:undefined},{...message,id:"1"},{...message,createdAt:"unavailable"},{...message,type:"heartbeat.run.status"},{...message,payload:{...message.payload,action:"issue.updated"}},{...message,payload:{...message.payload,entityId:"other"}}])expect(publicNotificationFrame(changed,"company","task",base+2)).toBeNull();
});

it("keeps empty observations unavailable rather than synthesizing a comment/event proof",()=>{const observers=example();for(const o of observers){o.frames=[];o.comments=[];o.activity=[];}expect(bindNotificationPublicEvents("company","task",observers)).toMatchObject({complete:false,reason:"no-new-comment-events",frames:[[],[]]});});
