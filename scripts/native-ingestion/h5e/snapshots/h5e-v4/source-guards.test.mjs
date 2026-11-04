import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const helperRoot=process.env.PROVENANCE_HELPER_ROOT ?? import.meta.dirname;
const main=await import(path.join(helperRoot,'native-ingestion-run-h5e-browser.mjs'));
const dependency=await import(path.join(helperRoot,'native-ingestion-h5c-cf-build-guards.mjs'));
import * as companion from './native-ingestion-run-blocked-stop-v4.mjs';

const root=import.meta.dirname,hash=b=>createHash('sha256').update(b).digest('hex');
const mainSource=await readFile(path.join(root,'native-ingestion-run-h5e-browser.mjs'),'utf8');
const composition=JSON.parse(await readFile(path.join(root,'composition.json'),'utf8'));
const buildRoot='/private/tmp/native-ingestion-evidence-cf/builds';
const descriptors=JSON.parse(await readFile('/private/tmp/native-ingestion-cf-build-descriptors.json','utf8'));
const localDescriptor=variant=>{
 const b=descriptors.builds[variant];return {...b,qualifiedInventorySummaryReference:b.inventorySummaryFile,
  qualifiedReceiptFile:path.join(buildRoot,'aligned-cf-builds-qualified.json'),
  inventorySummaryFile:path.join(buildRoot,'evidence/aligned-cf/environment/artifact-inventory-summary.json'),
  manifestFile:path.join(buildRoot,'evidence/aligned-cf/environment',path.basename(b.manifestFile))};
};

test('every clone equals its immutable parent plus the exact declared review changes',async()=>{
 for(const row of composition.clones){
  let value=await readFile(row.parent,'utf8');assert.equal(hash(Buffer.from(value)),row.parentSha256);
  for(const change of row.replacements){assert.equal(value.split(change.old).length-1,change.count);value=value.replaceAll(change.old,change.new);}
  const bytes=await readFile(path.join(root,row.file));assert.equal(bytes.toString('utf8'),value);assert.equal(hash(bytes),row.sha256);
 }
});

test('the dependency exposes exactly six checked functions and no main stage entry',()=>{
 assert.deepEqual(Object.keys(dependency).sort(),['assertNoPreferredUiShadow','physicalQuietGuard','sealArmArtifacts','validateActualInventory','validateVariantBuild','verifyRawArtifactSeals'].sort());
 assert.ok(Object.values(dependency).every(value=>typeof value==='function'));
});

for(const [name,helper]of [['main',main],['dependency',dependency]])for(const variant of ['B0','B1'])test(`${name} accepts the actual locally sealed CF ${variant} metadata`,async()=>{
 const q=await helper.validateVariantBuild(variant,localDescriptor(variant));
 assert.equal(q.receipt.binarySha256,descriptors.builds[variant].binarySha256);
 assert.equal(q.receipt.rustSourceTree,descriptors.builds[variant].rustSourceTree);
 assert.equal(q.manifest.revision,descriptors.builds[variant].revision);
});

for(const [name,helper]of [['main',main],['dependency',dependency]])test(`${name} rejects mixed revision, receipt and inventory metadata`,async()=>{
 await assert.rejects(helper.validateVariantBuild('B0',{...localDescriptor('B0'),revision:'f'.repeat(40)}),/qualified receipt revision mismatch/);
 await assert.rejects(helper.validateVariantBuild('B0',{...localDescriptor('B0'),qualifiedReceiptSha256:'a1259ba760f3cbbe44817e333f9f620bcf3769fb0a6c16f9ce2f0f5b2ed60d94'}),/bytes changed/);
 await assert.rejects(helper.validateVariantBuild('B0',{...localDescriptor('B0'),manifestFile:localDescriptor('B1').manifestFile,manifestFileSha256:localDescriptor('B1').manifestFileSha256}),/strictly equal/);
});

// Native provenance fixture tests are defined in native-provenance.test.mjs.

const cwd='/fixture-only/cf-app',node='/fixture-only/bin/node',environment={PATH:'/fixture-only/bin'};
const names=['node','pnpm','postgres','chromium','rustc','cargo'];
const runtimeChecks=Object.fromEntries(names.map(name=>[name,{executable:'/fixture-only/bin/'+name,args:[name==='rustc'||name==='cargo'?'-vV':'--version'],expected:({node:'v26.4.0',pnpm:'9.15.4'})[name]??'fixture-version-'+name}]));
function mockRuntime({wrongOutput,wrongPathNode=false}={}){
 const calls=[];return{calls,options:{currentExecutable:node,resolve:async value=>value,run:(file,args,options)=>{
  calls.push({file,args,options});
  if(file==='node')return JSON.stringify({executable:wrongPathNode?'/fixture-only/wrong-node':node,version:'v26.4.0',cwd});
  const name=names.find(name=>runtimeChecks[name].executable===file);assert.ok(name);
  assert.equal(options.cwd,cwd);assert.equal(options.env.PATH,environment.PATH);assert.equal(options.timeout,10000);
  return name===wrongOutput?'unexpected-version-'+name:runtimeChecks[name].expected;
 }}};
}

