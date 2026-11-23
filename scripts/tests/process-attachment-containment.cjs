const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const esbuild=require('esbuild');
const root=path.resolve(process.argv[2]);
const company='0000000a-0000-4000-8000-00000000000a';
const incident=['0000000b-0000-4000-8000-00000000000b','0000000c-0000-4000-8000-00000000000c'];
const allowedRun=id=>!incident.includes(id);
let origins=[],reads=0,privacyCalls=0,handler,projection;
const run=id=>id==='missing'?null:{id,companyId:id==='foreign'?'foreign':company};
const canRead=async(db,access,actor,r)=>{privacyCalls++;return r.companyId===company&&allowedRun(r.id)};
const attachment=()=>({id:'synthetic',companyId:company,issueId:'synthetic-issue',originatingRunId:origins[0],objectKey:'synthetic',byteSize:1});
const ctx={router:{get:(p,h)=>handler=h},db:{},access:{},getAccessibleResource:async(req,res,p)=>await p,
 svc:{getAttachmentById:async()=>attachment(),getById:async()=>({id:'synthetic-issue',companyId:company})},assertIssueReadAllowed:async()=>true,
 parseAttachmentRangeHeader:()=>({kind:'none'}),heartbeat:{getRun:async id=>run(id)},canActorReadHeartbeatRun:canRead,
 storage:{getObject:async()=>{reads++;throw Error('SYNTHETIC_STORAGE_BOUNDARY')}}};
const source=fs.readFileSync(path.join(root,'server/src/routes/issues.ts'),'utf8');const start=source.indexOf('  router.get("/attachments/:attachmentId/content"');const end=source.indexOf('  router.delete("/attachments/:attachmentId"',start);assert(start>=0&&end>start);
vm.runInNewContext(esbuild.transformSync(source.slice(start,end),{loader:'ts',format:'cjs'}).code,ctx);
const tables={};for(const name of ['assets','caseAttachments','heartbeatRuns','issues','issueAttachments','runnerApiResponseReservations'])tables[name]=new Proxy({name},{get:(t,k)=>k==='name'?t.name:name+'.'+String(k)});
const db={select:p=>{projection=p;let table,selectedId;const query={from:t=>{table=t.name;return query},leftJoin:()=>query,where:clause=>{if(table==='heartbeatRuns')selectedId=clause.find(x=>x[0]==='heartbeatRuns.id')?.[1];return query},limit:()=>query,then:(ok,bad)=>Promise.resolve(table==='issueAttachments'?origins.map(id=>Object.fromEntries(Object.keys(projection).map(k=>[k,k==='issueId'?'synthetic-issue':id]))):table==='heartbeatRuns'?(run(selectedId)?[run(selectedId)]:[]):[]).then(ok,bad)};return query}};
const mod={exports:{}};const sandbox={module:mod,exports:mod.exports,require:name=>{
 if(name==='drizzle-orm')return{and:(...x)=>x,eq:(...x)=>x};if(name==='@paperclipai/db')return tables;if(name==='@paperclipai/shared')return{isUuidLike:()=>true};if(name.endsWith('authorization.js'))return{authorizationService:()=>({decide:async()=>({allowed:true})})};if(name.endsWith('heartbeat-run-privacy.js'))return{canActorReadHeartbeatRun:canRead};if(name.endsWith('case-access.js'))return{canActorReadCase:async()=>true};throw Error('Unexpected import '+name)}};
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(root,'server/src/services/asset-content-access.ts'),'utf8'),{loader:'ts',format:'cjs'}).code,sandbox);
(async()=>{let failed=0;const results=[];for(const origin of [...incident,'ordinary',null,'missing','foreign']){
 origins=[origin];reads=0;privacyCalls=0;let status=null;const res={status:n=>{status=n;return res},json:()=>res,setHeader:()=>res};
 try{await handler({params:{attachmentId:'synthetic'},actor:{type:'agent'},headers:{},query:{}},res,()=>{})}catch(e){if(e.message!=='SYNTHETIC_STORAGE_BOUNDARY')throw e}
 const expected=origin==='ordinary'||origin===null;const pass=(reads===1)===expected;results.push({surface:'attachment',origin,expectedAllow:expected,storageReached:reads===1,privacyCalls,pass});if(!pass)failed++;
 privacyCalls=0;const allow=await mod.exports.canActorReadAssetContent(db,{type:'agent',companyId:company,agentId:'synthetic'},{id:'synthetic',companyId:company,objectKey:company+'/assets/companies/synthetic',createdByAgentId:'synthetic',createdByUserId:null});
 const assetPass=allow===expected;results.push({surface:'asset',origin,expectedAllow:expected,allowed:allow,privacyCalls,pass:assetPass});if(!assetPass)failed++;
 }
 // Projection-aware mixed attachment references: all attached provenance must pass.
 origins=['ordinary',...incident];const allow=await mod.exports.canActorReadAssetContent(db,{type:'agent',companyId:company},{id:'synthetic',companyId:company,objectKey:company+'/assets/companies/synthetic'});results.push({surface:'asset-mixed-incidents',allowed:allow,pass:!allow});if(allow)failed++;
 console.log(JSON.stringify({checks:results.length,failures:failed,results,sourceOnly:true,actualArtifactMapping:false},null,2));process.exitCode=failed?1:0;
})();
