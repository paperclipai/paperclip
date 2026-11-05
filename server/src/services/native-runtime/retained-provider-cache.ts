import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import type { RemoteWorkspaceTarget } from "../remote-workspace-transport.js";

const schema = "paperclip.native-provider-cache-reclaim.v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function verifiedCacheDigest(run: typeof heartbeatRuns.$inferSelect, workspaceId: string, target: RemoteWorkspaceTarget): string | null {
  const profile = record(run.runnerProfileJson), state = record(profile.nativeProviderPackAdmissionState);
  const admission = record(profile.nativeProviderPackAdmission), workspace = record(profile.remoteWorkspace);
  if (state.schema !== "paperclip.native-provider-pack-admission-state.v1" || state.state !== "verified"
    || typeof state.admissionEpoch !== "string" || !uuidPattern.test(state.admissionEpoch)
    || admission.schema !== "paperclip.native-provider-pack-admission.v1" || admission.stage !== "session_admitted"
    || admission.authority !== "core_verified_selection" || admission.runId !== run.id
    || admission.companyId !== run.companyId || admission.agentId !== run.agentId
    || workspace.workspaceId !== workspaceId || workspace.remoteCwd !== target.remoteCwd || workspace.leaseId !== target.leaseId
    || typeof admission.providerPackDigest !== "string" || !digestPattern.test(admission.providerPackDigest)) return null;
  return admission.providerPackDigest;
}

