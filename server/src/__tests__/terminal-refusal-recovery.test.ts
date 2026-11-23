import { DISPOSITION_REPAIR_MAX_ATTEMPTS } from '../services/recovery/disposition-repair.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createDb,companies,agents,issues,heartbeatRuns,agentWakeupRequests} from '@paperclipai/db';
import {eq} from 'drizzle-orm';
import {startEmbeddedPostgresTestDatabase} from './helpers/embedded-postgres.js';
import {recoveryService} from '../services/recovery/service.js';
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('hom3857-terminal-');db=createDb(temp.connectionString)},90000);
afterAll(async()=>{await temp?.cleanup()},90000);
const cases=[
 {errorCode:'adapter_failed',error:'This content was flagged for possible cybersecurity risk.'},
 {errorCode:'codex_transient_upstream',resultJson:{errorFamily:'model_refusal'}},
 {errorCode:'provider_quota',resultJson:{errorFamily:'model_refusal'}},
 {errorCode:'adapter_failed',resultJson:{stopReason:'refusal'}},
];
async function seed(row:Record<string,unknown>){
 const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),runId=randomUUID();
 await db.insert(companies).values({id:companyId,name:'Synthetic refusal regression',issuePrefix:'TR'+companyId.slice(0,6),requireBoardApprovalForNewAgents:false});
 await db.insert(agents).values({id:agentId,companyId,name:'Synthetic performer',role:'engineer',status:'idle',adapterType:'codex_local',adapterConfig:{},runtimeConfig:{},permissions:{}});
 await db.insert(issues).values({id:issueId,companyId,title:'Synthetic terminal diagnostic',status:'in_progress',priority:'critical',assigneeAgentId:agentId,updatedAt:new Date(Date.now()-16*60_000)});
 await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,status:'failed',invocationSource:'assignment',startedAt:new Date(Date.now()-18*60_000),finishedAt:new Date(Date.now()-17*60_000),createdAt:new Date(Date.now()-18*60_000),contextSnapshot:{issueId},...row,resultJson:{executionRecovery:{kind:'bootstrap',providerWorkStarted:false},...(row.resultJson as object??{})}});
 return {companyId,agentId,issueId,runId};
}
describe('actual recovery scheduling after terminal refusal',()=>{
 it.each(cases)('queues zero automatic attempts for %j',async row=>{
  const ids=await seed(row);const enqueueWakeup=vi.fn(async()=>null),scheduleRecoveryRetry=vi.fn(async()=>null);
  const recovery=recoveryService(db,{enqueueWakeup,scheduleRecoveryRetry});
  await recovery.reconcileStrandedAssignedIssues(ids);
  await recovery.reconcileStrandedAssignedIssues(ids);
  expect(enqueueWakeup).not.toHaveBeenCalled();expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,ids.companyId))).toHaveLength(0);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,ids.companyId))).toHaveLength(1);
  expect((await db.select().from(issues).where(eq(issues.id,ids.issueId)))[0]).toMatchObject({status:'blocked',assigneeAgentId:ids.agentId});
 });
 it('transport-only recovery still requests an automatic attempt',async()=>{
  const ids=await seed({errorCode:'codex_transient_upstream',error:'upstream unavailable'});
  const enqueueWakeup=vi.fn(async()=>null),scheduleRecoveryRetry=vi.fn(async()=>null);
  await recoveryService(db,{enqueueWakeup,scheduleRecoveryRetry}).reconcileStrandedAssignedIssues(ids);
  expect(enqueueWakeup.mock.calls.length+scheduleRecoveryRetry.mock.calls.length).toBeGreaterThan(0);
 });
 it('setup-only recovery stays stopped',async()=>{
  const ids=await seed({errorCode:'setup_failed',error:'configuration incomplete'});
  const enqueueWakeup=vi.fn(async()=>null),scheduleRecoveryRetry=vi.fn(async()=>null);
  await recoveryService(db,{enqueueWakeup,scheduleRecoveryRetry}).reconcileStrandedAssignedIssues(ids);
  expect(enqueueWakeup).not.toHaveBeenCalled();expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
 });
});


import { classifyContinuationFailure } from '../services/recovery/service.js';
import { createHeartbeatRetries } from '../services/heartbeat/retries.js';

