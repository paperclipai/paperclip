// PRIVATE UNRUN finite follow-on using the existing actual HTTP/Db owners.
// Caller starts generation1 through normal-app-child from the BEGINNING.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { dotRunnerAssignments, dotRunnerOperations, nativeRunResults, heartbeatRuns, completionContracts, issues, type Db } from "@paperclipai/db";
import { documentService } from "../../../services/documents.js";
import { externalOperationDigest } from "../../../vendor/paperclip-runner/index.js";
import { createCommittedReplyLoss } from "./committed-reply-loss.js";
import type { forkNormalDotApp } from "./physical-app-owner.js";

type Child=Awaited<ReturnType<typeof forkNormalDotApp>>;
type Wire={status:number;body:{result?:{isError?:boolean;structuredContent?:{result?:unknown}}}};
export async function usefulAfterPhysicalRestart(input:{
  db:Db; companyId:string; agentId:string; first:Child;
  startSecond:()=>Promise<Child>;
  // Original authorized normal board HTTP surface; no issue/outcome row writes.
  createTask:(body:{title:string;description:string;workMode:"standard";status:"todo";assigneeAgentId:string})=>Promise<{status:number;body:{id:string}}>;
  // Same unrevoked wrapped token, issuer/resource and original normal Cloud
  // tool path. The optional origin is ONLY the owned reply-loss transport.
  tool:(name:string,args:Record<string,unknown>,ownedOrigin?:string)=>Promise<Wire>;
  cloudLoopback:string;
  caseDeadline:number;
  assertPassiveQuiet:(durationMs:15000)=>Promise<void>;
}){
  const bounded=async<T>(work:Promise<T>,deadline:number,label:string)=>{
    const remaining=Math.min(deadline,input.caseDeadline)-performance.now();assert(remaining>0,label);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),remaining);})]);}
    finally{clearTimeout(timer);}
  };
  const until=async<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,deadline:number):Promise<T>=>{
    for(;;){const value=await bounded(read(),deadline,"original_followon_deadline_exhausted");if(accept(value))return value;
      await bounded(pause(25),deadline,"original_followon_deadline_exhausted");}
  };
  const firstIdentity={pid:input.first.pid,started:input.first.started,bootId:input.first.bootId};
  await input.first.stop(Math.min(input.caseDeadline,performance.now()+15000));
  const second=await bounded(input.startSecond(),input.caseDeadline,"original_followon_setup_deadline_exhausted");
  assert.notEqual(second.pid,firstIdentity.pid);assert.notEqual(second.bootId,firstIdentity.bootId);
  // First owner proved actual old PID/group absence before second startup. No
  // service-only reconstruction or fake process observation can satisfy that.
  const listed=await input.tool("paperclip_dot_tasks",{});assert.equal(listed.status,200);assert.equal(listed.body.result?.isError,false);
  const created=await input.createTask({title:"Save a fresh post-restart report",description:"Save a report document containing 31 + 11 = 42 using assigned Paperclip tools.",
    workMode:"standard",status:"todo",assigneeAgentId:input.agentId});
  assert.equal(created.status,201);assert.match(created.body.id,/^[a-f0-9-]{36}$/);
  const taskId=created.body.id,admissionId=randomUUID();
  const admitted=await input.tool("paperclip_dot_request_work",{issueId:taskId,requestId:admissionId});
  assert.equal(admitted.status,200);assert.equal(admitted.body.result?.isError,false);
  const runs=await until(()=>input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId,taskId)),
    rows=>rows.some(row=>row.runtimeMode==="native"&&row.status==="running"),Math.min(input.caseDeadline,performance.now()+30000));
  assert.equal(runs.length,1);const runId=runs[0].id;
  const assignments=await until(()=>input.db.select().from(dotRunnerAssignments).where(eq(dotRunnerAssignments.runId,runId)),
    rows=>rows.length===1,Math.min(input.caseDeadline,performance.now()+30000));
  const assignment=assignments[0];assert.equal(assignment.companyId,input.companyId);assert.equal(assignment.agentId,input.agentId);
  const acceptId=randomUUID();
  const accepted=await input.tool("paperclip_dot_accept",{assignmentId:assignment.id,requestId:acceptId});
  assert.equal(accepted.status,200);assert.equal(accepted.body.result?.isError,false);
  await until(()=>input.db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,acceptId)),
    rows=>rows.length===1&&rows[0].status==="completed",Math.min(input.caseDeadline,performance.now()+10000));
  const requestId=randomUUID();
  const args={name:"write_document",arguments:{key:"report",title:"Fresh arithmetic report",body:"31 + 11 = 42.",baseRevisionId:null,idempotencyKey:requestId}};
  const digest=externalOperationDigest("tool",args);
  let committedJournal:typeof dotRunnerOperations.$inferSelect|undefined;
  const awaitActualCommit=async()=>{
    const rows=await until(()=>input.db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,requestId)),
      rows=>rows.length===1&&rows[0].status==="completed",Math.min(input.caseDeadline,performance.now()+10000));
    assert.equal(rows.length,1);committedJournal=rows[0];assert.equal(committedJournal.digest,digest);
    assert.equal(committedJournal.assignmentId,assignment.id);assert.equal(committedJournal.companyId,input.companyId);
    assert(committedJournal.sourceEventId);assert.deepEqual(committedJournal.command,{bindingId:assignment.bindingId,bindingGeneration:assignment.bindingGeneration,
      runId,normalizedSessionId:assignment.normalizedSessionId,turnId:assignment.turnId,assignmentRevision:assignment.revision,requestId,action:"tool",input:args,digest});
    const document=await documentService(input.db).getIssueDocumentByKey(taskId,"report");assert(document);assert.equal(document.body,"31 + 11 = 42.");
  };
  const loss=await createCommittedReplyLoss({cloudLoopback:input.cloudLoopback,assignmentId:assignment.id,requestId,inputDigest:digest,awaitActualCommit});
  try{
    let lost=false;
    try{await input.tool("paperclip_dot_tool",{assignmentId:assignment.id,requestId,...args},loss.origin);}
    catch{lost=true;}
    // A generic network error is insufficient: exact actual request selected,
    // backend handler completed and normal journal+document committed BEFORE
    // this ONE frontend response was physically lost.
    assert(lost);await bounded(loss.droppedResponseClosed,input.caseDeadline,"lost_response_close_not_observed");
    assert.deepEqual(loss.evidence,{armed:false,selected:1,backendCompleted:1,committed:1,dropped:1,closedAfterDrop:1,overflow:0,observerFailures:0});
    const before=await documentService(input.db).getIssueDocumentByKey(taskId,"report");assert(before);
    const replay=await input.tool("paperclip_dot_tool",{assignmentId:assignment.id,requestId,...args});
    assert.equal(replay.status,200);assert.equal(replay.body.result?.isError,false);
    const journals=await input.db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,requestId));
    assert.equal(journals.length,1);assert.deepEqual(journals[0],committedJournal);
    const after=await documentService(input.db).getIssueDocumentByKey(taskId,"report");assert.deepEqual(after,before);
    const conflict=await input.tool("paperclip_dot_tool",{assignmentId:assignment.id,requestId,...args,arguments:{...args.arguments,body:"different"}});
    assert.equal(conflict.body.result?.isError,true);assert.deepEqual(await documentService(input.db).getIssueDocumentByKey(taskId,"report"),before);
    const [run]=await input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));assert(run.completionContractId);
    const [contract]=await input.db.select().from(completionContracts).where(eq(completionContracts.id,run.completionContractId));
    const specification=z.object({revision:z.string(),criteria:z.array(z.object({id:z.string()}))}).passthrough().parse(contract.contractJson);
    const result={reportedWorkDisposition:"completed",summary:"Saved fresh arithmetic report.",completionClaim:{contractRevision:specification.revision,
      objectiveSatisfied:true,criteria:specification.criteria.map(criterion=>({criterionId:criterion.id,status:"passed",evidenceRefs:[]})),remainingWork:[]},
      evidence:[],verification:[{commandOrCheck:"Read the persisted report: 31 + 11 = 42.",status:"pass"}]};
    const finishToolId=randomUUID();
    const finishedTool=await input.tool("paperclip_dot_tool",{assignmentId:assignment.id,requestId:finishToolId,name:"paperclip_finish",arguments:result});
    assert.equal(finishedTool.status,200);assert.equal(finishedTool.body.result?.isError,false);
    await until(()=>input.db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.requestId,finishToolId)),
      rows=>rows.length===1&&rows[0].status==="completed",Math.min(input.caseDeadline,performance.now()+10000));
    const finish=await input.tool("paperclip_dot_finish",{assignmentId:assignment.id,requestId:randomUUID(),result});
    assert.equal(finish.status,200);assert.equal(finish.body.result?.isError,false);
    const results=await until(()=>input.db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,runId)),rows=>rows.length===1,
      Math.min(input.caseDeadline,performance.now()+15000));assert.equal(results.length,1);
    const [task]=await input.db.select().from(issues).where(eq(issues.id,taskId));assert.equal(task.status,"done");
    await input.assertPassiveQuiet(15000);
    return {second,firstIdentity,secondIdentity:{pid:second.pid,started:second.started,bootId:second.bootId},taskId,runId,
      requestId,assignmentId:assignment.id,committedReplyLoss:{...loss.evidence},oneEffect:true};
  }finally{await loss.close();}
}