const reclaimScript = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const [root,source,expected]=process.argv.slice(1),schema='paperclip.native-provider-cache-reclaim.v1';
 if(!path.isAbsolute(root)||!/^[a-f0-9-]{36}$/.test(source)||!/^sha256:[a-f0-9]{64}$/.test(expected)||await fs.realpath(root)!==root)throw Error('invalid_binding');
 const runtime=path.join(root,'.paperclip-runtime'),runner=path.join(runtime,'paperclip-runner'),pack=path.join(runner,'provider-pack');
 const sessions=path.join(runner,'sessions'),parent=path.join(runner,'cache-reclaims'),work=path.join(parent,source),receiptPath=path.join(work,'receipt.json');
 const stat=async p=>fs.lstat(p,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 const directory=async p=>{const x=await fs.lstat(p,{bigint:true});if(!x.isDirectory()||x.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_directory');return x;};
 const write=async value=>{const temp=receiptPath+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fs.rename(temp,receiptPath);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}};
 await directory(runtime);await directory(runner);await directory(pack);const session=await directory(sessions);
 const file=path.join(pack,'provider-pack.json'),m=await stat(file);
 if(!m||!m.isFile()||m.isSymbolicLink()||m.nlink!==1n||m.size>524288n)throw Error('unsafe_manifest');
 const manifestBytes=await fs.readFile(file),manifest=JSON.parse(manifestBytes);
 const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}':JSON.stringify(v);
 if(manifest.schema!=='paperclip-runner/remote-provider-pack/v1'||manifest.digest!==expected
   ||expected!=='sha256:'+crypto.createHash('sha256').update(canonical(manifest.payload)).digest('hex'))throw Error('manifest_changed');
 let receipt,previous=await stat(receiptPath);
 if(previous){
  await directory(parent);await directory(work);
  if(!previous.isFile()||previous.isSymbolicLink()||previous.nlink!==1n||previous.size>16384n)throw Error('unsafe_receipt');
  receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));
  if(receipt.schema!==schema||receipt.sourceRunId!==source||receipt.manifestDigest!==expected
    ||receipt.sessionsDev!==String(session.dev)||receipt.sessionsIno!==String(session.ino)
    ||!Array.isArray(receipt.targets)||receipt.targets.length>2||new Set(receipt.targets.map(x=>x.name)).size!==receipt.targets.length
    ||receipt.targets.some(x=>!['node_modules','provider-assets'].includes(x.name)||!/^\d{1,24}$/.test(x.dev)||!/^\d{1,24}$/.test(x.ino)))throw Error('receipt_changed');
  if(receipt.status==='evicted'){console.log(JSON.stringify({...receipt,changed:false}));return;}
  if(receipt.status!=='prepared')throw Error('receipt_changed');
 }else{
  const targets=[];
  for(const name of ['node_modules','provider-assets']){const p=path.join(pack,name),x=await stat(p);if(!x)continue;
   if(!x.isDirectory()||x.isSymbolicLink()||await fs.realpath(p)!==p)throw Error('unsafe_cache_directory');targets.push({name,dev:String(x.dev),ino:String(x.ino)});}
  if(!targets.length){console.log(JSON.stringify({schema,sourceRunId:source,manifestDigest:expected,status:'absent',changed:false}));return;}
  await fs.mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(parent);
  await fs.mkdir(work,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(work);
  const savedManifest=path.join(work,'provider-pack-manifest.json'),existing=await stat(savedManifest);
  if((await fs.readdir(work)).some(name=>name!=='provider-pack-manifest.json'&&!/^receipt[.]json[.][a-f0-9-]{36}[.]tmp$/.test(name)))throw Error('unexpected_staging');
  if(existing){if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1n||existing.size>524288n
    ||!(await fs.readFile(savedManifest)).equals(manifestBytes))throw Error('staging_changed');}
  else await fs.writeFile(savedManifest,manifestBytes,{flag:'wx',mode:0o600});
  const capacity=await fs.statfs(root);receipt={schema,sourceRunId:source,manifestDigest:expected,targets,
   sessionsDev:String(session.dev),sessionsIno:String(session.ino),availableBytesBefore:capacity.bavail*capacity.bsize,status:'prepared'};
  await write(receipt);
 }
 let changed=false;
 for(const item of receipt.targets){
  const from=path.join(pack,item.name),to=path.join(work,item.name),current=await stat(from),moved=await stat(to);
  if(current&&moved)throw Error('cache_replaced');
  const present=current??moved;
  if(!present)continue;
  if(!present.isDirectory()||present.isSymbolicLink()||String(present.dev)!==item.dev||String(present.ino)!==item.ino)throw Error('cache_changed');
  if(current)await fs.rename(from,to);
  const checked=await stat(to);
  if(!checked||!checked.isDirectory()||checked.isSymbolicLink()||String(checked.dev)!==item.dev||String(checked.ino)!==item.ino)throw Error('cache_changed');
  await fs.rm(to,{recursive:true,force:false});changed=true;
 }
 const afterSession=await directory(sessions);
 if(String(afterSession.dev)!==receipt.sessionsDev||String(afterSession.ino)!==receipt.sessionsIno)throw Error('sessions_changed');
 const capacity=await fs.statfs(root);const result={...receipt,status:'evicted',changed,
  sessionDirectoryPreserved:true,availableBytesAfter:capacity.bavail*capacity.bsize};await write(result);console.log(JSON.stringify(result));
})().catch(()=>{process.stderr.write('native_provider_cache_reclaim_unconfirmed');process.exitCode=1;});`;

export async function reclaimInactiveNativeProviderCache(input: {
  db: Db; companyId: string; issueId: string; runId: string; workspaceId: string;
  target: RemoteWorkspaceTarget; assertOwned: () => Promise<void>;
}): Promise<boolean> {
  await input.assertOwned();
  const [source] = await input.db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns).innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
      eq(nativeRunFinalizations.issueId, input.issueId))).limit(1);
  if (!source || source.run.status !== "failed" || source.run.runtimeMode !== "native"
    || (source.run.nativeIssueId ?? source.run.issueId ?? source.run.contextSnapshot?.issueId) !== input.issueId
    || source.coordinator.phase !== "terminal_failure" || source.coordinator.leaseOwner !== null
    || record(source.coordinator.failureDetail).recoverable === true) return false;
  const expected = verifiedCacheDigest(source.run, input.workspaceId, input.target);
  if (!expected) return false;
  await input.assertOwned();
  const startedAt = new Date();
  let confirmed = false, changed = false;
  let metadata: Record<string, unknown> = { schema, manifestDigest: expected, outcome: "unconfirmed" };
  try {
    const response = await input.target.runner!.execute({ command: "node", args: ["-e", reclaimScript,
      input.target.remoteCwd, input.runId, expected], cwd: input.target.remoteCwd, bypassSession: true,
      env: { NODE_OPTIONS: "", NODE_PATH: "" }, timeoutMs: 45_000 });
    await input.assertOwned();
    if (response.exitCode !== 0 || response.timedOut || Buffer.byteLength(response.stdout) > 16_384)
      throw new Error("native_provider_cache_reclaim_unconfirmed");
    const receipt = record(JSON.parse(response.stdout));
    if (receipt.schema !== schema || receipt.sourceRunId !== input.runId || receipt.manifestDigest !== expected
      || !["evicted", "absent"].includes(String(receipt.status)) || typeof receipt.changed !== "boolean"
      || (receipt.status === "evicted" && receipt.sessionDirectoryPreserved !== true))
      throw new Error("native_provider_cache_reclaim_unconfirmed");
    metadata = { schema, manifestDigest: expected, outcome: receipt.status, changed: receipt.changed,
      sessionDirectoryPreserved: receipt.status === "evicted",
      availableBytesBefore: typeof receipt.availableBytesBefore === "number" ? receipt.availableBytesBefore : null,
      availableBytesAfter: typeof receipt.availableBytesAfter === "number" ? receipt.availableBytesAfter : null };
    confirmed = true;
    changed = receipt.status === "evicted" && receipt.changed === true;
  } catch {}
  await input.db.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
    heartbeatRunId: input.runId, executionWorkspaceId: input.workspaceId, phase: "native_provider_cache_reclaim",
    status: confirmed ? "succeeded" : "failed", startedAt, finishedAt: new Date(), metadata });
  return changed;
}