// Exercise the actual browserRun consumer with injected filesystem, port,
// process and application-launch seams. No application or OS process starts.
const browserRunSource=mainSource.slice(mainSource.indexOf('async function browserRun('),mainSource.indexOf('\nfunction comparatorArgs('));
assert.ok(browserRunSource.startsWith('async function browserRun('));
function consumer(checks,options={}){
 const runtime=mockRuntime(options),state={launches:0,saves:[],launchEnvironment:undefined},endAfterLaunch=new Error('fixture-only end after mock launch');
 const context={release:{runtimeChecks:checks,harnessRoot:'/fixture-only/harness',perVariantBuilds:{B0:{appRoot:cwd}}},out:'/fixture-only/evidence'};
 const actualConsumer=vm.runInNewContext(browserRunSource+'\nbrowserRun',{
  assert,path,MODE:main.MODE,process:{env:environment,execPath:node},mkdir:async()=>{},physicalQuietGuard:async()=>{},freePort:async()=>12345,
  checkFrozen:async(context,variant)=>({runtimeChecks:await main.validateRuntimeChecks(context.release.runtimeChecks,context.release.perVariantBuilds[variant].appRoot,environment,runtime.options)}),
  assertPathNode:(env,approved,directory)=>main.assertPathNode(env,approved,directory,runtime.options),
  saveJson:async(file,value)=>state.saves.push({file,value:JSON.parse(JSON.stringify(value))}),
  execute:async(_context,step)=>{state.launches++;state.launchEnvironment=step.launchEnvironment;throw endAfterLaunch;},
  armSidecar:async()=>{throw new Error('fixture-only no sidecar after mock stop');},extractEvidence:async()=>{throw new Error('fixture-only no evidence');},assertPortReleased:async()=>{},console,
 });
 return{state,calls:runtime.calls,endAfterLaunch,run:()=>actualConsumer(context,'fixture-only-arm','B0')};
}

test('main checkFrozen consumes the six-runtime guard and keeps the ten sealed artifact files',async()=>{
 const start=mainSource.indexOf('async function checkFrozen('),end=mainSource.indexOf('\nasync function execute(',start),body=mainSource.slice(start,end);
 assert.match(body,/await validateRuntimeChecks\(release\.runtimeChecks, release\.perVariantBuilds\[runtimeVariant\]\.appRoot, process\.env\)/);
 assert.match(body,/actualInventories, runtimeChecks/);
 const old=await readFile('/private/tmp/native-ingestion-run-h5d-browser.mjs','utf8');
 const block=source=>source.slice(source.indexOf('async function armArtifactFiles('),source.indexOf('\nexport async function sealArmArtifacts('));
 assert.equal(block(mainSource),block(old),'Runtime evidence stays inside the existing pre-arm receipt; the ten-file artifact set is unchanged');
});

test('all six valid outputs pass before the actual main consumer reaches only its injected launch seam',async()=>{
 const c=consumer(runtimeChecks);await assert.rejects(c.run(),error=>error===c.endAfterLaunch);
 assert.equal(c.state.launches,1);assert.equal(c.state.launchEnvironment.PATH,environment.PATH);
 const receipt=c.state.saves.find(row=>row.file.endsWith('/pre-arm-inventory-check.json')).value;
 assert.equal(receipt.runtimeChecks.passed,true);assert.deepEqual(Object.keys(receipt.runtimeChecks.checks),names);
 for(const name of names){const r=receipt.runtimeChecks.checks[name];assert.equal(r.actual,runtimeChecks[name].expected);assert.equal(r.approvedExecutable,runtimeChecks[name].executable);assert.equal(r.cwd,cwd);}
 assert.equal(receipt.runtimeChecks.PATH,environment.PATH);
});
for(const name of names)test(`missing ${name} blocks the actual main consumer before its launch seam`,async()=>{
 const checks=structuredClone(runtimeChecks);delete checks[name];const c=consumer(checks);
 await assert.rejects(c.run(),error=>{assert.equal(error.runtimePreflight.passed,false);return /exactly the six approved labels/.test(error.message);});
 assert.equal(c.state.launches,0);assert.equal(c.calls.length,0);assert.equal(c.state.saves.length,0);
});
for(const name of names)test(`changed ${name} output blocks the actual main consumer before its launch seam`,async()=>{
 const c=consumer(runtimeChecks,{wrongOutput:name});
 await assert.rejects(c.run(),error=>{assert.equal(error.runtimePreflight.passed,false);assert.equal(error.runtimePreflight.checks[name].actual,'unexpected-version-'+name);return error.message.includes('Runtime '+name+' output differs');});
 assert.equal(c.state.launches,0);assert.equal(c.state.saves.length,0);
});
test('a PATH-selected Node different from the approved runtime blocks all version commands and launch',async()=>{
 const c=consumer(runtimeChecks,{wrongPathNode:true});await assert.rejects(c.run(),/PATH node executable differs from approved runtime/);
 assert.equal(c.state.launches,0);assert.equal(c.calls.length,1);assert.equal(c.calls[0].file,'node');
});
for(const [name,mutate]of [
 ['extra runtime label',checks=>{checks.python=checks.node;}],
 ['relative executable',checks=>{checks.postgres.executable='postgres';}],
 ['missing argument list',checks=>{checks.cargo.args=[];}],
 ['missing expected output',checks=>{checks.chromium.expected='';}],
])test(`${name} fails before any runtime command or application launch`,async()=>{
 const checks=structuredClone(runtimeChecks);mutate(checks);const c=consumer(checks);await assert.rejects(c.run());assert.equal(c.state.launches,0);assert.equal(c.calls.length,0);
});

