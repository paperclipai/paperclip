import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,writeFile,mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const root=import.meta.dirname,helperRoot=process.env.PROVENANCE_HELPER_ROOT ?? root;
const main=await import(path.join(helperRoot,'native-ingestion-run-h5e-browser.mjs'));
const dependency=await import(path.join(helperRoot,'native-ingestion-h5c-cf-build-guards.mjs'));
const helpers=[['main',main],['companion dependency',dependency]];
const hash=b=>createHash('sha256').update(b).digest('hex');
const cf=JSON.parse(await readFile('/private/tmp/native-ingestion-evidence-cf/builds/aligned-cf-builds-qualified.json','utf8'));
const b2='75b3578cfccf040b087a55a624e01baa2bca37f9',base='0b616ccc90bf43cb26adac056a22ff01a84f982b';
const frozenTargets=['/home/ubuntu/native-ingestion/aligned-baseline/packages/paperclip-runner/runner/target','/home/ubuntu/native-ingestion/aligned-cf-baseline/packages/paperclip-runner/runner/target'];

// Guard-only fixtures retain complete real CF native provenance, but synthetic
// application files. No Git checkout, build, serving app or qualified B2 exists
// here; the live source/stamp/full-inventory guards would reject this fixture.
async function fixture(directory,mutate=()=>{}) {
 const revision=b2,variant='B2',appRoot=path.join(directory,'fixture-only-no-app');
 const files=['server/dist/index.js','ui/dist/index.html','packages/db/src/client.ts','packages/shared/src/index.ts'].map(path=>({bytes:1,path,sha256:'6'.repeat(64)}));
 const aggregateSha256=hash(Buffer.from(files.map(row=>JSON.stringify(row)).join('\n')+'\n'));
 const manifest={fixtureOnly:true,variant,revision,compiledBuildRevision:revision,roots:['server/dist','ui/dist','packages/db/src','packages/shared/src'],fileCount:files.length,files,aggregateSha256};
 const receipt=structuredClone(cf);receipt.fixtureOnly=true;
 receipt.results=[{variant,revision,compiledBuildRevision:revision,sourceClean:true}];
 receipt.nativeStageHashes=[{...structuredClone(cf.nativeStageHashes[0]),variant,targetRealPath:path.join(directory,'fixture-only-isolated-native-target')}];
 const descriptor={appRoot,revision,aggregateSha256,binarySha256:cf.binarySha256,rustSourceTree:cf.rustSourceTree};
 mutate({receipt,descriptor,manifest,native:receipt.nativeStageHashes[0]});
 descriptor.manifestFile=path.join(directory,'fixture-manifest.json.gz');await writeFile(descriptor.manifestFile,gzipSync(Buffer.from(JSON.stringify(manifest))));
 descriptor.manifestFileSha256=hash(await readFile(descriptor.manifestFile));
 descriptor.inventorySummaryFile=path.join(directory,'fixture-summary.json');
 await writeFile(descriptor.inventorySummaryFile,JSON.stringify({inventories:{B2:{manifest:path.basename(descriptor.manifestFile),manifestSha256:descriptor.manifestFileSha256,aggregateSha256,fileCount:files.length}}}));
 descriptor.inventorySummarySha256=hash(await readFile(descriptor.inventorySummaryFile));
 receipt.artifactInventorySummary=descriptor.inventorySummaryFile;
 if(!Object.hasOwn(receipt,'fixtureKeepTargetReference'))receipt.newSharedTarget=receipt.nativeStageHashes[0].targetRealPath;
 delete receipt.fixtureKeepTargetReference;
 descriptor.qualifiedReceiptFile=path.join(directory,'fixture-qualified.json');await writeFile(descriptor.qualifiedReceiptFile,JSON.stringify(receipt));
 descriptor.qualifiedReceiptSha256=hash(await readFile(descriptor.qualifiedReceiptFile));
 return descriptor;
}
async function withFixture(fn){const directory=await mkdtemp(path.join(os.tmpdir(),'h5e-v2-provenance-only-'));try{await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}}