const refusalRows = [
 {errorCode:'adapter_failed',error:'This content was flagged for possible cybersecurity risk.'},
 {errorCode:'adapter_failed',error:'  This content was flagged for possible cybersecurity risk  '},
 {errorCode:'adapter_failed',resultJson:{errorFamily:'model_refusal'}},
 {errorCode:'codex_transient_upstream',resultJson:{errorFamily:'model_refusal'}},
 {errorCode:'timeout',resultJson:{stopReason:'refusal'}},
 {errorCode:'model_refusal'},
 {errorCode:'provider_safety_refusal'},
];
const base={id:'synthetic-run',agentId:'synthetic-agent',companyId:'synthetic-company',status:'failed',contextSnapshot:{issueId:'synthetic-issue'},createdAt:new Date(0),startedAt:new Date(0),runnerProfileJson:{}};
describe('terminal provider refusal dominates automatic recovery',()=>{
 it.each(refusalRows)('zero continuation attempts for %j',row=>{
  expect(classifyContinuationFailure({...base,...row} as never)).toMatchObject({kind:'non_retryable',maxAttempts:0,baseBackoffMs:0});
 });
 it.each(refusalRows)('bounded scheduler has no side effects for %j',async row=>{
  const touched=vi.fn(()=>{throw new Error('UNEXPECTED_SIDE_EFFECT')});
  const db=new Proxy({}, {get:()=>touched});
  const dependencies=new Proxy({}, {get:()=>touched});
  const retry=createHeartbeatRetries(db as never,dependencies as never);
  const result=await retry.scheduleBoundedRetryForRun({...base,...row} as never,{adapterConfig:{}} as never,{maxAttempts:99,retryReason:'transient_failure',delayMs:0});
  expect(result).toMatchObject({outcome:'not_scheduled',issueId:'synthetic-issue'});
  expect(touched).not.toHaveBeenCalled();
 });
 it.each([
  {errorCode:'codex_transient_upstream',error:'upstream unavailable'},
  {errorCode:'adapter_failed',error:'connection reset'},
  {errorCode:'adapter_failed',error:'Safety report could not load due to connection reset'},
  {errorCode:'adapter_failed',resultJson:{output:'This content was flagged for possible cybersecurity risk.'}},
 ])('transport controls retain transient budget for %j',row=>{
  expect(classifyContinuationFailure({...base,...row} as never)).toMatchObject({kind:'transient_infra',maxAttempts:3});
 });
 it('setup failure stays non-retryable',()=>expect(classifyContinuationFailure({...base,errorCode:'setup_failed'} as never)).toMatchObject({kind:'non_retryable',maxAttempts:0}));
 it('deliberate review wait keeps its separate budget',()=>expect(classifyContinuationFailure({...base,errorCode:'issue_continuation_waiting_on_review'} as never)).toMatchObject({kind:'deliberate_wait_without_target',maxAttempts:DISPOSITION_REPAIR_MAX_ATTEMPTS}));
 it('transport still reaches scheduler admission',async()=>{
  const touched=vi.fn(()=>{throw new Error('SYNTHETIC_ADMISSION_SENTINEL')});
  const retry=createHeartbeatRetries(new Proxy({}, {get:()=>touched}) as never,new Proxy({}, {get:()=>touched}) as never);
  await expect(retry.scheduleBoundedRetryForRun({...base,errorCode:'codex_transient_upstream'} as never,{adapterConfig:{}} as never)).rejects.toThrow('SYNTHETIC_ADMISSION_SENTINEL');
  expect(touched).toHaveBeenCalled();
 });
});

describe('terminal refusal preserves current recovery authority', () => {
  it('does not take the task back after an owner change during recovery', async () => {
    const ids = await seed({errorCode: 'model_refusal'});
    const replacementId = randomUUID();
    await db.insert(agents).values({id: replacementId, companyId: ids.companyId,
      name: 'Replacement owner', role: 'engineer', status: 'idle', adapterType: 'codex_local'});
    const enqueueWakeup = vi.fn(async () => null), scheduleRecoveryRetry = vi.fn(async () => null);
    await recoveryService(db, {enqueueWakeup, scheduleRecoveryRetry,
      afterStrandedLatestRunRead: async () => {
        await db.update(issues).set({assigneeAgentId: replacementId}).where(eq(issues.id, ids.issueId));
      },
    }).reconcileStrandedAssignedIssues(ids);
    expect((await db.select().from(issues).where(eq(issues.id, ids.issueId)))[0])
      .toMatchObject({status: 'in_progress', assigneeAgentId: replacementId});
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
  });

  it('leaves an unexpired legacy controller lease to its finalizer', async () => {
    const ids = await seed({errorCode: 'model_refusal', runtimeMode: 'legacy',
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000)});
    const enqueueWakeup = vi.fn(async () => null), scheduleRecoveryRetry = vi.fn(async () => null);
    const result = await recoveryService(db, {enqueueWakeup, scheduleRecoveryRetry})
      .reconcileStrandedAssignedIssues(ids);
    expect(result.escalated).toBe(0);
    expect((await db.select().from(issues).where(eq(issues.id, ids.issueId)))[0])
      .toMatchObject({status: 'in_progress', assigneeAgentId: ids.agentId});
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(scheduleRecoveryRetry).not.toHaveBeenCalled();
  });
});