test('fixed main and companion stage order is unchanged and V4 accepts only its new frozen revision',async()=>{
 const oldMain=await import('/private/tmp/native-ingestion-run-h5d-browser.mjs');
 assert.deepEqual(main.STAGES,oldMain.STAGES);
 for(const stage of [...main.STAGES,main.FINALIZE_STAGE])assert.deepEqual(main.stagePlan(stage),oldMain.stagePlan(stage));
 const p=await import('/private/tmp/paperclip-native-event-blocked-stop-v4/tests/e2e/fixtures/native-ingestion-blocked-stop-protocol.mjs');
 for(const stage of companion.STAGES)assert.equal(companion.schedule(stage,p.registration()).length,stage==='qualification-b0'?1:10);
 companion.assertCompanionRevision('a89f321ab5654211cbff7be1ee15c110b8db4a5f');
 assert.throws(()=>companion.assertCompanionRevision('bc33f09cae26404352848169d92a20c89480a5f5'));
});

test('V4 preserves eight inherited main files and only replaces the two baseline literals in the ninth',async()=>{
 const repo='/private/tmp/paperclip-native-event-blocked-stop-v4',inherited='e431ec63d41fe90c6fd68bd2fc2bb969feeca917';
 const mainFiles=['native-event-ingestion.journey.ts','playwright-native-ingestion.config.ts','fixtures/in-feed-codex.mjs','fixtures/native-ingestion-bin/codex','fixtures/composer-stop-codex-loader.mjs','fixtures/native-ingestion-bootstrap.mjs','fixtures/native-ingestion-remote-server.mjs','fixtures/native-ingestion-protocol-qualification.mjs','fixtures/native-ingestion-h5.mjs'];
 for(const file of mainFiles){let before=execFileSync('git',['show',inherited+':tests/e2e/'+file],{cwd:repo});
  if(file==='fixtures/native-ingestion-h5.mjs')before=Buffer.from(before.toString().replace('bac53ec3bfeaf6546e7aaeaee516487b30534654',descriptors.builds.B0.revision).replace('07061a601cdc20603c8c7a46f9ddbad7ac5f5939',descriptors.builds.B1.revision));
  assert.deepEqual(await readFile(path.join(repo,'tests/e2e',file)),before);
 }
 const release=JSON.parse(await readFile(path.join(root,'templates/companion-v4-qualification-b0.unauthorized.json'),'utf8'));
 const changed=execFileSync('git',['diff','--name-only',inherited,release.harnessRevision],{cwd:repo,encoding:'utf8'}).trim().split('\n').sort();
 assert.deepEqual(changed,Object.keys(release.companionFiles).map(file=>'tests/e2e/'+file).sort());assert.equal(changed.length,11);
});

test('all prepared templates remain unauthorized and neither main nor companion can load them as a release',async()=>{
 const file=path.join(root,'templates/main-aa-b0.unauthorized.json'),r=JSON.parse(await readFile(file,'utf8'));
 assert.equal(r.authorized,false);assert.equal(r.prerequisiteEvidence.smallReportSha256,null);
 await assert.rejects(main.loadRelease(file,r.stage,r.outputRoot),/not authorized/);
 const cf=path.join(root,'templates/companion-v4-qualification-b0.unauthorized.json'),bytes=await readFile(cf),c=JSON.parse(bytes);
 assert.equal(c.authorized,false);await assert.rejects(companion.load(cf,hash(bytes),c.stage,c.outputRoot));
});
