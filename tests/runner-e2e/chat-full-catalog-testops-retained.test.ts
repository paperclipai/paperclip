import { it as test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as aggregate from './chat-full-catalog-testops-merge.js';
import {hash,model} from './chat-completion-testops-contract.mjs';
import {fullCatalogCases,catalogTargetSha} from './chat-full-catalog-testops-manifest.mjs';
import {privateArtifactKey} from './private-history.js';
import {manualCellKind} from './manual-private-retention.js';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const context={catalog:'full' as const,runId:'123',attempt:'1',workflowSha:'a'.repeat(40),targetSha:catalogTargetSha};
async function fixture(t:any){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'chat-retained-')));roots.push(root);
 const input=path.join(root,'inputs');await mkdir(input);
 const cases=fullCatalogCases.slice(0,3).map((row,i)=>({...row,caseId:100+i}));
 const selection={schema:'paperclip.chat-completion-testops-selection/v1',...context,projectId:1,planId:102,jobId:100,launchId:12,allureJobRunId:'77',cases};
 for(const [index,row] of cases.slice(0,2).entries()){
  const dir=path.join(input,row.key);await mkdir(dir);
  const passed=index===0;
  const result={schema:'paperclip.runner-e2e.result/v2',suiteDefinitionHash:'c'.repeat(64),startedAt:'2026-11-01T00:00:00Z',finishedAt:'2026-11-01T00:00:01Z',durationMs:1000,executionId:row.executionId,suiteId:'chat-features',caseId:row.scenario,profileId:'runner-opencode',provider:'opencode',environmentId:'local',model,runtimeMode:'native',attempt:1,source:{sha:catalogTargetSha,ref:null,workflowRunUrl:'https://github.com/paperclipai/paperclip/actions/runs/123'},status:passed?'passed':'failed',cleanup:passed?'passed':'failed',runIds:passed?Array.from({length:row.minimumRuns},(_,i)=>`owned-${i}`):[],matcherResults:passed?Array.from({length:row.checks??2},(_,i)=>({matcher:{kind:'json_path',path:`fixture.check${i}`,expected:true},passed:true,detail:'Retained independent check'})):[],screenshots:[]};
  const files=new Map([['normalized-results.json',Buffer.from(JSON.stringify({schema:'paperclip.runner-e2e.campaign/v2',campaignId:'gha-123-1',retries:0,results:[result]}))],['junit.xml',Buffer.from('<testsuite/>')]]);
  for(const [name,data] of files)await writeFile(path.join(dir,name),data);
  await writeFile(path.join(dir,'binding.json'),JSON.stringify({schema:'paperclip.chat-completion-testops-export/v1',...context,campaignId:'gha-123-1',executionIds:[row.executionId],files:[...files].map(([name,data])=>({path:name,bytes:data.length,sha256:hash(data)})),privateEvidence:[{executionId:row.executionId,requiredEvidenceComplete:passed,finalScreenshot:passed?{sha256:'e'.repeat(64),bytes:24}:null}]}));
 }
 const disposition={schema:'paperclip.chat-catalog-retained-disposition/v1',origin:{...context,projectId:1,planId:102,jobId:100,launchId:12,allureJobRunId:'77'},selectionSha256:hash(JSON.stringify(selection,null,2)),upstream:{status:'completed',jobsSha256:'b'.repeat(64)},custodySha256:'c'.repeat(64),gaps:[{executionId:cases[2].executionId,archiveKey:privateArtifactKey(manualCellKind(cases[2].executionId),context.runId),archiveStatus:'not_found'}]};
 return {root,input,selection,disposition,context,output:path.join(root,'report')};
}
async function prepare(f:any){return (aggregate.prepareRetainedCatalogReport ?? aggregate.mergeCatalogProjections)(f.input,f.output,f.selection,f.context,f.disposition,{kind:'operator',revisionSha:'d'.repeat(40)});}
test('available original PASS and FAIL publish beside explicit UNKNOWN reporting gap instead of all-or-nothing rejection',async t=>{
 const f=await fixture(t);await assert.rejects(aggregate.mergeCatalogProjections(f.input,path.join(f.root,'old'),f.selection,f.context),/Incomplete projection set/);
 const receipt=await prepare(f);
 assert.deepEqual(receipt.coverage,{selected:3,gradedOriginals:2,originalPassed:1,originalFailed:1,reportingGaps:1});
 const rows=await Promise.all((await readdir(f.output+'/allure')).filter(n=>n.endsWith('-result.json')).map(async n=>JSON.parse(await readFile(f.output+'/allure/'+n,'utf8'))));
 assert.deepEqual(rows.map(r=>r.status).sort(),['broken','failed','passed']);
 const gap=rows.find(r=>r.status==='broken');assert.equal(gap.historyId,hash(JSON.stringify([gap.fullName,'runner-opencode',model,'local'])));assert.deepEqual(gap.steps,[]);assert.equal(gap.start,undefined);assert.equal(gap.labels.find((r:any)=>r.name==='AS_ID').value,'102');
 const data=JSON.parse(await readFile(f.output+'/allure/'+gap.attachments[0].source,'utf8'));
 assert.equal(data.originalStatus,null);assert.equal(data.checks,null);assert.equal(data.nativeRunCount,null);assert.equal(data.cleanup,null);
 assert.equal(data.outcome,'reporting_gap');assert.equal(data.doesNotAttestFeatureOutcome,true);
 assert.equal(receipt.files.length,9);await assert.rejects(prepare(f));
});
test('unexplained missing, duplicate, foreign origin and nonterminal evidence refuse without emitting an Allure payload',async t=>{
 for(const change of [(f:any)=>f.disposition.gaps=[],(f:any)=>f.disposition.gaps.push(f.disposition.gaps[0]),(f:any)=>f.disposition.origin.workflowSha='f'.repeat(40),(f:any)=>f.disposition.upstream.status='in_progress',(f:any)=>f.disposition.selectionSha256='f'.repeat(64),(f:any)=>f.disposition.gaps[0].archiveStatus='present',(f:any)=>f.disposition.gaps[0].executionId=f.selection.cases[0].executionId]){
  const f=await fixture(t);change(f);await assert.rejects(prepare(f));await assert.rejects(readdir(f.output+'/allure'));
 }
});
test('gap input cannot inject a grade, private text, model usage or a foreign archive',async t=>{
 for(const change of [(g:any)=>g.status='passed',(g:any)=>g.error='PRIVATE_PROVIDER_PAYLOAD',(g:any)=>g.nativeRunCount=1,(g:any)=>g.archiveKey=g.archiveKey.replace('gha-123','gha-124')]){
  const f=await fixture(t);change(f.disposition.gaps[0]);await assert.rejects(prepare(f));
 }
});
test('a corrupt authentic projection cannot be downgraded into a gap or bypass original validation',async t=>{
 const f=await fixture(t);const dir=path.join(f.input,f.selection.cases[0].key);const file=dir+'/binding.json';const binding=JSON.parse(await readFile(file,'utf8'));binding.targetSha='f'.repeat(40);await writeFile(file,JSON.stringify(binding));await assert.rejects(prepare(f));
});