for(const [name,helper]of helpers){
 test(`${name}: qualified current75 and prospective sources use exact descriptor receipts`,()=>withFixture(async directory=>{
  const descriptor=await fixture(directory);const q=await helper.validateVariantBuild('B2',descriptor);
  assert.equal(q.receipt.fixtureOnly,true);assert.equal(q.receipt.rustSourceTree,cf.rustSourceTree);assert.equal(q.receipt.binarySha256,cf.binarySha256);
  assert.deepEqual(q.receipt.rustInputObjects,cf.rustInputObjects);assert.equal(Object.keys(q.receipt.rustInputObjects).length,15);
  assert.ok(!frozenTargets.includes(q.receipt.nativeStageHashes[0].targetRealPath));
  const future='f'.repeat(40),prospective=await fixture(directory,({receipt,descriptor,manifest})=>{
   receipt.results[0].revision=receipt.results[0].compiledBuildRevision=descriptor.revision=manifest.revision=manifest.compiledBuildRevision=future;
  });
  assert.equal((await helper.validateVariantBuild('B2',prospective)).manifest.revision,future,'Fixture metadata only: no future real commit or candidate is registered by this test');
  await assert.rejects(helper.validateVariantBuild('B2',{...prospective,revision:'e'.repeat(40)}),/qualified receipt revision mismatch/);
 }));
 test(`${name}: changed native input may retain the same binary only with a fresh current-head B2 receipt and isolated target`,()=>withFixture(async directory=>{
  const descriptor=await fixture(directory,({receipt})=>{receipt.rustInputObjects.protocol='e'.repeat(40);});
  const q=await helper.validateVariantBuild('B2',descriptor);assert.equal(q.receipt.rustInputObjects.protocol,'e'.repeat(40));assert.equal(q.receipt.binarySha256,cf.binarySha256);
  assert.notEqual(descriptor.qualifiedReceiptSha256,'5a849da1bc307f4f1fd05c70a75813f6f78acc9941a54cc01e945652a5a79d6b');
 }));
 test(`${name}: a complete changed compilation configuration requires no invented binary novelty`,()=>withFixture(async directory=>{
  const descriptor=await fixture(directory,({receipt})=>{receipt.effectiveRustEnvironment.RUSTFLAGS='-C debuginfo=0';});
  assert.equal((await helper.validateVariantBuild('B2',descriptor)).receipt.effectiveRustEnvironment.RUSTFLAGS,'-C debuginfo=0');
 }));
 test(`${name}: same native inputs accept a different independently qualified artifact hash`,()=>withFixture(async directory=>{
  const descriptor=await fixture(directory,({receipt,native,descriptor})=>{receipt.binarySha256=native.binarySha256=descriptor.binarySha256='a'.repeat(64);});
  const q=await helper.validateVariantBuild('B2',descriptor);
  assert.equal(q.receipt.binarySha256,'a'.repeat(64));assert.deepEqual(q.receipt.rustInputObjects,cf.rustInputObjects);
  assert.deepEqual(q.receipt.effectiveRustEnvironment,cf.effectiveRustEnvironment);assert.deepEqual(q.receipt.runtimeVersions,cf.runtimeVersions);
  assert.deepEqual(q.receipt.nativeStageHashes[0].metadata,cf.nativeStageHashes[0].metadata);
  await assert.rejects(helper.validateVariantBuild('B2',{...descriptor,binarySha256:'b'.repeat(64)}),/native stage binary mismatch/);
  await assert.rejects(helper.validateVariantBuild('B2',{...descriptor,qualifiedReceiptSha256:'b'.repeat(64)}),/qualified receipt bytes changed/);
 }));
 for(const target of frozenTargets)for(const changed of [false,true])test(`${name}: ${changed?'changed':'unchanged'} native cannot reuse immutable target ${target}`,()=>withFixture(async directory=>{
  const descriptor=await fixture(directory,({receipt,native})=>{native.targetRealPath=target;if(changed)receipt.rustInputObjects.protocol='e'.repeat(40);});
  await assert.rejects(helper.validateVariantBuild('B2',descriptor),/independent native target/);
 }));
 for(const [label,mutate,pattern]of [
  ['missing one of fifteen inputs',({receipt})=>{delete receipt.rustInputObjects['runner/Cargo.lock'];},/exact fifteen input paths/],
  ['unexpected native input path',({receipt})=>{receipt.rustInputObjects['unexpected-input']='e'.repeat(40);},/exact fifteen input paths/],
  ['invalid native input object',({receipt})=>{receipt.rustInputObjects.protocol='HEAD';},/immutable full/],
  ['missing compilation field',({receipt})=>{delete receipt.effectiveRustEnvironment.CARGO_ENCODED_RUSTFLAGS;},/configuration is incomplete/],
  ['unreviewed compilation field',({receipt})=>{receipt.effectiveRustEnvironment.UNRECORDED_FLAGS='-x';},/configuration is incomplete/],
  ['invalid compilation field type',({receipt})=>{receipt.effectiveRustEnvironment.RUSTFLAGS=['-x'];},/Invalid native compilation configuration/],
  ['missing toolchain output',({receipt})=>{delete receipt.runtimeVersions.cargo;},/complete toolchain version record/],
  ['contradictory compiler output',({receipt})=>{receipt.rustcVersion='rustc other';},/rustc version records disagree/],
  ['missing native metadata',({native})=>{delete native.metadata;},/Missing native metadata/],
  ['invalid native metadata contract',({native})=>{native.metadata.binaryName='other';},/qualified Runner contract/],
  ['invalid native version interval',({native})=>{native.metadata.prp.minimumVersion=3;native.metadata.prp.maximumVersion=2;},/version interval/],
  ['old B2-base receipt role',({receipt})=>{receipt.results[0].variant='B2-base';},/select this variant exactly once/],
  ['old base compiled stamp',({receipt})=>{receipt.results[0].compiledBuildRevision=base;},/qualified compiled revision mismatch/],
  ['old manifest compiled stamp',({manifest})=>{manifest.compiledBuildRevision=base;},/strictly equal/],
  ['missing isolated-build attestation',({receipt})=>{delete receipt.oldRustTargetNotReused;},/no baseline native target was reused/],
  ['build receipt points at baseline target',({receipt})=>{receipt.fixtureKeepTargetReference=true;},/bind its own independent native target/],
  ['target lexical alias',({native})=>{native.targetRealPath=frozenTargets[1]+'/../target';},/normalized canonical path/],
  ['nested baseline target',({native})=>{native.targetRealPath=frozenTargets[1]+'/other-target';},/independent native target/],
  ['baseline target ancestor',({native})=>{native.targetRealPath=path.posix.dirname(frozenTargets[1]);},/independent native target/],
 ])test(`${name}: rejects ${label}`,()=>withFixture(async directory=>{
  await assert.rejects(helper.validateVariantBuild('B2',await fixture(directory,mutate)),pattern);
 }));
 test(`${name}: rejects both frozen baseline source revisions relabelled B2`,()=>withFixture(async directory=>{
  for(const revision of cf.results.filter(row=>['B0','B1'].includes(row.variant)).map(row=>row.revision)){
   const descriptor=await fixture(directory,({receipt,descriptor,manifest})=>{
    receipt.results[0].revision=receipt.results[0].compiledBuildRevision=descriptor.revision=manifest.revision=manifest.compiledBuildRevision=revision;
   });
   await assert.rejects(helper.validateVariantBuild('B2',descriptor),/cannot reuse a frozen B0\/B1 baseline revision/);
  }
 }));
 test(`${name}: an actual old CF B2-base receipt is not a qualified B2 build`,async()=>{
  const descriptors=JSON.parse(await readFile('/private/tmp/native-ingestion-cf-build-descriptors.json','utf8'));
  const b=descriptors.unoptimizedB2Base,baseRoot='/private/tmp/native-ingestion-evidence-cf/builds';
  const descriptor={...b,qualifiedInventorySummaryReference:b.inventorySummaryFile,qualifiedReceiptFile:path.join(baseRoot,'aligned-cf-builds-qualified.json'),inventorySummaryFile:path.join(baseRoot,'evidence/aligned-cf/environment/artifact-inventory-summary.json'),manifestFile:path.join(baseRoot,'evidence/aligned-cf/environment',path.basename(b.manifestFile))};
  await assert.rejects(helper.validateVariantBuild('B2',descriptor),/select this variant exactly once/);
 });
}

