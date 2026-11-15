import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDb, startEmbeddedPostgresTestDatabase } from '../../packages/db/src/index.ts';
import { issueRoutes } from '../../server/src/routes/issues.ts';
import { errorHandler } from '../../server/src/middleware/index.ts';
import { seedIssueReadVisibilityFixture } from '../../server/src/__tests__/helpers/issue-read-visibility-fixture.ts';
import { listIssueNavigationState } from '../../server/src/services/issue-summaries.ts';
import { issueReadSqlCondition } from '../../server/src/services/authorization.ts';

// Run from the server package: pnpm --filter @paperclipai/server exec tsx scripts/benchmark-sidebar-subtasks.ts
// All data is synthetic. The temporary PostgreSQL cluster is removed in finally.
const directory = resolve(process.env.PAPERCLIP_BENCHMARK_OUTPUT ?? '../test-results/sidebar-subtasks-benchmark');
await mkdir(directory, { recursive: true });
const out = pathToFileURL(directory + '/');
const report: any = { synthetic: true, node: process.version, pool: 10, samples: 5, cases: [] };
const keeper = setInterval(() => {}, 1000);
const fixture = await startEmbeddedPostgresTestDatabase('sidebar-subtasks-perf-');
const db = createDb(fixture.connectionString, { maxConnections: 10 });
const client = db.$client;
const statements: Array<{query: string; params: unknown[]}> = [];
let record = false;
const counted = drizzle(client, { schema: db._.fullSchema, logger: { logQuery(query, params) { if (record) statements.push({query, params}); } } }) as typeof db;
let server: ReturnType<typeof express>['listen'] extends (...a:any[]) => infer R ? R : never;
const stats = (xs: number[]) => { const s = [...xs].sort((a,b)=>a-b); return {medianMs:+s[Math.floor(s.length/2)]!.toFixed(2), maxMs:+s.at(-1)!.toFixed(2), samplesMs:xs.map(x=>+x.toFixed(2))}; };
try {
  process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = 'enforce';
  const f = await seedIssueReadVisibilityFixture(db, {publicCount: 50});
  const actor = f.actors['cloud tenant owner'];
  const userId = (actor as any).userId!;
  const parents = f.publicIds;
  // Make each measured parent independent and participated-in by this viewer.
  await client.unsafe('update issues set parent_id=null, created_by_user_id=$2 where company_id=$1 and id=any($3::uuid[])',[f.companyId,userId,parents]);
  await client.unsafe(`create table perf_parents as select id from issues where id=any($1::uuid[])`,[parents]);
  await client.unsafe(`insert into issues (company_id,title,status,created_by_user_id) select $1,'Unrelated history '||n,'done',$2 from generate_series(1,20000)n`,[f.companyId,f.strangerUserId]);
  await client.unsafe(`insert into activity_log(company_id,actor_type,actor_id,action,entity_type,entity_id,created_at) select $1,'system','synthetic-agent','issue.updated','issue',$2,now() from generate_series(1,100000)n`,[f.companyId,parents[0]]);
  const connections=await Promise.all(Array.from({length:10},()=>client.reserve()));
  for(const connection of connections){await connection.unsafe("set statement_timeout='20s'");connection.release();}
  const app=express();
  app.use((req,_res,next)=>{req.actor=actor as any;next();});
  app.use('/api',issueRoutes(counted,{} as never)); app.use(errorHandler);
  server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const summaryPath=`/api/companies/${f.companyId}/issues/summaries?ids=${parents.join(',')}`;
  async function read(path:string) {const r=await fetch(origin+path);const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;}
  async function measure(path:string) {await read(path);const times=[];for(let n=0;n<5;n++){const t=performance.now();await read(path);times.push(performance.now()-t);}record=true;statements.length=0;const body=await read(path);record=false;return {time:stats(times),statements:statements.length,sqlBytes:statements.reduce((n,x)=>n+Buffer.byteLength(x.query),0),responseBytes:Buffer.byteLength(JSON.stringify(body)),body};}
  report.postgres=(await client.unsafe('select version()'))[0]!.version;
  report.fixture={parents:50,noiseIssues:20000,noiseActivity:100000,privacy:'enforce',actor:'cloud tenant owner',commentBytes:128};
  let previous=0;
  for(const perParent of [0,10,100,1000]) {
    if(perParent>previous) {
      await client.unsafe(`insert into issues(company_id,parent_id,title,status,created_by_user_id,created_at,updated_at)
        select $1,p.id,'Synthetic child '||n,'todo',$2,'2026-01-01','2026-01-01' from perf_parents p cross join generate_series($3::int,$4::int)n`,[f.companyId,userId,previous+1,perParent]);
      // One external comment per child, deliberately all read: the unread test
      // must check its pending/withdrawal branches rather than short-circuit.
      await client.unsafe(`insert into issue_comments(company_id,issue_id,author_user_id,body,created_at)
        select $1,i.id,$2,repeat('x',128),'2026-01-02' from issues i where i.company_id=$1 and i.parent_id=any($3::uuid[]) and not exists(select 1 from issue_comments c where c.issue_id=i.id)`,[f.companyId,f.strangerUserId,parents]);
      await client.unsafe(`insert into issue_read_states(company_id,issue_id,user_id,last_read_at)
        select $1,i.id,$2,'2026-01-03' from issues i where i.company_id=$1 and i.parent_id=any($3::uuid[]) on conflict(company_id,issue_id,user_id) do nothing`,[f.companyId,userId,parents]);
    }
    await client.unsafe('vacuum analyze');
    const base=await measure(summaryPath);
    const nav=await measure(summaryPath+'&navigation=true');
    for(const row of nav.body) {assert.equal(row.subtaskCount,perParent);assert.equal(row.unreadSubtaskCount,0);}
    const plans: any[]=[];
    for(const [index,s] of statements.entries()) {
      const plan=await client.unsafe('explain (analyze,buffers,format json) '+s.query,s.params as any[]);
      plans.push({index,sql:s.query,plan:plan[0]['QUERY PLAN']});
    }
    await writeFile(new URL(`plans-${perParent}.json`,out),JSON.stringify(plans,null,2));
    const childPath=`/api/companies/${f.companyId}/issues?parentId=${parents[0]}&view=rows&limit=10&sortField=id&sortDir=asc&includeRoutineExecutions=true&includeReadState=true`;
    const page=perParent?await measure(childPath):null;
    const item={childrenPerParent:perParent,totalCountedChildren:perParent*50,baseline:{...base,body:undefined},navigation:{...nav,body:undefined},firstChildPage:page?{...page,body:undefined,rows:page.body.length}:null};
    report.cases.push(item);console.log(JSON.stringify(item));
    await writeFile(new URL('database-results.json',out),JSON.stringify(report,null,2));
    previous=perParent;
  }
  // Compare the same large hierarchy when children are unread and when they
  // have never been touched by this person.
  for(const state of ['unread','untouched']) {
    if(state==='unread') await client.unsafe(`update issue_read_states set last_read_at='2026-01-01' where company_id=$1`,[f.companyId]);
    else await client.unsafe(`update issues set created_by_user_id=$2 where company_id=$1 and parent_id=any($3::uuid[])`,[f.companyId,f.strangerUserId,parents]);
    await client.unsafe('vacuum analyze');
    const m=await measure(summaryPath+'&navigation=true');
    assert.ok(m.body.every((x:any)=>x.unreadSubtaskCount===(state==='unread'?1000:0)));
    const plans=[];
    for(const [index,s] of statements.entries()) {
      const plan=await client.unsafe('explain (analyze,buffers,format json) '+s.query,s.params as any[]);
      plans.push({index,sql:s.query,plan:plan[0]['QUERY PLAN']});
    }
    await writeFile(new URL(`plans-${state}.json`,out),JSON.stringify(plans,null,2));
    const item={state,childrenPerParent:1000,...m,body:undefined};report.cases.push(item);console.log(JSON.stringify(item));
  }
  // A mature viewer's old withdrawal receipts exercise the indexed JSON lookup.
  await client.unsafe(`insert into activity_log(company_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at)
    select $1,'user',$2,'issue.thread_interaction_withdrawn','issue',$3,jsonb_build_object('handledForUserId',$2::text,'receipt',jsonb_build_object('outcome','withdrawn','issueId',$3::text)),'2025-12-01' from generate_series(1,5000)n`,[f.companyId,userId,parents[0]]);
  await client.unsafe(`update issues set created_by_user_id=$2 where company_id=$1 and parent_id=any($3::uuid[])`,[f.companyId,userId,parents]);
  await client.unsafe(`update issue_read_states set last_read_at='2026-01-03' where company_id=$1`,[f.companyId]);
  await client.unsafe('vacuum analyze');
  const receipts=await measure(summaryPath+'&navigation=true');
  report.receiptStress={oldViewerReceipts:5000,...receipts,body:undefined};console.log(JSON.stringify(report.receiptStress));
  const readCondition=await issueReadSqlCondition(db,actor);
  const q=()=>listIssueNavigationState(db,f.companyId,parents,readCondition,userId);
  const start=performance.now();await Promise.all(Array.from({length:3},q));report.concurrentThreeServiceRequestsMs=+(performance.now()-start).toFixed(2);
  await writeFile(new URL('database-results.json',out),JSON.stringify(report,null,2));
} finally {
  server?.close(); await client.end({timeout:0}); await fixture.cleanup(); clearInterval(keeper);
}
