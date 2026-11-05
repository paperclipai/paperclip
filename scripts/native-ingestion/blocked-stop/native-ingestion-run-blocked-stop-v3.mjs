// DRAFT: no execution is released by this source. Default invocation is a dry run.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, open, realpath, lstat } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const SELF=fileURLToPath(import.meta.url), H5SHA='6b6376b01de6cdc15ca05343a0bdd5c00424f1d6c546b9b4d61cd76716b253c4';
const COMPANION_REVISION='bc33f09cae26404352848169d92a20c89480a5f5';
const INHERITED='e431ec63d41fe90c6fd68bd2fc2bb969feeca917', LOCK='54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8';
const H5MEASUREMENT='2265aabe9c7344f5d4b9c8b08a5c6bbd5571a6e2de9ae7b72a8d1733250e609f';
export const STAGES=['qualification-b0','b0-aa','b1-aa','b0-b1','b1-b2','b0-b2'];
const CORE=['native-event-ingestion-blocked-stop.journey.ts','playwright-native-ingestion-blocked-stop.config.ts',
 'fixtures/native-ingestion-blocked-stop-authority.ts','fixtures/native-ingestion-blocked-stop-clock.ts','fixtures/native-ingestion-blocked-stop-db.ts','fixtures/native-ingestion-blocked-stop-protocol.mjs'];
const COMPANION=[...CORE,'fixtures/native-ingestion-blocked-stop-protocol.test.mjs','fixtures/native-ingestion-blocked-stop-validate.mjs','fixtures/native-ingestion-blocked-stop.md'];
const H5=['native-event-ingestion.journey.ts','playwright-native-ingestion.config.ts','fixtures/in-feed-codex.mjs','fixtures/native-ingestion-bin/codex',
 'fixtures/composer-stop-codex-loader.mjs','fixtures/native-ingestion-bootstrap.mjs','fixtures/native-ingestion-remote-server.mjs','fixtures/native-ingestion-protocol-qualification.mjs','fixtures/native-ingestion-h5.mjs'];