test('both candidate validators and native provenance policies are byte-identical',async()=>{
 const source=await Promise.all(['native-ingestion-run-h5e-browser.mjs','native-ingestion-h5c-cf-build-guards.mjs'].map(file=>readFile(path.join(root,file),'utf8')));
 const policy=s=>s.slice(s.indexOf('function validateNativeProvenance('),s.indexOf('// Match the existing inventory generator'));
 assert.equal(policy(source[0]),policy(source[1]));
});

for(const [name,file]of [['main','native-ingestion-run-h5e-browser.mjs'],['companion dependency','native-ingestion-h5c-cf-build-guards.mjs']])test(`${name}: a real filesystem target alias fails the live pre-app native-target guard`,()=>withFixture(async directory=>{
 const realTarget=path.join(directory,'actual-native-target'),aliasTarget=path.join(directory,'alias-native-target');await mkdir(realTarget);await symlink(realTarget,aliasTarget);
 const descriptor=await fixture(directory,({native})=>{native.targetRealPath=aliasTarget;});
 await mkdir(path.join(descriptor.appRoot,'packages/paperclip-runner/runner'),{recursive:true});await symlink(aliasTarget,path.join(descriptor.appRoot,'packages/paperclip-runner/runner/target'));
 const source=await readFile(path.join(root,file),'utf8');const body=source.slice(source.indexOf('async function checkFrozen('),source.indexOf('\nasync function execute('));
 const qualified=await (name==='main'?main:dependency).validateVariantBuild('B2',descriptor);
 const {realpath}=await import('node:fs/promises');let launches=0;
 const check=vm.runInNewContext(body+'\ncheckFrozen',{assert,path,process:{env:{}},checkReleaseBytes:async()=>{},validateRuntimeChecks:async()=>({fixtureOnly:true}),validateVariantBuild:async()=>qualified,execFileSync:(_file,args)=>args[0]==='status'?'':descriptor.revision,getJson:async()=>({commit:descriptor.revision}),realpath,readFile:async()=>{launches++;throw new Error('must fail before binary reads and app launch');},hash});
 await assert.rejects(check({release:{perVariantBuilds:{B2:descriptor}},plan:{requiredVariants:['B2']}},'B2'),/alias rather than its canonical path/);
 assert.equal(launches,0);
}));
