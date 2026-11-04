import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const base='/home/ubuntu/native-ingestion',helper=base+'/helpers/native-ingestion-run-h5b-browser.mjs',out=base+'/evidence/h5b/setup';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(helper)),'522d4fc718665ef484dec40ff56e463efe11b4ddf0c632c2d3f4811092d63fa6');
const h=await import(helper);
const quiet=await h.physicalQuietGuard({receiptFile:out+'/linux-quiet-readiness.json',phase:'pre-arm',armStage:'H5b-SETUP-ONLY'});
const receiptFile=base+'/aligned-4a83-builds-qualified.json',summaryFile=base+'/evidence/aligned-4a83/environment/artifact-inventory-summary.json';
const receipt=JSON.parse(await readFile(receiptFile,'utf8')),summary=JSON.parse(await readFile(summaryFile,'utf8'));
const results=[];
for(const [variant,directory] of [['B0','aligned-baseline'],['B1','aligned-cursors']]) {
 const row=receipt.results.find(v=>v.variant===variant),i=summary.inventories[variant],native=receipt.nativeStageHashes.find(v=>v.variant===variant);
 const descriptor={appRoot:base+'/'+directory,revision:row.revision,qualifiedReceiptFile:receiptFile,qualifiedReceiptSha256:sha(await readFile(receiptFile)),inventorySummaryFile:summaryFile,inventorySummarySha256:sha(await readFile(summaryFile)),manifestFile:path.join(path.dirname(summaryFile),i.manifest),manifestFileSha256:i.manifestSha256,aggregateSha256:i.aggregateSha256,binarySha256:native.binarySha256,rustSourceTree:receipt.rustSourceTree};
 const q=await h.validateVariantBuild(variant,descriptor),live=await h.validateActualInventory(descriptor,q.manifest),ui=await h.assertNoPreferredUiShadow(descriptor.appRoot);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:descriptor.appRoot,encoding:'utf8'}).trim(),descriptor.revision);
 assert.equal(execFileSync('git',['status','--short'],{cwd:descriptor.appRoot,encoding:'utf8'}).trim(),'');
 assert.equal(JSON.parse(await readFile(path.join(descriptor.appRoot,'server/dist/build-info.json'),'utf8')).commit,descriptor.revision);
 const target=path.join(descriptor.appRoot,'packages/paperclip-runner/runner/target'),binary=path.join(target,'release/paperclip-runnerd');
 assert.equal(await realpath(target),native.targetRealPath);assert.equal(sha(await readFile(binary)),native.binarySha256);
 results.push({variant,descriptor,live,ui,nativeTargetRealPath:await realpath(target)});
}
const pathNode=execFileSync('node',['-p','process.execPath'],{encoding:'utf8'}).trim();
assert.equal(await realpath(pathNode),await realpath(process.execPath));
const data={setupOnly:true,noSutBrowserProviderOrEvents:true,performanceAcceptanceEligible:false,atMs:Date.now(),helperSha256:sha(await readFile(helper)),harnessRevision:'179fe6fa6da1b24ca08c1162301538d3e3788af6',quiet,path:{PATH:process.env.PATH,nodeExecutable:process.execPath,pathResolvedNode:pathNode,nodeVersion:process.version},results};
await writeFile(out+'/linux-readiness.json',JSON.stringify(data,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({complete:true,setupOnly:true,noSutBrowserProviderOrEvents:true,variants:results.map(v=>({variant:v.variant,fileCount:v.live.fileCount,aggregate:v.live.aggregateSha256,uiShadowAbsent:v.ui.preferredIndexAbsent})),quiet:quiet.passed,nodeVersion:process.version}));
