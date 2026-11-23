const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const esbuild=require(process.env.CONTAINMENT_ESBUILD_MODULE || 'esbuild');
const root=path.resolve(process.argv[2] || '.');
const company='0000000a-0000-4000-8000-00000000000a', incidents=['0000000b-0000-4000-8000-00000000000b','0000000c-0000-4000-8000-00000000000c'];
// Execute the exact predicate already independently qualified; synthetic actor/data only.
const auth=fs.readFileSync(path.join(root,'server/src/agent-auth-jwt.ts'),'utf8');
const a=auth.indexOf('export function isRestrictedIncidentRunOutput('),b=auth.indexOf('\nexport function isRevokedIncidentRunAuthority',a);
const src=fs.readFileSync(path.join(root,'server/src/routes/activity.ts'),'utf8');
const start=src.indexOf('  router.get("/issues/:id/runs"'),end=src.indexOf('  router.get("/issues/:id/context-usage"',start);
if(a<0||b<a||start<0||end<start)throw Error('Source boundary mismatch');
const mod={exports:{}},sandbox={exports:mod.exports,module:mod};vm.runInNewContext(esbuild.transformSync(auth.slice(a,b),{loader:'ts',format:'cjs'}).code,sandbox);
let handler,currentCompany=company,issueAllowed=true,calls=[];
const fixtureRows=()=>[...incidents.map(runId=>({runId,resultJson:{stopReason:'SYNTHETIC_OUTPUT_MARKER'},nextAction:'SYNTHETIC_OUTPUT_MARKER'})),{runId:'ordinary',resultJson:{stopReason:'ordinary fixture'}}];
const zchain={array:()=>zchain,string:()=>zchain,uuid:()=>zchain,min:()=>zchain,max:()=>zchain,safeParse:x=>({success:true,data:x})};
const ctx={router:{get:(p,h)=>handler=h},getAccessibleResource:async(req,res,p)=>await p,resolveIssueByRef:async()=>({id:'fixture-issue',companyId:currentCompany}),assertIssueReadAllowed:async()=>issueAllowed,getActorInfo:()=>({actorId:'fixture-board'}),z:zchain,badRequest:x=>Error(x),isRestrictedIncidentRunOutput:mod.exports.isRestrictedIncidentRunOutput,svc:{runsForIssue:async(...args)=>{calls.push(args);return fixtureRows()}}};
vm.runInNewContext(esbuild.transformSync(src.slice(start,end),{loader:'ts',format:'cjs'}).code,ctx);
(async()=>{const checks=[];for(const actor of [{type:'agent',agentId:'fixture-reader'},{type:'board',userId:'fixture-human'}])for(const query of [{},{view:'recent'},{runIds:incidents.join(',')}]){
 currentCompany=company;issueAllowed=true;calls=[];let output;await handler({params:{id:'fixture-issue'},actor,query},{json:x=>output=x});
 checks.push({actor:actor.type,branch:query.view||('runIds'in query?'runIds':'all'),returned:output.map(x=>x.runId),pass:output.length===1&&output[0].runId==='ordinary'&&!JSON.stringify(output).includes('SYNTHETIC_OUTPUT_MARKER')});
 }
 currentCompany='other-company';let output;await handler({params:{id:'fixture-issue'},actor:{type:'agent'},query:{}},{json:x=>output=x});checks.push({case:'company-specific restriction',pass:output.length===3});
 issueAllowed=false;calls=[];output=undefined;await handler({params:{id:'fixture-issue'},actor:{type:'agent'},query:{}},{json:x=>output=x});checks.push({case:'issue denial precedes service',pass:calls.length===0&&output===undefined});
 const result={checks,passed:checks.filter(x=>x.pass).length,total:checks.length,sourceSha256:crypto.createHash('sha256').update(src).digest('hex'),syntheticOnly:true,liveHttp:false,actualIncidentContentRead:false};console.log(JSON.stringify(result,null,2));if(result.passed!==result.total)process.exitCode=1;
})();