const CONFIG='tests/e2e/playwright-native-ingestion-blocked-stop.config.ts', SCHEMA='paperclip.native-ingestion.blocked-stop-series.v1';
const AMBIENT=['DATABASE_URL','PAPERCLIP_RUNNER_STATE_DIR','PAPERCLIP_INGESTION_SERVER_COMMAND','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR',
 'PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR','PAPERCLIP_INGESTION_BROWSER_CAPTURE','NODE_OPTIONS',
 'PAPERCLIP_INGESTION_SMOKE','PAPERCLIP_INGESTION_OBSERVATION_MODE'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'), json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const option=name=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const absolute=value=>assert.ok(typeof value==='string'&&path.isAbsolute(value),'An absolute path is required');
const sha=value=>assert.match(value??'',/^[a-f0-9]{64}$/), revision=value=>assert.match(value??'',/^[a-f0-9]{40}$/);
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
export async function pinned(file,expected){absolute(file);sha(expected);const bytes=await readFile(file);assert.equal(hash(bytes),expected);return bytes;}
export function schedule(stage,registered){
 assert.ok(STAGES.includes(stage));if(stage==='qualification-b0')return [{stage,pair:0,index:0,variant:'b0',role:'qualification'}];
 const rows=registered.filter(row=>row.stage===stage);assert.equal(rows.length,10);
 const [a,b]=stage==='b0-aa'?['b0','b0']:stage==='b1-aa'?['b1','b1']:stage.split('-');
 for(let pair=1;pair<=5;pair++)for(let index=0;index<2;index++){
  const row=rows[(pair-1)*2+index],role=(pair%2===1?index===0:index===1)?'baseline':'candidate';
  assert.deepEqual(row,{stage,pair,index,variant:role==='baseline'?a:b,role});
 }return rows;
}
export function assertCompanionRevision(value){assert.equal(value,COMPANION_REVISION,'Use the exact frozen companionv3 revision');}
async function source(context){
 const {r}=context;assertCompanionRevision(r.harnessRevision);await pinned(context.releaseFile,context.releaseSha256);await pinned(SELF,r.orchestratorSha256);await pinned(r.h5HelperFile,H5SHA);
 assert.equal(git(r.harnessRoot,'rev-parse','HEAD'),r.harnessRevision);assert.equal(git(r.harnessRoot,'status','--short'),'');
 execFileSync('git',['merge-base','--is-ancestor',INHERITED,r.harnessRevision],{cwd:r.harnessRoot});
 assert.deepEqual(git(r.harnessRoot,'diff','--name-only',INHERITED,r.harnessRevision).split('\n').sort(),COMPANION.map(f=>'tests/e2e/'+f).sort());
 assert.equal(hash(await readFile(path.join(r.harnessRoot,'pnpm-lock.yaml'))),LOCK);
 assert.equal((await lstat(path.join(r.harnessRoot,'node_modules'))).isSymbolicLink(),false);
 assert.deepEqual(Object.keys(r.companionFiles).sort(),[...COMPANION].sort());
 for(const [file,digest]of Object.entries(r.companionFiles))await pinned(path.join(r.harnessRoot,'tests/e2e',file),digest);
 assert.equal(hash(Buffer.concat(await Promise.all(H5.map(f=>readFile(path.join(r.harnessRoot,'tests/e2e',f)))))),H5MEASUREMENT);
}
export async function load(releaseFile,expectedSha,stage,out){
 absolute(out);const bytes=await pinned(releaseFile,expectedSha),r=JSON.parse(bytes);revision(r.harnessRevision);assertCompanionRevision(r.harnessRevision);
 assert.equal(r.authorized,true);assert.equal(r.stage,stage);assert.equal(r.outputRoot,out);assert.equal(r.h5HelperSha256,H5SHA);
 assert.equal(r.resourceWatchdogMillis,1800000);assert.equal(r.inheritedH5cRevision,INHERITED);assert.equal(r.lockSha256,LOCK);
 assert.equal(r.runtimeChecks?.node?.expected,'v26.4.0');assert.equal(r.runtimeChecks?.pnpm?.expected,'9.15.4');
 const context={r,out,releaseFile,releaseSha256:hash(bytes)};await source(context);
 const h=await import(pathToFileURL(r.h5HelperFile).href),p=await import(pathToFileURL(path.join(r.harnessRoot,'tests/e2e/fixtures/native-ingestion-blocked-stop-protocol.mjs')).href);
 assert.equal(p.PROTOCOL,'blocked-stop-history-v1');assert.equal(p.WORKLOAD_SHA256,r.workloadSha256);sha(r.precisionRuleSha256);assert.equal(p.PRECISION_RULE_SHA256,r.precisionRuleSha256);
 assert.equal(typeof p.assertNoiseEnvelope,'function');context.h=h;context.p=p;context.rows=schedule(stage,p.registration());
 const needed=STAGES.indexOf(stage)<2?['B0']:STAGES.indexOf(stage)<4?['B0','B1']:['B0','B1','B2'];
 for(const variant of needed)await h.validateVariantBuild(variant,r.perVariantBuilds?.[variant]);
 return context;
}
async function runtime(r){
 assert.equal(process.version,'v26.4.0');const values={};
 assert.deepEqual(Object.keys(r.runtimeChecks).sort(),['cargo','chromium','node','pnpm','postgres','rustc']);
 for(const [name,check]of Object.entries(r.runtimeChecks)){
  absolute(check.executable);assert.ok(Array.isArray(check.args)&&check.args.every(v=>typeof v==='string'));assert.ok(check.expected);
  const actual=execFileSync(check.executable,check.args,{encoding:'utf8',timeout:10000}).trim();assert.equal(actual,check.expected);values[name]={...check,actual};
 }assert.equal(await realpath(r.runtimeChecks.node.executable),await realpath(process.execPath));return values;
}
export async function assertPathNode(environment,approvedExecutable,workingDirectory){
 absolute(workingDirectory);
 const actual=JSON.parse(execFileSync('node',['-p','JSON.stringify({executable:process.execPath,version:process.version})'],{env:environment,cwd:workingDirectory,encoding:'utf8',timeout:10000}));
 assert.equal(actual.version,'v26.4.0','PATH node version differs from approved runtime');
 const canonicalExecutable=await realpath(actual.executable),approvedCanonicalExecutable=await realpath(approvedExecutable);
 assert.equal(canonicalExecutable,approvedCanonicalExecutable,'PATH node executable differs from approved runtime');
 assert.equal(approvedCanonicalExecutable,await realpath(process.execPath),'Approved node differs from orchestrator runtime');
 return {...actual,canonicalExecutable,approvedCanonicalExecutable,PATH:environment.PATH,cwd:workingDirectory,canonicalCwd:await realpath(workingDirectory)};
}
async function buildCheck(context,variant){
 const b=context.r.perVariantBuilds[variant],q=await context.h.validateVariantBuild(variant,b);
 assert.equal(git(b.appRoot,'rev-parse','HEAD'),b.revision);assert.equal(git(b.appRoot,'status','--short'),'');
 assert.equal((await json(path.join(b.appRoot,'server/dist/build-info.json'))).commit,b.revision);
 const target=await realpath(path.join(b.appRoot,'packages/paperclip-runner/runner/target')),binary=path.join(target,'release/paperclip-runnerd');
 assert.equal(target,q.receipt.nativeStageHashes.find(row=>row.variant===variant).targetRealPath);
 assert.equal(await realpath(path.join(b.appRoot,'packages/paperclip-runner/runner/target/release/paperclip-runnerd')),binary);await pinned(binary,b.binarySha256);
 for(const [file,object]of Object.entries(q.receipt.rustInputObjects))assert.equal(git(b.appRoot,'rev-parse',`${b.revision}:packages/paperclip-runner/${file}`),object);
 return {qualified:q,live:await context.h.validateActualInventory(b,q.manifest),ui:await context.h.assertNoPreferredUiShadow(b.appRoot),binary};
}
async function portProbe(port=0){
 const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 const actual=server.address().port;await new Promise(resolve=>server.close(resolve));return actual;
}
async function launch(context,directory,env,launchEnvironment){
 const record={startedAtMs:Date.now(),executable:process.execPath,args:['node_modules/@playwright/test/cli.js','test','--config',CONFIG],cwd:context.r.harnessRoot,environmentOverrides:env,resourceWatchdogMillis:1800000};
 const stream=(await open(path.join(directory,'playwright.log'),'wx')).createWriteStream(),child=spawn(record.executable,record.args,{cwd:record.cwd,env:launchEnvironment,stdio:['ignore','pipe','pipe']});
 record.childPid=child.pid;child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});let force;
 const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
 const timer=setTimeout(()=>{record.watchdogExpired=true;child.kill('SIGTERM');force=setTimeout(()=>{record.forcedDriverKill=true;child.kill('SIGKILL');},30000);},1800000);
 try{Object.assign(record,await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}));}
 catch(error){record.launchError=String(error);throw error;}finally{
  clearTimeout(timer);clearTimeout(force);process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);await new Promise(resolve=>stream.end(resolve));
  record.finishedAtMs=Date.now();record.logSha256=hash(await readFile(path.join(directory,'playwright.log')));await save(path.join(directory,'command.json'),record);
 }return record;
}
export async function owningEvidence(directory){
 const bytes=await readFile(path.join(directory,'playwright.json')),report=JSON.parse(bytes),tests=[];
 function visit(value){if(Array.isArray(value))for(const child of value)visit(child);else if(value&&typeof value==='object'){
  if(Array.isArray(value.results)&&Object.hasOwn(value,'expectedStatus'))tests.push(value);for(const [key,child]of Object.entries(value))if(key!=='results')visit(child);
 }}visit(report);assert.deepEqual(report.errors??[],[]);assert.equal(tests.length,1);const test=tests[0];assert.equal(test.expectedStatus,'passed');assert.equal(test.timeout,900000);assert.equal(test.results.length,1);
 const result=test.results[0];assert.equal(result.status,'passed');assert.equal(result.retry,0);assert.deepEqual(result.errors??[],[]);assert.ok(!result.error);
 assert.ok(Number.isFinite(report.stats?.duration)&&report.stats.duration>=0&&report.stats.duration<=900000,'Owning invocation exceeded original900s');
 assert.ok(Number.isFinite(Date.parse(result.startTime))&&Number.isFinite(result.duration)&&result.duration>=0&&result.duration<=900000,'Missing owning attempt timing');
 const attachments=result.attachments.filter(a=>a.name==='native-ingestion-blocked-stop-evidence');assert.equal(attachments.length,1);
 let attached;if(attachments[0].body)attached=Buffer.from(attachments[0].body,'base64');else{
  const target=await realpath(path.resolve(directory,attachments[0].path));assert.ok(target.startsWith((await realpath(directory))+path.sep),'Attachment escapes owning output');attached=await readFile(target);
 }
 return {bytes:attached,evidence:JSON.parse(attached),reportSha256:hash(bytes),owner:{startTime:result.startTime,durationMs:result.duration,status:result.status,retry:result.retry}};
}
export async function verifyQuietReceipts(directory){
 for(const phase of ['pre-arm','post-arm']){
  const q=await json(path.join(directory,phase==='pre-arm'?'physical-quiet-pre.json':'physical-quiet-post.json'));
  assert.equal(q.schema,'paperclip.native-ingestion.physical-quiet.v1');assert.equal(q.platform,'linux');assert.equal(q.phase,phase);assert.equal(q.passed,true);
  assert.equal(q.zombiePolicy,'Strict: matched zombie/dead rows remain blockers until absent; no automatic killing or silent zombie exclusion.');
  assert.ok(q.observations?.length>0);assert.deepEqual(q.observations.at(-1).blockers,[]);
 }
}
async function readArm(context,arm,expectedReleaseSha256=context.releaseSha256){
 const {r,p}=context,directory=path.dirname(arm.file),attached=await owningEvidence(directory),raw=await readFile(arm.file);assert.equal(hash(raw),hash(attached.bytes));await verifyQuietReceipts(directory);
 const preflight=await json(path.join(directory,'pre-arm-inventory-check.json')),port=await json(path.join(directory,'physical-http-port-check.json'));
 assert.equal(preflight.releaseSha256,expectedReleaseSha256);assert.equal(preflight.variant,arm.variant);assert.equal(port.nodeBindAndListenPassed,true);
 const e=attached.evidence,b=r.perVariantBuilds[arm.variant],sidecar=await json(arm.inventoryFile);p.assertFunctional(e);
 assert.equal(e.variant,arm.variant);assert.equal(e.sourceRevision,b.revision);assert.equal(e.buildInfo.commit,b.revision);
 assert.equal(e.serverEntrySha256,(await context.h.validateVariantBuild(arm.variant,b)).manifest.files.find(v=>v.path==='server/dist/index.js').sha256);
 assert.deepEqual(e.harnessProvenance,{sourceRevision:r.harnessRevision,sourceStatus:'',driverLockSha256:LOCK,inheritedH5cRevision:INHERITED});
 const expected={};for(const f of [...CORE,...H5])expected[f]=hash(await readFile(path.join(r.harnessRoot,'tests/e2e',f)));assert.deepEqual(e.sourceHashes,expected);
 assert.equal(sidecar.variant,arm.variant);assert.equal(sidecar.sourceRevision,b.revision);assert.equal(sidecar.compiledBuildRevision,b.revision);assert.equal(sidecar.playwrightReportSha256,attached.reportSha256);
 for(const [key,digest]of [['manifestFile','manifestFileSha256'],['inventorySummaryFile','inventorySummarySha256'],['qualifiedReceiptFile','qualifiedReceiptSha256']]){
  assert.equal(sidecar[digest],b[digest]);assert.equal(sidecar[key],path.join('inventory',path.basename(b[key])));await pinned(path.resolve(directory,sidecar[key]),b[digest]);
 }assert.equal(sidecar.aggregateSha256,b.aggregateSha256);assert.equal(sidecar.command.code,0);assert.equal(sidecar.command.signal,null);assert.equal(sidecar.command.watchdogExpired,undefined);
 assert.ok(e.startedAtMs>=sidecar.command.startedAtMs&&e.finishedAtMs<=sidecar.command.finishedAtMs,'Raw proof must belong inside its owning command');
 assert.equal(await realpath(sidecar.command.executable),await realpath(r.runtimeChecks.node.executable));
 assert.equal(preflight.pathNode.version,'v26.4.0');assert.equal(preflight.pathNode.PATH,sidecar.command.environmentOverrides.PATH);
 assert.equal(preflight.pathNode.cwd,b.appRoot);assert.equal(preflight.pathNode.canonicalCwd,await realpath(b.appRoot));
 assert.equal(preflight.pathNode.canonicalExecutable,await realpath(r.runtimeChecks.node.executable));assert.equal(preflight.pathNode.approvedCanonicalExecutable,preflight.pathNode.canonicalExecutable);
 assert.deepEqual(sidecar.command.args,['node_modules/@playwright/test/cli.js','test','--config',CONFIG]);assert.equal(sidecar.command.cwd,r.harnessRoot);assert.equal(sidecar.command.resourceWatchdogMillis,1800000);
 assert.equal(sidecar.command.environmentOverrides.PAPERCLIP_INGESTION_APP_ROOT,b.appRoot);assert.equal(sidecar.command.environmentOverrides.PAPERCLIP_INGESTION_VARIANT,arm.variant);
 assert.equal(sidecar.command.environmentOverrides.PAPERCLIP_INGESTION_EVIDENCE_DIR,directory);assert.equal(Number(sidecar.command.environmentOverrides.PAPERCLIP_E2E_PORT),port.port);
 assert.equal(hash(await readFile(path.join(directory,'playwright.log'))),sidecar.command.logSha256);return e;
}
async function arm(context,row,stageDirectory){
 const {r,h}=context,variant=row.variant.toUpperCase(),label=`${row.stage}-pair${row.pair}-${row.index}-${row.role}-${variant}`,directory=path.join(stageDirectory,label);await mkdir(directory);
 await source(context);for(const key of AMBIENT)assert.ok(!process.env[key],`Ambient override rejected:${key}`);
 const port=await portProbe(),env={PAPERCLIP_INGESTION_APP_ROOT:r.perVariantBuilds[variant].appRoot,PAPERCLIP_INGESTION_EVIDENCE_DIR:directory,
  PAPERCLIP_E2E_PORT:String(port),PAPERCLIP_INGESTION_TRANSPORT:'sandbox-remote-with-local-stop',PAPERCLIP_INGESTION_VARIANT:variant,
  PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES:'Independent frozen companiondriver; independent normal qualified appbuild'};
 await h.physicalQuietGuard({receiptFile:path.join(directory,'physical-quiet-pre.json'),phase:'pre-arm',armStage:label});
 const versions=await runtime(r),checked=await buildCheck(context,variant);env.PAPERCLIP_RUNNER_BINARY=checked.binary;env.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH=checked.binary;
 env.PATH=process.env.PATH;const launchEnvironment={...process.env,...env},pathNode=await assertPathNode(launchEnvironment,r.runtimeChecks.node.executable,r.perVariantBuilds[variant].appRoot);
 const discovery=execFileSync(process.execPath,['node_modules/@playwright/test/cli.js','test','--config',CONFIG,'--list'],{cwd:r.harnessRoot,env:launchEnvironment,encoding:'utf8',timeout:30000});
 assert.match(discovery,/Total: 1 test in 1 file/);assert.match(discovery,/native-event-ingestion-blocked-stop\.journey\.ts/);
 await save(path.join(directory,'pre-arm-inventory-check.json'),{releaseSha256:context.releaseSha256,variant,versions,pathNode,discovery,live:checked.live,ui:checked.ui,checkedAtMs:Date.now()});
 let command,failure;try{command=await launch(context,directory,env,launchEnvironment);assert.equal(command.code,0);assert.equal(command.signal,null);assert.equal(command.watchdogExpired,undefined);}catch(error){failure=error;}
 const cleanupFailures=[];
 try{await portProbe(port);await save(path.join(directory,'physical-http-port-check.json'),{port,nodeBindAndListenPassed:true,atMs:Date.now()});}
 catch(error){cleanupFailures.push({step:'port',error:String(error)});failure??=error;}
 try{await h.physicalQuietGuard({receiptFile:path.join(directory,'physical-quiet-post.json'),phase:'post-arm',armStage:label,primaryFailureAlreadyPresent:Boolean(failure)});}
 catch(error){cleanupFailures.push({step:'physical-quiet',error:String(error)});failure??=error;}
 if(cleanupFailures.length)await save(path.join(directory,'cleanup-failures.json'),cleanupFailures);if(failure)throw failure;
 const attached=await owningEvidence(directory),file=path.join(directory,'blocked-stop-evidence.json');await writeFile(file,attached.bytes,{flag:'wx'});
 const inventory=path.join(directory,'inventory');await mkdir(inventory);const b=r.perVariantBuilds[variant],copies={};
 for(const [key,digest]of [['manifestFile','manifestFileSha256'],['inventorySummaryFile','inventorySummarySha256'],['qualifiedReceiptFile','qualifiedReceiptSha256']]){
  const target=path.join(inventory,path.basename(b[key]));await writeFile(target,await pinned(b[key],b[digest]),{flag:'wx'});copies[key]=path.relative(directory,target);
 }const inventoryFile=path.join(directory,'arm-inventory.json');await save(inventoryFile,{schema:'paperclip.native-ingestion.arm-inventory.v1',variant,sourceRevision:b.revision,compiledBuildRevision:b.revision,
  playwrightReportSha256:attached.reportSha256,...copies,manifestFileSha256:b.manifestFileSha256,qualifiedReceiptSha256:b.qualifiedReceiptSha256,inventorySummarySha256:b.inventorySummarySha256,aggregateSha256:b.aggregateSha256,command});
 const result={...row,variant,label,file,playwrightFile:path.join(directory,'playwright.json'),inventoryFile};await readArm(context,result);result.artifacts=await h.sealArmArtifacts(context.out,result);return result;
}
function identity(context){const r=context.r;return {harnessRevision:r.harnessRevision,companionFiles:r.companionFiles,workloadSha256:r.workloadSha256,precisionRuleSha256:r.precisionRuleSha256,h5HelperSha256:H5SHA,orchestratorSha256:r.orchestratorSha256,runtimeChecks:r.runtimeChecks};}
function pairManifest(arms){return Array.from({length:5},(_,index)=>{
 const entry={pair:index+1};for(const role of ['baseline','candidate']){const arm=arms.find(a=>a.pair===index+1&&a.role===role);assert.ok(arm);
  for(const [suffix,key]of [['File','file'],['PlaywrightFile','playwrightFile'],['InventoryFile','inventoryFile'],['Artifacts','artifacts']])entry[role+suffix]=arm[key];
 }return entry;
});}
async function readSeries(context,stage,pin){
 assert.equal(pin.file,path.join(context.out,stage+'.json'));const report=JSON.parse(await pinned(pin.file,pin.sha256));assert.equal(report.schema,SCHEMA);assert.equal(report.stage,stage);assert.equal(report.complete,true);assert.equal(report.passed,true);assert.deepEqual(report.identity,identity(context));
 const ownerRelease=JSON.parse(await pinned(report.releaseFile,report.releaseSha256));assert.equal(ownerRelease.authorized,true);assert.equal(ownerRelease.stage,stage);assert.equal(ownerRelease.outputRoot,context.out);
 assert.equal(report.releaseFile,path.join(context.out,stage,'root-release.json'));assert.deepEqual(identity({r:ownerRelease}),report.identity);
 const expected=schedule(stage,context.p.registration());assert.equal(report.arms.length,expected.length);
 const raw=[];for(const [i,a]of report.arms.entries()){for(const k of ['stage','pair','index','role'])assert.equal(a[k],expected[i][k]);assert.equal(a.variant,expected[i].variant.toUpperCase());
  assert.deepEqual(await context.h.sealArmArtifacts(context.out,a),a.artifacts);raw.push(await readArm(context,a,report.releaseSha256));
 }if(stage!=='qualification-b0'){assert.deepEqual(report.pairManifest,pairManifest(report.arms));await context.h.verifyRawArtifactSeals(context.out,report.pairManifest);}
 if(stage.endsWith('-aa')){assert.equal(report.noiseFile,path.join(context.out,stage+'.noise.json'));
  assert.deepEqual(JSON.parse(await pinned(report.noiseFile,report.noiseSha256)),report.noise);
  assert.deepEqual(report.noise,context.p.noiseEnvelope(logicalPairs(report.arms,raw)));context.p.assertNoiseEnvelope(report.noise);
 }
 return {report,raw};
}
function logicalPairs(arms,raw){return Array.from({length:5},(_,i)=>['baseline','candidate'].map(role=>raw[arms.findIndex(a=>a.pair===i+1&&a.role===role)]));}
async function prerequisites(context){
 const index=STAGES.indexOf(context.r.stage),prior={},companies=new Set(),runs=new Set();let completed=0;
 for(const stage of STAGES.slice(0,index)){const value=await readSeries(context,stage,context.r.priorStageReports?.[stage]??{});assert.ok(value.report.completedAtMs>completed);completed=value.report.completedAtMs;prior[stage]=value.report;
  if(stage!=='qualification-b0'&&!stage.endsWith('-aa')){const noiseStage=stage.startsWith('b1')?'b1-aa':'b0-aa';
   const recomputed=context.p.comparePairs(logicalPairs(value.report.arms,value.raw),prior[noiseStage].noise);assert.deepEqual(value.report.comparison,recomputed);assert.ok(Object.values(recomputed).every(row=>row.pass));
  }for(const e of value.raw){assert.ok(!companies.has(e.companyId)&&!runs.has(e.runId),'An earlier arm was reused');companies.add(e.companyId);runs.add(e.runId);}
 }if(index>=3)for(const stage of ['b0-aa','b1-aa']){
  const pin=context.r.noiseReports?.[stage];assert.equal(pin?.file,prior[stage].noiseFile);assert.equal(pin?.sha256,prior[stage].noiseSha256);
  context.p.assertNoiseEnvelope(JSON.parse(await pinned(pin.file,pin.sha256)));
 }
 return {prior,companies,runs,lastCompletedAtMs:completed};
}
async function execute(context){
 const {r,h,p}=context,prior=await prerequisites(context),directory=path.join(context.out,r.stage);await mkdir(directory);await writeFile(path.join(directory,'root-release.json'),await pinned(context.releaseFile,context.releaseSha256),{flag:'wx'});
 const arms=[],raw=[];try{for(const row of context.rows){const a=await arm(context,row,directory),e=await readArm(context,a);
  assert.ok(!prior.companies.has(e.companyId)&&!prior.runs.has(e.runId),'Every arm needs a fresh company and run');prior.companies.add(e.companyId);prior.runs.add(e.runId);arms.push(a);raw.push(e);await save(path.join(directory,`arm${arms.length}-sealed.json`),a);
 }await source(context);let noise,comparison;const pairs=r.stage==='qualification-b0'?undefined:logicalPairs(arms,raw),manifest=pairs?pairManifest(arms):undefined;
 if(manifest)await h.verifyRawArtifactSeals(context.out,manifest);else assert.deepEqual(await h.sealArmArtifacts(context.out,arms[0]),arms[0].artifacts);
 if(r.stage.endsWith('-aa')){noise=p.noiseEnvelope(pairs);}else if(pairs){const baseline=r.stage.startsWith('b1')?'b1-aa':'b0-aa';comparison=p.comparePairs(pairs,prior.prior[baseline].noise);}
 let noiseFile,noiseSha256;if(noise){noiseFile=path.join(context.out,r.stage+'.noise.json');await save(noiseFile,noise);noiseSha256=hash(await readFile(noiseFile));}
 const passed=noise?noise.suitable&&noise.noiseFrozen:!comparison||Object.values(comparison).every(row=>row.pass),report={schema:SCHEMA,scope:'Separate blocked-write control qualification/nonregression only; not main application performance acceptance',stage:r.stage,
  identity:identity(context),releaseFile:path.join(directory,'root-release.json'),releaseSha256:context.releaseSha256,complete:true,passed,arms,pairManifest:manifest,noise,noiseFile,noiseSha256,comparison,completedAtMs:Date.now()};
 await save(path.join(context.out,r.stage+'.json'),report);if(noise)p.assertNoiseEnvelope(noise);assert.equal(passed,true,'Companion control nonregression failed');
 }catch(error){await save(path.join(directory,'failure.json'),{stage:r.stage,complete:false,error:String(error),stack:error.stack,completedArms:arms,atMs:Date.now()});throw error;}
}
async function main(){
 if(!process.argv.includes('--execute')&&!process.argv.includes('--validate-release')){console.log(JSON.stringify({draft:true,executionReleased:false,stages:STAGES,registeredTimingArms:50,qualificationArms:1,
  note:'Exact companion source/revision, calibration rules and runtime command outputs are not frozen by this draft. No candidate or qualification result is invented.',
  requiredReleaseFields:['authorized','stage','outputRoot','orchestratorSha256','h5HelperFile','h5HelperSha256','harnessRoot','harnessRevision','inheritedH5cRevision','lockSha256','companionFiles(9 exact SHA256)','workloadSha256','precisionRuleSha256','resourceWatchdogMillis:1800000','runtimeChecks(exact executable/args/expected for node26.4.0,pnpm9.15.4,postgres,chromium,rustc,cargo)','perVariantBuilds(actual qualified H5c-compatible descriptors)','priorStageReports(exact passed owner/raw/proof/seal reports by file/SHA256)','noiseReports(exact b0-aa and b1-aa noise JSON file/SHA256 pins before comparisons)' ]},null,2));return;}
 const c=await load(option('release'),option('release-sha256'),option('stage'),option('output-root'));await prerequisites(c);
 if(!process.argv.includes('--execute')){console.log(JSON.stringify({valid:true,sourceAndBindingsOnly:true,arms:c.rows.length,noRuntimeQualification:true}));return;}
 await mkdir(c.out,{recursive:true});await execute(c);
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)await main();
